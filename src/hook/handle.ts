import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertEvents, openHistoryDb } from "../helper/historyDb";
import { detectAndRecordSkillUsage } from "../main/capabilities/skillsAnalytics";
import { parseAutoAllowOff } from "../shared/autoAllow";
import { DEFAULT_TRUSTED_HOSTS } from "../shared/commands";
import { HISTORY_DIR, leashDir, protectedRoots } from "../shared/constants";
import { scanFileForFindings, scanTextForFindings, type ContentFinding, type FindingCategory } from "../shared/contentScan";
import {
  DEFAULT_CONTENT_GUARD_SETTINGS,
  getAutoAcceptMode,
  getContentGuardSettings,
  getGodMode,
  getGuardSettings,
  getSetting,
  getTrustedHosts,
  getValueExceptionHashes,
  listBlocks,
  listGrants,
  listRules,
  listSecureAreas,
  listSessionAllows,
  readSecretSince,
  recordDecision,
  recordFinding,
  recordHealthWarning,
  recordSecretTouch,
  touchGrants,
} from "../shared/db";
import { enabledIgnoredPrefixes } from "../shared/ignored";
import { isSensitive } from "../shared/paths";
import { AFTER_SECRET_MS, isEgressRequest, SESSION_MAX_S } from "../shared/policy";
import { matchSecureArea } from "../shared/secureAreas";
import type { Access, ContentGuardLane, ContentGuardSettings, GuardSettings, HistoryEvent, HookRequest, SecureArea, SessionAllow, Verdict } from "../shared/types";
import { decide, isDestructiveCommand } from "./decide";
import { normaliseHook } from "./normalise";
import { respond } from "./respond";

export type HookAnswer = "allow" | "deny" | "timeout";

function laneForCategory(category: FindingCategory, guards: ContentGuardSettings): ContentGuardLane {
  if (category === "secret") return guards.secrets;
  if (category === "pci") return guards.pci;
  if (category === "pii") return guards.pii;
  return guards.phi;
}

export async function handlePayload(options: {
  entry: "claude" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes";
  raw: unknown;
  db: DatabaseSync;
  now: number;
  home: string;
  ask: (request: HookRequest) => Promise<HookAnswer>;
  notify?: (title: string, body: string) => void;
  historyPath?: string;
  historyDb?: DatabaseSync;
  ignored?: readonly string[];
}): Promise<{ stdout: string; exitCode: number }> {
  const started = Date.now();
  const normalised = normaliseHook(options.raw, options.entry, options.home);
  if (normalised.kind === "ignore") return respond(options.entry, { kind: "pass" });
  const request = normalised.request;
  try {
    detectAndRecordSkillUsage(request, options.home);
  } catch {
    /* analytics must never fail the hook */
  }
  const lockdown = getSetting(options.db, "lockdown", "0") === "1";
  const autoAcceptMode = getAutoAcceptMode(options.db);
  const godMode = getGodMode(options.db);
  let secureAreas: SecureArea[] = [];
  let sessionAllows: SessionAllow[] = [];
  let guards: GuardSettings = { destructiveCommands: true, egressAfterSecret: true };
  let contentGuards: ContentGuardSettings = { ...DEFAULT_CONTENT_GUARD_SETTINGS };
  let trustedHosts: string[] = [...DEFAULT_TRUSTED_HOSTS];
  let exceptionHashes = new Set<string>();
  try {
    secureAreas = listSecureAreas(options.db);
    sessionAllows = listSessionAllows(options.db, options.now);
    guards = getGuardSettings(options.db);
  } catch {
    /* fallback for minimal test schemas */
  }
  try {
    contentGuards = getContentGuardSettings(options.db);
    trustedHosts = getTrustedHosts(options.db);
  } catch {
    /* fallback to defaults */
  }
  try {
    exceptionHashes = getValueExceptionHashes(options.db);
  } catch {
    /* fallback when value_exceptions table is absent */
  }

  const enabledCategories: Partial<Record<FindingCategory, boolean>> = {
    secret: contentGuards.secrets !== "off",
    pci: contentGuards.pci !== "off",
    pii: contentGuards.pii !== "off",
    phi: contentGuards.phi !== "off",
  };
  const anyCategoryEnabled = Object.values(enabledCategories).some(Boolean);

  interface MatchedFinding {
    finding: ContentFinding;
    target: string;
  }
  const matchedFindings: MatchedFinding[] = [];
  const seenFindings = new Set<string>();
  const preScannedSecretPaths = new Set<string>();
  const addFindings = (items: ContentFinding[], target: string) => {
    for (const finding of items) {
      const key = `${finding.ruleId}:${finding.valueHash}`;
      if (seenFindings.has(key)) continue;
      seenFindings.add(key);
      matchedFindings.push({ finding, target });
    }
  };

  if (anyCategoryEnabled) {
    const scanOpts = { categories: enabledCategories, exceptionHashes };
    if (request.command) {
      addFindings(scanTextForFindings(request.command, scanOpts), request.command);
    }
    if (request.url) {
      addFindings(scanTextForFindings(request.url, scanOpts), request.url);
    }
    if (request.access === "read") {
      for (const path of request.paths) {
        const fileFindings = scanFileForFindings(path, scanOpts);
        if (fileFindings.some((f) => f.category === "secret")) {
          preScannedSecretPaths.add(path);
        }
        addFindings(fileFindings, path);
      }
    }
  }
  const contentFindings = matchedFindings.map((item) => item.finding);

  if (guards.egressAfterSecret && isEgressRequest(request)) {
    let seenSecret = readSecretSince(options.db, request.agent, request.sessionId, options.now - AFTER_SECRET_MS, options.historyDb);
    if (!seenSecret && !options.historyDb) {
      const historyPath = options.historyPath ?? (process.env.AGENTIC_LEASH_HISTORY_DIR ? join(process.env.AGENTIC_LEASH_HISTORY_DIR, "history.db") : join(HISTORY_DIR, "history.db"));
      const fallbackPath = join(leashDir(options.home), "history.db");
      for (const candidate of new Set([historyPath, fallbackPath])) {
        if (!existsSync(candidate)) continue;
        let hDb: DatabaseSync | null = null;
        try {
          hDb = openHistoryDb(candidate, true);
          if (readSecretSince(options.db, request.agent, request.sessionId, options.now - AFTER_SECRET_MS, hDb)) {
            seenSecret = true;
            break;
          }
        } catch {
          /* ignore history fallback error */
        } finally {
          try {
            hDb?.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (seenSecret) request.afterSecret = true;
  }

  let verdict: Verdict = decide(request, listGrants(options.db), {
    now: options.now,
    lockdown,
    protectedRoots: protectedRoots(options.home),
    home: options.home,
    autoAllowOff: parseAutoAllowOff(getSetting(options.db, "auto_allow_off", "[]")),
    rules: listRules(options.db),
    blocks: listBlocks(options.db),
    autoAcceptModeUntil: autoAcceptMode.until,
    autoAcceptModeAgent: autoAcceptMode.agent,
    godModeUntil: godMode.until,
    godModeAgent: godMode.agent,
    secureAreas,
    sessionAllows,
    guardDestructiveCommands: guards.destructiveCommands,
    guardEgressAfterSecret: guards.egressAfterSecret,
    trustedHosts,
    contentGuards,
    contentFindings,
  });

  if (verdict.kind === "pass" && verdict.grantIds?.length) {
    try {
      touchGrants(options.db, verdict.grantIds, options.now, SESSION_MAX_S * 1000);
    } catch (error) {
      /* a busy grants db must not fail the tool call */
      recordHealthWarning(
        options.db,
        {
          ts: options.now,
          message: `Grant update failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        options.home,
      );
    }
  }
  const initialPromptArea = verdict.kind === "prompt" ? verdict.matchedSecureArea : undefined;
  let answer: HookAnswer | null = null;
  if (verdict.kind === "prompt") {
    answer = await options.ask(request);
    verdict = answer === "allow" ? { kind: "pass" } : answer === "deny" ? { kind: "deny", reason: "Denied in Agentic Leash" } : verdict;
  }
  if (answer === "timeout" && options.notify) {
    const target = request.command || request.url || request.paths[0] || "access";
    options.notify("Request timed out", `${request.agent} wanted ${target}; denied`);
  }
  const output = answer === "timeout" ? respond(options.entry, "timeout") : respond(options.entry, verdict.kind === "prompt" ? "timeout" : verdict);

  const isAllowed = verdict.kind === "pass" || verdict.kind === "warn" || verdict.kind === "monitor" || answer === "allow";
  const scannedSecretPaths = new Set<string>(isAllowed && request.access === "read" ? preScannedSecretPaths : []);
  if (isAllowed && request.access === "read" && contentGuards.secrets === "off") {
    for (const path of request.paths) {
      if (scanFileForFindings(path, { categories: { secret: true }, exceptionHashes }).length > 0) {
        scannedSecretPaths.add(path);
      }
    }
  }

  const isPathSecret = (path: string, access: Access): boolean => {
    if (scannedSecretPaths.has(path) || isSensitive(path, options.home)) return true;
    const match = matchSecureArea(path, access, options.home, secureAreas);
    if (!match || match.rule === "allow") return false;
    return (
      match.area.group === "secrets" ||
      match.area.group === "project_secrets" ||
      match.area.group === "blocked" ||
      (match.area.group as string) === "always_blocked"
    );
  };

  const isPathSensitive = (path: string, access: Access) => {
    if (isPathSecret(path, access)) return true;
    const match = matchSecureArea(path, access, options.home, secureAreas);
    return match !== null && match.rule !== "allow";
  };

  if (isAllowed) {
    try {
      const events: HistoryEvent[] = [];
      if (request.command) {
        events.push({
          ts: options.now,
          agent: request.agent,
          pid: process.pid,
          exe: request.command,
          kind: "exec",
          path: request.cwd,
          destPath: null,
          sensitive: isSensitive(request.cwd, options.home) || (guards.destructiveCommands && isDestructiveCommand(request.command)),
          source: "hook",
        });
        const realFilePaths = request.paths.filter((p) => p !== request.cwd);
        const access: Access = request.access === "write" ? "write" : "read";
        for (const path of realFilePaths) {
          events.push({
            ts: options.now,
            agent: request.agent,
            pid: process.pid,
            exe: request.tool,
            kind: access,
            path,
            destPath: null,
            sensitive: isPathSensitive(path, access),
            source: "hook",
          });
        }
      } else if (request.paths.length > 0) {
        const access: Access = request.access === "write" ? "write" : "read";
        for (const path of request.paths) {
          events.push({
            ts: options.now,
            agent: request.agent,
            pid: process.pid,
            exe: request.tool,
            kind: access,
            path,
            destPath: null,
            sensitive: isPathSensitive(path, access),
            source: "hook",
          });
        }
      }
      if (request.url) {
        events.push({
          ts: options.now,
          agent: request.agent,
          pid: process.pid,
          exe: request.tool,
          kind: "net",
          path: request.url,
          destPath: null,
          sensitive: Boolean(request.afterSecret),
          source: "hook",
        });
      }
      if (events.length > 0) {
        const historyPath = options.historyPath ?? (process.env.AGENTIC_LEASH_HISTORY_DIR ? join(process.env.AGENTIC_LEASH_HISTORY_DIR, "history.db") : join(HISTORY_DIR, "history.db"));
        let historyDb: DatabaseSync | null = null;
        let openedHere = false;
        try {
          if (options.historyDb) {
            historyDb = options.historyDb;
          } else {
            try {
              historyDb = openHistoryDb(historyPath);
              openedHere = true;
            } catch {
              const fallbackPath = join(leashDir(options.home), "history.db");
              if (fallbackPath !== historyPath) {
                historyDb = openHistoryDb(fallbackPath);
                openedHere = true;
              }
            }
          }
          if (historyDb) {
            let ignored = options.ignored;
            if (!ignored) {
              try {
                ignored = enabledIgnoredPrefixes(options.db);
              } catch {
                ignored = [];
              }
            }
            insertEvents(historyDb, events, ignored);
          }
        } finally {
          if (openedHere && historyDb) {
            try {
              historyDb.close();
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* history writing must NEVER fail the hook or tool execution */
    }
  }

  const secret = scannedSecretPaths.size > 0 || request.paths.some((path) => isPathSecret(path, request.access));
  if (isAllowed && secret) {
    try {
      recordSecretTouch(options.db, {
        agent: request.agent,
        sessionId: request.sessionId,
        ts: options.now,
      });
    } catch (error) {
      recordHealthWarning(
        options.db,
        {
          ts: options.now,
          message: `Secret touch log write failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        options.home,
      );
    }
  }

  if (matchedFindings.length > 0) {
    const resolveAction = (finding: ContentFinding): "block" | "ask" | "warn" | "monitor" | "pass" => {
      const lane = laneForCategory(finding.category, contentGuards);
      if (lane === "block") return "block";
      if (lane === "ask") return isAllowed ? "pass" : "ask";
      if (lane === "warn") return verdict.kind === "deny" ? "block" : "warn";
      if (lane === "monitor") return verdict.kind === "deny" ? "block" : "monitor";
      return "pass";
    };
    for (const { finding, target } of matchedFindings) {
      try {
        recordFinding(options.db, {
          ts: options.now,
          agent: request.agent,
          sessionId: request.sessionId ?? null,
          tool: request.tool,
          target,
          ruleId: finding.ruleId,
          category: finding.category,
          severity: finding.severity,
          label: finding.label,
          preview: finding.preview,
          valueHash: finding.valueHash,
          action: resolveAction(finding),
        });
      } catch {
        /* ignore when findings table is absent in minimal test schemas */
      }
    }
  }

  try {
    recordDecision(options.db, {
      ts: options.now,
      agent: request.agent,
      tool: request.tool,
      paths: request.paths,
      command: request.command,
      url: request.url,
      verdict: answer === "timeout" ? "timeout" : verdict.kind === "warn" || verdict.kind === "monitor" ? "pass" : verdict.kind,
      reason:
        verdict.kind === "deny" || verdict.kind === "warn" || verdict.kind === "monitor"
          ? verdict.reason
          : answer === "timeout" && initialPromptArea
            ? `Timed out (${initialPromptArea.label})`
            : verdict.kind === "pass" && (verdict.godMode || verdict.autoAcceptMode)
              ? "Auto-Accept active"
              : undefined,
      durationMs: Math.max(0, Date.now() - started),
      sessionId: request.sessionId,
      secret,
      prompted: answer !== null,
    });
  } catch (error) {
    /* a locked decision log must not fail the tool call */
    recordHealthWarning(
      options.db,
      {
        ts: options.now,
        message: `Decision log write failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      options.home,
    );
  }
  return output;
}

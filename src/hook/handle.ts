import { decide } from "./decide";
import { normaliseHook } from "./normalise";
import { respond } from "./respond";
import { parseAutoAllowOff } from "../shared/autoAllow";
import { getAutoAcceptMode, getGodMode, getSetting, listBlocks, listGrants, listRules, readSecretSince, recordDecision, touchGrants } from "../shared/db";
import { HISTORY_DIR, leashDir, protectedRoots } from "../shared/constants";
import { isSensitive } from "../shared/paths";
import { AFTER_SECRET_MS, isEgressRequest, SESSION_MAX_S } from "../shared/policy";
import type { DatabaseSync } from "node:sqlite";
import type { Access, HistoryEvent, HookRequest, Verdict } from "../shared/types";
import { detectAndRecordSkillUsage } from "../main/capabilities/skillsAnalytics";
import { insertEvents, openHistoryDb } from "../helper/historyDb";
import { enabledIgnoredPrefixes } from "../shared/ignored";
import { join } from "node:path";

export type HookAnswer = "allow" | "deny" | "timeout";

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
  if (isEgressRequest(request) && readSecretSince(options.db, request.agent, request.sessionId, options.now - AFTER_SECRET_MS)) request.afterSecret = true;
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
  });
  if (verdict.kind === "pass" && verdict.grantIds?.length) {
    try {
      touchGrants(options.db, verdict.grantIds, options.now, SESSION_MAX_S * 1000);
    } catch {
      /* a busy grants db must not fail the tool call */
    }
  }
  let answer: HookAnswer | null = null;
  if (verdict.kind === "prompt") {
    answer = await options.ask(request);
    verdict = answer === "allow" ? { kind: "pass" } : answer === "deny" ? { kind: "deny", reason: "Denied in Agentic Leash" } : verdict;
  }
  const output = answer === "timeout" ? respond(options.entry, "timeout") : respond(options.entry, verdict.kind === "prompt" ? "timeout" : verdict);

  const isAllowed = verdict.kind === "pass" || answer === "allow";
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
          sensitive: isSensitive(request.cwd, options.home),
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
            sensitive: isSensitive(path, options.home),
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
            sensitive: isSensitive(path, options.home),
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
          sensitive: false,
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

  try {
    recordDecision(options.db, {
      ts: options.now,
      agent: request.agent,
      tool: request.tool,
      paths: request.paths,
      command: request.command,
      url: request.url,
      verdict: answer === "timeout" ? "timeout" : verdict.kind,
      reason: verdict.kind === "deny" ? verdict.reason : verdict.kind === "pass" && verdict.godMode ? "God Mode active" : verdict.kind === "pass" && verdict.autoAcceptMode ? "Auto Accept Mode active" : undefined,
      durationMs: Math.max(0, Date.now() - started),
      sessionId: request.sessionId,
      secret: request.paths.some((path) => isSensitive(path, options.home)),
      prompted: answer !== null,
    });
  } catch {
    /* a locked decision log must not fail the tool call */
  }
  return output;
}

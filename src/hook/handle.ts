import { decide } from "./decide";
import { normaliseHook } from "./normalise";
import { respond } from "./respond";
import { parseAutoAllowOff } from "../shared/autoAllow";
import { getGodMode, getSetting, listBlocks, listGrants, listRules, readSecretSince, recordDecision, touchGrants } from "../shared/db";
import { protectedRoots } from "../shared/constants";
import { isSensitive } from "../shared/paths";
import { AFTER_SECRET_MS, isEgressRequest, SESSION_MAX_S } from "../shared/policy";
import type { DatabaseSync } from "node:sqlite";
import type { HookRequest, Verdict } from "../shared/types";

export type HookAnswer = "allow" | "deny" | "timeout";

export async function handlePayload(options: {
  entry: "claude" | "cursor" | "codex" | "gemini" | "antigravity" | "hermes";
  raw: unknown;
  db: DatabaseSync;
  now: number;
  home: string;
  ask: (request: HookRequest) => Promise<HookAnswer>;
  notify?: (title: string, body: string) => void;
}): Promise<{ stdout: string; exitCode: number }> {
  const started = Date.now();
  const normalised = normaliseHook(options.raw, options.entry, options.home);
  if (normalised.kind === "ignore") return respond(options.entry, { kind: "pass" });
  const request = normalised.request;
  const lockdown = getSetting(options.db, "lockdown", "0") === "1";
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
  try {
    recordDecision(options.db, {
      ts: options.now,
      agent: request.agent,
      tool: request.tool,
      paths: request.paths,
      command: request.command,
      url: request.url,
      verdict: answer === "timeout" ? "timeout" : verdict.kind,
      reason: verdict.kind === "deny" ? verdict.reason : verdict.kind === "pass" && verdict.godMode ? "God mode active" : undefined,
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

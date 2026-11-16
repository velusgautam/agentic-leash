import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHistory, openHistoryDb } from "../../src/helper/historyDb";
import { decide } from "../../src/hook/decide";
import { handlePayload } from "../../src/hook/handle";
import {
  deleteSecureArea,
  getGuardSettings,
  getVerboseCapture,
  grantSessionAllow,
  isAllowedBySessionAllow,
  isSecureAreasSetupDone,
  listDecisions,
  listSecureAreas,
  listSessionAllows,
  openGrantsDb,
  readSecretSince,
  revokeSessionAllow,
  setGuardSettings,
  setSecureAreasSetupDone,
  setVerboseCapture,
  updateSecureArea,
  upsertSecureArea,
} from "../../src/shared/db";
import { BUILTIN_SECURE_AREAS, matchSecureArea } from "../../src/shared/secureAreas";
import { containsSecretPattern, scanFileForSecrets } from "../../src/shared/secretScan";
import type { HookRequest, SecureArea } from "../../src/shared/types";

const home = "/Users/tester";

const makeArea = (over: Partial<SecureArea>): SecureArea => ({
  id: 1,
  pattern: "~/.ssh",
  label: "SSH keys",
  group: "secrets",
  readRule: "ask",
  writeRule: "ask",
  enabled: true,
  builtin: true,
  createdAt: 0,
  ...over,
});

const builtinAreas: SecureArea[] = BUILTIN_SECURE_AREAS.map((item, idx) => ({
  id: idx + 1,
  pattern: item.pattern,
  label: item.label,
  group: item.group,
  readRule: item.readRule,
  writeRule: item.writeRule,
  enabled: true,
  builtin: true,
  createdAt: 0,
}));

const req = (over: Partial<HookRequest>): HookRequest => ({
  agent: "claude-code",
  event: "PreToolUse",
  tool: "Read",
  access: "read",
  paths: [`${home}/proj/src/index.ts`],
  cwd: `${home}/proj`,
  ...over,
});

describe("WP2: Secure Areas matcher & built-ins", () => {
  it("expands ~/ and matches directory prefixes without matching sibling prefixes", () => {
    expect(matchSecureArea(`${home}/.ssh/id_rsa`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea("~/.ssh/config", "write", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/.ssh_backup/key`, "read", home, builtinAreas)).toBeNull();
  });

  it("matches subpaths like .git/hooks for write=ask and read=allow", () => {
    expect(matchSecureArea(`${home}/proj/.git/hooks/pre-commit`, "read", home, builtinAreas)?.rule).toBe("allow");
    expect(matchSecureArea(`${home}/proj/.git/hooks/pre-commit`, "write", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/.git/hooks`, "write", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/.git/hooks-bak/x`, "write", home, builtinAreas)).toBeNull();
  });

  it("matches basename globs and excludes .env.example, .env.sample, .env.template", () => {
    expect(matchSecureArea(`${home}/proj/.env`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/.env.local`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/.env`, "write", home, builtinAreas)?.rule).toBe("allow");
    expect(matchSecureArea(`${home}/proj/.env.example`, "read", home, builtinAreas)).toBeNull();
    expect(matchSecureArea(`${home}/proj/.env.sample`, "read", home, builtinAreas)).toBeNull();
    expect(matchSecureArea(`${home}/proj/.env.template`, "read", home, builtinAreas)).toBeNull();
    expect(matchSecureArea(`${home}/proj/certs/server.pem`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/certs/server.key`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/proj/certs/cert.p12`, "read", home, builtinAreas)?.rule).toBe("ask");
  });

  it("enforces blocked areas on both read and write, and startup/personal rules per access", () => {
    expect(matchSecureArea(`${home}/Library/Keychains/login.keychain-db`, "read", home, builtinAreas)?.rule).toBe("block");
    expect(matchSecureArea(`${home}/Library/Application Support/Google/Chrome/Default/Cookies`, "write", home, builtinAreas)?.rule).toBe("block");
    expect(matchSecureArea(`${home}/Desktop/notes.txt`, "read", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/Desktop/notes.txt`, "write", home, builtinAreas)?.rule).toBe("allow");
    expect(matchSecureArea(`${home}/.zshrc`, "read", home, builtinAreas)?.rule).toBe("allow");
    expect(matchSecureArea(`${home}/.zshrc`, "write", home, builtinAreas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/.claude/settings.json`, "write", home, builtinAreas)?.rule).toBe("ask");
  });

  it("ignores disabled areas and returns the strictest rule (block > ask > allow)", () => {
    const areas: SecureArea[] = [
      makeArea({ id: 1, pattern: "~/Desktop", readRule: "allow", writeRule: "allow", enabled: true }),
      makeArea({ id: 2, pattern: "~/Desktop/vault", readRule: "ask", writeRule: "ask", enabled: true }),
      makeArea({ id: 3, pattern: "~/Desktop/vault/chrome", readRule: "block", writeRule: "block", enabled: true }),
      makeArea({ id: 4, pattern: "~/Desktop/disabled", readRule: "block", writeRule: "block", enabled: false }),
    ];
    expect(matchSecureArea(`${home}/Desktop/vault/chrome/data`, "read", home, areas)?.rule).toBe("block");
    expect(matchSecureArea(`${home}/Desktop/vault/file.txt`, "read", home, areas)?.rule).toBe("ask");
    expect(matchSecureArea(`${home}/Desktop/disabled/file.txt`, "read", home, areas)?.rule).toBe("allow");
  });
});

describe("WP2: secretScan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-scan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects API keys, tokens, and private key headers without false positives", () => {
    expect(containsSecretPattern("OPENAI_API_KEY=sk-proj1234567890")).toBe(true);
    expect(containsSecretPattern("token = ghp_abcdef123456")).toBe(true);
    expect(containsSecretPattern("github_pat_11ABCDEF")).toBe(true);
    expect(containsSecretPattern("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsSecretPattern("SLACK=xoxb-1234-5678")).toBe(true);
    expect(containsSecretPattern("GOOGLE_KEY=AIzaSyDummyKey12345")).toBe(true);
    expect(containsSecretPattern("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true);

    expect(containsSecretPattern("const runner = 'task-runner';")).toBe(false);
    expect(containsSecretPattern("export function add(a: number, b: number) { return a + b; }")).toBe(false);
    expect(containsSecretPattern("")).toBe(false);
  });

  it("scans files up to maxBytes and never throws on missing or unreadable paths", () => {
    const secretFile = join(dir, "config.ts");
    writeFileSync(secretFile, 'export const KEY = "ghp_1234567890abcdef";\n');
    expect(scanFileForSecrets(secretFile)).toBe(true);

    const cleanFile = join(dir, "clean.ts");
    writeFileSync(cleanFile, "export const x = 42;\n");
    expect(scanFileForSecrets(cleanFile)).toBe(false);

    const beyondLimit = join(dir, "large.txt");
    writeFileSync(beyondLimit, `${"a".repeat(200)} sk-1234567890`);
    expect(scanFileForSecrets(beyondLimit, 100)).toBe(false);
    expect(scanFileForSecrets(beyondLimit, 300)).toBe(true);

    expect(scanFileForSecrets(join(dir, "does-not-exist.txt"))).toBe(false);
    expect(scanFileForSecrets(dir)).toBe(false);
  });
});

describe("WP2: DB schema, seeding, CRUD, session allows, and settings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-wp2db-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("idempotently seeds built-in Secure Areas and preserves user edits/deletions", () => {
    const dbPath = join(dir, "grants.db");
    let db = openGrantsDb(dbPath);
    const seeded = listSecureAreas(db);
    expect(seeded.length).toBe(BUILTIN_SECURE_AREAS.length);
    const ssh = seeded.find((a) => a.pattern === "~/.ssh")!;
    expect(ssh).toMatchObject({ group: "secrets", readRule: "ask", writeRule: "ask", enabled: true, builtin: true });

    updateSecureArea(db, ssh.id, { enabled: false, readRule: "block" });
    const npmrc = seeded.find((a) => a.pattern === "~/.npmrc")!;
    deleteSecureArea(db, npmrc.id);
    db.close();

    db = openGrantsDb(dbPath);
    const reopened = listSecureAreas(db);
    expect(reopened.find((a) => a.pattern === "~/.ssh")).toMatchObject({ enabled: false, readRule: "block" });
    expect(reopened.find((a) => a.pattern === "~/.npmrc")).toBeUndefined();
    db.close();
  });

  it("supports upsert, update, delete, session allows, guards, setup done, and verbose capture", () => {
    const db = openGrantsDb(join(dir, "grants.db"));

    const custom = upsertSecureArea(db, {
      pattern: "~/Work/keys",
      label: "Work keys",
      group: "custom",
      readRule: "ask",
      writeRule: "block",
    });
    expect(custom.pattern).toBe("~/Work/keys");
    expect(upsertSecureArea(db, { pattern: "~/Work/keys", label: "Work keys 2", readRule: "block", writeRule: "block" }).id).toBe(custom.id);
    expect(deleteSecureArea(db, custom.id)).toBe(true);

    const allow = grantSessionAllow(db, {
      path: `${home}/.ssh/config`,
      agent: "claude-code",
      sessionId: "sess-1",
      access: "read",
      expiresAt: 10_000,
      createdAt: 1_000,
    });
    expect(listSessionAllows(db, 2_000)).toHaveLength(1);
    expect(isAllowedBySessionAllow(db, { path: `${home}/.ssh/config`, agent: "claude-code", sessionId: "sess-1", access: "read", now: 5_000, home })).toBe(true);
    expect(isAllowedBySessionAllow(db, { path: `${home}/.ssh/config`, agent: "claude-code", sessionId: "sess-2", access: "read", now: 5_000, home })).toBe(false);
    expect(isAllowedBySessionAllow(db, { path: `${home}/.ssh/config`, agent: "claude-code", sessionId: "sess-1", access: "write", now: 5_000, home })).toBe(false);
    expect(isAllowedBySessionAllow(db, { path: `${home}/.ssh/config`, agent: "claude-code", sessionId: "sess-1", access: "read", now: 12_000, home })).toBe(false);
    expect(revokeSessionAllow(db, allow.id)).toBe(true);
    expect(listSessionAllows(db)).toHaveLength(0);

    expect(getGuardSettings(db)).toEqual({ destructiveCommands: true, egressAfterSecret: true });
    expect(setGuardSettings(db, { destructiveCommands: false })).toEqual({ destructiveCommands: false, egressAfterSecret: true });

    expect(isSecureAreasSetupDone(db)).toBe(false);
    setSecureAreasSetupDone(db, true);
    expect(isSecureAreasSetupDone(db)).toBe(true);

    expect(getVerboseCapture(db)).toBe(false);
    expect(setVerboseCapture(db, true)).toBe(true);
    expect(getVerboseCapture(db)).toBe(true);

    db.close();
  });
});

describe("WP2: decide() with Secure Areas & handlePayload integration", () => {
  let dir: string;
  let testHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-wp2hook-"));
    testHome = join(dir, "home");
    mkdirSync(join(testHome, "proj"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies v0.9 decision tree (lockdown, protectedRoots, block, ask, guards, godMode pass)", () => {
    const baseOpts = {
      now: 1_000,
      lockdown: false,
      protectedRoots: [`${home}/.agentic-leash`],
      home,
      secureAreas: builtinAreas,
      sessionAllows: [],
      guardDestructiveCommands: true,
      guardEgressAfterSecret: true,
    };

    // Outside Secure Areas -> pass with godMode
    expect(decide(req({}), [], baseOpts)).toEqual({ kind: "pass", godMode: true });

    // Lockdown & protectedRoots -> deny
    expect(decide(req({}), [], { ...baseOpts, lockdown: true }).kind).toBe("deny");
    expect(decide(req({ paths: [`${home}/.agentic-leash/grants.db`] }), [], baseOpts).kind).toBe("deny");

    // Block Secure Area -> deny with label
    const blocked = decide(req({ paths: [`${home}/Library/Keychains/login.keychain-db`] }), [], baseOpts);
    expect(blocked.kind).toBe("deny");
    if (blocked.kind === "deny") {
      expect(blocked.reason).toBe("Blocked by Secure Area: macOS Keychains");
    }

    // Ask Secure Area -> prompt with matchedSecureArea
    const askSsh = decide(req({ paths: [`${home}/.ssh/id_rsa`] }), [], baseOpts);
    expect(askSsh.kind).toBe("prompt");
    if (askSsh.kind === "prompt") {
      expect(askSsh.matchedSecureArea?.group).toBe("secrets");
    }

    // Covered by sessionAllow -> pass
    expect(
      decide(req({ paths: [`${home}/.ssh/id_rsa`], sessionId: "s1" }), [], {
        ...baseOpts,
        sessionAllows: [
          { id: 1, path: `${home}/.ssh/id_rsa`, agent: "claude-code", sessionId: "s1", access: "read", expiresAt: 5_000, createdAt: 0 },
        ],
      }),
    ).toEqual({ kind: "pass", godMode: true });

    // Destructive command -> prompt unless guard is off
    expect(decide(req({ command: "rm -rf /tmp/foo", paths: [`${home}/proj`] }), [], baseOpts).kind).toBe("prompt");
    expect(
      decide(req({ command: "rm -rf /tmp/foo", paths: [`${home}/proj`] }), [], {
        ...baseOpts,
        guardDestructiveCommands: false,
      }),
    ).toEqual({ kind: "pass", godMode: true });

    // Egress after secret -> prompt unless guard is off
    expect(decide(req({ url: "https://example.com", paths: [], afterSecret: true }), [], baseOpts).kind).toBe("prompt");
    expect(
      decide(req({ url: "https://example.com", paths: [], afterSecret: true }), [], {
        ...baseOpts,
        guardEgressAfterSecret: false,
      }),
    ).toEqual({ kind: "pass", godMode: true });
  });

  it("scans allowed reads in handlePayload without prompting, marks secret/sensitive, and arms egress guard", async () => {
    const db = openGrantsDb(join(dir, "grants.db"));
    const historyDb = openHistoryDb(join(dir, "history.db"));
    const fileWithSecret = join(testHome, "proj", "settings.ts");
    writeFileSync(fileWithSecret, 'export const OPENAI = "sk-proj-abc123456789";\n');

    let askedOnRead = false;
    const now = 1_700_000_000_000;
    const readRes = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: fileWithSecret },
        cwd: join(testHome, "proj"),
        session_id: "sess-scan",
      },
      db,
      historyDb,
      now,
      home: testHome,
      ask: async () => {
        askedOnRead = true;
        return "deny";
      },
    });

    expect(askedOnRead).toBe(false);
    expect(readRes.exitCode).toBe(0);
    expect(readSecretSince(db, "claude-code", "sess-scan", now - 1000)).toBe(true);

    const decisions = listDecisions(db);
    expect(decisions[0]?.verdict).toBe("pass");
    const histRows = listHistory(historyDb, 0, 20);
    expect(histRows[0]?.sensitive).toBe(true);

    // Subsequent network request within 60s must prompt via afterSecret
    let promptedAfterSecret = false;
    let sawAfterSecretFlag = false;
    await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com/upload" },
        cwd: join(testHome, "proj"),
        session_id: "sess-scan",
      },
      db,
      historyDb,
      now: now + 15_000,
      home: testHome,
      ask: async (hookReq) => {
        promptedAfterSecret = true;
        sawAfterSecretFlag = Boolean(hookReq.afterSecret);
        return "deny";
      },
    });

    expect(promptedAfterSecret).toBe(true);
    expect(sawAfterSecretFlag).toBe(true);

    historyDb.close();
    db.close();
  });
});

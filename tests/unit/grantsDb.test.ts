import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openHistoryDb, insertEvents } from "../../src/helper/historyDb";
import {
  addValueException,
  clearAutoAcceptMode,
  clearFindings,
  clearGodMode,
  collapseGrantDupes,
  createRule,
  countBlocked,
  DEFAULT_CONTENT_GUARD_SETTINGS,
  DEFAULT_TRUSTED_EGRESS_HOSTS,
  deleteRule,
  deleteValueException,
  extendGrant,
  getAutoAcceptMode,
  getContentGuardSettings,
  getGodMode,
  getTrustedHosts,
  getValueExceptionHashes,
  listApprovals,
  listDecisions,
  listDeniedDecisions,
  listFindings,
  listGrants,
  listSecureAreas,
  listValueExceptions,
  openGrantsDb,
  pruneApprovals,
  readSecretSince,
  recordApproval,
  recordDecision,
  recordFinding,
  recordSecretTouch,
  setAutoAcceptMode,
  setContentGuardSettings,
  setGodMode,
  setTrustedHosts,
  updateRule,
  updateSecureArea,
  upsertCommandGrant,
  upsertGrant,
  upsertSecureArea,
} from "../../src/shared/db";
import { describeRule, matchSecureArea, RULE_RANK } from "../../src/shared/secureAreas";
import type { SecureArea } from "../../src/shared/types";

const row = (path: string, expiresAt: number | null, createdAt = 1) => ({
  agent: "cursor",
  path,
  access: "write" as const,
  source: "leash" as const,
  createdAt,
  expiresAt,
});

const SAFE_COMMANDS = [
  "pwd", "whoami", "id", "id -u", "id -un", "id -g", "id -gn",
  "uname", "uname -a", "uname -m", "arch", "hostname", "tty",
  "sw_vers", "sw_vers -productName", "sw_vers -productVersion", "sw_vers -buildVersion",
  "true", "false",
  "git --version", "node --version", "npm --version", "npx --version", "pnpm --version",
  "yarn --version", "bun --version", "deno --version", "python --version", "python3 --version",
  "ruby --version", "go version", "rustc --version", "cargo --version", "java -version",
  "javac -version", "swift --version", "clang --version", "tsc --version", "docker --version",
  "gh --version", "xcodebuild -version", "xcode-select -p",
];

describe("upsertGrant", () => {
  it("refreshes the same agent, path, and access instead of inserting another row", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-grants-")), "grants.db"));
    upsertGrant(db, row("/Volumes/Agentic Leash 1", 100));
    upsertGrant(db, row("/Volumes/Agentic Leash 1", 250, 20));
    const grants = listGrants(db);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.expiresAt).toBe(250);
    expect(grants[0]?.createdAt).toBe(20);
    db.close();
  });

  it("keeps a longer grant, including forever", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-grants-")), "grants.db"));
    upsertGrant(db, row("/work", null, 5));
    upsertGrant(db, row("/work", 50, 9));
    expect(listGrants(db)[0]).toMatchObject({ expiresAt: null, createdAt: 5 });
    upsertGrant(db, row("/other", 80, 1));
    upsertGrant(db, row("/other", 40, 2));
    expect(listGrants(db).find((grant) => grant.path === "/other")).toMatchObject({ expiresAt: 80, createdAt: 1 });
    db.close();
  });
});

describe("collapseGrantDupes", () => {
  it("leaves one row per path and keeps forever over a timed grant", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-grants-")), "grants.db"));
    const insert = db.prepare("INSERT INTO grants (agent, path, access, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("cursor", "/Volumes/Agentic Leash 1", "write", "leash", 1, 150);
    insert.run("cursor", "/Volumes/Agentic Leash 1", "write", "leash", 2, null);
    insert.run("cursor", "/Volumes/Agentic Leash 1", "write", "leash", 3, 900);
    collapseGrantDupes(db);
    const grants = listGrants(db);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.expiresAt).toBe(null);
    db.close();
  });
});

describe("command grants", () => {
  it("reads a pre-command database as command null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "al-old-")), "grants.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE grants (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, path TEXT NOT NULL, access TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER)");
    raw.prepare("INSERT INTO grants (agent, path, access, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run("cursor", "/proj", "write", "leash", 1, null);
    raw.close();
    const db = openGrantsDb(path);
    expect(listGrants(db)[0]).toMatchObject({ path: "/proj", command: null });
    db.close();
  });

  it("keeps a command row off the folder upsert and refreshes its expiry", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-cmd-")), "grants.db"));
    upsertCommandGrant(db, { agent: "cursor", command: "npm test", createdAt: 1, expiresAt: 10 });
    upsertCommandGrant(db, { agent: "cursor", command: "npm test", createdAt: 2, expiresAt: null });
    upsertGrant(db, row("", 5, 3));
    const grants = listGrants(db);
    expect(grants.filter((grant) => grant.command === "npm test")).toEqual([expect.objectContaining({ path: "", expiresAt: null, createdAt: 1 })]);
    expect(grants.filter((grant) => grant.command == null)).toHaveLength(1);
    db.close();
  });

  it("does not collapse two commands that share an empty path", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-cmd-")), "grants.db"));
    upsertCommandGrant(db, { agent: "cursor", command: "npm test", createdAt: 1, expiresAt: 10 });
    upsertCommandGrant(db, { agent: "cursor", command: "npm test --watch", createdAt: 1, expiresAt: 10 });
    collapseGrantDupes(db);
    expect(listGrants(db)).toHaveLength(2);
    db.close();
  });
});

describe("rules", () => {
  it("seeds exact global safe commands once and preserves deletions", () => {
    const path = join(mkdtempSync(join(tmpdir(), "al-safe-")), "grants.db");
    let db = openGrantsDb(path);
    const seeded = db.prepare("SELECT value FROM rules WHERE kind = 'command' AND agent = '*' ORDER BY id").all() as { value: string }[];
    expect(seeded.map((row) => row.value)).toEqual(SAFE_COMMANDS);
    const removed = db.prepare("SELECT id FROM rules WHERE value = 'pwd'").get() as { id: number };
    deleteRule(db, removed.id);
    db.close();

    db = openGrantsDb(path);
    const values = db.prepare("SELECT value FROM rules WHERE kind = 'command' AND agent = '*'").all() as { value: string }[];
    expect(values.map((row) => row.value)).not.toContain("pwd");
    expect(values).toHaveLength(SAFE_COMMANDS.length - 1);
    db.close();
  });

  it("creates, rejects a duplicate, updates, and deletes", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-rules-")), "grants.db"));
    const home = "/Users/v";
    const created = createRule(db, { kind: "folder", agent: "*", value: "~/proj" }, home, 5);
    expect(created.error).toBeNull();
    const folder = created.rules.find((rule) => rule.kind === "folder");
    expect(folder).toMatchObject({ kind: "folder", agent: "*", value: "/Users/v/proj", createdAt: 5 });
    expect(createRule(db, { kind: "folder", agent: "*", value: "/Users/v/proj" }, home, 6).error).toBe("Already in the allow list.");
    const id = folder!.id;
    const updated = updateRule(db, id, { kind: "command", agent: "cursor", value: "npm test" }, home, 7);
    expect(updated.error).toBeNull();
    expect(updated.rules).toContainEqual(expect.objectContaining({ kind: "command", value: "npm test", createdAt: 7 }));
    expect(createRule(db, { kind: "command", agent: "cursor", value: "ls" }, home, 8).error).toBeNull();
    expect(updateRule(db, id, { kind: "command", agent: "cursor", value: "ls" }, home, 9).error).toBe("Already in the allow list.");
    expect(updateRule(db, id, { kind: "command", agent: "cursor", value: "npm test" }, home, 8).error).toBeNull();
    expect(updateRule(db, 99, { kind: "command", agent: "*", value: "ls" }, home, 8)).toMatchObject({ error: "That rule is gone." });
    const left = deleteRule(db, id);
    expect(left.map((rule) => rule.value)).toContain("ls");
    expect(deleteRule(db, id)).toEqual(left);
    const ls = left.find((rule) => rule.value === "ls")!;
    expect(deleteRule(db, ls.id).map((rule) => rule.value)).not.toContain("ls");
    db.close();
  });
});

describe("decisions", () => {
  it("stores the command, url and paths behind each decision", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-dec-")), "grants.db"));
    recordDecision(db, { ts: 1, agent: "cursor", tool: "Bash", paths: [], verdict: "deny", reason: "Denied in Agentic Leash", command: "rm -rf x" });
    recordDecision(db, { ts: 2, agent: "cursor", tool: "Write", paths: ["/a", "/b"], verdict: "pass" });
    recordDecision(db, { ts: 3, agent: "cursor", tool: "WebFetch", paths: [], verdict: "pass", url: "https://x.dev" });
    const [web, write, bash] = listDecisions(db);
    expect(web).toMatchObject({ url: "https://x.dev", command: null });
    expect(write).toMatchObject({ paths: '["/a","/b"]', command: null, url: null, reason: null });
    expect(bash).toMatchObject({ command: "rm -rf x", url: null, reason: "Denied in Agentic Leash" });
    db.close();
  });

  it("adds command and url to a pre-existing decisions table", () => {
    const path = join(mkdtempSync(join(tmpdir(), "al-olddec-")), "grants.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE decisions (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, paths TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT, grant_id INTEGER, duration_ms INTEGER)");
    raw.prepare("INSERT INTO decisions (ts, agent, tool, paths, verdict) VALUES (?, ?, ?, ?, ?)").run(1, "cursor", "Write", '["/p"]', "pass");
    raw.close();
    const db = openGrantsDb(path);
    recordDecision(db, { ts: 2, agent: "cursor", tool: "Bash", paths: [], verdict: "pass", command: "ls" });
    expect(listDecisions(db).map((row) => [row.command, row.url])).toEqual([["ls", null], [null, null]]);
    db.close();
  });
});

describe("extendGrant", () => {
  const fresh = () => openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-ext-")), "grants.db"));
  it("extends from expiry while live and from now once expired", () => {
    const db = fresh();
    const live = upsertGrant(db, row("/live", 5000));
    const dead = upsertGrant(db, row("/dead", 100));
    expect(extendGrant(db, live, 60, 1000)).toBe(65_000);
    expect(extendGrant(db, dead, 60, 1000)).toBe(61_000);
    expect(listGrants(db).find((grant) => grant.id === live)?.expiresAt).toBe(65_000);
  });
  it("does nothing for forever, config or missing grants", () => {
    const db = fresh();
    const forever = upsertGrant(db, row("/f", null));
    const config = upsertGrant(db, { ...row("/c", 5000), source: "config" });
    expect(extendGrant(db, forever, 60, 1000)).toBeNull();
    expect(extendGrant(db, config, 60, 1000)).toBeNull();
    expect(extendGrant(db, 999, 60, 1000)).toBeNull();
    expect(listGrants(db).find((grant) => grant.id === config)?.expiresAt).toBe(5000);
  });
});

describe("approvals and blocked counts", () => {
  it("records, lists and prunes approvals", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-apr-")), "grants.db"));
    recordApproval(db, { ts: 10, agent: "cursor", path: "/p", command: null, access: "write", ttlSeconds: 900 });
    recordApproval(db, { ts: 50, agent: "cursor", path: null, command: "ls", access: "write", ttlSeconds: null });
    expect(listApprovals(db, 20)).toMatchObject([{ ts: 50, command: "ls", path: null, ttlSeconds: null }]);
    expect(listApprovals(db, 0)).toHaveLength(2);
    expect(pruneApprovals(db, 20)).toBe(1);
    expect(listApprovals(db, 0)).toHaveLength(1);
  });
  it("counts denied and timed out decisions", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-blk-")), "grants.db"));
    for (const [ts, verdict] of [[1, "deny"], [10, "deny"], [11, "timeout"], [12, "allow"]] as const) recordDecision(db, { ts, agent: "cursor", tool: "t", paths: [], verdict });
    expect(countBlocked(db, 5)).toBe(2);
  });
});

describe("autoAcceptMode and godMode", () => {
  it("stores, retrieves, and clears auto accept mode and god mode settings", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-god-")), "grants.db"));
    expect(getAutoAcceptMode(db)).toEqual({ until: 0, agent: "*" });
    setAutoAcceptMode(db, 100_000, "cursor");
    expect(getAutoAcceptMode(db)).toEqual({ until: 100_000, agent: "cursor" });
    clearAutoAcceptMode(db);
    expect(getAutoAcceptMode(db)).toEqual({ until: 0, agent: "*" });

    expect(getGodMode(db)).toEqual({ until: 0, agent: "*" });
    setGodMode(db, 100_000, "cursor");
    expect(getGodMode(db)).toEqual({ until: 100_000, agent: "cursor" });
    clearGodMode(db);
    expect(getGodMode(db)).toEqual({ until: 0, agent: "*" });
    db.close();
  });
});

describe("v0.11 secure_areas migration & monitor/warn rules", () => {
  it("migrates pre-v0.11 secure_areas CHECK constraints to allow monitor and warn while preserving rows", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "al-mig-sa-")), "grants.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE secure_areas (
        id INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        "group" TEXT NOT NULL,
        read_rule TEXT NOT NULL CHECK (read_rule IN ('allow','ask','block')),
        write_rule TEXT NOT NULL CHECK (write_rule IN ('allow','ask','block')),
        enabled INTEGER NOT NULL DEFAULT 1,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO settings (key, value) VALUES ('secure_areas_seed_v1', '1');
      INSERT INTO secure_areas (id, pattern, label, "group", read_rule, write_rule, enabled, builtin, created_at)
      VALUES (7, '~/custom-vault', 'Custom Vault', 'custom', 'ask', 'block', 1, 0, 12345);
    `);
    raw.close();

    // First open migrates table and preserves existing row
    let db = openGrantsDb(dbPath);
    const areas = listSecureAreas(db);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({
      id: 7,
      pattern: "~/custom-vault",
      label: "Custom Vault",
      readRule: "ask",
      writeRule: "block",
      createdAt: 12345,
    });

    // Can now update and insert monitor/warn rules
    const updated = updateSecureArea(db, 7, { readRule: "monitor", writeRule: "warn" });
    expect(updated).toMatchObject({ id: 7, readRule: "monitor", writeRule: "warn" });

    const added = upsertSecureArea(db, {
      pattern: "~/notes",
      label: "Notes",
      readRule: "warn",
      writeRule: "monitor",
    });
    expect(added).toMatchObject({ readRule: "warn", writeRule: "monitor" });
    db.close();

    // Re-opening is idempotent
    db = openGrantsDb(dbPath);
    expect(listSecureAreas(db)).toHaveLength(2);
    expect(listSecureAreas(db).find((a) => a.id === 7)).toMatchObject({ readRule: "monitor", writeRule: "warn" });
    db.close();
  });

  it("ranks and describes allow < monitor < warn < ask < block", () => {
    expect(RULE_RANK).toEqual({ allow: 1, monitor: 2, warn: 3, ask: 4, block: 5 });
    expect(describeRule("monitor", "read")).toContain("Monitor on read");
    expect(describeRule("warn", "write")).toContain("Warn on write");

    const home = "/Users/tester";
    const areas: SecureArea[] = [
      { id: 1, pattern: "~/docs", label: "docs-mon", group: "custom", readRule: "monitor", writeRule: "allow", enabled: true, builtin: false, createdAt: 0 },
      { id: 2, pattern: "~/docs", label: "docs-warn", group: "custom", readRule: "warn", writeRule: "allow", enabled: true, builtin: false, createdAt: 0 },
    ];
    expect(matchSecureArea(`${home}/docs/readme.md`, "read", home, areas)?.rule).toBe("warn");
  });
});

describe("findings CRUD", () => {
  it("records, lists newest-first with limit, and clears findings", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-find-")), "grants.db"));
    const f1 = recordFinding(db, {
      ts: 100,
      agent: "claude-code",
      sessionId: "s1",
      tool: "Read",
      target: "/proj/.env",
      ruleId: "openai-key",
      category: "secret",
      severity: "high",
      label: "OpenAI API Key",
      preview: "sk-p••••890",
      valueHash: "hash-1",
      action: "prompted",
    });
    const f2 = recordFinding(db, {
      ts: 300,
      agent: "cursor",
      sessionId: null,
      tool: "Bash",
      target: "curl https://example.com",
      ruleId: "ssn",
      category: "pii",
      severity: "medium",
      label: "US SSN",
      preview: "••••1234",
      valueHash: "hash-2",
      action: "warned",
    });
    const f3 = recordFinding(db, {
      ts: 200,
      agent: "codex",
      tool: "Write",
      target: "/proj/patient.txt",
      ruleId: "mrn",
      category: "phi",
      severity: "medium",
      label: "Medical Record Number",
      preview: "MRN••••99",
      valueHash: "hash-3",
      action: "monitored",
    });

    expect(f1.id).toBeGreaterThan(0);
    expect(f2.sessionId).toBeNull();
    expect(f3.ts).toBe(200);

    const all = listFindings(db);
    expect(all.map((r) => r.valueHash)).toEqual(["hash-2", "hash-3", "hash-1"]);
    expect(listFindings(db, 2).map((r) => r.valueHash)).toEqual(["hash-2", "hash-3"]);

    clearFindings(db);
    expect(listFindings(db)).toEqual([]);
    db.close();
  });
});

describe("value_exceptions CRUD", () => {
  it("adds, upserts on valueHash, lists, exposes hash set, and deletes", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-ex-")), "grants.db"));
    const first = addValueException(db, {
      valueHash: "abc123",
      preview: "sk-t••••xyz",
      label: "Test key",
      note: "fixture",
      createdAt: 1000,
    });
    expect(first).toMatchObject({ valueHash: "abc123", preview: "sk-t••••xyz", label: "Test key", note: "fixture", createdAt: 1000 });

    const upserted = addValueException(db, {
      valueHash: "abc123",
      preview: "sk-t••••xyz",
      label: "Updated test key",
      note: "updated note",
      createdAt: 2000,
    });
    expect(upserted.id).toBe(first.id);
    expect(upserted.label).toBe("Updated test key");
    expect(upserted.note).toBe("updated note");

    const second = addValueException(db, {
      valueHash: "def456",
      preview: "4111••••1111",
      label: "Test card",
      createdAt: 3000,
    });

    const list = listValueExceptions(db);
    expect(list.map((r) => r.valueHash)).toEqual(["def456", "abc123"]);
    expect(getValueExceptionHashes(db)).toEqual(new Set(["abc123", "def456"]));

    deleteValueException(db, second.id);
    expect(getValueExceptionHashes(db)).toEqual(new Set(["abc123"]));
    db.close();
  });
});

describe("trusted_egress_hosts & content_guard_settings", () => {
  it("provides default trusted hosts and normalizes/dedupes updates", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-hosts-")), "grants.db"));
    expect(getTrustedHosts(db)).toEqual([...DEFAULT_TRUSTED_EGRESS_HOSTS]);

    const saved = setTrustedHosts(db, ["  GitHub.com ", "api.example.com", "github.com", "", "  ", "LOCALHOST"]);
    expect(saved).toEqual(["github.com", "api.example.com", "localhost"]);
    expect(getTrustedHosts(db)).toEqual(["github.com", "api.example.com", "localhost"]);

    expect(setTrustedHosts(db, [])).toEqual([]);
    expect(getTrustedHosts(db)).toEqual([]);
    db.close();
  });

  it("provides default content guard settings and merges partial patches", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-cgs-")), "grants.db"));
    expect(getContentGuardSettings(db)).toEqual(DEFAULT_CONTENT_GUARD_SETTINGS);

    expect(setContentGuardSettings(db, { pii: "block", pipeToShell: false })).toEqual({
      secrets: "ask",
      pci: "ask",
      pii: "block",
      phi: "warn",
      pipeToShell: false,
    });
    expect(getContentGuardSettings(db)).toEqual({
      secrets: "ask",
      pci: "ask",
      pii: "block",
      phi: "warn",
      pipeToShell: false,
    });
    db.close();
  });
});

describe("listDeniedDecisions", () => {
  it("returns only deny and timeout decisions ordered newest-first", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-den-")), "grants.db"));
    recordDecision(db, { ts: 10, agent: "cursor", tool: "Read", paths: ["/a"], verdict: "deny", reason: "Blocked" });
    recordDecision(db, { ts: 20, agent: "cursor", tool: "Read", paths: ["/b"], verdict: "pass" });
    recordDecision(db, { ts: 30, agent: "cursor", tool: "Bash", paths: [], verdict: "timeout", reason: "Timed out", command: "curl x" });
    recordDecision(db, { ts: 30, agent: "cursor", tool: "Write", paths: ["/c"], verdict: "deny", reason: "Denied" });

    const denied = listDeniedDecisions(db);
    expect(denied.map((d) => [d.ts, d.verdict, d.reason])).toEqual([
      [30, "deny", "Denied"],
      [30, "timeout", "Timed out"],
      [10, "deny", "Blocked"],
    ]);
    expect(listDeniedDecisions(db, 2)).toHaveLength(2);
    db.close();
  });
});

describe("readSecretSince cross-session isolation", () => {
  it("isolates secret_touches, decisions, and historyDb from other sessions when sessionId is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "al-rs-"));
    const db = openGrantsDb(join(dir, "grants.db"));
    const historyDb = openHistoryDb(join(dir, "history.db"));

    // Session s1 touches a secret, plus a null-session touch and a history.db sensitive event
    recordSecretTouch(db, { agent: "claude-code", sessionId: "s1", ts: 10_000 });
    recordSecretTouch(db, { agent: "claude-code", ts: 10_500 });
    recordDecision(db, { ts: 11_000, agent: "claude-code", tool: "Read", paths: ["/tmp/.env"], verdict: "pass", sessionId: "s1", secret: true });
    insertEvents(historyDb, [
      {
        ts: 12_000,
        agent: "claude-code",
        pid: 1,
        exe: "Read",
        kind: "read",
        path: "/Users/v/.ssh/id_rsa",
        destPath: null,
        sensitive: true,
        source: "hook",
      },
    ]);

    // Session s1 sees its own secret read
    expect(readSecretSince(db, "claude-code", "s1", 5_000, historyDb)).toBe(true);
    // Session s2 MUST NOT bleed from s1, null-session touches, or unscoped history.db
    expect(readSecretSince(db, "claude-code", "s2", 5_000, historyDb)).toBe(false);
    // Undefined sessionId (legacy/unscoped) still checks all touches/decisions/historyDb
    expect(readSecretSince(db, "claude-code", undefined, 5_000, historyDb)).toBe(true);
    expect(readSecretSince(db, "claude-code", undefined, 15_000, historyDb)).toBe(false);

    // When only historyDb has a sensitive event: scoped session returns false, unscoped returns true
    const db2 = openGrantsDb(join(dir, "grants2.db"));
    expect(readSecretSince(db2, "claude-code", "s-fresh", 5_000, historyDb)).toBe(false);
    expect(readSecretSince(db2, "claude-code", undefined, 5_000, historyDb)).toBe(true);

    historyDb.close();
    db2.close();
    db.close();
  });
});

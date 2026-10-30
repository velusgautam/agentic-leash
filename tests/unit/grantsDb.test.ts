import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  clearGodMode,
  collapseGrantDupes,
  createRule,
  countBlocked,
  deleteRule,
  extendGrant,
  getGodMode,
  listApprovals,
  listDecisions,
  listGrants,
  openGrantsDb,
  pruneApprovals,
  recordApproval,
  recordDecision,
  setGodMode,
  updateRule,
  upsertCommandGrant,
  upsertGrant,
} from "../../src/shared/db";

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

describe("godMode", () => {
  it("stores, retrieves, and clears god mode settings", () => {
    const db = openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-god-")), "grants.db"));
    expect(getGodMode(db)).toEqual({ until: 0, agent: "*" });
    setGodMode(db, 100_000, "cursor");
    expect(getGodMode(db)).toEqual({ until: 100_000, agent: "cursor" });
    clearGodMode(db);
    expect(getGodMode(db)).toEqual({ until: 0, agent: "*" });
    db.close();
  });
});

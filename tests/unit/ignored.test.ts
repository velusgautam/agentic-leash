import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { insertEvents, openHistoryDb, queryHistory } from "../../src/helper/historyDb";
import { appliedIgnoredKey, dropIgnored, ignoredKey } from "../../src/helper/historyDb";
import { openGrantsDb } from "../../src/shared/db";
import { addIgnored, deleteIgnored, enabledIgnoredPrefixes, ignoredCategory, listIgnored, matchesIgnored, setIgnoredEnabled, updateIgnored } from "../../src/shared/ignored";
import { eventBucket } from "../../src/shared/noise";

const home = "/Users/me";
const ignored = [
  `${home}/.cursor/acp-sessions/a/store.db-wal`,
  `${home}/.cursor/chats/a/store.db-shm`,
  `${home}/.cursor/plugins/cache/cursor-public/superpowers/hooks/session-start`,
  `${home}/.cursor/skills-cursor/a/SKILL.md`,
  `${home}/.cursor/extensions/ms-python/package.json`,
  `${home}/.agentic-leash/grants.db-wal`,
  "/Applications/Agentic Leash.app/Contents/MacOS/Agentic Leash",
  "/Volumes/Agentic Leash 3/Agentic Leash.app/Contents/Info.plist",
  "/usr/bin/grep",
  "/bin/cat",
  `${home}/Library/Application Support/Claude/GPUCache/data_0`,
  `${home}/Library/Application Support/Claude/Cache/data_0`,
  `${home}/Library/Application Support/Claude/Code Cache/js`,
  `${home}/Library/Application Support/Claude/DIPS-wal`,
  `${home}/Library/Application Support/Claude/Cookies-journal`,
  `${home}/Library/Application Scripts/com.apple.Safari/x`,
  `${home}/Library/Containers/com.apple.Safari/Data`,
  "/Applications/Claude.app/Contents/MacOS/Claude",
  `${home}/.gemini/antigravity-cli/cache/onboarding.json`,
  `${home}/.gemini/antigravity-cli/log/cli-20261026.log`,
  `${home}/.gemini/antigravity-cli/crashes/dump.dmp`,
  `${home}/.gemini/antigravity-cli/brain/session/transcript.jsonl`,
  "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
  "/opt/homebrew/var/homebrew/tmp/x",
  "/opt/homebrew/share/man/man1/git.1",
];

const kept = [
  `${home}/Work/studio/src/index.ts`,
  `${home}/Library/Application Support/Claude/local-agent-mode-sessions/a`,
  `${home}/Library/Application Support/Claude/claude-code/sessions`,
  "/opt/homebrew/Cellar/git/bin/git",
  "/Volumes/Other/file",
  "/usr/local/bin/node",
];

function db() {
  return openGrantsDb(join(mkdtempSync(join(tmpdir(), "al-ignored-")), "grants.db"));
}

describe("matchesIgnored", () => {
  it("matches the scanned prefixes and leaves project files", () => {
    const grants = db();
    const prefixes = enabledIgnoredPrefixes(grants);
    for (const path of ignored) expect(prefixes.some((prefix) => matchesIgnored(path, prefix)), path).toBe(true);
    for (const path of kept) expect(prefixes.some((prefix) => matchesIgnored(path, prefix)), path).toBe(false);
    expect(matchesIgnored("/usr/bin/grep", "/bin")).toBe(false);
    expect(matchesIgnored(`${home}/Library/Application Support/Claude/Code Cache/js`, "/Library/Application Support/Claude/Cache")).toBe(false);
    expect(matchesIgnored("/Users/velugautam/.gemini/antigravity-cli/log/cli-20261026_115755.log", "/Users/velugautam/.gemini/")).toBe(true);
    expect(matchesIgnored("/Users/velugautam/.gemini/antigravity-cli/log/cli-20261026_115755.log", "/Users/velugautam/.gemini")).toBe(true);
    grants.close();
  });
});

describe("eventBucket", () => {
  it("drops an ignored write instead of filing it as noise", () => {
    const grants = db();
    const prefixes = enabledIgnoredPrefixes(grants);
    expect(eventBucket({ kind: "write", path: `${home}/.cursor/chats/a/store.db-wal` }, prefixes)).toBe("drop");
    expect(eventBucket({ kind: "write", path: `${home}/Work/studio/src/index.ts` }, prefixes)).toBe("main");
    expect(eventBucket({ kind: "net", path: "10.0.0.1:443" }, prefixes)).toBe("main");
    grants.close();
  });
});

describe("ignored rows", () => {
  it("classifies built-in paths and user additions", () => {
    expect(ignoredCategory("/.cursor/chats", true)).toBe("Cursor");
    expect(ignoredCategory("/Library/Application Support/Claude/Cache", true)).toBe("Claude");
    expect(ignoredCategory("/.gemini/antigravity-cli/cache", true)).toBe("Antigravity");
    expect(ignoredCategory("/Applications/Antigravity.app", true)).toBe("Antigravity");
    expect(ignoredCategory("/Applications/Agentic Leash.app", true)).toBe("Agentic Leash");
    expect(ignoredCategory("/usr/bin", true)).toBe("System");
    expect(ignoredCategory("/opt/homebrew/var", true)).toBe("Homebrew");
    expect(ignoredCategory("/.cursor/custom", false)).toBe("User added");
  });

  it("seeds builtins, lets them be unchecked, and deletes only added rows", () => {
    const grants = db();
    const seeded = listIgnored(grants);
    expect(seeded.length).toBeGreaterThan(10);
    expect(seeded.every((row) => row.builtin && row.enabled)).toBe(true);
    const bin = seeded.find((row) => row.prefix === "/bin");
    expect(bin).toBeTruthy();
    setIgnoredEnabled(grants, bin!.id, false);
    expect(enabledIgnoredPrefixes(grants)).not.toContain("/bin");
    expect(enabledIgnoredPrefixes(grants)).toContain("/usr/bin");
    expect(deleteIgnored(grants, bin!.id)).toBe(false);
    expect(listIgnored(grants).some((row) => row.id === bin!.id)).toBe(true);
    expect(addIgnored(grants, "relative")).toBeNull();
    expect(addIgnored(grants, "/")).toBeNull();
    const beforeAdd = Date.now();
    const added = addIgnored(grants, "/tmp/scratch");
    expect(added?.builtin).toBe(false);
    expect(added?.category).toBe("User added");
    expect(added?.createdAt).toBeGreaterThanOrEqual(beforeAdd);
    expect(enabledIgnoredPrefixes(grants)).toContain("/tmp/scratch");
    expect(deleteIgnored(grants, added!.id)).toBe(true);
    expect(listIgnored(grants).some((row) => row.prefix === "/tmp/scratch")).toBe(false);
    listIgnored(grants);
    expect(listIgnored(grants).filter((row) => row.prefix === "/usr/bin")).toHaveLength(1);
    grants.close();
  });

  it("sorts user added paths by latest date added first", () => {
    const grants = db();
    addIgnored(grants, "/tmp/older");
    // Manually tweak createdAt to simulate time differences
    grants.prepare("UPDATE ignored_noise SET created_at = 1000 WHERE prefix = '/tmp/older'").run();
    addIgnored(grants, "/tmp/newer");
    grants.prepare("UPDATE ignored_noise SET created_at = 2000 WHERE prefix = '/tmp/newer'").run();
    addIgnored(grants, "/tmp/newest");
    grants.prepare("UPDATE ignored_noise SET created_at = 3000 WHERE prefix = '/tmp/newest'").run();

    const list = listIgnored(grants);
    const userAdded = list.filter((row) => !row.builtin);
    expect(userAdded.map((row) => row.prefix)).toEqual(["/tmp/newest", "/tmp/newer", "/tmp/older"]);
    grants.close();
  });

  it("updates user added paths and prevents modifying builtins", () => {
    const grants = db();
    const added = addIgnored(grants, "/tmp/original");
    expect(added).not.toBeNull();
    const updated = updateIgnored(grants, added!.id, "/tmp/modified/");
    expect(updated).not.toBeNull();
    expect(updated?.prefix).toBe("/tmp/modified");
    expect(listIgnored(grants).some((row) => row.prefix === "/tmp/modified")).toBe(true);
    expect(listIgnored(grants).some((row) => row.prefix === "/tmp/original")).toBe(false);

    // Cannot modify builtins
    const bin = listIgnored(grants).find((row) => row.prefix === "/bin")!;
    expect(updateIgnored(grants, bin.id, "/tmp/newbin")).toBeNull();
    grants.close();
  });
});

describe("dropIgnored", () => {
  it("removes matching rows from main history and noise", () => {
    const history = openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db"));
    const row = { ts: 1, agent: "cursor" as const, pid: 1, exe: "cursor", sensitive: false, source: "eslogger" as const };
    insertEvents(history, [
      { ...row, kind: "write", path: `${home}/.cursor/chats/a/store.db` },
      { ...row, ts: 2, kind: "read", path: `${home}/Work/studio/src/index.ts` },
      { ...row, ts: 3, kind: "write", path: "/tmp/payload" },
    ]);
    dropIgnored(history, ["/.cursor/chats", "/tmp/payload"]);
    expect(queryHistory(history, { from: null, to: null, agents: [], path: "", kind: "all", sensitive: false, includeNoise: true, offset: 0, limit: 20 }).rows.map((item) => item.path)).toEqual([
      `${home}/Work/studio/src/index.ts`,
    ]);
    history.close();
  });

  it("removes matching rows even when prefix has a trailing slash", () => {
    const history = openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db"));
    const row = { ts: 1, agent: "cursor" as const, pid: 1, exe: "cursor", sensitive: false, source: "eslogger" as const };
    insertEvents(history, [
      { ...row, kind: "write", path: "/Users/velugautam/.gemini/antigravity-cli/log/cli-20261026_115755.log" },
      { ...row, ts: 2, kind: "read", path: "/Users/velugautam/Work/studio/src/index.ts" },
    ]);
    dropIgnored(history, ["/Users/velugautam/.gemini/"]);
    expect(queryHistory(history, { from: null, to: null, agents: [], path: "", kind: "all", sensitive: false, includeNoise: true, offset: 0, limit: 20 }).rows.map((item) => item.path)).toEqual([
      "/Users/velugautam/Work/studio/src/index.ts",
    ]);
    history.close();
  });

  it("matches renames by destination and handles more prefixes than one statement holds", () => {
    const history = openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db"));
    const row = { ts: 1, agent: "cursor" as const, pid: 1, exe: "cursor", sensitive: false, source: "eslogger" as const };
    insertEvents(history, [
      { ...row, kind: "rename", path: `${home}/Work/a.ts`, destPath: "/tmp/first/a.ts" },
      { ...row, ts: 2, kind: "write", path: "/tmp/p70/x.ts" },
      { ...row, ts: 3, kind: "write", path: `${home}/Work/keep.ts` },
    ]);
    const prefixes = ["/tmp/first", ...Array.from({ length: 70 }, (_, index) => `/tmp/p${index + 1}`)];
    dropIgnored(history, prefixes);
    expect(queryHistory(history, { from: null, to: null, agents: [], path: "", kind: "all", sensitive: false, includeNoise: true, offset: 0, limit: 20 }).rows.map((item) => item.path)).toEqual([
      `${home}/Work/keep.ts`,
    ]);
    history.close();
  });

  it("remembers which ignore list it last applied across restarts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db");
    const history = openHistoryDb(path);
    expect(appliedIgnoredKey(history)).toBe("");
    dropIgnored(history, ["/.cursor/chats", "/tmp/payload"]);
    history.close();
    const reopened = openHistoryDb(path);
    expect(appliedIgnoredKey(reopened)).toBe(ignoredKey(["/.cursor/chats", "/tmp/payload"]));
    reopened.close();
  });

  it("records an empty ignore list without touching rows", () => {
    const history = openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db"));
    dropIgnored(history, []);
    expect(appliedIgnoredKey(history)).toBe(ignoredKey([]));
    history.close();
  });

  it("frees the blobs of dropped rows but keeps shared ones", () => {
    const history = openHistoryDb(join(mkdtempSync(join(tmpdir(), "al-ignored-hist-")), "history.db"));
    const row = { ts: 1, agent: "cursor" as const, pid: 1, exe: "cursor", sensitive: false, source: "eslogger" as const };
    insertEvents(history, [
      { ...row, kind: "write", path: `${home}/Work/other/b.ts`, beforeBlob: "gone before", afterBlob: "shared" },
      { ...row, ts: 2, kind: "write", path: `${home}/Work/studio/a.ts`, beforeBlob: "kept before", afterBlob: "shared" },
    ]);
    dropIgnored(history, [`${home}/Work/other`]);
    expect((history.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n).toBe(2);
    dropIgnored(history, [`${home}/Work/studio`]);
    expect((history.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n).toBe(0);
    history.close();
  });
});

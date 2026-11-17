import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../../src/helper/classify";
import {
  collapseRecursiveReads,
  historyText,
  insertEvents,
  listHistory,
  openHistoryDb,
  pruneHistory,
  queryHistory,
} from "../../src/helper/historyDb";
import { ProcTree } from "../../src/helper/proctree";
import { readVerboseCapture } from "../../src/helper/leash-helper";
import { collapseRecursiveReads as collapseFromTracker } from "../../src/helper/tracker";
import { grantsDbPath } from "../../src/shared/constants";
import { openGrantsDb, setSetting } from "../../src/shared/db";
import { BUILTIN_IGNORED, matchesIgnored } from "../../src/shared/ignored";
import { eventBucket, isJunk, isNoise } from "../../src/shared/noise";
import {
  MAIN_RETENTION_DAYS,
  NOISE_RETENTION_DAYS,
  ORDINARY_RETENTION_DAYS,
  SENSITIVE_RETENTION_DAYS,
} from "../../src/shared/retention";
import { CAP_DEFAULT_BYTES, capBytes, formatCap } from "../../src/shared/storage";
import type { HistoryEvent } from "../../src/shared/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const home = "/Users/alice";

function makeEvent(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    ts: 1_700_000_000_000,
    agent: "claude-code",
    pid: 100,
    exe: "/usr/local/bin/claude",
    kind: "read",
    path: `${home}/project/src/index.ts`,
    destPath: null,
    sensitive: false,
    source: "eslogger",
    ...over,
  };
}

describe("WP4 History & Live noise reduction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-wp4-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("1. Built-in hidden paths & noise buckets", () => {
    it("drops build outputs, system paths, diagnostics, SQLite side-files, .CFUserTextEncoding, and keychain temp files", () => {
      const noisyReads = [
        `${home}/project/.build/arm64-apple-macosx/debug/App`,
        `${home}/project/dist/bundle.js`,
        `${home}/project/out/main.js`,
        `${home}/project/build/output.o`,
        `${home}/Library/Developer/Xcode/DerivedData/MyApp-abc/Build/Products/Debug/MyApp`,
        `${home}/.pnpm-store/v3/files/00/abcd`,
        `${home}/project/.git/objects/ab/cdef1234`,
        "/private/var/db/diagnostics/Persist/00001.tracev3",
        "/private/var/folders/ab/cdef/T/tmp.txt",
        "/dev/null",
        "/usr/lib/libSystem.B.dylib",
        "/usr/local/bin/node",
        "/System/Library/Frameworks/Foundation.framework/Foundation",
        "/opt/homebrew/Cellar/git/2.40.0/bin/git",
        "/Library/Preferences/com.apple.HIToolbox.plist",
        "/Applications/Safari.app/Contents/MacOS/Safari",
        `${home}/.CFUserTextEncoding`,
        `${home}/project/state.db-wal`,
        `${home}/project/state.db-shm`,
        `${home}/project/state.db-journal`,
        `${home}/Library/Keychains/login.keychain-db.sb-f02087bb-Kl74Qf`,
        `${home}/Library/Keychains/.fl6C12A3`,
      ];

      for (const path of noisyReads) {
        expect(eventBucket({ kind: "read", path, source: "eslogger" }), path).toBe("drop");
      }

      // Built-in ignored prefixes match build outputs, diagnostics, root system dirs, and .CFUserTextEncoding
      for (const path of [
        `${home}/project/.build/debug/a`,
        `${home}/project/dist/index.js`,
        `${home}/project/out/a.js`,
        `${home}/project/build/a.o`,
        `${home}/Library/Developer/Xcode/DerivedData/Foo/a`,
        "/private/var/db/diagnostics/a",
        "/dev/tty",
        "/System/Library/foo",
        "/Library/Preferences/foo",
        "/Applications/Foo.app",
        `${home}/.CFUserTextEncoding`,
      ]) {
        expect(BUILTIN_IGNORED.some((prefix) => matchesIgnored(path, prefix)), path).toBe(true);
      }

      // Keeps real user paths and doesn't confuse ~/dev or ~/Library with root /dev or /Library
      expect(BUILTIN_IGNORED.some((prefix) => matchesIgnored(`${home}/dev/my-app/src/index.ts`, prefix))).toBe(false);
      expect(isNoise(`${home}/project/src/index.ts`)).toBe(false);
      expect(isJunk(`${home}/project/state.db-wal`)).toBe(true);
      expect(isJunk(`${home}/project/state.db-shm`)).toBe(true);
      expect(isJunk(`${home}/project/state.db-journal`)).toBe(true);
      expect(isJunk(`${home}/.CFUserTextEncoding`)).toBe(true);
    });
  });

  describe("2. Drop non-sensitive raw ES reads unless verboseCapture is true", () => {
    it("drops non-sensitive raw eslogger reads when verboseCapture is false, keeping hooks, writes, net, sensitive reads, and summaries", () => {
      const db = openHistoryDb(join(dir, "history.db"));
      const events: HistoryEvent[] = [
        makeEvent({ ts: 1000, kind: "read", source: "eslogger", sensitive: false, path: `${home}/project/src/a.ts` }),
        makeEvent({ ts: 2000, kind: "read", source: "eslogger", sensitive: true, path: `${home}/.ssh/id_ed25519` }),
        makeEvent({ ts: 3000, kind: "read", source: "hook", exe: "Read", sensitive: false, path: `${home}/project/src/b.ts` }),
        makeEvent({ ts: 4000, kind: "write", source: "eslogger", sensitive: false, path: `${home}/project/src/c.ts` }),
        makeEvent({ ts: 5000, kind: "net", source: "net", sensitive: false, path: "1.2.3.4:443" }),
        makeEvent({ ts: 6000, kind: "read", source: "eslogger", sensitive: false, path: `${home}/project/src (60 files read)` }),
      ];

      insertEvents(db, events, [], { verboseCapture: false });
      const rows = queryHistory(db, {
        from: null,
        to: null,
        agents: [],
        path: "",
        kind: "all",
        sensitive: false,
        includeNoise: true,
        offset: 0,
        limit: 50,
      }).rows;

      expect(rows.map((r) => r.path).sort()).toEqual([
        `${home}/.ssh/id_ed25519`,
        `${home}/project/src (60 files read)`,
        `${home}/project/src/b.ts`,
        `${home}/project/src/c.ts`,
        "1.2.3.4:443",
      ]);
      db.close();
    });

    it("retains non-sensitive raw eslogger reads when verboseCapture is true", () => {
      const db = openHistoryDb(join(dir, "history.db"));
      insertEvents(
        db,
        [makeEvent({ ts: 1000, kind: "read", source: "eslogger", sensitive: false, path: `${home}/project/src/a.ts` })],
        [],
        { verboseCapture: true },
      );
      expect(listHistory(db).map((r) => r.path)).toEqual([`${home}/project/src/a.ts`]);
      db.close();
    });

    it("reads verbose_capture setting from grants.db defaulting to false", () => {
      const fakeHome = join(dir, "home");
      expect(readVerboseCapture(fakeHome, false)).toBe(false);
      expect(readVerboseCapture(fakeHome, true)).toBe(true);

      const gDb = openGrantsDb(grantsDbPath(fakeHome));
      expect(readVerboseCapture(fakeHome, false)).toBe(false);
      setSetting(gDb, "verbose_capture", "1");
      expect(readVerboseCapture(fakeHome, false)).toBe(true);
      setSetting(gDb, "verbose_capture", "0");
      expect(readVerboseCapture(fakeHome, true)).toBe(false);
      gDb.close();
    });
  });

  describe("3. Merge duplicate writes (hook + eslogger within 2000 ms)", () => {
    it("merges hook and eslogger writes in the same batch while keeping hook exe and eslogger blobs", () => {
      const db = openHistoryDb(join(dir, "history.db"));
      const file = `${home}/project/src/app.ts`;

      insertEvents(db, [
        makeEvent({ ts: 10_000, agent: "claude-code", exe: "Edit", kind: "write", path: file, source: "hook" }),
        makeEvent({
          ts: 10_500,
          agent: "claude" as HistoryEvent["agent"],
          exe: "/usr/local/bin/claude",
          kind: "write",
          path: file,
          source: "eslogger",
          beforeBlob: "const a = 1;",
          afterBlob: "const a = 2;",
        }),
      ]);

      const rows = listHistory(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.exe).toBe("Edit");
      expect(rows[0]!.path).toBe(file);
      expect(historyText(db, rows[0]!.id)).toEqual({ before: "const a = 1;", after: "const a = 2;" });
      db.close();
    });

    it("merges hook and eslogger writes across separate insertEvents calls in either arrival order", () => {
      const db = openHistoryDb(join(dir, "history.db"));
      const file1 = `${home}/project/src/first.ts`;
      const file2 = `${home}/project/src/second.ts`;

      // Order 1: hook first, then eslogger within 2000 ms
      insertEvents(db, [makeEvent({ ts: 20_000, agent: "cursor", exe: "Write", kind: "write", path: file1, source: "hook" })]);
      insertEvents(db, [
        makeEvent({
          ts: 21_200,
          agent: "cursor-agent" as HistoryEvent["agent"],
          exe: "/usr/local/bin/cursor",
          kind: "write",
          path: file1,
          source: "eslogger",
          beforeBlob: "old-1",
          afterBlob: "new-1",
        }),
      ]);

      // Order 2: eslogger first, then hook within 2000 ms
      insertEvents(db, [
        makeEvent({
          ts: 30_000,
          agent: "codex",
          exe: "/usr/local/bin/codex",
          kind: "write",
          path: file2,
          source: "eslogger",
          beforeBlob: "old-2",
          afterBlob: "new-2",
        }),
      ]);
      insertEvents(db, [makeEvent({ ts: 31_800, agent: "codex", exe: "apply_patch", kind: "write", path: file2, source: "hook" })]);

      // Outside 2000 ms window should NOT merge
      const file3 = `${home}/project/src/separate.ts`;
      insertEvents(db, [makeEvent({ ts: 40_000, agent: "codex", exe: "Edit", kind: "write", path: file3, source: "hook" })]);
      insertEvents(db, [makeEvent({ ts: 42_500, agent: "codex", exe: "/usr/local/bin/codex", kind: "write", path: file3, source: "eslogger", afterBlob: "v2" })]);

      const rows = listHistory(db);
      expect(rows).toHaveLength(4);

      const r1 = rows.find((r) => r.path === file1)!;
      expect(r1.exe).toBe("Write");
      expect(historyText(db, r1.id)).toEqual({ before: "old-1", after: "new-1" });

      const r2 = rows.find((r) => r.path === file2)!;
      expect(r2.exe).toBe("apply_patch");
      expect(historyText(db, r2.id)).toEqual({ before: "old-2", after: "new-2" });

      expect(rows.filter((r) => r.path === file3)).toHaveLength(2);
      db.close();
    });
  });

  describe("4. Keychain token refreshes & .sb-* temp files", () => {
    it("classifies /usr/bin/security keychain touches as non-sensitive and keeps non-security keychain reads sensitive", () => {
      const tree = new ProcTree();
      tree.apply({
        process: { audit_token: { pid: 500 }, executable: { path: "/usr/local/bin/claude" } },
      });
      tree.apply({
        process: { audit_token: { pid: 501 }, ppid: 500, executable: { path: "/usr/bin/security" } },
        event: { exec: { target: { audit_token: { pid: 501 }, ppid: 500, executable: { path: "/usr/bin/security" } } } },
      });
      tree.apply({
        process: { audit_token: { pid: 502 }, ppid: 500, executable: { path: "/bin/cat" } },
        event: { exec: { target: { audit_token: { pid: 502 }, ppid: 500, executable: { path: "/bin/cat" } } } },
      });

      const securityRead = classify(
        {
          time: "2026-11-16T10:00:00.000Z",
          process: { audit_token: { pid: 501 }, executable: { path: "/usr/bin/security" } },
          event: { open: { file: { path: `${home}/Library/Keychains/login.keychain-db` }, fflag: 1 } },
        },
        tree,
        home,
      );
      expect(securityRead).not.toBeNull();
      expect(securityRead!.sensitive).toBe(false);

      const securityLock = classify(
        {
          time: "2026-11-16T10:00:01.000Z",
          process: { audit_token: { pid: 501 }, executable: { path: "/usr/bin/security" } },
          event: { open: { file: { path: `${home}/Library/Keychains/.fl6C12A3` }, fflag: 1 } },
        },
        tree,
        home,
      );
      expect(securityLock).not.toBeNull();
      expect(securityLock!.sensitive).toBe(false);

      const catRead = classify(
        {
          time: "2026-11-16T10:00:02.000Z",
          process: { audit_token: { pid: 502 }, executable: { path: "/bin/cat" } },
          event: { open: { file: { path: `${home}/Library/Keychains/login.keychain-db` }, fflag: 1 } },
        },
        tree,
        home,
      );
      expect(catRead).not.toBeNull();
      expect(catRead!.sensitive).toBe(true);
    });

    it("collapses 183 daily /usr/bin/security keychain refreshes into 1 quiet row per day and drops .sb-* temp files", () => {
      const db = openHistoryDb(join(dir, "history.db"));
      const day1 = 20_000 * DAY_MS;
      const day2 = 20_001 * DAY_MS;
      const batch: HistoryEvent[] = [];

      for (let i = 0; i < 183; i += 1) {
        batch.push(
          makeEvent({
            ts: day1 + i * 1000,
            agent: "antigravity",
            pid: 600 + i,
            exe: "/usr/bin/security",
            kind: i % 2 === 0 ? "read" : "write",
            path: i % 3 === 0 ? `${home}/Library/Keychains/.fl1234` : `${home}/Library/Keychains/login.keychain-db`,
            sensitive: false,
            source: "eslogger",
          }),
        );
        batch.push(
          makeEvent({
            ts: day1 + i * 1000,
            agent: "antigravity",
            pid: 600 + i,
            exe: "/usr/bin/security",
            kind: "rename",
            path: `${home}/Library/Keychains/login.keychain-db.sb-f02087bb-AbCd${i}`,
            destPath: `${home}/Library/Keychains/login.keychain-db`,
            sensitive: false,
            source: "eslogger",
          }),
        );
      }

      // Next day gets 1 row for that day
      batch.push(
        makeEvent({
          ts: day2 + 500,
          agent: "antigravity",
          pid: 900,
          exe: "/usr/bin/security",
          kind: "read",
          path: `${home}/Library/Keychains/login.keychain-db`,
          sensitive: false,
          source: "eslogger",
        }),
      );

      insertEvents(db, batch, [], { verboseCapture: false });
      const rows = queryHistory(db, {
        from: null,
        to: null,
        agents: [],
        path: "",
        kind: "all",
        sensitive: false,
        includeNoise: true,
        offset: 0,
        limit: 50,
      }).rows;

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sensitive === false)).toBe(true);
      expect(rows.every((r) => r.exe === "/usr/bin/security")).toBe(true);
      db.close();
    });
  });

  describe("5. Collapse recursive command bursts", () => {
    it("exports collapseRecursiveReads from both historyDb and tracker, collapsing >50 reads while preserving sensitive files", () => {
      expect(collapseFromTracker).toBe(collapseRecursiveReads);

      const batch: HistoryEvent[] = [];
      for (let i = 0; i < 65; i += 1) {
        batch.push(
          makeEvent({
            ts: 1_000 + i,
            agent: "claude-code",
            pid: 777,
            exe: "/usr/bin/grep",
            kind: "read",
            path: `${home}/project/src/mod-${i % 3}/file-${i}.ts`,
            sensitive: false,
            source: "eslogger",
          }),
        );
      }
      // Mix in sensitive files read by the same process
      batch.push(
        makeEvent({
          ts: 1_100,
          agent: "claude-code",
          pid: 777,
          exe: "/usr/bin/grep",
          kind: "read",
          path: `${home}/project/.env`,
          sensitive: true,
          source: "eslogger",
        }),
      );
      // A different pid with <= 50 reads should NOT collapse
      for (let i = 0; i < 10; i += 1) {
        batch.push(
          makeEvent({
            ts: 2_000 + i,
            agent: "claude-code",
            pid: 888,
            exe: "/bin/cat",
            kind: "read",
            path: `${home}/project/docs/${i}.md`,
            sensitive: false,
            source: "eslogger",
          }),
        );
      }

      const collapsed = collapseRecursiveReads(batch, 50);
      expect(collapsed).toHaveLength(12); // 1 summary + 1 sensitive + 10 from pid 888
      expect(collapsed[0]!.path).toBe(`${home}/project/src (65 files read)`);
      expect(collapsed[0]!.sensitive).toBe(false);
      expect(collapsed[1]!.path).toBe(`${home}/project/.env`);
      expect(collapsed[1]!.sensitive).toBe(true);

      // Verify insertEvents stores the summary and sensitive file in events while dropping the 10 raw ES reads
      const db = openHistoryDb(join(dir, "history.db"));
      insertEvents(db, batch, [], { verboseCapture: false });
      const rows = listHistory(db);
      expect(rows.map((r) => r.path).sort()).toEqual([
        `${home}/project/.env`,
        `${home}/project/src (65 files read)`,
      ]);
      db.close();
    });

    it("does not collapse when count equals threshold (50)", () => {
      const exact50 = Array.from({ length: 50 }, (_, i) =>
        makeEvent({ ts: 1000 + i, pid: 123, exe: "/usr/bin/find", path: `${home}/project/f-${i}.ts` }),
      );
      expect(collapseRecursiveReads(exact50, 50)).toHaveLength(50);
    });
  });

  describe("6. Tiered retention & 500 MB default cap", () => {
    it("retains sensitive events for 90 days, ordinary events for 14 days, and uses 500 MB default cap", () => {
      expect(SENSITIVE_RETENTION_DAYS).toBe(90);
      expect(MAIN_RETENTION_DAYS).toBe(90);
      expect(ORDINARY_RETENTION_DAYS).toBe(14);
      expect(NOISE_RETENTION_DAYS).toBe(14);
      expect(CAP_DEFAULT_BYTES).toBe(500 * 1024 * 1024);
      expect(capBytes("")).toBe(500 * 1024 * 1024);
      expect(formatCap(capBytes(""))).toBe("500 MB");

      const db = openHistoryDb(join(dir, "history.db"));
      const now = 200 * DAY_MS;
      insertEvents(db, [
        makeEvent({ ts: now - 95 * DAY_MS, kind: "read", sensitive: true, path: `${home}/.ssh/old_key` }),
        makeEvent({ ts: now - 60 * DAY_MS, kind: "read", sensitive: true, path: `${home}/.ssh/kept_key` }),
        makeEvent({ ts: now - 20 * DAY_MS, kind: "write", sensitive: false, path: `${home}/project/old.ts` }),
        makeEvent({ ts: now - 10 * DAY_MS, kind: "write", sensitive: false, path: `${home}/project/new.ts` }),
        makeEvent({ ts: now - 20 * DAY_MS, kind: "write", sensitive: false, path: "/tmp/old-noise" }),
        makeEvent({ ts: now - 5 * DAY_MS, kind: "write", sensitive: false, path: "/tmp/new-noise" }),
      ]);

      pruneHistory(db, now);
      const rows = queryHistory(db, {
        from: null,
        to: null,
        agents: [],
        path: "",
        kind: "all",
        sensitive: false,
        includeNoise: true,
        offset: 0,
        limit: 50,
      }).rows;

      expect(rows.map((r) => r.path).sort()).toEqual([
        `${home}/.ssh/kept_key`,
        `${home}/project/new.ts`,
        "/tmp/new-noise",
      ]);
      db.close();
    });
  });
});

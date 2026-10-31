import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHistory, openHistoryDb } from "../../src/helper/historyDb";
import { handlePayload } from "../../src/hook/handle";
import { openGrantsDb, setGodMode, upsertGrant } from "../../src/shared/db";
import type { DatabaseSync } from "node:sqlite";

describe("hook history integration", () => {
  let dir: string;
  let grantsDb: DatabaseSync;
  let historyDb: DatabaseSync;
  let historyPath: string;
  const home = "/Users/testuser";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-hookhist-"));
    grantsDb = openGrantsDb(join(dir, "grants.db"));
    historyPath = join(dir, "history.db");
    historyDb = openHistoryDb(historyPath);
  });

  afterEach(() => {
    try {
      grantsDb.close();
      historyDb.close();
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
  });

  it("records allowed file read into history.db with source: hook", async () => {
    const filePath = "/Users/testuser/project/src/index.ts";
    upsertGrant(grantsDb, {
      agent: "claude-code",
      path: "/Users/testuser/project",
      access: "read",
      source: "leash",
      createdAt: Date.now(),
      expiresAt: null,
    });

    const now = Date.now();
    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: filePath },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now,
      home,
      ask: async () => "deny",
    });

    expect(result.exitCode).toBe(0);
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("read");
    expect(rows[0]!.path).toBe(filePath);
    expect(rows[0]!.exe).toBe("View");
    expect(rows[0]!.sensitive).toBe(false);

    // Verify raw source in DB is "hook"
    const raw = historyDb.prepare("SELECT source FROM events WHERE id = ?").get(rows[0]!.id) as { source: string };
    expect(raw.source).toBe("hook");
  });

  it("records allowed file write under God Mode into history.db", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const filePath = "/Users/testuser/project/src/output.txt";
    const now = Date.now();

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: filePath, text: "new content" },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now,
      home,
      ask: async () => "deny",
    });

    expect(result.exitCode).toBe(0);
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("write");
    expect(rows[0]!.path).toBe(filePath);
    expect(rows[0]!.exe).toBe("Edit");

    const raw = historyDb.prepare("SELECT source FROM events WHERE id = ?").get(rows[0]!.id) as { source: string };
    expect(raw.source).toBe("hook");
  });

  it("records command execution into history.db when paths is empty", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const now = Date.now();

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "ExecuteCommand",
        tool_input: { command: "pnpm test" },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now,
      home,
      ask: async () => "deny",
    });

    expect(result.exitCode).toBe(0);
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("exec");
    expect(rows[0]!.path).toBe("/Users/testuser/project");
    expect(rows[0]!.exe).toBe("pnpm test");

    const raw = historyDb.prepare("SELECT source FROM events WHERE id = ?").get(rows[0]!.id) as { source: string };
    expect(raw.source).toBe("hook");
  });

  it("records network requests into history.db when paths is empty", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const now = Date.now();

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "WebFetch",
        tool_input: { url: "https://api.github.com/repos" },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now,
      home,
      ask: async () => "deny",
    });

    expect(result.exitCode).toBe(0);
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("net");
    expect(rows[0]!.path).toBe("https://api.github.com/repos");
    expect(rows[0]!.exe).toBe("WebFetch");

    const raw = historyDb.prepare("SELECT source FROM events WHERE id = ?").get(rows[0]!.id) as { source: string };
    expect(raw.source).toBe("hook");
  });

  it("records user-prompted allow into history.db", async () => {
    const filePath = "/Users/testuser/project/doc.md";
    let asked = false;

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: filePath },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now: Date.now(),
      home,
      ask: async () => {
        asked = true;
        return "allow";
      },
    });

    expect(asked).toBe(true);
    expect(result.exitCode).toBe(0);
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("read");
    expect(rows[0]!.path).toBe(filePath);
  });

  it("does not record events when request is denied", async () => {
    const filePath = "/Users/testuser/project/secret.txt";

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: filePath },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now: Date.now(),
      home,
      ask: async () => "deny",
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(0);
  });

  it("correctly identifies sensitive paths in history event", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const secretPath = `${home}/.ssh/id_rsa`;

    await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: secretPath },
        cwd: home,
      },
      db: grantsDb,
      historyDb,
      now: Date.now(),
      home,
      ask: async () => "deny",
    });

    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sensitive).toBe(true);
  });

  it("records multiple paths when tool touches multiple files", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const pathA = "/Users/testuser/project/a.ts";
    const pathB = "/Users/testuser/project/b.ts";

    await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "MultiEdit",
        tool_input: { file_paths: [pathA, pathB] },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyDb,
      now: Date.now(),
      home,
      ask: async () => "deny",
    });

    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(2);
    const paths = rows.map((r) => r.path);
    expect(paths).toContain(pathA);
    expect(paths).toContain(pathB);
  });

  it("works with historyPath option when historyDb is not provided directly", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    const filePath = "/Users/testuser/project/test.ts";

    await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: filePath },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyPath,
      now: Date.now(),
      home,
      ask: async () => "deny",
    });

    const rows = listHistory(historyDb, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]!.path).toBe(filePath);
  });

  it("never fails tool call if history write fails", async () => {
    setGodMode(grantsDb, Date.now() + 300_000, "*");
    // Pass an invalid / unwriteable history path
    const invalidPath = "/nonexistent/invalid/dir/history.db";

    const result = await handlePayload({
      entry: "claude",
      raw: {
        hook_event_name: "PreToolUse",
        tool_name: "View",
        tool_input: { file_path: "/Users/testuser/project/test.ts" },
        cwd: "/Users/testuser/project",
      },
      db: grantsDb,
      historyPath: invalidPath,
      now: Date.now(),
      home,
      ask: async () => "deny",
    });

    expect(result.exitCode).toBe(0);
  });
});

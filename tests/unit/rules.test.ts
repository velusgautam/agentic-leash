import { describe, expect, it } from "vitest";
import { validateRule } from "../../src/shared/rules";

const home = "/Users/v";

describe("validateRule", () => {
  it("rejects a bad kind before a blank value", () => {
    expect(validateRule({ kind: "nope", agent: "*", value: "  " }, home)).toEqual({ ok: false, error: "Pick a folder or a command." });
  });
  it("rejects an unknown agent", () => {
    expect(validateRule({ kind: "command", agent: "t3-code", value: "npm test" }, home)).toEqual({ ok: false, error: "Pick an agent." });
  });
  it("rejects a blank value", () => {
    expect(validateRule({ kind: "command", agent: "*", value: "  " }, home)).toEqual({ ok: false, error: "Enter a folder path or a command." });
  });
  it("stores a trimmed command and keeps internal spaces", () => {
    expect(validateRule({ kind: "command", agent: "cursor", value: "  npm  test  " }, home)).toEqual({ ok: true, kind: "command", agent: "cursor", value: "npm  test" });
    expect(validateRule({ kind: "command", agent: "antigravity", value: "  agy  chat  " }, home)).toEqual({ ok: true, kind: "command", agent: "antigravity", value: "agy  chat" });
  });
  it("rejects a relative folder and stores an absolute one", () => {
    expect(validateRule({ kind: "folder", agent: "*", value: "proj" }, home)).toEqual({ ok: false, error: "Folder path must be absolute." });
    expect(validateRule({ kind: "folder", agent: "*", value: "~/proj" }, home)).toEqual({ ok: true, kind: "folder", agent: "*", value: "/Users/v/proj" });
  });
  it("rejects /, /Users and the home folder", () => {
    expect(validateRule({ kind: "folder", agent: "*", value: "/" }, home)).toEqual({ ok: false, error: "That folder is too broad." });
    expect(validateRule({ kind: "folder", agent: "*", value: "/Users" }, home)).toEqual({ ok: false, error: "That folder is too broad." });
    expect(validateRule({ kind: "folder", agent: "*", value: "~" }, home)).toEqual({ ok: false, error: "That folder is too broad." });
  });
});

describe("validateRule guarded paths", () => {
  it("refuses secrets, startup files and whole personal folders, but takes a folder inside one", () => {
    const secret = "Secret and startup files can't be allowed forever. Approve them from the popup when needed.";
    expect(validateRule({ kind: "folder", agent: "*", value: "~/.ssh" }, home)).toEqual({ ok: false, error: secret });
    expect(validateRule({ kind: "folder", agent: "*", value: "~/Library/LaunchAgents" }, home)).toEqual({ ok: false, error: secret });
    expect(validateRule({ kind: "folder", agent: "*", value: "~/Documents" }, home)).toEqual({ ok: false, error: "Your whole Documents folder can't be allowed forever. Pick a folder inside it." });
    expect(validateRule({ kind: "folder", agent: "*", value: "~/Documents/code" }, home)).toEqual({ ok: true, kind: "folder", agent: "*", value: "/Users/v/Documents/code" });
  });
});

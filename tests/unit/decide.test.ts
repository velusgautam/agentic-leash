import { describe, expect, it } from "vitest";
import { coveredPending, decide } from "../../src/hook/decide";
import { normaliseHook } from "../../src/hook/normalise";
import { extractShellPaths, hasUnresolved, isUnder } from "../../src/shared/paths";
import { requestPolicy } from "../../src/shared/policy";
import type { AllowRule, Grant, HookRequest } from "../../src/shared/types";

const req = (over: Partial<HookRequest>): HookRequest => ({ agent: "cursor", event: "preToolUse", tool: "Read", access: "read", paths: ["/a/b/c"], cwd: "/a/b", ...over });
const grant = (over: Partial<Grant>): Grant => ({ id: 1, agent: "cursor", path: "/a/b", access: "read", source: "leash", command: null, createdAt: 0, expiresAt: null, ...over });
const opts = { now: 1_000, lockdown: false, protectedRoots: ["/secret"] };
const rule = (over: Partial<AllowRule>): AllowRule => ({ id: 1, kind: "folder", agent: "*", value: "/proj", createdAt: 0, ...over });

describe("decide", () => {
  it("denies during lockdown", () => {
    expect(decide(req({}), [], { ...opts, lockdown: true })).toEqual({ kind: "deny", reason: "Agentic Leash lockdown is on" });
  });
  it("denies a protected root", () => {
    expect(decide(req({ paths: ["/secret/grants.db"] }), [], opts).kind).toBe("deny");
  });
  it("denies a forever folder rule on a protected root", () => {
    expect(decide(req({ paths: ["/secret/x"] }), [], { ...opts, rules: [rule({ value: "/secret" })] }).kind).toBe("deny");
  });
  it("passes when god mode is active", () => {
    expect(decide(req({ paths: ["/random/path"] }), [], { ...opts, now: 1_000, godModeUntil: 5_000, godModeAgent: "*" })).toEqual({ kind: "pass", godMode: true });
    expect(decide(req({ agent: "cursor", paths: ["/random/path"] }), [], { ...opts, now: 1_000, godModeUntil: 5_000, godModeAgent: "claude-code" }).kind).toBe("prompt");
    expect(decide(req({ agent: "cursor", paths: ["/random/path"] }), [], { ...opts, now: 6_000, godModeUntil: 5_000, godModeAgent: "*" }).kind).toBe("prompt");
  });
  it("denies during lockdown or protected root even if god mode is active", () => {
    expect(decide(req({ paths: ["/random/path"] }), [], { ...opts, now: 1_000, godModeUntil: 5_000, lockdown: true })).toEqual({ kind: "deny", reason: "Agentic Leash lockdown is on" });
    expect(decide(req({ paths: ["/secret/config"] }), [], { ...opts, now: 1_000, godModeUntil: 5_000 })).toEqual({ kind: "deny", reason: "Agentic Leash protects its own files" });
  });
  it("prompts when the grant is expired", () => {
    expect(decide(req({}), [grant({ expiresAt: 500 })], opts).kind).toBe("prompt");
  });
  it("prompts when a read grant meets a write", () => {
    expect(decide(req({ access: "write" }), [grant({ access: "read" })], opts).kind).toBe("prompt");
  });
  it("lets a star grant cover every agent", () => {
    expect(decide(req({ agent: "claude-code" }), [grant({ agent: "*" })], opts).kind).toBe("pass");
  });
  it("does not treat /a/bc as inside /a/b", () => {
    expect(isUnder("/a/bc", "/a/b")).toBe(false);
    expect(decide(req({ paths: ["/a/bc"] }), [grant({ path: "/a/b" })], opts).kind).toBe("prompt");
  });
  it("lets an active write grant cover a later shell command in that folder", () => {
    const shell = (command: string) => {
      const normalised = normaliseHook({ command, cwd: "/Volumes/Agentic Leash 1", hook_event_name: "beforeShellExecution" }, "cursor");
      if (normalised.kind !== "request") throw new Error("expected a shell request");
      return normalised.request;
    };
    const active = grant({ path: "/Volumes/Agentic Leash 1", access: "write" });
    const first = shell("ls spikes");
    const again = shell("npm test");
    expect(decide(first, [active], opts).kind).toBe("pass");
    expect(decide(again, [active], opts).kind).toBe("pass");
    expect(decide(shell("cat /etc/hosts"), [active], opts).kind).toBe("prompt");
    expect(coveredPending([{ id: "exec", request: again, askedAt: 0 }], [active], opts)).toEqual(["exec"]);
  });
  it("names queued requests a new grant already covers", () => {
    const pending = [
      { id: "1", request: req({ paths: ["/a/b/c.txt"], access: "write" }), askedAt: 0 },
      { id: "2", request: req({ paths: ["/other"], access: "write" }), askedAt: 0 },
    ];
    expect(coveredPending(pending, [grant({ path: "/a/b", access: "write" })], opts)).toEqual(["1"]);
  });
  it("covers a child of a folder grant", () => {
    expect(decide(req({ paths: ["/a/b/c/d"], access: "write" }), [grant({ path: "/a/b", access: "write" })], opts).kind).toBe("pass");
  });
  it("passes an exact command grant from another directory and ignores expiry that has passed", () => {
    const command = "cat /etc/hosts";
    const shell = req({ command, paths: ["/elsewhere", "/etc/hosts"], access: "write", cwd: "/elsewhere" });
    expect(decide(shell, [grant({ command, access: "write", path: "" })], opts).kind).toBe("pass");
    expect(decide(shell, [grant({ command, access: "write", path: "", expiresAt: 500 })], opts).kind).toBe("prompt");
    expect(decide(req({ command: "npm test --watch", paths: ["/a/b"], access: "write" }), [grant({ command: "npm test", access: "write", path: "" })], opts).kind).toBe("prompt");
  });
  it("lets a command rule pass and lets lockdown deny it", () => {
    const shell = req({ command: "npm test", paths: ["/etc/hosts"], access: "write" });
    const rules = [rule({ kind: "command", value: "npm test", agent: "cursor" })];
    expect(decide(shell, [], { ...opts, rules }).kind).toBe("pass");
    expect(decide(shell, [], { ...opts, rules, lockdown: true }).kind).toBe("deny");
  });
  it("lets a folder rule cover a child read and ignores a command grant path", () => {
    expect(decide(req({ paths: ["/proj/sub/a"], access: "read" }), [], { ...opts, rules: [rule({ value: "/proj" })] }).kind).toBe("pass");
    expect(decide(req({ agent: "claude-code", paths: ["/proj/a"], access: "write" }), [], { ...opts, rules: [rule({ agent: "cursor", value: "/proj" })] }).kind).toBe("prompt");
    expect(decide(req({ agent: "claude-code", paths: ["/proj/a"], access: "write" }), [], { ...opts, rules: [rule({ agent: "*", value: "/proj" })] }).kind).toBe("pass");
    expect(decide(req({ paths: ["/secret-file"], access: "read" }), [grant({ command: "npm test", path: "", access: "write" })], opts).kind).toBe("prompt");
  });
});

describe("decide on /dev/null", () => {
  it("passes a read-only command that redirects to /dev/null when cwd has a read grant", () => {
    const shell = normaliseHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "head -n 10 *.txt 2>/dev/null || true" }, cwd: "/Users/v/proj" }, "claude", "/Users/v");
    if (shell.kind !== "request") throw new Error("expected a request");
    expect(decide(shell.request, [grant({ agent: "claude-code", path: "/Users/v/proj", access: "read" })], opts)).toEqual({ kind: "pass", grantIds: [1] });
  });
});

describe("extractShellPaths", () => {
  it("leaves out /dev/null", () => {
    for (const command of ["ls 2>/dev/null", "ls >/dev/null", "cat < /dev/null", "cat /dev/null"]) expect(extractShellPaths(command, "/a/b", "/Users/v"), command).toEqual(["/a/b"]);
  });
  it("expands home and keeps the working directory", () => {
    expect(extractShellPaths("cat ~/.ssh/id_rsa", "/tmp", "/Users/v")).toEqual(["/tmp", "/Users/v/.ssh/id_rsa"]);
  });
  it("resolves relative tokens and quoted paths", () => {
    expect(extractShellPaths("cd ../x && ls", "/a/b", "/Users/v")).toEqual(["/a/b", "/a/x"]);
    expect(extractShellPaths('cat "/tmp/my file.txt"', "/a", "/Users/v")).toContain("/tmp/my file.txt");
  });
  it("drops trailing punctuation from paths", () => {
    expect(extractShellPaths(`node -e "x('/Users/v/proj,')"`, "/a", "/Users/v")).toContain("/Users/v/proj");
    expect(extractShellPaths(`node -e "x('/Users/v/proj,')"`, "/a", "/Users/v").some((path) => path.endsWith(","))).toBe(false);
    expect(extractShellPaths("cat /a/b.", "/z", "/Users/v")).toEqual(["/z", "/a/b"]);
    expect(extractShellPaths("cat /a/b),", "/z", "/Users/v")).toEqual(["/z", "/a/b"]);
    expect(extractShellPaths("ls ./", "/a/b", "/Users/v")).toEqual(["/a/b"]);
    expect(extractShellPaths("ls ../..", "/a/b/c", "/Users/v")).toEqual(["/a/b/c", "/a"]);
    expect(extractShellPaths("cd ..", "/a/b", "/Users/v")).toEqual(["/a/b", "/a"]);
  });
  it("keeps unresolved variables so they can be refused", () => {
    expect(extractShellPaths("for d in a b; do ls /w/$d/.github; done", "/z", "/Users/v")).toContain("/w/$d/.github");
    expect(extractShellPaths("curl /repos/\\${SOURCE_REPO}/releases", "/z", "/Users/v")).toContain("/repos/${SOURCE_REPO}/releases");
  });
});

describe("unresolved variables", () => {
  const shell = (command: string) => req({ tool: "Bash", access: "write", command, cwd: "/z", paths: extractShellPaths(command, "/z", "/Users/v") });
  const write = (path: string) => grant({ path, access: "write" });
  it("prompts even when a grant covers the folder or the literal path", () => {
    const loop = shell("for d in a b; do ls /w/$d/.github; done");
    expect(decide(loop, [write("/z"), write("/w")], opts).kind).toBe("prompt");
    expect(decide(loop, [write("/z"), write("/w/$d/.github")], opts).kind).toBe("prompt");
    const repo = shell("curl /repos/${SOURCE_REPO}/releases");
    expect(decide(repo, [write("/z"), write("/repos")], opts).kind).toBe("prompt");
  });
  it("offers only allow once and never writes a path grant with $", () => {
    const policy = requestPolicy(shell("ls /w/$d"), "/Users/v", () => "/w");
    expect(policy).toMatchObject({ presets: ["once"], preset: "once", exact: true });
    expect(hasUnresolved(["/a", "/w/$d"])).toBe(true);
    expect(hasUnresolved(["/a", "/w/d"])).toBe(false);
  });
});

import { connect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { insertEvents, openHistoryDb } from "../../src/helper/historyDb";
import { launch } from "./launch";

const OUT = "docs/media";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture marketing images");

test("marketing screenshots", async () => {
  test.setTimeout(60_000);
  const dir = mkdtempSync(join(tmpdir(), "al-shots-"));
  const db = openHistoryDb(join(dir, "history.db"));
  const now = Date.now();
  const desktop = "/Applications/Claude.app/Contents/MacOS/Claude";
  const cli = "/Users/ada/.local/bin/claude";
  const before = "export function remaining(expiresAt: number | null): string {\n  if (expiresAt === null) return \"Forever\";\n  return \"1h\";\n}\n";
  const after = "export function remaining(expiresAt: number | null): string {\n  if (expiresAt === null) return \"Forever\";\n  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));\n  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;\n  return `${seconds}s`;\n}\n";
  insertEvents(db, [
    { pid: 1, exe: cli, source: "eslogger", sensitive: false, ts: now - 12000, agent: "claude-code", kind: "read", path: "/Users/ada/Projects/leash/package.json" },
    { pid: 1, exe: desktop, source: "eslogger", sensitive: false, ts: now - 11000, agent: "claude-code", kind: "write", path: "/Users/ada/Projects/leash/README.md", beforeBlob: "# Agentic Leash\n\n", afterBlob: "# Agentic Leash\n\nSee and control what AI coding agents can touch.\n" },
    { pid: 1, exe: "/Users/ada/.local/bin/cursor-agent", source: "eslogger", sensitive: false, ts: now - 10000, agent: "cursor", kind: "write", path: "/Users/ada/Projects/leash/src/shared/grantView.ts", beforeBlob: before, afterBlob: after },
    { pid: 1, exe: "/Users/ada/.local/bin/codex", source: "eslogger", sensitive: false, ts: now - 9000, agent: "codex", kind: "exec", path: "/usr/bin/git" },
    { pid: 1, exe: "/Users/ada/.local/bin/gemini", source: "eslogger", sensitive: false, ts: now - 8000, agent: "gemini", kind: "read", path: "/Users/ada/Projects/leash/src/main/index.ts" },
    { pid: 1, exe: "/Users/ada/.local/bin/hermes", source: "eslogger", sensitive: false, ts: now - 7000, agent: "hermes", kind: "create", path: "/Users/ada/Projects/leash/src/helper/net.ts" },
    { pid: 1, exe: desktop, source: "eslogger", sensitive: false, ts: now - 6000, agent: "claude-code", kind: "net", path: "api.anthropic.com:443" },
    { pid: 1, exe: cli, source: "eslogger", sensitive: true, ts: now - 5000, agent: "claude-code", kind: "read", path: "/Users/ada/.ssh/config" },
    { pid: 1, exe: desktop, source: "eslogger", sensitive: true, ts: now - 4000, agent: "claude-code", kind: "read", path: "/Users/ada/.aws/credentials" },
  ]);
  db.close();

  const rawDir = `${OUT}/raw`;
  mkdirSync(rawDir, { recursive: true });
  const app = await launch(["--force-device-scale-factor=2"], { AGENTIC_LEASH_HISTORY_DIR: dir });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  await win.evaluate(`(async () => {
    await window.leash.setTheme("dark");
    localStorage.setItem("agentic-leash:appearance", JSON.stringify({ contrast: 100, glass: 80, density: "comfortable", palette: "leash" }));
    const grants = [
      { agent: "cursor", path: "/Users/ada/Projects/leash", access: "write", ttlSeconds: 15 * 60 },
      { agent: "claude-code", path: "/Users/ada/Projects/leash/src", access: "write", ttlSeconds: 2 * 60 * 60 },
      { agent: "*", path: "/Users/ada/Projects", access: "read", ttlSeconds: 8 * 60 * 60 },
      { agent: "codex", path: "/Users/ada/Projects/leash/docs", access: "write", ttlSeconds: null },
    ];
    for (const grant of grants) await window.leash.createGrant(grant);
  })()`);
  const boxes: Record<string, unknown> = {};
  const box = async (name: string, locator: ReturnType<typeof win.locator>) => {
    boxes[name] = await locator.boundingBox();
  };
  const shot = async (page: typeof win, name: string) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${rawDir}/${name}.png`, scale: "device" });
  };

  await win.getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByRole("link", { name: "Appearance", exact: true }).click();
  await win.getByRole("button", { name: "Leash" }).click();
  await expect(win.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await expect(win.getByRole("button", { name: "Leash" })).toHaveAttribute("aria-pressed", "true");
  await box("appearanceTheme", win.getByRole("heading", { name: "Theme", exact: true }).locator("xpath=.."));
  await box("appearanceInterface", win.getByRole("heading", { name: "Interface", exact: true }).locator("xpath=.."));
  await shot(win, "appearance");

  await win.getByRole("link", { name: "Back", exact: true }).click();
  await win.getByRole("link", { name: "Live", exact: true }).click();
  await expect(win.getByText("/Users/ada/.ssh/config")).toBeVisible();
  await box("sensitiveRow", win.getByText("/Users/ada/.ssh/config").locator("xpath=ancestor::li[1]"));
  await box("sensitiveToggle", win.getByRole("button", { name: /^Sensitive/ }));
  await shot(win, "live-sensitive");

  await win.getByRole("link", { name: "History", exact: true }).click();
  await win.getByText("/Users/ada/Projects/leash/src/shared/grantView.ts").click();
  await expect(win.getByText("seconds").first()).toBeVisible();
  await box("historyDetail", win.getByRole("complementary"));
  await shot(win, "history-diff");

  await win.getByRole("link", { name: "Access", exact: true }).click();
  await win.getByRole("button", { name: "Expires" }).click();
  await expect(win.getByText("Forever")).toBeVisible();
  await expect(win.getByText(/\d+m/).first()).toBeVisible();
  await box("grantControls", win.getByRole("button", { name: "Approved" }).locator("xpath=../.."));
  await box("grantList", win.getByText("Live grants").locator("xpath=.."));
  await shot(win, "grants");

  await win.getByRole("tab", { name: "Secure Areas" }).click();
  await expect(win.getByText("Secrets").first()).toBeVisible();
  await box("secureAreasHeader", win.getByText("Protected folders and files").locator("xpath=ancestor::div[contains(@class,'rounded-')][1]"));
  await box("secureAreasLast", win.getByText("Startup & agent config").locator("xpath=ancestor::div[contains(@class,'rounded-')][1]"));
  await shot(win, "secure-areas");

  await win.getByRole("tab", { name: "Active" }).click();
  await win.getByRole("button", { name: "Revoke & lockdown" }).click();
  await expect(win.getByRole("alertdialog").getByText("Revoke all 4 grants and lock down?")).toBeVisible();
  await box("revokeDialog", win.getByRole("alertdialog"));
  await shot(win, "revoke");
  await win.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ id: "shot-1", request: { agent: "cursor", event: "preToolUse", tool: "Read", access: "read", paths: [join(home, ".ssh/config")], cwd: join(home, "Projects/leash") } })}\n`);
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await expect(popup.getByText(/High risk/i)).toBeVisible();
  boxes.popupSize = popup.viewportSize();
  await shot(popup, "approval");
  writeFileSync(`${rawDir}/boxes.json`, `${JSON.stringify(boxes, null, 2)}\n`);
  socket.destroy();
  await app.close();
});

test("walkthrough frames", async () => {
  test.setTimeout(120_000);
  const theme = process.env.THEME === "light" ? "light" : "dark";
  const out = `${OUT}/walkthrough${theme === "light" ? "/light" : ""}`;
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "al-walk-home-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), "");
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini/settings.json"), "{}\n");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes/config.yaml"), "");
  const dir = mkdtempSync(join(tmpdir(), "al-walk-"));
  const db = openHistoryDb(join(dir, "history.db"));
  const cli = "/Users/ada/.local/bin/claude";
  const desktop = "/Applications/Claude.app/Contents/MacOS/Claude";
  const base = { pid: 1, source: "eslogger" as const, sensitive: false };
  let clock = Date.now() - 60_000;
  const add = (events: Record<string, unknown>[]) => {
    insertEvents(db, events.map((event) => ({ ...base, ts: (clock += 1000), ...event })) as unknown as Parameters<typeof insertEvents>[1]);
  };

  const app = await launch(["--force-device-scale-factor=2"], { AGENTIC_LEASH_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), AGENTIC_LEASH_HISTORY_DIR: dir, AGENTIC_LEASH_SKIP_SETUP: "" });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  await win.evaluate(`window.leash.setTheme(${JSON.stringify(theme)})`);
  const boxes: Record<string, unknown> = {};
  const box = async (name: string, locator: ReturnType<typeof win.locator>) => {
    boxes[name] = await locator.boundingBox();
  };
  const shot = async (page: typeof win, name: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/${name}.png`, scale: "device" });
  };

  await expect(win.getByText("Set up this Mac")).toBeVisible();
  const claudeRow = win.getByText("Claude hooks").locator("xpath=ancestor::*[.//button][1]");
  await box("setupHooks", win.getByText("1. Hooks").locator("xpath=.."));
  await box("setupInstall", claudeRow.getByRole("button", { name: "Install" }));
  await shot(win, "01-setup");

  add([
    { exe: cli, agent: "claude", kind: "read", path: "/Users/ada/Projects/leash/package.json" },
    { exe: desktop, agent: "claude", kind: "write", path: "/Users/ada/Projects/leash/README.md", beforeBlob: "# Leash\n", afterBlob: "# Leash\n\nSee what agents touch.\n" },
    { exe: "/Users/ada/.local/bin/codex", agent: "codex", kind: "exec", path: "/usr/bin/git" },
  ]);
  await claudeRow.getByRole("button", { name: "Install" }).click();
  await expect(win.getByText("Live activity")).toBeVisible();
  await win.getByRole("button", { name: "Got it" }).click();
  await expect(win.getByRole("alertdialog")).toBeHidden();
  await win.waitForTimeout(1000);
  const dismiss = win.getByRole("button", { name: "Dismiss" });
  if (await dismiss.isVisible()) await dismiss.click();
  for (const name of ["Live", "Access", "History"]) await box(`nav${name}`, win.getByRole("link", { name, exact: true }));
  await box("liveList", win.locator(".table-frame"));
  await box("sidebarAgents", win.getByText("Agents", { exact: true }).locator("xpath=.."));
  await shot(win, "02-live-a");

  add([
    { exe: "/Users/ada/.local/bin/gemini", agent: "gemini", kind: "read", path: "/Users/ada/Projects/leash/src/main/index.ts" },
    { exe: "/Users/ada/.local/bin/hermes", agent: "hermes", kind: "create", path: "/Users/ada/Projects/leash/src/helper/net.ts" },
    { exe: desktop, agent: "claude", kind: "net", path: "api.anthropic.com:443" },
    { exe: "/Users/ada/.local/bin/cursor-agent", agent: "cursor-agent", kind: "read", path: "/Users/ada/Projects/leash/src/shared/grantView.ts" },
  ]);
  await expect(win.getByText("api.anthropic.com:443")).toBeVisible();
  await shot(win, "03-live-b");

  await win.evaluate(`(async () => {
    await window.leash.createGrant({ agent: "claude-code", path: "/Users/ada/Projects/leash/src", access: "write", ttlSeconds: 2 * 60 * 60 });
    await window.leash.createGrant({ agent: "*", path: "/Users/ada/Projects", access: "read", ttlSeconds: 8 * 60 * 60 });
    await window.leash.createGrant({ agent: "codex", path: "/Users/ada/Projects/leash/docs", access: "write", ttlSeconds: null });
  })()`);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ id: "walk-1", request: { agent: "cursor", event: "preToolUse", tool: "Write", access: "write", paths: ["/Users/ada/Projects/website/index.html"], cwd: "/Users/ada/Projects/website" } })}\n`);
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await expect(popup.getByText("Cursor wants to change a file")).toBeVisible();
  await box("popupPath", popup.locator("pre"));
  await shot(popup, "04-approval");
  await popup.getByRole("button", { name: "website", exact: true }).click();
  await expect(popup.getByText("Allow website this session")).toBeVisible();
  const allow = popup.getByRole("button", { name: /^This session/ });
  await box("popupScope", popup.getByRole("button", { name: "website", exact: true }));
  await box("popupTtl", allow.locator("xpath=.."));
  await box("popupAllow", allow);
  await shot(popup, "05-approval-scope");
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect.poll(() => win.evaluate(`window.leash.listGrants().then((rows) => rows.length)`)).toBe(4);
  socket.destroy();

  await win.getByRole("link", { name: "Access", exact: true }).click();
  const website = win.getByText("/Users/ada/Projects/website", { exact: true }).locator("xpath=ancestor::*[.//button][1]");
  await expect(website).toBeVisible();
  await box("grantNew", website);
  await box("grantTtl", website.getByText(/^\d+m$/));
  await box("sortExpires", win.getByRole("button", { name: "Expires" }));
  await shot(win, "06-grants");
  await win.getByRole("button", { name: "Expires" }).click();
  await box("grantControls", win.getByRole("button", { name: "Approved" }).locator("xpath=../.."));
  await box("grantList", win.getByText("Live grants").locator("xpath=.."));
  await shot(win, "07-grants-sorted");

  add([{ exe: "/Users/ada/.local/bin/cursor-agent", agent: "cursor-agent", kind: "write", path: "/Users/ada/Projects/website/index.html", beforeBlob: "<h1>Website</h1>\n<p>Coming soon</p>\n", afterBlob: "<h1>Agentic Leash</h1>\n<p>See and control what AI coding agents can touch.</p>\n<a href=\"/download\">Download for macOS</a>\n" }]);
  await win.getByRole("link", { name: "History", exact: true }).click();
  await box("historyRow", win.getByText("/Users/ada/Projects/website/index.html"));
  await win.getByText("/Users/ada/Projects/website/index.html").click();
  const details = win.getByRole("complementary");
  await expect(details.getByText("Allowed by Cursor · Agentic Leash grant")).toBeVisible();
  await box("historyDetail", details);
  await box("historyGrant", details.getByText("Allowed by Cursor · Agentic Leash grant").locator("xpath=../.."));
  await shot(win, "08-history");

  add([{ exe: cli, agent: "claude", kind: "read", path: "/Users/ada/.ssh/id_ed25519", sensitive: true }]);
  await win.getByRole("link", { name: "Live", exact: true }).click();
  const secret = win.getByText("/Users/ada/.ssh/id_ed25519");
  await expect(secret).toBeVisible();
  await box("sensitiveRow", secret.locator("xpath=ancestor::li[1]"));
  await box("sensitiveToggle", win.getByRole("button", { name: /^Sensitive/ }));
  await shot(win, "09-sensitive");

  await win.getByRole("link", { name: "Access", exact: true }).click();
  await box("revokeButton", win.getByRole("button", { name: "Revoke all and lock down" }));
  await win.getByRole("button", { name: "Revoke all and lock down" }).click();
  const dialog = win.getByRole("alertdialog");
  await expect(dialog.getByText("Revoke all 4 grants?")).toBeVisible();
  await box("revokeDialog", dialog);
  await box("revokeConfirm", dialog.getByRole("button", { name: "Revoke all" }));
  await shot(win, "10-revoke");
  await dialog.getByRole("button", { name: "Revoke all" }).click();
  const end = win.getByRole("button", { name: "End lockdown", pressed: true });
  await expect(end).toBeEnabled();
  await expect(win.getByRole("button", { name: "Nothing to revoke" }).first()).toBeVisible();
  await win.waitForTimeout(2200);
  await box("lockdown", end.locator("xpath=.."));
  await shot(win, "11-lockdown");

  await win.getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(win.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  await box("appearanceTheme", win.getByRole("heading", { name: "Theme", exact: true }).locator("xpath=.."));
  await box("appearanceInterface", win.getByRole("heading", { name: "Interface", exact: true }).locator("xpath=.."));
  await box("appearanceDark", win.getByRole("button", { name: "Dark" }));
  await shot(win, "12-appearance");

  db.close();
  if (theme === "dark") writeFileSync(`${OUT}/walkthrough/boxes.json`, `${JSON.stringify(boxes, null, 2)}\n`);
  await app.close();
});

import { connect } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch } from "./launch";

test("an approval request opens the popup with one-click choices", async () => {
  const app = await launch();
  await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const projectDir = join(home, "Documents", "project");
  const request = {
    agent: "cursor",
    event: "preToolUse",
    tool: "Read",
    access: "read",
    paths: [join(projectDir, "src", "index.ts")],
    cwd: projectDir,
  };
  socket.write(`${JSON.stringify({ id: "e2e-1", request })}\n`);
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await expect(popup.getByText("Cursor wants to read a file")).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Allow once/ })).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Allow this session/ })).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Allow today/ })).toBeVisible();
  await expect(popup.getByText(/Until the agent is idle for 30 minutes, at most 12 hours./)).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => !window.isFullScreenable() && !window.isFullScreen() && window.getSize()[0] === 520))).toBe(true);
  await expect(popup.getByRole("button", { name: "Users", exact: true })).toHaveCount(0);
  if (process.env.SCREENSHOT) await popup.screenshot({ path: process.env.SCREENSHOT.replace(".png", "-approval.png") });
  const win = await app.firstWindow();
  await popup.getByRole("button", { name: /project/i }).click();
  await expect(popup.getByRole("button", { name: /project/i })).toHaveAttribute("aria-pressed", "true");
  expect(await win.evaluate(`window.leash.listGrants().then((rows) => rows.length)`)).toBe(0);
  await popup.getByRole("button", { name: /^Allow this session/ }).click();
  await expect.poll(() => win.evaluate(`window.leash.listGrants().then((rows) => rows.map((row) => row.path).join(","))`)).toBe(projectDir);
  await expect(popup.getByText("No requests waiting.")).toBeVisible();
  socket.destroy();
  await app.close();
});

test("the lockdown button label follows revoke-all", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.evaluate(`window.leash.createGrant({ agent: "*", path: "/tmp/leash-lock", access: "write", ttlSeconds: 3600 })`);
  await win.getByRole("link", { name: "Access", exact: true }).click();
  const lockdownBtn = win.getByRole("tabpanel", { name: "Active" }).getByRole("button", { name: "Lockdown", exact: true });
  await expect(lockdownBtn).toHaveAttribute("aria-pressed", "false");
  await lockdownBtn.click();
  await expect(win.getByRole("status").filter({ hasText: "Lockdown is on" })).toBeVisible();
  const end = win.getByRole("button", { name: "End lockdown", pressed: true });
  await expect(end).toBeEnabled();
  await expect(win.getByText("/tmp/leash-lock")).toBeVisible();
  await end.click();
  await expect(win.getByRole("status").filter({ hasText: "Lockdown is on" })).toHaveCount(0);
  await expect(win.getByText("/tmp/leash-lock")).toBeVisible();

  await win.getByRole("button", { name: "Revoke & lockdown" }).click();
  await win.getByRole("alertdialog").getByRole("button", { name: "Revoke & lockdown" }).click();
  await expect(win.getByRole("status").filter({ hasText: "Lockdown is on" })).toBeVisible();
  await expect(win.getByText("/tmp/leash-lock")).toHaveCount(0);
  await end.click();
  await expect(win.getByRole("status").filter({ hasText: "Lockdown is on" })).toHaveCount(0);
  await expect(lockdownBtn).toHaveAttribute("aria-pressed", "false");
  await app.close();
});

test("revoking a grant asks first and explains the outcome", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.evaluate(`window.leash.createGrant({ agent: "*", path: "/tmp/leash-e2e", access: "write", ttlSeconds: 3600 })`);
  await win.getByRole("link", { name: "Access", exact: true }).click();
  await win.getByRole("button", { name: "Revoke", exact: true }).click();
  const dialog = win.getByRole("alertdialog");
  await expect(dialog.getByText("Revoke this grant?")).toBeVisible();
  await expect(dialog.getByText("The next access here opens an approval request again.")).toBeVisible();
  if (process.env.SCREENSHOT) {
    await win.waitForTimeout(400);
    await win.screenshot({ path: process.env.SCREENSHOT });
  }
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(win.getByText("/tmp/leash-e2e")).toBeVisible();
  await win.getByRole("button", { name: "Revoke", exact: true }).click();
  await win.getByRole("alertdialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(win.getByText("No grants yet")).toBeVisible();
  await app.close();
});

test("allow all approves every waiting request for this session", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  for (const name of ["a", "b"]) {
    const dir = join(home, "Documents", name);
    const request = { agent: "cursor", event: "preToolUse", tool: "Read", access: "read", paths: [join(dir, "src", "index.ts")], cwd: dir };
    socket.write(`${JSON.stringify({ id: `e2e-batch-${name}`, request })}\n`);
  }
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  const allowAll = popup.getByRole("button", { name: "Allow all (2) this session" });
  await expect(allowAll).toBeEnabled();
  await allowAll.click();
  await expect(popup.getByText("No requests waiting.")).toBeVisible();
  await expect.poll(() => win.evaluate(`window.leash.listGrants().then((rows) => rows.map((row) => row.path).sort().join(","))`)).toBe(
    `${join(home, "Documents", "a", "src")},${join(home, "Documents", "b", "src")}`,
  );
  socket.destroy();
  await app.close();
});

test("always allow folder adds the folder to Custom Secure Areas", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const projectDir = join(home, "Documents", "always-proj");
  const request = { agent: "cursor", event: "preToolUse", tool: "Read", access: "read", paths: [join(projectDir, "src", "app.ts")], cwd: projectDir };
  socket.write(`${JSON.stringify({ id: "e2e-always", request })}\n`);
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await popup.getByRole("button", { name: /^Always allow folder/ }).click();
  await expect(popup.getByText("No requests waiting.")).toBeVisible();
  await expect.poll(() =>
    win.evaluate(
      `window.leash.listSecureAreas().then((areas) => areas.some((a) => a.group === "custom" && a.readRule === "allow" && a.writeRule === "allow" && a.pattern === "~/Documents/always-proj/src"))`,
    ),
  ).toBe(true);
  socket.destroy();
  await app.close();
});

test("a secret request is high risk, never offers Always allow folder, focuses Deny on Enter, and Allow once writes no grant", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const askSecret = (id: string) =>
    socket.write(`${JSON.stringify({ id, request: { agent: "claude-code", event: "PreToolUse", tool: "Read", access: "read", paths: [join(home, ".ssh", "id_ed25519")], cwd: home } })}\n`);
  askSecret("e2e-secret-1");
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await expect(popup.getByText(/High risk/)).toBeVisible();
  await expect(popup.getByText(/ssh keys/i).first()).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Allow (once|this session|today)/ })).toHaveCount(3);
  await expect(popup.getByRole("button", { name: /^Always allow folder/ })).toHaveCount(0);
  await expect(popup.getByRole("group", { name: "Allow scope" })).toHaveCount(0);
  await expect(popup.getByRole("button", { name: /^Deny/ })).toBeFocused();
  if (process.env.SCREENSHOT) await popup.screenshot({ path: process.env.SCREENSHOT.replace(".png", "-secret.png") });
  await popup.waitForTimeout(700);
  await popup.keyboard.press("Enter");
  await expect(popup.getByRole("status").filter({ hasText: "Denied" })).toBeVisible();
  await popup.getByRole("button", { name: "Undo" }).click();
  askSecret("e2e-secret-2");
  await expect(popup.getByText(/High risk/)).toBeVisible();
  await popup.waitForTimeout(700);
  await popup.getByRole("button", { name: /^Allow once/ }).click();
  await expect(popup.getByText("No requests waiting.")).toBeVisible();
  expect(await win.evaluate(`window.leash.listGrants().then((rows) => rows.length)`)).toBe(0);
  socket.destroy();
  await app.close();
});

test("a denial can be undone, and denied requests show under Blocked until cleared", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const socket = connect(join(home, ".agentic-leash", "agentic-leash.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const docsDir = join(home, "Documents", "x");
  const ask = (id: string, path: string) =>
    socket.write(`${JSON.stringify({ id, request: { agent: "cursor", event: "preToolUse", tool: "Read", access: "read", paths: [path], cwd: docsDir, sessionId: "s1" } })}\n`);
  ask("e2e-deny", join(docsDir, "a.txt"));
  const popup = await app.waitForEvent("window", { predicate: (page) => page.url().includes("#/approval") });
  await popup.getByRole("button", { name: /^Deny/ }).click();
  await expect(popup.getByRole("status").filter({ hasText: "Denied" })).toBeVisible();
  const blocks = () => win.evaluate(`window.leash.listBlocks().then((b) => b.remembered.length + ":" + b.never.length)`);
  await expect.poll(blocks).toBe("1:0");
  await popup.getByRole("button", { name: "Undo" }).click();
  await expect.poll(blocks).toBe("0:0");

  ask("e2e-deny-2", join(docsDir, "b.txt"));
  await expect(popup.getByText("Cursor wants to read a file")).toBeVisible();
  await popup.getByRole("button", { name: /^Deny/ }).click();
  await expect.poll(blocks).toBe("1:0");
  await win.getByRole("link", { name: "Access", exact: true }).click();
  await win.getByRole("tab", { name: "Blocked" }).click();
  await expect(win.getByText(join(docsDir, "b.txt")).first()).toBeVisible();
  await win.getByRole("button", { name: "Clear all" }).click();
  await expect.poll(blocks).toBe("0:0");
  await expect(win.getByText("Nothing denied in the last 10 minutes.")).toBeVisible();
  socket.destroy();
  await app.close();
});

test("insights shows prompt stats and switches range", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.evaluate(`window.leash.createGrant({ agent: "*", path: "/tmp/leash-insights", access: "write", ttlSeconds: 3600 })`);
  await win.getByRole("link", { name: "Insights", exact: true }).click();
  await expect(win.getByRole("heading", { name: "Insights" })).toBeVisible();
  await expect(win.getByText("Prompts per day", { exact: true }).first()).toBeVisible();
  await expect(win.getByText("Prompts you answered per day")).toBeVisible();
  await win.getByRole("button", { name: "30 days" }).click();
  await expect(win.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(win.locator("table.sr-only tbody tr")).toHaveCount(30);
  if (process.env.SCREENSHOT) await win.screenshot({ path: process.env.SCREENSHOT.replace(".png", "-insights.png") });
  await app.close();
});

test("locking the Mac ends personal-folder grants by default", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  const home = await app.evaluate(() => process.env.AGENTIC_LEASH_HOME!);
  const paths = () => win.evaluate(`window.leash.listGrants().then((rows) => rows.map((row) => row.path).sort().join(","))`);
  const grant = (path: string, ttlSeconds: number | null) => win.evaluate(`window.leash.createGrant({ agent: "*", path: ${JSON.stringify(path)}, access: "read", ttlSeconds: ${ttlSeconds} })`);
  const lock = () => app.evaluate(({ powerMonitor }) => powerMonitor.emit("lock-screen"));
  await grant(join(home, "Documents", "taxes"), 600);
  await grant("/tmp/leash-lock-a", 600);
  await grant("/tmp/leash-lock-forever", null);
  await lock();
  await expect.poll(paths).toBe("/tmp/leash-lock-a,/tmp/leash-lock-forever");
  await app.close();
});

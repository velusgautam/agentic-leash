import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { insertEvents, openHistoryDb, writeHistoryStats } from "../../src/helper/historyDb";
import { launch } from "./launch";

test("General shows Open at login, disabled outside the installed app", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(win.getByText("Open at login")).toBeVisible();
  await expect(win.getByText("Available in the installed app.")).toBeVisible();
  await expect(win.getByRole("switch", { name: "Open at login" })).toBeDisabled();
  await expect(win.getByRole("button", { name: "Uninstall" })).toBeVisible();
  await win.getByRole("link", { name: "Monitoring & storage" }).click();
  await expect(win.getByRole("button", { name: "Available in the installed app" })).toHaveCount(2);
  await expect(win.getByRole("button", { name: "Granted" })).toHaveCount(0);
  await win.getByRole("link", { name: "Hidden from history", exact: true }).click();
  await expect(win.getByText("/.cursor/chats", { exact: true })).toBeVisible();
  const chats = win.getByRole("switch", { name: "/.cursor/chats" });
  await expect(chats).toBeChecked();
  await win.getByLabel("Hidden path").fill("scratch");
  await win.getByRole("button", { name: "Add", exact: true }).click();
  await expect(win.getByText("Use a full path, such as /tmp/scratch.")).toBeVisible();
  await win.getByLabel("Hidden path").fill("/tmp/scratch");
  await win.getByRole("button", { name: "Add", exact: true }).click();
  await expect(win.getByRole("cell", { name: "/tmp/scratch", exact: true })).toBeVisible();
  await expect(win.getByText("User-added hidden paths")).toBeVisible();
  await win.getByRole("button", { name: "Delete", exact: true }).click();
  await win.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(win.getByText("No user-added hidden paths yet.")).toBeVisible();
  await chats.click();
  await expect(chats).not.toBeChecked();
  await app.close();
});

function seedHistory(): string {
  const historyDir = mkdtempSync(join(tmpdir(), "al-history-optimize-"));
  const history = openHistoryDb(join(historyDir, "history.db"));
  const event = { agent: "cursor", pid: 1, exe: "cursor-agent", path: "/Users/me/project/a.ts", sensitive: false, source: "eslogger" } as const;
  insertEvents(history, [{ ...event, ts: 1, kind: "write", beforeBlob: "before", afterBlob: "after" }, { ...event, ts: 2, kind: "read" }]);
  history.prepare("INSERT INTO blobs (hash, size, data) VALUES ('old', 0, zeroblob(100000))").run();
  history.close();
  return historyDir;
}

async function openMonitoring(env: Record<string, string> = {}) {
  const app = await launch([], env);
  const win = await app.firstWindow();
  await win.getByRole("link", { name: "Settings", exact: true }).click();
  await win.getByRole("link", { name: "Monitoring & storage" }).click();
  return { app, win };
}

test("Monitoring compacts history after confirmation", async () => {
  const { app, win } = await openMonitoring({ AGENTIC_LEASH_HISTORY_DIR: seedHistory() });
  await expect(win.getByText(/History database is/)).toBeVisible();
  await win.getByRole("button", { name: "Clean up", exact: true }).click();
  const dialog = win.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Compact history?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Clean up", exact: true }).click();
  await expect(win.getByText(/Reduced history from/)).toBeVisible();
  await app.close();
});

test("Monitoring removes reads after confirmation", async () => {
  const { app, win } = await openMonitoring({ AGENTIC_LEASH_HISTORY_DIR: seedHistory() });
  await win.getByLabel("Cleanup").selectOption("reads");
  await win.getByRole("button", { name: "Clean up", exact: true }).click();
  const dialog = win.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Remove reads?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Clean up", exact: true }).click();
  await expect(win.getByText(/Reduced history from .* Removed 1 row\./)).toBeVisible();
  await app.close();
});

test("Monitoring keeps a valid history size limit", async () => {
  const { app, win } = await openMonitoring();
  await expect(win.getByText("Automatic cleanup starts at half this size. Default 10 GB.")).toBeVisible();
  const field = win.getByLabel("History size limit in GB");
  await expect(field).toHaveValue("10");
  await field.fill("0");
  await field.press("Enter");
  await expect(field).toHaveValue("10");
  await field.fill("5");
  await field.press("Enter");
  await expect(win.getByRole("alertdialog")).toHaveCount(0);
  await win.reload();
  await expect(win.getByLabel("History size limit in GB")).toHaveValue("5");
  await app.close();
});

const storageOffset = (win: Page) =>
  win.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find((el) => el.textContent === "Storage");
    let box = heading?.parentElement?.parentElement ?? null;
    while (box && !(box.scrollHeight > box.clientHeight + 10 && getComputedStyle(box).overflowY === "auto")) box = box.parentElement;
    return heading && box ? Math.round(heading.getBoundingClientRect().top - box.getBoundingClientRect().top) : 999;
  });

function seedStats(percent: number, hardCap = false): string {
  const historyDir = mkdtempSync(join(tmpdir(), "al-history-stats-"));
  const history = openHistoryDb(join(historyDir, "history.db"));
  const capBytes = 1024 ** 3;
  writeHistoryStats(history, { usedBytes: Math.ceil((capBytes * percent) / 100), fileBytes: capBytes, capBytes, counts: [], prunedAt: null, prunedRows: 0, hardCap });
  history.close();
  return historyDir;
}

test("Storage warning can be dismissed and stays dismissed", async () => {
  const app = await launch([], { AGENTIC_LEASH_HISTORY_DIR: seedStats(55) });
  const win = await app.firstWindow();
  const banner = win.getByRole("status").filter({ hasText: "History is using 55% of its 1 GB limit. Automatic cleanup is removing old reads first, then file changes and network activity if needed." });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Manage storage" }).click();
  await expect(win.getByRole("heading", { name: "Monitoring & storage" })).toBeVisible();
  await expect.poll(() => storageOffset(win)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => storageOffset(win)).toBeLessThan(60);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  await win.reload();
  await expect(win.getByRole("heading", { name: "Monitoring & storage" })).toBeVisible();
  await expect(win.getByText(/History is using/)).toHaveCount(0);
  await app.close();
});

for (const [width, height] of [[1100, 720], [840, 620]] as const) {
  test(`Manage storage lands on Storage at ${width}x${height}`, async () => {
    const app = await launch([], { AGENTIC_LEASH_HISTORY_DIR: seedStats(55) });
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), [width, height]);
    await win.getByRole("status").getByRole("button", { name: "Manage storage" }).click();
    await expect.poll(() => storageOffset(win)).toBeGreaterThanOrEqual(0);
    await expect.poll(() => storageOffset(win)).toBeLessThan(60);
    await app.close();
  });
}

test("Storage warning shows the 60% step", async () => {
  const app = await launch([], { AGENTIC_LEASH_HISTORY_DIR: seedStats(65) });
  const win = await app.firstWindow();
  const banner = win.getByRole("status").filter({ hasText: "History is using 65% of its 1 GB limit." });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await app.close();
});

test("Storage warning at the hard cap cannot be dismissed", async () => {
  const app = await launch([], { AGENTIC_LEASH_HISTORY_DIR: seedStats(85, true) });
  const win = await app.firstWindow();
  const banner = win.getByRole("status").filter({ hasText: "History is at its 1 GB limit. The oldest history, including sensitive files, is being deleted. Raise the limit or clean up to stop this." });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Manage storage" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await app.close();
});

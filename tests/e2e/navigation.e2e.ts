import { expect, test } from "@playwright/test";
import { launch } from "./launch";

const SECTIONS = ["General", "Agents", "Monitoring & storage", "Hidden from history", "Appearance", "Keybindings", "Diagnostics", "Licenses"];

test("sidebar navigates pages, agents and settings", async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await expect(win.getByText("Live activity")).toBeVisible();

  await win.getByRole("link", { name: "Access", exact: true }).click();
  await expect(win.getByText("No grants yet")).toBeVisible();

  await win.getByRole("link", { name: "History", exact: true }).click();
  await expect(win.getByText("No history yet")).toBeVisible();

  await win.getByRole("link", { name: "Claude", exact: true }).click();
  await expect(win.getByText("Folders", { exact: true })).toBeVisible();

  await win.getByRole("link", { name: "Settings", exact: true }).click();
  for (const name of SECTIONS) await expect(win.getByRole("link", { name, exact: true })).toBeVisible();

  await win.getByRole("link", { name: "Licenses", exact: true }).click();
  await expect(win.getByText("Copyright (c) 2026 T3 Tools Inc.")).toBeVisible();

  await win.getByRole("link", { name: "Back", exact: true }).click();
  await expect(win.getByText("Live activity")).toBeVisible();
  await app.close();
});

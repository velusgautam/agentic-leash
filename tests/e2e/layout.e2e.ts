import { expect, test } from "@playwright/test";
import { launch } from "./launch";

test("sidebar header and page header divider align across layouts and chrome states", async () => {
  const app = await launch();
  try {
    const win = await app.firstWindow();

    const measureAlignment = async () =>
      win.evaluate(() => {
        const sidebarHeader = document.querySelector('[data-slot="sidebar-header"]') as HTMLElement | null;
        const sidebarBorder = sidebarHeader?.querySelector(".border-b") as HTMLElement | null;
        const pageHeader = document.querySelector("main .border-b") as HTMLElement | null;
        const brandText = Array.from(sidebarHeader?.querySelectorAll("span") ?? []).find(
          (el) => el.textContent?.trim() === "Agentic Leash",
        ) as HTMLElement | undefined;

        const sidebarBottom = sidebarBorder?.getBoundingClientRect().bottom ?? -1;
        const pageBottom = pageHeader?.getBoundingClientRect().bottom ?? -2;
        const brandRect = brandText?.getBoundingClientRect();

        return {
          sidebarBottom,
          pageBottom,
          diff: Math.abs(sidebarBottom - pageBottom),
          brandTop: brandRect?.top ?? -1,
          brandTruncated: brandText ? brandText.scrollWidth > brandText.clientWidth + 1 : true,
        };
      });

    // 1. Default desktop size (windowed)
    await win.setViewportSize({ width: 1440, height: 900 });
    await expect(win.getByText("Live activity")).toBeVisible();
    let m = await measureAlignment();
    expect(m.diff).toBeLessThanOrEqual(1);
    expect(m.brandTop).toBeGreaterThanOrEqual(26);
    expect(m.brandTruncated).toBe(false);

    // 2. Narrower window size (1080x700)
    await win.setViewportSize({ width: 1080, height: 700 });
    m = await measureAlignment();
    expect(m.diff).toBeLessThanOrEqual(1);
    expect(m.brandTruncated).toBe(false);

    // 3. Fullscreen (top bar hidden)
    await win.evaluate(() => {
      window.dispatchEvent(new CustomEvent("leash:window-chrome", { detail: { fullScreen: true, topBarReveal: false } }));
    });
    await win.waitForTimeout(200);
    m = await measureAlignment();
    expect(m.diff).toBeLessThanOrEqual(1);
    expect(m.brandTruncated).toBe(false);

    // 4. Fullscreen (top bar revealed)
    await win.evaluate(() => {
      window.dispatchEvent(new CustomEvent("leash:window-chrome", { detail: { fullScreen: true, topBarReveal: true } }));
    });
    await win.waitForTimeout(250);
    m = await measureAlignment();
    expect(m.diff).toBeLessThanOrEqual(1);
    expect(m.sidebarBottom).toBeGreaterThanOrEqual(118);

    // Reset to windowed and check other routes (Access, History, Settings)
    await win.evaluate(() => {
      window.dispatchEvent(new CustomEvent("leash:window-chrome", { detail: { fullScreen: false, topBarReveal: false } }));
    });
    await win.waitForTimeout(200);

    for (const label of ["Access", "History", "Settings"]) {
      await win.getByRole("link", { name: label, exact: true }).click();
      await win.waitForTimeout(150);
      m = await measureAlignment();
      expect(m.diff).toBeLessThanOrEqual(1);
    }
  } finally {
    await app.close();
  }
});

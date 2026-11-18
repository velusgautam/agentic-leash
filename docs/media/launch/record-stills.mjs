import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const media = join(root, "..");
const useRaw = existsSync(join(media, "raw/boxes.json"));
const base = useRaw ? "../raw" : "../walkthrough";
const boxes = JSON.parse(readFileSync(join(media, useRaw ? "raw/boxes.json" : "walkthrough/boxes.json"), "utf8"));

const rect = (name, pad = 0) => {
  const b = boxes[name];
  if (!b) return null;
  return { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 };
};

const union = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

const shots = useRaw
  ? {
      "live-sensitive.png": {
        plate: "live-sensitive.png",
        focus: union(rect("sensitiveRow", 8), rect("sensitiveToggle", 8)),
      },
      "history-diff.png": {
        plate: "history-diff.png",
        focus: rect("historyDetail", 4),
      },
      "grants.png": {
        plate: "grants.png",
        focus: union(rect("grantControls", 8), rect("grantList", 8)),
      },
      "secure-areas.png": {
        plate: "secure-areas.png",
        focus: union(rect("secureAreasHeader", 8), rect("secureAreasLast", 8)),
      },
      "revoke.png": {
        plate: "revoke.png",
        focus: rect("revokeDialog", 8),
      },
      "approval.png": {
        plate: "live-sensitive.png",
        popup: "approval.png",
        focus: boxes.popupSize
          ? {
              x: (1440 - 520) / 2 - 14,
              y: (900 - (520 * boxes.popupSize.height) / boxes.popupSize.width) / 2 - 14,
              w: 520 + 28,
              h: (520 * boxes.popupSize.height) / boxes.popupSize.width + 28,
            }
          : { x: 444, y: 210, w: 552, h: 480 },
      },
      "appearance.png": {
        plate: "appearance.png",
        focus: union(rect("appearanceTheme", 8), rect("appearanceInterface", 8)),
      },
    }
  : (() => {
      const detail = rect("historyDetail");
      const appearance = union(rect("appearanceTheme", 8), rect("appearanceInterface", 8));
      return {
        "grants.png": { plate: "07-grants-sorted.png", focus: union(rect("grantControls", 6), rect("grantList", 8)) },
        "revoke.png": { plate: "10-revoke.png", focus: rect("revokeDialog", 8) },
        "history-diff.png": { plate: "08-history.png", focus: { x: detail.x + 4, y: detail.y + 4, w: detail.w - 10, h: 412 } },
        "live-sensitive.png": { plate: "09-sensitive.png", focus: union(rect("sensitiveRow", 6), rect("sensitiveToggle", 6)) },
        "approval.png": { plate: "03-live-b.png", popup: "05-approval-scope.png", focus: { x: 444, y: 229, w: 552, h: 442 } },
        "appearance.png": { plate: "12-appearance.png", focus: { ...appearance, y: appearance.y - 56, h: appearance.h + 56 } },
      };
    })();

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`file://${join(root, "stills.html")}`);

await page.evaluate(() => window.showBanner());
await page.locator("#banner").screenshot({ path: join(media, "banner.png") });

for (const [file, shot] of Object.entries(shots)) {
  await page.evaluate((value) => window.showShot(value), { dim: !shot.popup, base, ...shot });
  await page.locator("#shot").screenshot({ path: join(media, file) });
}
await browser.close();

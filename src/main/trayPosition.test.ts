import { describe, expect, it, vi } from "vitest";
import {
  applyTrayAutosave,
  DEFAULT_TRAY_PREFERRED_POSITION,
  resetTrayPosition,
  seedTrayPreferredPosition,
  TRAY_AUTOSAVE_NAME,
  type TrayDefaultsRunner,
} from "./trayPosition";

const EXPECTED_KEY = `NSStatusItem Preferred Position ${TRAY_AUTOSAVE_NAME}`;

function makeRunner(overrides?: Partial<TrayDefaultsRunner>): TrayDefaultsRunner {
  return {
    read: vi.fn().mockResolvedValue(null),
    writeFloat: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("applyTrayAutosave", () => {
  it("calls tray.setAutosaveName with TRAY_AUTOSAVE_NAME and returns true", () => {
    const setAutosaveName = vi.fn();
    expect(applyTrayAutosave({ setAutosaveName })).toBe(true);
    expect(setAutosaveName).toHaveBeenCalledOnce();
    expect(setAutosaveName).toHaveBeenCalledWith(TRAY_AUTOSAVE_NAME);
  });

  it("returns false when setAutosaveName is not present", () => {
    expect(applyTrayAutosave({})).toBe(false);
  });

  it("catches errors thrown by setAutosaveName and returns false", () => {
    const setAutosaveName = vi.fn(() => {
      throw new Error("boom");
    });
    expect(applyTrayAutosave({ setAutosaveName })).toBe(false);
  });
});

describe("seedTrayPreferredPosition", () => {
  it("seeds preferred position on macOS first launch when unset", async () => {
    const runner = makeRunner();
    const result = await seedTrayPreferredPosition({ platform: "darwin", runner });
    expect(result).toBe(true);
    expect(runner.read).toHaveBeenCalledWith("com.agenticleash.app", EXPECTED_KEY);
    expect(runner.writeFloat).toHaveBeenCalledWith(
      "com.agenticleash.app",
      EXPECTED_KEY,
      DEFAULT_TRAY_PREFERRED_POSITION,
    );
  });

  it("uses custom bundleId and position when provided", async () => {
    const runner = makeRunner();
    const result = await seedTrayPreferredPosition({
      platform: "darwin",
      bundleId: "com.example.custom",
      position: 250,
      runner,
    });
    expect(result).toBe(true);
    expect(runner.read).toHaveBeenCalledWith("com.example.custom", EXPECTED_KEY);
    expect(runner.writeFloat).toHaveBeenCalledWith("com.example.custom", EXPECTED_KEY, 250);
  });

  it("skips writing when preferred position is already set", async () => {
    const runner = makeRunner({
      read: vi.fn().mockResolvedValue("412.5"),
    });
    const result = await seedTrayPreferredPosition({ platform: "darwin", runner });
    expect(result).toBe(false);
    expect(runner.read).toHaveBeenCalledOnce();
    expect(runner.writeFloat).not.toHaveBeenCalled();
  });

  it("is a no-op on non-darwin platforms", async () => {
    const runner = makeRunner();
    expect(await seedTrayPreferredPosition({ platform: "linux", runner })).toBe(false);
    expect(await seedTrayPreferredPosition({ platform: "win32", runner })).toBe(false);
    expect(runner.read).not.toHaveBeenCalled();
    expect(runner.writeFloat).not.toHaveBeenCalled();
  });

  it("returns false without throwing when runner rejects", async () => {
    const runner = makeRunner({
      read: vi.fn().mockRejectedValue(new Error("defaults failed")),
    });
    expect(await seedTrayPreferredPosition({ platform: "darwin", runner })).toBe(false);
  });
});

describe("resetTrayPosition", () => {
  it("unconditionally writes preferred position on macOS", async () => {
    const runner = makeRunner({
      read: vi.fn().mockResolvedValue("999"),
    });
    const result = await resetTrayPosition({ platform: "darwin", runner });
    expect(result).toBe(true);
    expect(runner.read).not.toHaveBeenCalled();
    expect(runner.writeFloat).toHaveBeenCalledWith(
      "com.agenticleash.app",
      EXPECTED_KEY,
      DEFAULT_TRAY_PREFERRED_POSITION,
    );
  });

  it("is a no-op on non-darwin platforms", async () => {
    const runner = makeRunner();
    expect(await resetTrayPosition({ platform: "linux", runner })).toBe(false);
    expect(runner.writeFloat).not.toHaveBeenCalled();
  });

  it("returns false without throwing when writeFloat rejects", async () => {
    const runner = makeRunner({
      writeFloat: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    expect(await resetTrayPosition({ platform: "darwin", runner })).toBe(false);
  });
});

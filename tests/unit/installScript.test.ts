import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "../../scripts/install.sh");

describe("scripts/install.sh", () => {
  it("prints usage and exits 0 with --help", () => {
    const res = spawnSync("bash", [scriptPath, "--help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: install.sh [options]");
    expect(res.stdout).toContain("--dir <path>");
    expect(res.stdout).toContain("--version <ver>");
  });

  it("rejects Intel macOS builds with a clear message", () => {
    const res = spawnSync("bash", [scriptPath, "--version", "0.3.0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTIC_LEASH_TEST_OS: "Darwin",
        AGENTIC_LEASH_TEST_ARCH: "x86_64",
      },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Apple Silicon (arm64)");
  });

  it("rejects non-macOS operating systems", () => {
    const res = spawnSync("bash", [scriptPath, "--version", "0.4.0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTIC_LEASH_TEST_OS: "Linux",
        AGENTIC_LEASH_TEST_ARCH: "x86_64",
      },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("requires macOS");
  });

  it("fails when SHA256SUMS does not match the downloaded macOS disk image", () => {
    const root = mkdtempSync(join(tmpdir(), "leash-install-badsum-"));
    const releaseDir = join(root, "releases", "v0.4.0");
    const installDir = join(root, "Applications");
    mkdirSync(releaseDir, { recursive: true });

    const artifactName = "Agentic.Leash-0.4.0-arm64.dmg";
    writeFileSync(join(releaseDir, artifactName), "tampered-dmg");
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      `${"0".repeat(64)}  ${artifactName}\n`,
    );

    const res = spawnSync("bash", [scriptPath, "--version", "0.4.0", "--dir", installDir], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTIC_LEASH_TEST_OS: "Darwin",
        AGENTIC_LEASH_TEST_ARCH: "arm64",
        AGENTIC_LEASH_RELEASE_BASE_URL: `file://${join(root, "releases")}`,
      },
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");
    expect(existsSync(join(installDir, "Agentic Leash.app"))).toBe(false);
  });

  it("is marked executable", () => {
    chmodSync(scriptPath, 0o755);
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("includes kickstart command for helper daemon when present and passwordless sudo is available", () => {
    const text = readFileSync(scriptPath, "utf8");
    expect(text).toContain("/Library/LaunchDaemons/com.agenticleash.helper.plist");
    expect(text).toContain("sudo -n true");
    expect(text).toContain("sudo launchctl kickstart -k system/com.agenticleash.helper");
  });
});

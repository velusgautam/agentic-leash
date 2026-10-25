import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "../../scripts/install.sh");

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

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

  it("installs the Linux AppImage and verifies SHA256SUMS from a release feed", () => {
    const root = mkdtempSync(join(tmpdir(), "leash-install-test-"));
    const releaseDir = join(root, "releases", "v0.4.0");
    const installDir = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const binaryContent = "#!/bin/sh\necho 'Agentic Leash 0.4.0'\n";
    const artifactName = "Agentic.Leash-0.4.0-linux-x86_64.AppImage";
    writeFileSync(join(releaseDir, artifactName), binaryContent);
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      `${sha256(binaryContent)}  ${artifactName}\n`,
    );

    const apiJson = join(root, "latest.json");
    writeFileSync(apiJson, JSON.stringify({ tag_name: "v0.4.0" }));

    const res = spawnSync("bash", [scriptPath, "--dir", installDir], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTIC_LEASH_TEST_OS: "Linux",
        AGENTIC_LEASH_TEST_ARCH: "x86_64",
        AGENTIC_LEASH_RELEASES_API_URL: `file://${apiJson}`,
        AGENTIC_LEASH_RELEASE_BASE_URL: `file://${join(root, "releases")}`,
      },
    });

    expect(res.status).toBe(0);
    const installedPath = join(installDir, "agentic-leash");
    expect(existsSync(installedPath)).toBe(true);
    expect(readFileSync(installedPath, "utf8")).toBe(binaryContent);
  });

  it("fails when SHA256SUMS does not match the downloaded artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "leash-install-badsum-"));
    const releaseDir = join(root, "releases", "v0.4.0");
    const installDir = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const artifactName = "Agentic.Leash-0.4.0-linux-x86_64.AppImage";
    writeFileSync(join(releaseDir, artifactName), "tampered-binary");
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      `${"0".repeat(64)}  ${artifactName}\n`,
    );

    const res = spawnSync("bash", [scriptPath, "--version", "0.4.0", "--dir", installDir], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTIC_LEASH_TEST_OS: "Linux",
        AGENTIC_LEASH_TEST_ARCH: "x86_64",
        AGENTIC_LEASH_RELEASE_BASE_URL: `file://${join(root, "releases")}`,
      },
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");
    expect(existsSync(join(installDir, "agentic-leash"))).toBe(false);
  });

  it("is marked executable", () => {
    chmodSync(scriptPath, 0o755);
    expect(existsSync(scriptPath)).toBe(true);
  });
});

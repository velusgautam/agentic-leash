import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const SECRET_PATTERNS: RegExp[] = [
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{4,}/,
  /\bghp_[A-Za-z0-9_]{4,}/,
  /\bgithub_pat_[A-Za-z0-9_]{4,}/,
  /\bAKIA[A-Za-z0-9]{4,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{4,}/,
  /\bAIza[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
];

/** Returns true if `text` contains a recognizable API key, token, or private key header. */
export function containsSecretPattern(text: string): boolean {
  if (!text) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reads up to `maxBytes` (default 64 KiB) from `filePath` and checks for secret patterns.
 * Never throws on missing, directory, or unreadable files.
 */
export function scanFileForSecrets(filePath: string, maxBytes = 65536): boolean {
  if (!filePath || maxBytes <= 0) return false;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return false;
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, 0);
    if (bytesRead <= 0) return false;
    return containsSecretPattern(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore close errors */
      }
    }
  }
}

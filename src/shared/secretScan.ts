import { KNOWN_SECRET_RULES, scanFileForFindings, scanTextForFindings } from "./contentScan";

export const SECRET_PATTERNS: RegExp[] = KNOWN_SECRET_RULES.map(
  (rule) => new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")),
);

const SECRET_ONLY_CATEGORIES = {
  secret: true,
  pci: false,
  pii: false,
  phi: false,
} as const;

/** Returns true if `text` contains a recognizable API key, token, high-entropy secret, or private key header. */
export function containsSecretPattern(text: string): boolean {
  if (!text) return false;
  return scanTextForFindings(text, { categories: SECRET_ONLY_CATEGORIES }).length > 0;
}

/**
 * Reads up to `maxBytes` (default 64 KiB) from `filePath` and checks for secret patterns.
 * Never throws on missing, directory, binary, or unreadable files.
 */
export function scanFileForSecrets(filePath: string, maxBytes = 65536): boolean {
  return scanFileForFindings(filePath, { categories: SECRET_ONLY_CATEGORIES, maxBytes }).length > 0;
}

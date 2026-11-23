import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type FindingCategory = "secret" | "pci" | "pii" | "phi";
export type FindingSeverity = "high" | "medium" | "low";

export interface ContentFinding {
  ruleId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  label: string;
  preview: string;
  valueHash: string;
}

export interface ContentScanOptions {
  categories?: Partial<Record<FindingCategory, boolean>>;
  exceptionHashes?: Set<string>;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 65536;
const ENTROPY_THRESHOLD = 4.0;

/** Computes Shannon entropy (bits per character) for `input`. */
export function shannonEntropy(input: string): number {
  if (!input) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const len = input.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Validates a digit string (allowing spaces/hyphens) using the Luhn checksum algorithm. */
export function isValidLuhn(digits: string): boolean {
  const normalized = digits.replace(/[\s-]/g, "");
  if (!/^\d{2,}$/.test(normalized)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = normalized.length - 1; i >= 0; i--) {
    let d = normalized.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** Validates an IBAN using ISO 13616 length/format rules and mod-97 checksum. */
export function isValidIban(iban: string): boolean {
  const normalized = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;

  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      const val = code - 55; // A=10 .. Z=35
      remainder = (remainder * 10 + Math.floor(val / 10)) % 97;
      remainder = (remainder * 10 + (val % 10)) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

/** Returns the SHA-256 hex digest of `value`. */
export function hashFindingValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns a safe masked preview (first 4 + last 3 chars when long, or `••••` + 4-char hash tag). */
export function maskFindingPreview(value: string): string {
  if (value.length >= 12) {
    return `${value.slice(0, 4)}••••${value.slice(-3)}`;
  }
  return `••••${hashFindingValue(value).slice(0, 4)}`;
}

interface SecretRule {
  ruleId: string;
  label: string;
  pattern: RegExp;
}

export const KNOWN_SECRET_RULES: readonly SecretRule[] = [
  {
    ruleId: "anthropic_api_key",
    label: "Anthropic API Key",
    pattern: /(?<![A-Za-z0-9])(sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{8,})/g,
  },
  {
    ruleId: "openai_api_key",
    label: "OpenAI API Key",
    pattern: /(?<![A-Za-z0-9])(sk-(?!ant-)[A-Za-z0-9_-]{10,})/g,
  },
  {
    ruleId: "aws_access_key",
    label: "AWS Access Key ID",
    pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  },
  {
    ruleId: "github_token",
    label: "GitHub Token",
    pattern: /\b((?:ghp|gho|ghs)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
  },
  {
    ruleId: "stripe_key",
    label: "Stripe Secret Key",
    pattern: /\b([sr]k_live_[A-Za-z0-9]{10,})\b/g,
  },
  {
    ruleId: "slack_token",
    label: "Slack Token",
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  },
  {
    ruleId: "google_api_key",
    label: "Google API Key",
    pattern: /\b(AIza[A-Za-z0-9_-]{12,})\b/g,
  },
  {
    ruleId: "sendgrid_api_key",
    label: "SendGrid API Key",
    pattern: /\b(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    ruleId: "npm_token",
    label: "npm Access Token",
    pattern: /\b(npm_[A-Za-z0-9]{10,})\b/g,
  },
  {
    ruleId: "pypi_token",
    label: "PyPI API Token",
    pattern: /\b(pypi-[A-Za-z0-9_-]{12,})\b/g,
  },
  {
    ruleId: "db_connection_string",
    label: "Database Connection String",
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@'"]+:[^@\s'"]+@[^\s'"<>]+)/gi,
  },
  {
    ruleId: "jwt_token",
    label: "JSON Web Token (JWT)",
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})\b/g,
  },
  {
    ruleId: "private_key",
    label: "PEM Private Key",
    pattern: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/g,
  },
];

const ENTROPY_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|auth[_-]?token)[A-Za-z0-9_.-]*)['"]?\s*[:=]\s*['"]?([A-Za-z0-9+/=_-]{20,})['"]?/gi;
const PLACEHOLDER_RE = /(?:example|changeme|change[_-]?me|your[_-]|placeholder|dummy|sample|replace[_-]?me|xxxx+)/i;
const REPEATED_CHAR_RE = /(.)\1{4,}/;
const PURE_HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const NON_SECRET_SHA_KEY_RE = /(?:sha|commit|hash|digest|checksum|git|rev|etag)/i;
const STRONG_SECRET_KEY_RE = /(?:api[_-]?key|secret|password|passwd|auth[_-]?token)$/i;

const CREDIT_CARD_RE = /(?<![\d.-])\b(\d(?:[ -]?\d){12,18})\b(?![\d.-])/g;
const IBAN_CANDIDATE_RE = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30})\b/g;
const SSN_RE = /\b(\d{3}-\d{2}-\d{4})\b/g;
const LABELED_PHONE_RE =
  /\b(?:phone(?:[_\s-]?number)?|tel(?:ephone)?|mobile|cell|fax)\s*[:=#-]\s*['"]?((?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4})['"]?(?!\d)\b/gi;
const MRN_RE = /\bMRN[:#\s-]+(\d{6,10})\b/gi;
const ICD10_RE = /\b(?:ICD-?10|diagnosis)[:#\s-]+([A-TV-Z]\d{2}(?:\.\d{1,4})?)\b/gi;

function isCategoryEnabled(category: FindingCategory, opts?: ContentScanOptions): boolean {
  const cats = opts?.categories;
  if (!cats) return true;
  const values = Object.values(cats).filter((v): v is boolean => v !== undefined);
  if (values.length === 0) return true;
  if (values.every((v) => v === true)) {
    return cats[category] === true;
  }
  return cats[category] !== false;
}

function isLikelyPlaceholderSecret(keyName: string, value: string): boolean {
  if (PLACEHOLDER_RE.test(value) || REPEATED_CHAR_RE.test(value)) return true;
  if (PURE_HEX_SHA_RE.test(value)) {
    if (NON_SECRET_SHA_KEY_RE.test(keyName)) return true;
    if (!STRONG_SECRET_KEY_RE.test(keyName)) return true;
  }
  return false;
}

function isLikelyTimestampOrNonCard(raw: string, digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  // ISO-like date/time fragments such as 2026-11-23-123456
  if (/^(?:19|20)\d{2}[- ](?:0[1-9]|1[0-2])[- ](?:0[1-9]|[12]\d|3[01])/.test(raw)) return true;
  // Unseparated 13-digit Unix epoch ms timestamps (1400000000000 .. 2099999999999)
  if (!/[\s-]/.test(raw) && digits.length === 13 && /^(?:1[4-9]|20)\d{11}$/.test(digits)) return true;
  // Unseparated 14-digit YYYYMMDDHHMMSS timestamps
  if (
    !/[\s-]/.test(raw) &&
    digits.length === 14 &&
    /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(digits)
  ) {
    return true;
  }
  return false;
}

function isValidUsSsn(ssn: string): boolean {
  const [area, group, serial] = ssn.split("-");
  if (!area || !group || !serial) return false;
  if (area === "000" || area === "666" || area.startsWith("9")) return false;
  if (group === "00" || serial === "0000") return false;
  return true;
}

/** Scans `text` for secrets, PCI, PII, and PHI findings with deduplication and exception filtering. */
export function scanTextForFindings(text: string, opts?: ContentScanOptions): ContentFinding[] {
  if (!text) return [];

  const findings: ContentFinding[] = [];
  const seen = new Set<string>();
  const matchedSecretHashes = new Set<string>();
  const exceptions = opts?.exceptionHashes;

  const pushFinding = (
    ruleId: string,
    category: FindingCategory,
    severity: FindingSeverity,
    label: string,
    value: string,
  ): string => {
    const valueHash = hashFindingValue(value);
    if (exceptions?.has(valueHash)) return valueHash;
    const key = `${ruleId}:${valueHash}`;
    if (seen.has(key)) return valueHash;
    seen.add(key);
    findings.push({
      ruleId,
      category,
      severity,
      label,
      preview: maskFindingPreview(value),
      valueHash,
    });
    return valueHash;
  };

  if (isCategoryEnabled("secret", opts)) {
    for (const rule of KNOWN_SECRET_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      for (const match of text.matchAll(re)) {
        const value = match[1] ?? match[0];
        if (!value) continue;
        // Skip template variables like postgres://user:${PASS}@host in DB connection strings
        if (rule.ruleId === "db_connection_string" && /\$\{[^}]+\}|<[^>]+>/.test(value)) continue;
        const hash = pushFinding(rule.ruleId, "secret", "high", rule.label, value);
        matchedSecretHashes.add(hash);
      }
    }

    const entropyRe = new RegExp(ENTROPY_ASSIGNMENT_RE.source, ENTROPY_ASSIGNMENT_RE.flags);
    for (const match of text.matchAll(entropyRe)) {
      const keyName = match[1] ?? "";
      const value = match[2] ?? "";
      if (!value || isLikelyPlaceholderSecret(keyName, value)) continue;
      if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
      const valueHash = hashFindingValue(value);
      if (matchedSecretHashes.has(valueHash)) continue;
      pushFinding("high_entropy_secret", "secret", "high", "High-Entropy Secret", value);
    }
  }

  if (isCategoryEnabled("pci", opts)) {
    const ccRe = new RegExp(CREDIT_CARD_RE.source, CREDIT_CARD_RE.flags);
    for (const match of text.matchAll(ccRe)) {
      const raw = match[1] ?? match[0];
      const digits = raw.replace(/[\s-]/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      if (isLikelyTimestampOrNonCard(raw, digits)) continue;
      if (!isValidLuhn(digits)) continue;
      pushFinding("credit_card", "pci", "high", "Credit Card Number", raw);
    }

    const ibanRe = new RegExp(IBAN_CANDIDATE_RE.source, IBAN_CANDIDATE_RE.flags);
    for (const match of text.matchAll(ibanRe)) {
      const raw = match[1] ?? match[0];
      if (!isValidIban(raw)) continue;
      pushFinding("iban", "pci", "high", "IBAN", raw);
    }
  }

  if (isCategoryEnabled("pii", opts)) {
    const ssnRe = new RegExp(SSN_RE.source, SSN_RE.flags);
    for (const match of text.matchAll(ssnRe)) {
      const ssn = match[1] ?? match[0];
      if (!isValidUsSsn(ssn)) continue;
      pushFinding("us_ssn", "pii", "medium", "US Social Security Number", ssn);
    }

    const phoneRe = new RegExp(LABELED_PHONE_RE.source, LABELED_PHONE_RE.flags);
    for (const match of text.matchAll(phoneRe)) {
      const phone = match[1];
      if (!phone) continue;
      pushFinding("phone_number", "pii", "medium", "Phone Number", phone);
    }
  }

  if (isCategoryEnabled("phi", opts)) {
    const mrnRe = new RegExp(MRN_RE.source, MRN_RE.flags);
    for (const match of text.matchAll(mrnRe)) {
      const mrn = match[1];
      if (!mrn) continue;
      pushFinding("mrn", "phi", "medium", "Medical Record Number", mrn);
    }

    const icdRe = new RegExp(ICD10_RE.source, ICD10_RE.flags);
    for (const match of text.matchAll(icdRe)) {
      const code = match[1];
      if (!code) continue;
      pushFinding("icd10_code", "phi", "medium", "ICD-10 Diagnosis Code", code);
    }
  }

  return findings;
}

/**
 * Reads up to `opts?.maxBytes ?? 65536` bytes from `filePath` and scans for findings.
 * Safely returns `[]` on missing, binary (NUL-byte), directory, or unreadable files.
 */
export function scanFileForFindings(filePath: string, opts?: ContentScanOptions): ContentFinding[] {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!filePath || maxBytes <= 0) return [];

  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return [];
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, 0);
    if (bytesRead <= 0) return [];
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) return [];
    return scanTextForFindings(slice.toString("utf8"), opts);
  } catch {
    return [];
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

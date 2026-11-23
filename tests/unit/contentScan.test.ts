import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashFindingValue,
  isValidIban,
  isValidLuhn,
  maskFindingPreview,
  scanFileForFindings,
  scanTextForFindings,
  shannonEntropy,
} from "../../src/shared/contentScan";
import { containsSecretPattern, scanFileForSecrets, SECRET_PATTERNS } from "../../src/shared/secretScan";

describe("contentScan helpers", () => {
  it("computes Shannon entropy accurately", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaaaaaaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBeCloseTo(1, 5);
    expect(shannonEntropy("Kj8mP2xQ9vL4nR7wZ1fT5yB3cH6dG0s")).toBeGreaterThanOrEqual(4.0);
  });

  it("hashes values with SHA-256 and masks previews safely", () => {
    const secret = "sk-proj-abc123def456ghi789";
    const hash = hashFindingValue(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(maskFindingPreview(secret)).toBe("sk-p••••789");
    expect(maskFindingPreview(secret)).not.toContain("abc123def456");

    const shortVal = "E11.9";
    const shortPreview = maskFindingPreview(shortVal);
    expect(shortPreview).toBe(`••••${hashFindingValue(shortVal).slice(0, 4)}`);
    expect(shortPreview).not.toContain("E11.9");
  });

  it("validates Luhn checksums correctly", () => {
    expect(isValidLuhn("4532015112830366")).toBe(true);
    expect(isValidLuhn("4532 0151 1283 0366")).toBe(true);
    expect(isValidLuhn("4532-0151-1283-0366")).toBe(true);
    expect(isValidLuhn("79927398713")).toBe(true);
    expect(isValidLuhn("4532015112830367")).toBe(false);
    expect(isValidLuhn("4532-abcd-1283-0366")).toBe(false);
    expect(isValidLuhn("4")).toBe(false);
  });

  it("validates IBAN ISO 13616 mod-97 checksums correctly", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
    expect(isValidIban("FR1420041010050500013M02606")).toBe(true);
    expect(isValidIban("DE00 3704 0044 0532 0130 00")).toBe(false);
    expect(isValidIban("GB82WEST12345698765433")).toBe(false);
    expect(isValidIban("NOTANIBAN")).toBe(false);
  });
});

describe("scanTextForFindings: secrets", () => {
  it("detects all supported provider secrets, DB URLs, JWTs, and PEM private keys", () => {
    const sampleJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const text = [
      "OPENAI=sk-proj1234567890abcdef",
      "ANTHROPIC=sk-ant-api03-1234567890abcdef",
      "AWS1=AKIAIOSFODNN7EXAMPLE",
      "AWS2=ASIAIOSFODNN7EXAMPLE",
      "GH1=ghp_1234567890abcdef",
      "GH2=gho_1234567890abcdef",
      "GH3=ghs_1234567890abcdef",
      "GH4=github_pat_11ABCDEF123456",
      "STRIPE1=sk_live_1234567890abcdef",
      "STRIPE2=rk_live_1234567890abcdef",
      "SLACK=xoxb-1234567890-abcdef",
      "GOOGLE=AIzaSyDummyKey12345678",
      "SENDGRID=SG.abcdefghijklmnop.qrstuvwxyz1234567890",
      "NPM=npm_1234567890abcdef",
      "PYPI=pypi-AgEIcHlwaS5vcmc1234567890",
      "PG=postgresql://admin:s3cr3tPass@db.internal:5432/prod",
      "MONGO=mongodb+srv://app:passw0rd99@cluster0.example.net/db",
      "REDIS=redis://default:r3d1sSecret@cache.internal:6379",
      `JWT=${sampleJwt}`,
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const findings = scanTextForFindings(text);
    const rules = new Set(findings.map((f) => f.ruleId));

    expect(rules.has("openai_api_key")).toBe(true);
    expect(rules.has("anthropic_api_key")).toBe(true);
    expect(rules.has("aws_access_key")).toBe(true);
    expect(rules.has("github_token")).toBe(true);
    expect(rules.has("stripe_key")).toBe(true);
    expect(rules.has("slack_token")).toBe(true);
    expect(rules.has("google_api_key")).toBe(true);
    expect(rules.has("sendgrid_api_key")).toBe(true);
    expect(rules.has("npm_token")).toBe(true);
    expect(rules.has("pypi_token")).toBe(true);
    expect(rules.has("db_connection_string")).toBe(true);
    expect(rules.has("jwt_token")).toBe(true);
    expect(rules.has("private_key")).toBe(true);
    // Known provider secrets should not also double-report as high_entropy_secret
    expect(rules.has("high_entropy_secret")).toBe(false);
    expect(findings.every((f) => f.category === "secret" && f.severity === "high")).toBe(true);
  });

  it("does not misclassify Anthropic keys as OpenAI keys", () => {
    const findings = scanTextForFindings("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij1234567890");
    expect(findings.map((f) => f.ruleId)).toEqual(["anthropic_api_key"]);
  });

  it("detects high-entropy assignment secrets and ignores placeholders and git SHAs", () => {
    const truePositives = [
      'api_key = "Kj8mP2xQ9vL4nR7wZ1fT5yB3cH6dG0s"',
      '{"client_secret": "Q9wE2rT5yU8iO1pA4sD7fG0hJ3kL6zX9"}',
      "auth_token=N7bV4cX1zM9lK6jH3gF0dS8aP5oI2uY4",
    ].join("\n");

    const tpFindings = scanTextForFindings(truePositives);
    expect(tpFindings).toHaveLength(3);
    expect(tpFindings.every((f) => f.ruleId === "high_entropy_secret")).toBe(true);

    const falsePositives = [
      'api_key = "example_api_key_placeholder_12345"',
      'password = "changeme_please_right_now_12345"',
      'secret = "your_secret_value_goes_here_123"',
      'token = "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"',
      'api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      "token = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "commit_sha_token = 0123456789abcdef0123456789abcdef01234567",
      "const runner = 'task-runner';",
      "DATABASE_URL=postgres://user:${DB_PASS}@localhost:5432/app",
      "DATABASE_URL=postgres://localhost:5432/app",
    ].join("\n");

    expect(scanTextForFindings(falsePositives)).toEqual([]);
  });
});

describe("scanTextForFindings: PCI, PII, PHI", () => {
  it("detects Luhn-valid credit cards and rejects invalid ones, all-same digits, and timestamps", () => {
    const text = [
      "card1: 4532 0151 1283 0366",
      "card2: 5425-2334-3010-9903",
      "invalid_luhn: 4532 0151 1283 0367",
      "all_zeros: 0000 0000 0000 0000",
      "all_fours: 4444-4444-4444-4444",
      "epoch_ms_luhn_passing: 1700000000005",
      "iso_ts: 2026-11-23-123456",
      "compact_ts: 20261123220000",
    ].join("\n");

    const findings = scanTextForFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.ruleId === "credit_card" && f.category === "pci" && f.severity === "high")).toBe(
      true,
    );
  });

  it("detects valid IBANs and ignores invalid mod-97 IBANs", () => {
    const text = "wire to DE89 3704 0044 0532 0130 00 or bad DE00 3704 0044 0532 0130 00";
    const findings = scanTextForFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("iban");
    expect(findings[0].category).toBe("pci");
    expect(findings[0].valueHash).toBe(hashFindingValue("DE89 3704 0044 0532 0130 00"));
  });

  it("detects valid US SSNs and labeled phone numbers without noisy unlabeled false positives", () => {
    const text = [
      "valid_ssn=123-45-6789",
      "bad_000=000-12-3456",
      "bad_666=666-12-3456",
      "bad_9xx=912-34-5678",
      "bad_group=123-00-6789",
      "bad_serial=123-45-0000",
      "phone: +1 (415) 555-0199",
      "unlabeled_code_numbers: 415-555-0199",
    ].join("\n");

    const findings = scanTextForFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.ruleId).sort()).toEqual(["phone_number", "us_ssn"]);
    expect(findings.every((f) => f.category === "pii" && f.severity === "medium")).toBe(true);
  });

  it("detects PHI MRN and labeled ICD-10 diagnosis codes", () => {
    const text = [
      "Patient MRN: 12345678",
      "ICD-10: E11.9",
      "Diagnosis: J45.20",
      "unlabeled_code: E11.9",
    ].join("\n");

    const findings = scanTextForFindings(text);
    expect(findings).toHaveLength(3);
    expect(findings.filter((f) => f.ruleId === "mrn")).toHaveLength(1);
    expect(findings.filter((f) => f.ruleId === "icd10_code")).toHaveLength(2);
    expect(findings.every((f) => f.category === "phi" && f.severity === "medium")).toBe(true);
  });
});

describe("deduplication, options, file scanning, and secretScan compatibility", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-contentscan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates by ruleId + valueHash and respects exceptionHashes and category filters", () => {
    const key = "ghp_1234567890abcdef";
    const ssn = "123-45-6789";
    const text = `${key}\n${key}\n${ssn}`;

    const all = scanTextForFindings(text);
    expect(all).toHaveLength(2);

    const suppressed = scanTextForFindings(text, {
      exceptionHashes: new Set([hashFindingValue(key)]),
    });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].ruleId).toBe("us_ssn");

    const noPii = scanTextForFindings(text, { categories: { pii: false } });
    expect(noPii).toHaveLength(1);
    expect(noPii[0].ruleId).toBe("github_token");

    const onlyPii = scanTextForFindings(text, { categories: { pii: true } });
    expect(onlyPii).toHaveLength(1);
    expect(onlyPii[0].ruleId).toBe("us_ssn");
  });

  it("scans files up to maxBytes and safely returns [] for missing, directory, or binary files", () => {
    const secretFile = join(dir, "env.txt");
    writeFileSync(secretFile, "STRIPE=sk_live_1234567890abcdef\n");
    expect(scanFileForFindings(secretFile)).toHaveLength(1);

    const beyondLimit = join(dir, "large.txt");
    writeFileSync(beyondLimit, `${"x".repeat(200)} ghp_1234567890abcdef`);
    expect(scanFileForFindings(beyondLimit, { maxBytes: 100 })).toEqual([]);
    expect(scanFileForFindings(beyondLimit, { maxBytes: 300 })).toHaveLength(1);

    const binaryFile = join(dir, "image.bin");
    writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from("sk-proj1234567890")]));
    expect(scanFileForFindings(binaryFile)).toEqual([]);

    expect(scanFileForFindings(join(dir, "missing.txt"))).toEqual([]);
    expect(scanFileForFindings(dir)).toEqual([]);
  });

  it("keeps secretScan.ts backwards-compatible", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(7);
    expect(containsSecretPattern("OPENAI_API_KEY=sk-proj1234567890")).toBe(true);
    expect(containsSecretPattern("SSN=123-45-6789")).toBe(false);

    const file = join(dir, "creds.txt");
    writeFileSync(file, "NPM_TOKEN=npm_1234567890abcdef\n");
    expect(scanFileForSecrets(file)).toBe(true);
  });
});

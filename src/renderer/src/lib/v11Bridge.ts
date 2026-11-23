import type {
  ContentGuardSettings,
  DecisionRow,
  FindingRow,
  ValueExceptionRow,
} from "../../../shared/types";

export type AllowDeniedDecisionMode =
  | "allow_path"
  | "allow_command"
  | "trust_host"
  | "relax_secure_area";

export interface AllowDeniedDecisionResult {
  ok: boolean;
  action: string;
  detail?: string;
}

export interface AddValueExceptionInput {
  valueHash: string;
  preview: string;
  label: string;
  note?: string;
}

export const DEFAULT_CONTENT_GUARD_SETTINGS: ContentGuardSettings = {
  secrets: "ask",
  pci: "ask",
  pii: "warn",
  phi: "warn",
  pipeToShell: true,
};

export const DEFAULT_TRUSTED_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "gist.github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "proxy.golang.org",
  "localhost",
  "127.0.0.1",
];

interface V11LeashMethods {
  getContentGuardSettings(): Promise<ContentGuardSettings>;
  setContentGuardSettings(patch: Partial<ContentGuardSettings>): Promise<ContentGuardSettings>;
  getTrustedHosts(): Promise<string[]>;
  setTrustedHosts(hosts: string[]): Promise<string[]>;
  listFindings(limit?: number): Promise<FindingRow[]>;
  clearFindings(): Promise<void>;
  listValueExceptions(): Promise<ValueExceptionRow[]>;
  addValueException(input: AddValueExceptionInput): Promise<ValueExceptionRow>;
  deleteValueException(id: number): Promise<void>;
  listDeniedDecisions(limit?: number): Promise<DecisionRow[]>;
  allowDeniedDecision(
    id: number,
    mode?: AllowDeniedDecisionMode,
  ): Promise<AllowDeniedDecisionResult>;
  resetTrayPosition(): Promise<boolean>;
}

function getRawLeash(): Partial<V11LeashMethods> | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { leash?: unknown }).leash as Partial<V11LeashMethods> | undefined;
}

export const v11Bridge: V11LeashMethods = {
  async getContentGuardSettings() {
    const fn = getRawLeash()?.getContentGuardSettings;
    if (typeof fn !== "function") return { ...DEFAULT_CONTENT_GUARD_SETTINGS };
    return fn();
  },

  async setContentGuardSettings(patch) {
    const fn = getRawLeash()?.setContentGuardSettings;
    if (typeof fn !== "function") return { ...DEFAULT_CONTENT_GUARD_SETTINGS, ...patch };
    return fn(patch);
  },

  async getTrustedHosts() {
    const fn = getRawLeash()?.getTrustedHosts;
    if (typeof fn !== "function") return [...DEFAULT_TRUSTED_HOSTS];
    return fn();
  },

  async setTrustedHosts(hosts) {
    const fn = getRawLeash()?.setTrustedHosts;
    if (typeof fn !== "function") return [...hosts];
    return fn(hosts);
  },

  async listFindings(limit) {
    const fn = getRawLeash()?.listFindings;
    if (typeof fn !== "function") return [];
    return fn(limit);
  },

  async clearFindings() {
    const fn = getRawLeash()?.clearFindings;
    if (typeof fn !== "function") return;
    return fn();
  },

  async listValueExceptions() {
    const fn = getRawLeash()?.listValueExceptions;
    if (typeof fn !== "function") return [];
    return fn();
  },

  async addValueException(input) {
    const fn = getRawLeash()?.addValueException;
    if (typeof fn !== "function") {
      return {
        id: 0,
        valueHash: input.valueHash,
        preview: input.preview,
        label: input.label,
        note: input.note ?? null,
        createdAt: Date.now(),
      };
    }
    return fn(input);
  },

  async deleteValueException(id) {
    const fn = getRawLeash()?.deleteValueException;
    if (typeof fn !== "function") return;
    return fn(id);
  },

  async listDeniedDecisions(limit) {
    const fn = getRawLeash()?.listDeniedDecisions;
    if (typeof fn !== "function") return [];
    return fn(limit);
  },

  async allowDeniedDecision(id, mode) {
    const fn = getRawLeash()?.allowDeniedDecision;
    if (typeof fn !== "function") {
      return { ok: false, action: "unavailable", detail: "Method unavailable in this build." };
    }
    return fn(id, mode);
  },

  async resetTrayPosition() {
    const fn = getRawLeash()?.resetTrayPosition;
    if (typeof fn !== "function") return false;
    return fn();
  },
};

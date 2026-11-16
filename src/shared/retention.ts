export const RETENTION_MIN_DAYS = 5;
export const RETENTION_MAX_DAYS = 365;
export const SENSITIVE_RETENTION_DAYS = 90;
export const ORDINARY_RETENTION_DAYS = 14;
export const MAIN_RETENTION_DAYS = 90;
export const NOISE_RETENTION_DAYS = 14;

export function parseRetentionDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value);
  if (days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) return null;
  return days;
}

export function retentionDays(value: string, fallback: number): number {
  return parseRetentionDays(value) ?? fallback;
}

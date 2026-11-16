import { DECISION_RETENTION_MS } from "../shared/constants";
import { deleteGrants, getSetting, listGrants, pruneApprovals, pruneDecisions, pruneSecretTouches } from "../shared/db";
import type { DatabaseSync } from "node:sqlite";
import type { Grant } from "../shared/types";

export function expireLeashGrants(db: DatabaseSync, now: number): Grant[] {
  const expired = listGrants(db).filter((grant) => grant.source === "leash" && grant.expiresAt !== null && grant.expiresAt <= now);
  if (expired.length) deleteGrants(db, "source = 'leash' AND expires_at IS NOT NULL AND expires_at <= ?", now);
  return expired;
}

export function pruneOldDecisions(db: DatabaseSync, now: number): number {
  if (!Number.isFinite(now) || now <= DECISION_RETENTION_MS) return 0;
  let effectiveNow = now;
  const lastSweepIso = getSetting(db, "last_sweep", "");
  if (lastSweepIso) {
    const lastSweepMs = Date.parse(lastSweepIso);
    if (Number.isFinite(lastSweepMs) && lastSweepMs > 0 && now - lastSweepMs >= DECISION_RETENTION_MS) {
      effectiveNow = lastSweepMs;
    }
  }
  const cutoff = effectiveNow - DECISION_RETENTION_MS;
  if (cutoff <= 0) return 0;
  pruneApprovals(db, effectiveNow - 30 * 24 * 60 * 60 * 1000);
  pruneSecretTouches(db, cutoff);
  return pruneDecisions(db, cutoff);
}

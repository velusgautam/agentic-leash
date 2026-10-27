import { createHash } from "node:crypto";
import { join } from "node:path";
import { isSensitive, skipRead } from "../shared/paths";
import { KEYCHAIN_SAFE_BUFFER, startupKind } from "../shared/sensitive";
import type { HistoryEvent } from "../shared/types";
import type { EsEvent } from "./proctree";
import type { ProcTree } from "./proctree";

const FWRITE = 2;

function pidOf(event: EsEvent): number {
  return event.process?.audit_token?.pid ?? 0;
}

function exeOf(event: EsEvent): string {
  return event.process?.executable?.path ?? "";
}

function tsOf(event: EsEvent): number {
  return event.time ? Date.parse(event.time) : Date.now();
}

function destination(value: unknown): string | undefined {
  const dest = value as { existing_file?: { path?: string }; new_path?: { dir?: { path?: string }; filename?: string }; file?: { path?: string } } | undefined;
  if (!dest) return;
  if (dest.existing_file?.path) return dest.existing_file.path;
  if (dest.new_path?.dir?.path && dest.new_path.filename) return join(dest.new_path.dir.path, dest.new_path.filename);
  return dest.file?.path;
}

export function classify(event: EsEvent, tree: ProcTree, home: string, skipExtras: string[] = []): HistoryEvent | null {
  const pid = pidOf(event);
  if (!tree.has(pid)) return null;
  const body = event.event ?? {};
  const base = { ts: tsOf(event), agent: tree.agent(pid) as HistoryEvent["agent"], pid, exe: exeOf(event), sensitive: false, source: "eslogger" as const };
  const file = (path: string, kind: HistoryEvent["kind"], destPath?: string): HistoryEvent | null => {
    if (kind === "read" && skipRead(path, home, skipExtras)) return null;
    const isSafeBufferCommit = kind === "rename" && Boolean(destPath) && KEYCHAIN_SAFE_BUFFER.test(path) && path.startsWith(`${destPath}.sb-`);
    const flagged = (item: string) => isSensitive(item, home) || (kind !== "read" && startupKind(item, home) !== null);
    const destFlagged = destPath && !isSafeBufferCommit ? flagged(destPath) : false;
    return { ...base, kind, path, destPath, sensitive: flagged(path) || destFlagged };
  };

  if (body.open) {
    const open = body.open as { file?: { path?: string }; fflag?: number };
    const path = open.file?.path;
    if (!path) return null;
    if ((open.fflag ?? 0) & FWRITE) return null;
    return file(path, "read");
  }
  if (body.close) {
    const close = body.close as { modified?: boolean; target?: { path?: string } };
    if (!close.modified || !close.target?.path) return null;
    return file(close.target.path, "write");
  }
  if (body.create) {
    const path = destination((body.create as { destination?: unknown }).destination);
    return path ? file(path, "create") : null;
  }
  if (body.unlink) {
    const path = (body.unlink as { target?: { path?: string } }).target?.path;
    return path ? file(path, "delete") : null;
  }
  if (body.rename) {
    const rename = body.rename as { source?: { path?: string }; destination?: unknown };
    const path = rename.source?.path;
    return path ? file(path, "rename", destination(rename.destination)) : null;
  }
  if (body.exec) {
    const path = (body.exec as { target?: { executable?: { path?: string } } }).target?.executable?.path ?? exeOf(event);
    return file(path, "exec");
  }
  return null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

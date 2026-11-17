import { execFileSync } from "node:child_process";
import { parseLsof } from "../main/system";
import type { HistoryEvent } from "../shared/types";

export function lsofText(pids: number[]): string {
  if (!pids.length) return "";
  try {
    return execFileSync("/usr/sbin/lsof", ["-nP", "-i", "-a", "-p", pids.join(",")], { encoding: "utf8" });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

export function pollNet(options: {
  pids: number[];
  seen: Set<string>;
  now: number;
  agentFor: (pid: number) => HistoryEvent["agent"];
  lsof: (pids: number[]) => string;
}): HistoryEvent[] {
  for (const key of options.seen) {
    if (!options.pids.includes(Number(key.slice(0, key.indexOf("|"))))) options.seen.delete(key);
  }
  if (!options.pids.length) return [];
  const events: HistoryEvent[] = [];
  for (const row of parseLsof(options.lsof(options.pids))) {
    if (!options.pids.includes(row.pid)) continue;
    const key = `${row.pid}|${row.remote}`;
    if (options.seen.has(key)) continue;
    options.seen.add(key);
    events.push({
      ts: options.now,
      agent: options.agentFor(row.pid),
      pid: row.pid,
      exe: "",
      kind: "net",
      path: row.remote,
      sensitive: false,
      source: "net",
    });
  }
  return events;
}

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

/**
 * Parses Windows `netstat -ano -p tcp` output.
 */
export function parseNetstat(text: string): { pid: number; remote: string }[] {
  const rows: { pid: number; remote: string }[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    const parts = trimmed.split(/\s+/);
    // Columns: [0]=TCP, [1]=Local Address, [2]=Foreign Address, [3]=State, [4]=PID
    if (parts.length < 5) continue;
    const foreign = parts[2] ?? "";
    const state = parts[3];
    const pid = Number(parts[4]);
    if (state !== "ESTABLISHED" || !pid || !foreign || foreign.startsWith("0.0.0.0") || foreign.startsWith("127.0.0.1") || foreign.startsWith("[::]")) {
      continue;
    }
    rows.push({ pid, remote: foreign });
  }
  return rows;
}

/**
 * Parses Linux `ss -ntp` output.
 */
export function parseSs(text: string): { pid: number; remote: string }[] {
  const rows: { pid: number; remote: string }[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("ESTAB")) continue;
    const parts = trimmed.split(/\s+/);
    // Columns: [0]=State, [1]=Recv-Q, [2]=Send-Q, [3]=Local, [4]=Peer, [5]=Process Info
    if (parts.length < 5) continue;
    const remote = parts[4] ?? "";
    const procInfo = parts.slice(5).join(" ");
    const pidMatch = /pid=(\d+)/.exec(procInfo);
    const pid = pidMatch ? Number(pidMatch[1]) : 0;
    if (pid && remote && !remote.startsWith("127.0.0.1") && !remote.startsWith("[::1]")) {
      rows.push({ pid, remote });
    }
  }
  return rows;
}

/**
 * Decodes a hex IP (little-endian hex as stored in Linux /proc/net/tcp) to dotted-quad.
 */
function decodeHexIp(hex: string): string {
  if (hex.length !== 8) return hex;
  const num = parseInt(hex, 16);
  const b1 = num & 0xff;
  const b2 = (num >> 8) & 0xff;
  const b3 = (num >> 16) & 0xff;
  const b4 = (num >> 24) & 0xff;
  return `${b1}.${b2}.${b3}.${b4}`;
}

/**
 * Parses Linux `/proc/net/tcp` entries and maps inode to PID.
 */
export function parseProcNetTcp(text: string, inodeToPid = new Map<number, number>()): { pid: number; remote: string }[] {
  const rows: { pid: number; remote: string }[] = [];
  const lines = text.split("\n").slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // [1]=local_address [2]=rem_address [3]=st ... [9]=inode
    if (parts.length < 10) continue;
    const state = parts[3];
    if (state !== "01") continue; // 01 is TCP_ESTABLISHED
    const rem = parts[2];
    if (!rem || !rem.includes(":")) continue;
    const [hexIp, hexPort] = rem.split(":");
    const ip = decodeHexIp(hexIp!);
    const port = parseInt(hexPort!, 16);
    const inode = Number(parts[9]);
    const pid = inodeToPid.get(inode);
    if (pid && port) {
      rows.push({ pid, remote: `${ip}:${port}` });
    }
  }
  return rows;
}

export function pollNetCrossPlatform(options: {
  pids: number[];
  seen: Set<string>;
  now: number;
  agentFor: (pid: number) => HistoryEvent["agent"];
  connections: (pids: number[]) => { pid: number; remote: string }[];
}): HistoryEvent[] {
  for (const key of options.seen) {
    if (!options.pids.includes(Number(key.slice(0, key.indexOf("|"))))) options.seen.delete(key);
  }
  if (!options.pids.length) return [];
  const events: HistoryEvent[] = [];
  for (const row of options.connections(options.pids)) {
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

export function pollNet(options: {
  pids: number[];
  seen: Set<string>;
  now: number;
  agentFor: (pid: number) => HistoryEvent["agent"];
  lsof: (pids: number[]) => string;
}): HistoryEvent[] {
  return pollNetCrossPlatform({
    pids: options.pids,
    seen: options.seen,
    now: options.now,
    agentFor: options.agentFor,
    connections: (pids) => parseLsof(options.lsof(pids)),
  });
}

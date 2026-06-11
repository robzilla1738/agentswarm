import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { home } from "./config";
import { clip, ensureDir, oneLine } from "./util";

/**
 * Cheap cross-run memory: a JSON file per workspace directory holding the last
 * runs' missions, outcomes, and key decisions. Loaded into the conductor's
 * system prompt at launch so a swarm working the same project twice doesn't
 * start from zero. Isolated-sandbox runs are excluded — their workspace is
 * unique per run, so there is nothing to remember against.
 */
export interface RunMemoryEntry {
  mission: string;
  finishedAt: number;
  status: string;
  summary: string;
  keyDecisions: string[];
}

const MAX_ENTRIES = 20;

export function memoryFile(cwd: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  return path.join(home(), "memory", `${hash}.json`);
}

export function loadMemory(cwd: string): RunMemoryEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(cwd), "utf8"));
    return Array.isArray(raw?.entries) ? (raw.entries as RunMemoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendMemory(cwd: string, entry: RunMemoryEntry): void {
  try {
    const file = memoryFile(cwd);
    ensureDir(path.dirname(file));
    const entries = [...loadMemory(cwd), entry].slice(-MAX_ENTRIES);
    fs.writeFileSync(file, JSON.stringify({ cwd: path.resolve(cwd), entries }, null, 2), "utf8");
  } catch {
    /* memory is best-effort */
  }
}

/** Prompt block for the conductor, or "" when there's no history. */
export function memoryBlock(cwd: string): string {
  const entries = loadMemory(cwd);
  if (!entries.length) return "";
  const lines = entries.slice(-8).map((e) => {
    const when = new Date(e.finishedAt).toISOString().slice(0, 10);
    const decisions = e.keyDecisions.length
      ? ` Decisions: ${e.keyDecisions.map((d) => oneLine(d, 100)).join("; ")}`
      : "";
    return `- [${when}, ${e.status}] "${oneLine(e.mission, 100)}" — ${oneLine(e.summary, 200)}${decisions}`;
  });
  return clip(
    `PRIOR RUNS IN THIS WORKSPACE (build on them; don't redo settled decisions without reason):\n${lines.join("\n")}`,
    4000
  );
}

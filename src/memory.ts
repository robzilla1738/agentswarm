import * as crypto from "crypto";
import * as path from "path";
import { home } from "./config";
import { clip, oneLine, readJson, writeJson } from "./util";

/**
 * Cheap cross-run memory: a JSON file per workspace directory holding the last
 * runs' missions, outcomes, and key decisions. Loaded into the conductor's
 * system prompt at launch so a swarm working the same project twice doesn't
 * start from zero. Isolated-sandbox runs are excluded — their workspace is
 * unique per run, so there is nothing to remember against.
 */
export interface RunMemoryEntry {
  /** Entries keyed by runId update in place — interim snapshots become the final record. */
  runId?: string;
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
  const raw = readJson<{ entries?: unknown }>(memoryFile(cwd), {});
  if (!Array.isArray(raw.entries)) return [];
  // Memory is best-effort and the file is user-editable: one malformed entry
  // must degrade to "forgotten", never crash a run at startup.
  return raw.entries.filter(
    (e): e is RunMemoryEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as RunMemoryEntry).mission === "string" &&
      typeof (e as RunMemoryEntry).summary === "string" &&
      typeof (e as RunMemoryEntry).status === "string" &&
      Number.isFinite((e as RunMemoryEntry).finishedAt) &&
      Array.isArray((e as RunMemoryEntry).keyDecisions) &&
      (e as RunMemoryEntry).keyDecisions.every((d) => typeof d === "string")
  );
}

export function appendMemory(cwd: string, entry: RunMemoryEntry): void {
  try {
    // Same-run entries replace (interim → final); writeJson is temp+rename so
    // a crash mid-write never loses the prior history.
    const prior = loadMemory(cwd).filter((e) => !(entry.runId && e.runId === entry.runId));
    const entries = [...prior, entry].slice(-MAX_ENTRIES);
    writeJson(memoryFile(cwd), { cwd: path.resolve(cwd), entries });
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

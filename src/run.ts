import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { SwarmConfig, runDir, runsDir } from "./config";
import { Executor } from "./executor";
import { Journal, TailState, eventsFile, readEvents, readNewEvents } from "./journal";
import { resolveSandboxKind } from "./sandbox";
import { RunState } from "./state";
import { RunMeta, RunOptions, RunSummary } from "./types";
import { ensureDir, rid, writeJson } from "./util";

export interface CreateRunInput {
  mission: string;
  cwd: string;
  sandbox: boolean;
  options: RunOptions;
}

export function optionsFromConfig(cfg: SwarmConfig, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    model: cfg.model,
    conductorModel: cfg.conductorModel,
    maxWorkers: cfg.maxWorkers,
    maxStepsPerTask: cfg.maxStepsPerTask,
    maxTasks: cfg.maxTasks,
    maxTokens: cfg.maxTokensPerRun,
    taskTimeoutMs: cfg.taskTimeoutMs,
    verification: cfg.verification,
    thinking: cfg.thinking,
    reasoningEffort: cfg.reasoningEffort,
    safeMode: cfg.safeMode,
    // Resolved at launch so the run is reproducible across resume even if
    // the operator later changes the default.
    sandboxRuntime: resolveSandboxKind(cfg),
    ...overrides,
  };
}

export function createRun(input: CreateRunInput): RunMeta {
  const id = rid("run");
  const dir = runDir(id);
  let cwd = path.resolve(input.cwd);
  if (input.sandbox) {
    // Isolated working directory inside the run folder.
    cwd = path.join(dir, "workspace");
    ensureDir(cwd);
  }
  const meta: RunMeta = {
    id,
    mission: input.mission,
    createdAt: Date.now(),
    cwd,
    sandbox: input.sandbox,
    options: input.options,
  };
  ensureDir(dir);
  ensureDir(path.join(dir, "artifacts"));
  writeJson(path.join(dir, "meta.json"), meta);
  return meta;
}

export function metaPath(id: string): string {
  return path.join(runDir(id), "meta.json");
}

export function loadMeta(id: string): RunMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as RunMeta;
  } catch {
    return null;
  }
}

/** Execute a run to completion in this process. */
export async function executeRun(cfg: SwarmConfig, meta: RunMeta, journal: Journal): Promise<Executor> {
  const ex = new Executor(cfg, meta, journal);
  await ex.run();
  return ex;
}

/**
 * Re-reducing every journal on every dashboard poll gets expensive once runs
 * accumulate; summaries are pure functions of the journal file, so cache them
 * keyed on (size, mtime).
 */
const summaryCache = new Map<string, { size: number; mtimeMs: number; summary: RunSummary }>();

/**
 * Live runs additionally tail their journal incrementally: a multi-hour run's
 * growing events.jsonl costs O(new bytes) per poll instead of a full re-parse.
 */
const liveCache = new Map<string, { state: RunState; tail: TailState }>();

const TERMINAL_STATUSES = ["done", "failed", "cancelled"];

/**
 * Grace before a silent, pid-less run is presumed dead. The pid file is the
 * primary live signal; this window only covers engine startup (before
 * writePid) and filesystem lag — generous enough that slow disks and slow
 * provider preflights never flag a healthy run as interrupted.
 */
const STALE_AFTER_MS = 45_000;

/**
 * A run whose engine process vanished without writing a terminal status
 * (kill -9, reboot) would otherwise show "running" forever. Presentation-level
 * only — the journal stays untouched.
 */
function applyLiveness(s: RunSummary): RunSummary {
  if (s.pid || TERMINAL_STATUSES.includes(s.status)) return s;
  const lastBeat = s.heartbeatAt || s.updatedAt || s.createdAt;
  if (Date.now() - lastBeat > STALE_AFTER_MS) {
    s.status = "failed";
    s.statusReason = "interrupted — the engine process is no longer running";
  }
  return s;
}

export function listRuns(pricing: SwarmConfig["pricing"]): RunSummary[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsDir()).filter((d) => d.startsWith("run_"));
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const id of ids) {
    const meta = loadMeta(id);
    if (!meta) continue;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(eventsFile(runDir(id)));
    } catch {
      /* no events yet */
    }
    const cached = summaryCache.get(id);
    let pure: RunSummary;
    if (cached && stat && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      pure = cached.summary;
    } else {
      let live = liveCache.get(id);
      if (!live) {
        live = { state: new RunState(pricing), tail: { offset: 0, carry: "" } };
        liveCache.set(id, live);
      }
      for (const ev of readNewEvents(eventsFile(runDir(id)), live.tail)) live.state.apply(ev);
      if (!live.state.meta) live.state.meta = meta;
      pure = live.state.summary();
      pure.id = id;
      pure.mission = meta.mission;
      pure.model = meta.options.model;
      pure.createdAt = meta.createdAt;
      if (stat) summaryCache.set(id, { size: stat.size, mtimeMs: stat.mtimeMs, summary: pure });
      // Terminal runs never change again — the frozen summary suffices.
      if (TERMINAL_STATUSES.includes(pure.status)) liveCache.delete(id);
    }
    const s: RunSummary = { ...pure, tasks: { ...pure.tasks } };
    s.pid = readPid(id);
    out.push(applyLiveness(s));
  }
  // Deleted runs must not pin their reduced state in a long-lived hub forever.
  const live = new Set(ids);
  for (const key of summaryCache.keys()) if (!live.has(key)) summaryCache.delete(key);
  for (const key of liveCache.keys()) if (!live.has(key)) liveCache.delete(key);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Permanently remove a run's directory (journal, artifacts, workspace). */
export function deleteRun(id: string): void {
  if (isRunLive(id)) throw new Error("run is live — stop it before deleting");
  // A just-launched engine takes a moment to write its pid file; deleting in
  // that window would yank the directory out from under it. Refuse while the
  // run is non-terminal and fresh enough that the engine may still appear.
  const evs = readEvents(runDir(id));
  const lastStatus = [...evs].reverse().find((e) => e.type === "run.status") as { status?: string } | undefined;
  const status = String(lastStatus?.status ?? "planning");
  if (!TERMINAL_STATUSES.includes(status)) {
    const lastT = evs.length ? evs[evs.length - 1].t : loadMeta(id)?.createdAt ?? 0;
    if (Date.now() - lastT <= STALE_AFTER_MS) {
      throw new Error("run is still starting — stop it or wait a moment");
    }
  }
  fs.rmSync(runDir(id), { recursive: true, force: true });
  summaryCache.delete(id);
  liveCache.delete(id);
}

/**
 * Whether an interrupted run can be resumed: it must exist, not be live, and
 * its journal must not have reached a terminal status. (A run the liveness
 * layer *presents* as failed/interrupted still has a non-terminal journal.)
 */
export function resumeInfo(id: string): { resumable: boolean; reason?: string } {
  const meta = loadMeta(id);
  if (!meta) return { resumable: false, reason: "run not found" };
  if (isRunLive(id)) return { resumable: false, reason: "run is already running" };
  const evs = readEvents(runDir(id));
  if (!evs.length) return { resumable: false, reason: "run never started — launch it instead" };
  const last = [...evs].reverse().find((e) => e.type === "run.status") as { status?: string } | undefined;
  const status = String(last?.status ?? "planning");
  if (TERMINAL_STATUSES.includes(status)) {
    return { resumable: false, reason: `run already ended (${status})` };
  }
  return { resumable: true };
}

/** Spawn the engine for a run as a detached background process. */
export function launchDetached(id: string, binPath: string, resume = false): void {
  let out: number | "ignore" = "ignore";
  try {
    out = fs.openSync(path.join(runDir(id), "exec.log"), "a");
  } catch {
    /* log is best-effort */
  }
  const child = spawn(process.execPath, [binPath, "_exec", id, ...(resume ? ["--resume"] : [])], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  if (typeof out === "number") {
    try {
      fs.closeSync(out);
    } catch {
      /* child holds its own descriptor */
    }
  }
}

export function loadRunState(id: string, pricing: SwarmConfig["pricing"]): RunState | null {
  const meta = loadMeta(id);
  if (!meta) return null;
  const state = new RunState(pricing);
  for (const ev of readEvents(runDir(id))) state.apply(ev);
  if (!state.meta) state.meta = meta;
  return state;
}

// ---------- pid tracking (for the hub to know what's live) ----------

export function pidPath(id: string): string {
  return path.join(runDir(id), "run.pid");
}

export function writePid(id: string): void {
  try {
    fs.writeFileSync(pidPath(id), String(process.pid), "utf8");
  } catch {
    /* best effort */
  }
}

export function clearPid(id: string): void {
  try {
    fs.unlinkSync(pidPath(id));
  } catch {
    /* gone */
  }
}

export function readPid(id: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidPath(id), "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0); // throws if not alive
    return pid;
  } catch {
    return null;
  }
}

export function isRunLive(id: string): boolean {
  return readPid(id) !== null;
}

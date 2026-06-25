import * as fs from "fs";
import * as path from "path";
import { runDir, SwarmConfig, sessionDir, sessionsDir } from "./config";
import { loadMemory } from "./memory";
import { isRunLive, listRuns, loadRunState } from "./run";
import { RunOptions, SessionMeta, SessionSummary, TurnRecord } from "./types";
import { clip, ensureDir, oneLine, rid, safeJson, writeJson } from "./util";

/**
 * Code-chat SESSIONS. A session is a durable, multi-turn conversation that builds
 * software: each user message is a TURN, run as an ordinary code-mode run (see
 * run.ts) pointed at the session's persistent workspace. This module owns the
 * session entity — its meta, its append-only turn index (turns.jsonl), and the
 * prior-turn context block injected into a follow-up turn's conductor. Turn runs
 * themselves are plain run_<id> dirs; nothing here duplicates the journal.
 */

function metaFile(id: string): string {
  return path.join(sessionDir(id), "meta.json");
}

function turnsFile(id: string): string {
  return path.join(sessionDir(id), "turns.jsonl");
}

/** A directory is "empty" (greenfield) if it has nothing but dotfiles. */
export function isEmptyDir(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return true; // missing → treat as empty (we'll create it)
  }
  return entries.every((e) => e.startsWith("."));
}

export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export interface CreateSessionInput {
  title?: string;
  /** Existing-dir case: absolute path the user picked. Omit for a managed workspace. */
  workspace?: string;
  options: RunOptions;
}

export function createSession(input: CreateSessionInput): SessionMeta {
  const id = rid("sess");
  const dir = sessionDir(id);
  ensureDir(dir);
  let workspace: string;
  let workspaceKind: SessionMeta["workspaceKind"];
  let preexistingGit = false;
  if (input.workspace) {
    workspace = path.resolve(input.workspace);
    workspaceKind = "existing";
    preexistingGit = isGitRepo(workspace);
  } else {
    workspace = path.join(dir, "workspace");
    ensureDir(workspace);
    workspaceKind = "managed";
  }
  const now = Date.now();
  const meta: SessionMeta = {
    id,
    title: clip((input.title || "").trim() || "Untitled project", 120),
    createdAt: now,
    updatedAt: now,
    workspace,
    workspaceKind,
    options: input.options,
    ...(preexistingGit ? { preexistingGit: true } : {}),
  };
  writeJson(metaFile(id), meta);
  return meta;
}

export function loadSessionMeta(id: string): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function saveSessionMeta(meta: SessionMeta): void {
  writeJson(metaFile(meta.id), meta);
}

export function touchSession(id: string): void {
  const meta = loadSessionMeta(id);
  if (!meta) return;
  meta.updatedAt = Date.now();
  saveSessionMeta(meta);
}

export function appendTurn(id: string, rec: Omit<TurnRecord, "t">): void {
  fs.appendFileSync(turnsFile(id), JSON.stringify({ t: Date.now(), ...rec }) + "\n", "utf8");
}

export function readTurns(id: string): TurnRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(turnsFile(id), "utf8");
  } catch {
    return [];
  }
  const out: TurnRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const rec = safeJson<TurnRecord>(s);
    if (rec && rec.turnId) out.push(rec);
  }
  return out;
}

/** Any turn of this session whose engine is currently running. */
export function sessionLiveTurn(id: string): string | null {
  for (const turn of readTurns(id)) if (isRunLive(turn.turnId)) return turn.turnId;
  return null;
}

export function listSessionIds(): string[] {
  try {
    return fs.readdirSync(sessionsDir()).filter((d) => d.startsWith("sess_"));
  } catch {
    return [];
  }
}

export function listSessions(pricing: SwarmConfig["pricing"]): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const id of listSessionIds()) {
    const summary = sessionSummary(id, pricing);
    if (summary) out.push(summary);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function sessionSummary(id: string, pricing: SwarmConfig["pricing"]): SessionSummary | null {
  const meta = loadSessionMeta(id);
  if (!meta) return null;
  const turns = readTurns(id);
  const last = turns[turns.length - 1];
  let lastStatus: SessionSummary["lastStatus"];
  if (last) {
    const st = loadRunState(last.turnId, pricing);
    lastStatus = st?.summary().status;
  }
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    workspace: meta.workspace,
    workspaceKind: meta.workspaceKind,
    turns: turns.length,
    lastStatus,
    lastTurnId: last?.turnId,
    live: sessionLiveTurn(id) !== null,
  };
}

/** Full session view: meta + every turn with its run summary (newest run data). */
export function sessionSnapshot(id: string, pricing: SwarmConfig["pricing"]) {
  const meta = loadSessionMeta(id);
  if (!meta) return null;
  const turns = readTurns(id);
  const byId = new Map(listRuns(pricing).map((r) => [r.id, r]));
  return {
    meta,
    live: sessionLiveTurn(id),
    turns: turns.map((t) => ({
      turnId: t.turnId,
      message: t.message,
      at: t.t,
      run: byId.get(t.turnId) ?? null,
    })),
  };
}

/**
 * Permanently remove a session. Managed workspace lives inside sessionDir → it
 * is removed with the dir. An EXISTING (user-picked) workspace lives outside
 * sessionDir, so rm-ing sessionDir never touches it — we assert that invariant
 * before deleting to guarantee we never wipe a user's real directory. Each turn
 * is its own run_<id> dir OUTSIDE sessionDir, so we cascade-delete those too —
 * otherwise they leak on disk and linger in the run list forever.
 */
export function deleteSession(id: string): void {
  if (sessionLiveTurn(id)) throw new Error("session has a live turn — stop it before deleting");
  const meta = loadSessionMeta(id);
  const dir = sessionDir(id);
  if (meta && meta.workspaceKind === "existing") {
    const ws = path.resolve(meta.workspace);
    const inside = ws === dir || ws.startsWith(dir + path.sep);
    if (inside) throw new Error("refusing to delete: an existing-dir session's workspace resolved inside the session dir");
  }
  // Cascade-delete the turn runs (best-effort — the live-turn guard above means
  // none is running; a half-removed run dir must never block the session delete).
  for (const turn of readTurns(id)) {
    try {
      fs.rmSync(runDir(turn.turnId), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The prior-turn context block injected into a follow-up turn's conductor prompt
 * (in place of the workspace-keyed memoryBlock, which would also pull in unrelated
 * runs that touched the dir). Each completed turn already wrote {summary,
 * keyDecisions} to the workspace memory file via appendMemory — we just re-order
 * those entries by THIS session's turn sequence so the swarm gets an ordered
 * account of what each earlier turn built and decided, and iterates on prior work
 * instead of redoing it. Empty on turn 1. `workspace` is the session's persistent
 * tree (= the turn run's cwd).
 */
export function sessionContextBlock(id: string, workspace: string): string {
  const turns = readTurns(id);
  if (turns.length < 2) return ""; // nothing prior to fold in on turn 1
  const mem = new Map(loadMemory(workspace).map((e) => [e.runId, e]));
  const lines: string[] = [];
  let n = 0;
  for (const turn of turns) {
    const e = mem.get(turn.turnId);
    // Only fold COMPLETED turns into context — a still-running or failed turn's
    // partial record would mislead the next turn.
    if (!e || e.status !== "done") continue;
    n++;
    lines.push(`Turn ${n} — "${oneLine(turn.message, 160)}" → ${oneLine(e.summary, 240)}`);
    for (const d of e.keyDecisions.slice(0, 6)) lines.push(`  · ${oneLine(d, 160)}`);
  }
  if (!lines.length) return "";
  return clip(
    `THIS CODE-CHAT SO FAR (prior turns built the SAME workspace — build ON them; do not redo settled work, ` +
      `and keep everything they built working):\n${lines.join("\n")}`,
    5000
  );
}

"use client";

import { Fragment, useMemo } from "react";
import type { AgentView, ConductorSay, RunStatus, Task } from "@/lib/types";
import { Clamp, EmptyState, Md } from "./atoms";
import { TaskCard } from "./TaskCard";
import { TaskRow } from "./TaskRow";

const GLOW = "0 0 22px -6px rgb(var(--hi) / 0.5)";
/* The conductor's "spawning wave N" thought often lands a few ms after the
   wave's tasks are created — slack keeps it bucketed with that wave. */
const SLACK_MS = 1000;

const SETTLED = ["done", "failed", "blocked"];

export function SwarmBoard({
  tasks,
  agents,
  status,
  conductorLog,
  finalSummary,
  now,
  onSelect,
  onOpenReport,
}: {
  tasks: Task[];
  agents: AgentView[];
  status: RunStatus;
  conductorLog: ConductorSay[];
  finalSummary?: string;
  now: number;
  onSelect: (t: Task) => void;
  onOpenReport: () => void;
}) {
  const waves = useMemo(() => {
    const map = new Map<number, Task[]>();
    for (const t of tasks) {
      const w = t.wave || 1;
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(t);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks]);

  // Bucket conductor thoughts: each wave gets the latest message that
  // preceded it; everything after the last wave's start is the live tail.
  // Each message appears at most once here — the full log lives in the rail.
  const { preWave, tail } = useMemo(() => {
    const starts = waves.map(([w, group]) => [w, Math.min(...group.map((t) => t.createdAt))] as const);
    const preWave = new Map<number, ConductorSay>();
    let tail: ConductorSay | undefined;
    for (const msg of conductorLog) {
      const hit = starts.find(([, start]) => msg.t < start + SLACK_MS);
      if (hit) preWave.set(hit[0], msg);
      else tail = msg;
    }
    return { preWave, tail };
  }, [waves, conductorLog]);

  const agentForTask = (t: Task): AgentView | undefined => {
    const list = agents.filter((a) => a.taskId === t.id && a.status === "running");
    return list[list.length - 1];
  };

  const live = ["planning", "running", "synthesizing"].includes(status);
  const planning = status === "planning" && tasks.length === 0;
  const firstWave = waves[0]?.[0];
  const topMsg = (firstWave !== undefined ? preWave.get(firstWave)?.text : undefined) ?? (planning ? tail?.text : undefined);

  return (
    <div className="spine flex flex-col gap-7">
      <ConductorTopNode status={status} latest={topMsg} taskCount={tasks.length} />

      {planning ? (
        <div className="spine-item">
          <div className="panel">
            <EmptyState glyph="◌" title="Conductor is planning…" sub="Decomposing your mission into the first wave of parallel tasks." />
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="spine-item">
          <div className="panel">
            <EmptyState glyph="◇" title="No tasks yet" sub="The conductor hasn't spawned any work." />
          </div>
        </div>
      ) : (
        waves.map(([wave, group], i) => (
          <Fragment key={wave}>
            {i > 0 && preWave.get(wave) && <ConductorAside text={preWave.get(wave)!.text} />}
            <WaveSection wave={wave} group={group} agentForTask={agentForTask} now={now} onSelect={onSelect} />
          </Fragment>
        ))
      )}

      {!planning && tail && <ConductorAside text={tail.text} pulse={live} />}

      {!live &&
        (finalSummary ? (
          <MissionEndNode summary={finalSummary} onOpenReport={onOpenReport} />
        ) : (
          <EndMarker status={status} />
        ))}
    </div>
  );
}

function ConductorTopNode({ status, latest, taskCount }: { status: RunStatus; latest?: string; taskCount: number }) {
  const thinking = ["planning", "running", "synthesizing"].includes(status);
  return (
    <div className="spine-item">
      <span
        className="spine-node text-ink"
        style={{ boxShadow: thinking ? GLOW : "none", transition: "box-shadow 0.4s" }}
      >
        ◉
      </span>
      <div className="flex items-baseline gap-2.5">
        <span className="font-semibold text-sm tracking-tight text-ink">Conductor</span>
        <span className="mono text-2xs text-ink-faint">
          {status === "synthesizing"
            ? "synthesizing the final report"
            : `orchestrating ${taskCount} task${taskCount !== 1 ? "s" : ""}`}
        </span>
      </div>
      <p className="text-xs leading-snug mt-1 line-clamp-2 text-ink-dim">
        {latest || (thinking ? "coordinating the swarm…" : "idle")}
      </p>
    </div>
  );
}

/** Interleaved conductor thought between waves (or the live tail). */
function ConductorAside({ text, pulse }: { text: string; pulse?: boolean }) {
  return (
    <div className="spine-item" style={{ animation: "var(--animate-rise)" }}>
      <span className="spine-node" style={{ boxShadow: pulse ? GLOW : undefined, transition: "box-shadow 0.4s" }}>
        ◉
      </span>
      <p
        className="text-xs leading-snug line-clamp-2 text-ink-dim"
        style={{ minHeight: 21, animation: pulse ? "var(--animate-pulse-soft)" : undefined }}
      >
        {text}
      </p>
    </div>
  );
}

function WaveSection({
  wave,
  group,
  agentForTask,
  now,
  onSelect,
}: {
  wave: number;
  group: Task[];
  agentForTask: (t: Task) => AgentView | undefined;
  now: number;
  onSelect: (t: Task) => void;
}) {
  const settled = group.filter((t) => SETTLED.includes(t.status));
  const active = group.filter((t) => !SETTLED.includes(t.status));
  const failed = settled.filter((t) => t.status === "failed").length;

  return (
    <div className="spine-item" style={{ animation: "var(--animate-rise)" }}>
      <span className="spine-node" style={{ fontSize: 10 }}>{wave}</span>
      <div className="flex items-center gap-3 mb-3" style={{ minHeight: 21 }}>
        <span className="label">Wave {wave}</span>
        <span className={`mono text-2xs ${failed ? "text-ink" : "text-ink-faint"}`}>
          {settled.length}/{group.length} settled{failed ? ` · ${failed} failed` : ""}
        </span>
        <span className="flex-1 h-px bg-border-soft" />
      </div>

      {settled.length > 0 && (
        <div className="tile divide-y divide-border-soft overflow-hidden">
          {settled.map((t) => (
            <TaskRow key={t.id} task={t} now={now} onClick={() => onSelect(t)} />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${settled.length > 0 ? "mt-3" : ""}`}>
          {active.map((t) => (
            <TaskCard key={t.id} task={t} agent={agentForTask(t)} now={now} onClick={() => onSelect(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MissionEndNode({ summary, onOpenReport }: { summary: string; onOpenReport: () => void }) {
  return (
    <div className="spine-item" style={{ animation: "var(--animate-rise)" }}>
      <span className="spine-node text-ink">✓</span>
      <div className="panel p-4" style={{ borderColor: "rgb(var(--hi) / 0.22)", background: "rgb(var(--hi) / 0.03)" }}>
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <div className="label text-ink">✓ Mission summary</div>
          <button className="btn btn-sm shrink-0" onClick={onOpenReport}>
            Open full report →
          </button>
        </div>
        <Clamp lines={4}>
          <Md compact>{summary}</Md>
        </Clamp>
      </div>
    </div>
  );
}

/** Terminal run with no final summary (cancelled, failed early). */
function EndMarker({ status }: { status: RunStatus }) {
  const glyph = status === "failed" ? "✗" : status === "cancelled" ? "⊘" : "■";
  return (
    <div className="spine-item" style={{ animation: "var(--animate-rise)" }}>
      <span className="spine-node">{glyph}</span>
      <p className="text-xs text-ink-faint flex items-center" style={{ minHeight: 21 }}>
        run ended — {status}
      </p>
    </div>
  );
}

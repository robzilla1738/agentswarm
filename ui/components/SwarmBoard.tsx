"use client";

import { useMemo } from "react";
import type { AgentView, RunStatus, Task } from "@/lib/types";
import { EmptyState } from "./atoms";
import { TaskCard } from "./TaskCard";

export function SwarmBoard({
  tasks,
  agents,
  status,
  conductorLatest,
  now,
  onSelect,
}: {
  tasks: Task[];
  agents: AgentView[];
  status: RunStatus;
  conductorLatest?: string;
  now: number;
  onSelect: (t: Task) => void;
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

  const agentForTask = (t: Task): AgentView | undefined => {
    const list = agents.filter((a) => a.taskId === t.id && a.status === "running");
    return list[list.length - 1];
  };

  const planning = status === "planning" && tasks.length === 0;

  return (
    <div>
      <ConductorNode status={status} latest={conductorLatest} taskCount={tasks.length} />

      {planning ? (
        <div className="panel mt-4">
          <EmptyState glyph="◌" title="Conductor is planning…" sub="Decomposing your mission into the first wave of parallel tasks." />
        </div>
      ) : tasks.length === 0 ? (
        <div className="panel mt-4">
          <EmptyState glyph="◇" title="No tasks yet" sub="The conductor hasn't spawned any work." />
        </div>
      ) : (
        <div className="space-y-8 mt-6">
          {waves.map(([wave, group]) => {
            const settled = group.filter((t) => ["done", "failed", "blocked"].includes(t.status)).length;
            const failed = group.filter((t) => t.status === "failed").length;
            return (
              <div key={wave}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="label">Wave {wave}</span>
                  <span className={`mono text-2xs ${failed ? "text-ink" : "text-ink-faint"}`}>
                    {settled}/{group.length} settled{failed ? ` · ${failed} failed` : ""}
                  </span>
                  <span className="flex-1 h-px bg-border-soft" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {group.map((t) => (
                    <TaskCard key={t.id} task={t} agent={agentForTask(t)} now={now} onClick={() => onSelect(t)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConductorNode({ status, latest, taskCount }: { status: RunStatus; latest?: string; taskCount: number }) {
  const thinking = ["planning", "running", "synthesizing"].includes(status);
  return (
    <div
      className="panel p-4"
      style={{ borderColor: thinking ? "rgb(var(--hi) / 0.25)" : undefined, transition: "border-color 0.4s" }}
    >
      <div className="flex items-center gap-3.5">
        <div
          className="glyph shrink-0 relative text-ink"
          style={{
            width: 38,
            height: 38,
            fontSize: 13,
            boxShadow: thinking ? "0 0 22px -6px rgb(var(--hi) / 0.5)" : "none",
            transition: "box-shadow 0.4s",
          }}
        >
          ◉
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className="font-semibold text-base tracking-tight">Conductor</span>
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
      </div>
    </div>
  );
}

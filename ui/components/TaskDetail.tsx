"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { fmtDur, statusColor } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { AgentView, Task } from "@/lib/types";
import { StatusBadge } from "./atoms";

export function TaskDetail({
  runId,
  task,
  agents,
  now,
  onClose,
}: {
  runId: string;
  task: Task | null;
  agents: AgentView[];
  now: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task) return null;
  const taskAgents = agents.filter((a) => a.taskId === task.id);
  const current = taskAgents[taskAgents.length - 1];
  const color = statusColor(task.status);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ animation: "var(--animate-fade-in)" }}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div
        className="relative h-full overflow-y-auto"
        style={{
          width: "min(580px, 94vw)",
          background: "var(--color-bg-soft)",
          borderLeft: "1px solid var(--color-border)",
          animation: "var(--animate-slide-in)",
        }}
      >
        {/* sticky header */}
        <div
          className="sticky top-0 z-10 px-6 pt-5 pb-4 border-b border-border-soft"
          style={{
            background: "color-mix(in oklab, var(--color-bg-soft) 88%, transparent)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="flex items-start justify-between gap-3 mb-2.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <PixelAvatar seed={task.id} size={22} />
              <span className="mono font-bold text-lg" style={{ color }}>{task.id}</span>
              <span className="text-sm font-medium text-ink-dim">{personaName(task.id)}</span>
              <StatusBadge status={task.status} />
              <span className="text-2xs text-ink-faint">{task.role}</span>
            </div>
            <button onClick={onClose} className="btn btn-sm shrink-0">esc ✕</button>
          </div>

          <h2 className="text-lg font-semibold leading-snug">{task.title}</h2>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs mt-1.5 text-ink-faint">
            <span>wave {task.wave}</span>
            {task.deps.length > 0 && <span className="mono">⇠ {task.deps.join(", ")}</span>}
            {task.verify && <span className="text-ink-dim">⊛ adversarially verified</span>}
            {task.attempt > 1 && <span className="text-ink-dim">attempt {task.attempt}</span>}
            {task.startedAt && <span className="mono">{fmtDur((task.endedAt ?? now) - task.startedAt)}</span>}
          </div>
        </div>

        <div className="px-6 py-5">
          <Section title="Objective">
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-dim">
              {task.objective}
            </p>
          </Section>

          {task.context && (
            <Section title="Context from the conductor">
              <p className="text-xs leading-relaxed whitespace-pre-wrap text-ink-faint">
                {task.context}
              </p>
            </Section>
          )}

          {task.report && (
            <Section title="Report">
              <div
                className="rounded-xl px-4 py-3.5 border border-border-soft"
                style={{ background: "rgba(0,0,0,0.25)" }}
              >
                <div className="prose-report" style={{ fontSize: 13 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.report}</ReactMarkdown>
                </div>
              </div>
            </Section>
          )}

          {task.feedback && (
            <Section title="Verifier feedback">
              <div
                className="text-xs leading-relaxed whitespace-pre-wrap rounded-xl p-3.5 text-ink-dim"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.16)" }}
              >
                {task.feedback}
              </div>
            </Section>
          )}

          {task.error && task.status !== "done" && (
            <Section title="Error">
              <div
                className="text-xs leading-relaxed whitespace-pre-wrap rounded-xl p-3.5 text-ink"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.22)" }}
              >
                {task.error}
              </div>
            </Section>
          )}

          {task.artifacts.length > 0 && (
            <Section title={`Artifacts · ${task.artifacts.length}`}>
              <div className="flex flex-col gap-1.5">
                {task.artifacts.map((a) => (
                  <a
                    key={a}
                    href={api.artifactUrl(runId, a)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 py-2 tile tile-hover text-ink"
                  >
                    <span className="mono text-xs truncate flex-1">{a}</span>
                    <span className="mono text-2xs text-ink-dim">open ↗</span>
                  </a>
                ))}
              </div>
            </Section>
          )}

          {taskAgents.length > 0 && (
            <Section title={`Agents · ${taskAgents.length}`}>
              <div className="flex flex-col gap-2">
                {taskAgents.map((a, i) => (
                  <AgentBlock key={a.id} agent={a} now={now} expanded={a === current} attempt={i + 1} />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentBlock({ agent, now, expanded, attempt }: { agent: AgentView; now: number; expanded: boolean; attempt: number }) {
  const [open, setOpen] = useState(expanded);
  const running = agent.status === "running";
  const dur = fmtDur((agent.endedAt ?? now) - agent.startedAt);

  return (
    <div className="tile overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
      >
        <span
          className="rounded-full shrink-0"
          style={{ width: 7, height: 7, background: running ? "var(--color-ink)" : "var(--color-ink-faint)" }}
        />
        <span className="mono text-2xs text-ink-dim">{agent.id}</span>
        <span className="text-2xs text-ink-dim">{agent.role}</span>
        <span className="mono text-2xs ml-auto shrink-0 text-ink-faint">
          #{attempt} · {agent.steps} steps · {dur}{running ? " · live" : ""}
        </span>
        <span className="text-ink-faint" style={{ fontSize: 9, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-border-soft" style={{ paddingTop: 10 }}>
          {agent.lastThink && (
            <div>
              <div className="label mb-1">reasoning</div>
              <div className="text-xs leading-relaxed whitespace-pre-wrap mono text-ink-faint" style={{ maxHeight: 180, overflow: "auto" }}>
                {agent.lastThink.slice(-1400)}
              </div>
            </div>
          )}
          {agent.lastText && (
            <div>
              <div className="label mb-1">output</div>
              <div className="text-xs leading-relaxed whitespace-pre-wrap text-ink-dim" style={{ maxHeight: 180, overflow: "auto" }}>
                {agent.lastText.slice(-1400)}
              </div>
            </div>
          )}
          {!agent.lastThink && !agent.lastText && (
            <div className="text-2xs text-ink-faint">
              {running ? "Waiting for the first output…" : "No captured output."}
            </div>
          )}
          {agent.lastTool && (
            <div className="text-2xs mono text-ink-faint">last tool: {agent.lastTool}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="label mb-2">{title}</div>
      {children}
    </div>
  );
}

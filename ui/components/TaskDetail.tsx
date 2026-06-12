"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtDur, statusColor } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { AgentView, Task } from "@/lib/types";
import { Clamp, Md, StatusBadge } from "./atoms";

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
              <PixelAvatar seed={task.id} size={30} />
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
            {task.team && <span>⌬ sub-swarm</span>}
            {task.modelTier && task.modelTier !== "default" && <span>{task.modelTier} tier</span>}
            {task.deps.length > 0 && <span className="mono">⇠ {task.deps.join(", ")}</span>}
            {task.verify && <span>⊛ adversarially verified</span>}
            {task.attempt > 1 && <span>attempt {task.attempt}</span>}
            {task.startedAt && <span className="mono">{fmtDur((task.endedAt ?? now) - task.startedAt)}</span>}
          </div>
        </div>

        <div className="px-6 py-5">
          <FailureCallout task={task} />

          <Section title="Objective">
            <Clamp lines={3}>
              <Md compact>{task.objective}</Md>
            </Clamp>
          </Section>

          {task.context && (
            <Section title="Context from the conductor">
              <Clamp lines={3}>
                <Md compact dim>{task.context}</Md>
              </Clamp>
            </Section>
          )}

          {task.report && (
            <Section title={reportTitle(task)}>
              <div
                className="rounded-xl px-4 py-3.5 border border-border-soft"
                style={{ background: "var(--input-bg)" }}
              >
                <Clamp lines={10}>
                  <Md compact dim={task.status === "failed" || task.status === "blocked"}>{task.report}</Md>
                </Clamp>
              </div>
            </Section>
          )}

          {task.keyFacts && task.keyFacts.length > 0 && (
            <Section title="Key facts (handoff)">
              <ul className="space-y-1.5">
                {task.keyFacts.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-ink-dim">
                    <span className="text-ink-faint shrink-0 mt-px">◆</span>
                    <Md compact dim>{f}</Md>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.openQuestions && task.openQuestions.length > 0 && (
            <Section title="Open questions">
              <ul className="space-y-1.5">
                {task.openQuestions.map((q, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-ink-faint">
                    <span className="shrink-0 mt-px">?</span>
                    <Md compact dim>{q}</Md>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.filesTouched && task.filesTouched.length > 0 && (
            <Section title={`Files touched · ${task.filesTouched.length}`}>
              <div className="flex flex-wrap gap-1.5">
                {task.filesTouched.map((f) => (
                  <span key={f} className="chip">{f}</span>
                ))}
              </div>
            </Section>
          )}

          {task.lastCheckpoint && task.status !== "done" && (
            <Section title="Latest checkpoint">
              <div
                className="rounded-xl px-3.5 py-3 border border-border-soft"
                style={{ background: "rgb(var(--hi) / 0.02)" }}
              >
                <Md compact dim>{task.lastCheckpoint}</Md>
              </div>
            </Section>
          )}

          {task.feedback && task.status !== "failed" && task.status !== "blocked" && (
            <Section title="Verifier feedback (previous attempt)">
              <div
                className="rounded-xl p-3.5"
                style={{ background: "rgb(var(--hi) / 0.03)", border: "1px solid rgb(var(--hi) / 0.16)" }}
              >
                <Clamp lines={5}>
                  <Md compact dim>{task.feedback}</Md>
                </Clamp>
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

          {task.sources && task.sources.length > 0 && (
            <Section title={`Sources · ${task.sources.length}`}>
              <div className="flex flex-col gap-1.5">
                {task.sources.map((s, i) => (
                  <a
                    key={`${s.url}${i}`}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 py-2 tile tile-hover text-ink"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="mono text-xs truncate block">{s.title || s.url.replace(/^https?:\/\//, "")}</span>
                      {s.note && <span className="text-2xs text-ink-faint truncate block">{s.note}</span>}
                    </span>
                    {s.date && <span className="mono text-2xs text-ink-faint shrink-0">{s.date}</span>}
                    <span className="mono text-2xs text-ink-dim shrink-0">↗</span>
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

function reportTitle(task: Task): string {
  if (task.status === "failed" || task.status === "blocked") {
    return `Last report (unverified · attempt ${task.attempt})`;
  }
  if (task.status === "verifying") return "Report (being verified)";
  return "Report";
}

/**
 * Failed/blocked tasks lead with the reason. The engine often stores the same
 * text in both `error` and `feedback` (the retry path falls back from one to
 * the other), so overlapping copies collapse to one.
 */
function FailureCallout({ task }: { task: Task }) {
  if (task.status !== "failed" && task.status !== "blocked") return null;
  const error = task.error?.trim() ?? "";
  const feedback = task.feedback?.trim() ?? "";
  const same =
    !!error && !!feedback && (error === feedback || error.startsWith(feedback.slice(0, 80)) || feedback.startsWith(error.slice(0, 80)));
  const main = same ? feedback : error || feedback;
  if (!main) return null;

  return (
    <Section title={task.status === "blocked" ? "Why it's blocked" : "Why it failed"}>
      <div
        className="rounded-xl p-3.5"
        style={{ background: "rgb(var(--hi) / 0.05)", border: "1px solid rgb(var(--hi) / 0.22)" }}
      >
        <Clamp lines={6}>
          <Md compact>{main}</Md>
        </Clamp>
        {!same && error && feedback && (
          <div className="mt-2.5 pt-2.5 border-t border-border-soft">
            <div className="label mb-1">Verifier feedback</div>
            <Clamp lines={6}>
              <Md compact dim>{feedback}</Md>
            </Clamp>
          </div>
        )}
      </div>
    </Section>
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
        <div className="px-3 pb-3 pt-2.5 space-y-2.5 border-t border-border-soft">
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
              <div style={{ maxHeight: 180, overflow: "auto" }}>
                <Md compact dim>{agent.lastText.slice(-1400)}</Md>
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

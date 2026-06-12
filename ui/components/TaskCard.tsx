"use client";

import { fmtDur, statusColor } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { AgentView, Task } from "@/lib/types";
import { Spinner, ToolIcon } from "./atoms";

export function statusGlyph(status: string) {
  switch (status) {
    case "done": return "✓";
    case "failed": return "✗";
    case "blocked": return "⊘";
    case "verifying": return "◈";
    default: return "";
  }
}

/** Markdown syntax reads as noise in a two-line preview. */
export function plainPreview(s: string): string {
  return s.replace(/[#*`_>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

export function TaskCard({
  task,
  agent,
  now,
  onClick,
}: {
  task: Task;
  agent?: AgentView;
  now: number;
  onClick: () => void;
}) {
  const color = statusColor(task.status);
  const active = task.status === "running" || task.status === "verifying";
  const role = task.status === "verifying" ? "verifier" : task.role;
  const dur = task.startedAt ? fmtDur((task.endedAt ?? now) - task.startedAt) : "";

  return (
    <button
      onClick={onClick}
      className="panel panel-hover text-left p-4 w-full relative overflow-hidden flex flex-col"
      style={{
        animation: "var(--animate-rise)",
        borderColor: active ? "rgb(var(--hi) / 0.16)" : undefined,
        opacity: task.status === "pending" ? 0.75 : 1,
      }}
    >
      <div className="flex items-center gap-2 mb-1.5 w-full">
        <PixelAvatar seed={task.id} size={26} />
        <span className="mono text-2xs font-bold shrink-0" style={{ color }}>{task.id}</span>
        <span className="text-2xs font-medium shrink-0 text-ink-dim">{personaName(task.id)}</span>
        <span className="text-2xs shrink-0 text-ink-faint">· {role}</span>
        {task.team && (
          <span title="runs as a sub-swarm" className="text-2xs text-ink-dim">⌬</span>
        )}
        {task.modelTier && task.modelTier !== "default" && (
          <span title={`${task.modelTier} model tier`} className="mono text-2xs shrink-0 text-ink-faint">
            {task.modelTier === "strong" ? "S" : "¢"}
          </span>
        )}
        {task.verify && (
          <span title="adversarially verified" className="text-2xs text-ink-dim">⊛</span>
        )}
        {task.attempt > 1 && (
          <span className="text-2xs shrink-0 text-ink-dim">retry {task.attempt}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {active ? (
            <Spinner size={11} />
          ) : (
            <span className="text-sm" style={{ color }}>{statusGlyph(task.status)}</span>
          )}
          {dur && <span className="mono text-2xs text-ink-faint">{dur}</span>}
        </span>
      </div>

      <div className="text-sm leading-snug mb-1.5 line-clamp-2 text-ink">
        {task.title}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {task.deps.length > 0 && (
          <span className="mono text-2xs text-ink-faint">
            ⇠ {task.deps.join(", ")}
          </span>
        )}
        {task.artifacts.length > 0 && (
          <span className="mono text-2xs text-ink-dim" title={task.artifacts.join(", ")}>
            ↧ {task.artifacts.length} artifact{task.artifacts.length > 1 ? "s" : ""}
          </span>
        )}
        <SourceBadge cited={task.sources?.length ?? 0} live={task.liveSourceCount ?? 0} />
      </div>

      {active && agent && (
        <div className="mt-2 pt-2 text-2xs flex items-start gap-1.5 w-full border-t border-border-soft text-ink-dim">
          <ToolIcon name={agent.lastTool} />
          <span className="line-clamp-2 text-ink-faint" style={{ animation: "var(--animate-pulse-soft)", overflowWrap: "anywhere" }}>
            {agent.lastTool ? <span className="mono text-ink-dim">{agent.lastTool}</span> : null}
            {agent.lastTool ? " · " : ""}
            {tailText(agent) || "thinking…"}
          </span>
        </div>
      )}

      {!active && task.status === "done" && task.report && (
        <div className="mt-1.5 text-2xs line-clamp-2 text-ink-faint">
          {plainPreview(task.report)}
        </div>
      )}

      {(task.status === "failed" || task.status === "blocked") && (task.error || task.feedback) && (
        <div className="mt-1.5 text-2xs line-clamp-2" style={{ color }}>
          {plainPreview(task.feedback || task.error || "")}
        </div>
      )}
    </button>
  );
}

/** Cited sources once reported; the live touched-count until then (an empty citation list must not hide it). */
function SourceBadge({ cited, live }: { cited: number; live: number }) {
  const n = cited || live;
  if (!n) return null;
  return (
    <span className="mono text-2xs text-ink-dim" title={cited ? `${cited} cited sources` : `${live} sources touched so far`}>
      ⌕ {n} source{n > 1 ? "s" : ""}
    </span>
  );
}

function tailText(a: AgentView): string {
  const t = (a.lastText || a.lastThink || "").replace(/\s+/g, " ").trim();
  return t.length > 90 ? "…" + t.slice(t.length - 89) : t;
}

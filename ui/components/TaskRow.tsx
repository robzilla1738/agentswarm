"use client";

import { fmtDur, statusColor } from "@/lib/format";
import { PixelAvatar, personaName } from "@/lib/persona";
import type { Task } from "@/lib/types";
import { plainPreview, statusGlyph } from "./TaskCard";

/** Compact one-line row for a settled task (done / failed / blocked). */
export function TaskRow({ task, now, onClick }: { task: Task; now: number; onClick: () => void }) {
  const color = statusColor(task.status);
  const bad = task.status === "failed" || task.status === "blocked";
  const dur = task.startedAt ? fmtDur((task.endedAt ?? now) - task.startedAt) : "—";
  const problem = bad ? plainPreview(task.feedback || task.error || "") : "";

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 w-full text-left px-3 py-2 hover:bg-[rgb(var(--hi)/0.04)] transition-colors"
      style={{ animation: "var(--animate-rise)" }}
    >
      <span className={`mono text-sm shrink-0 w-4 text-center ${bad ? "font-bold" : ""}`} style={{ color }}>
        {statusGlyph(task.status)}
      </span>
      <PixelAvatar seed={task.id} size={20} />
      <span className={`mono text-2xs shrink-0 w-7 ${bad ? "font-bold text-ink" : "text-ink-dim"}`}>{task.id}</span>
      <span className="text-2xs shrink-0 w-16 truncate hidden sm:inline text-ink-dim">{personaName(task.id)}</span>
      <span className="text-2xs shrink-0 w-20 truncate hidden md:inline text-ink-faint">{task.role}</span>
      <span className="text-xs truncate flex-1 min-w-0 text-ink">
        {task.title}
        {problem && (
          <span className="ml-2" style={{ color }}>{problem}</span>
        )}
      </span>
      {task.attempt > 1 && (
        <span className="text-2xs shrink-0 hidden sm:inline text-ink-faint">retry {task.attempt}</span>
      )}
      {(task.sources?.length ?? 0) > 0 && (
        <span
          className="mono text-2xs shrink-0 text-right text-ink-faint hidden sm:inline"
          title={`${task.sources!.length} cited sources`}
        >
          ⌕ {task.sources!.length}
        </span>
      )}
      <span className="mono text-2xs shrink-0 w-9 text-right text-ink-faint" title={task.artifacts.join(", ")}>
        {task.artifacts.length > 0 ? `↧ ${task.artifacts.length}` : ""}
      </span>
      <span className="mono text-2xs shrink-0 w-14 text-right text-ink-faint">{dur}</span>
    </button>
  );
}

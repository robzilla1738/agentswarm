"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { daysToIso, fmtAgo, fmtMoney, fmtNum, fmtTokens } from "@/lib/format";
import type { RunSummary } from "@/lib/types";
import { StatusBadge, StatusDot } from "./atoms";

export function RunCard({ run, now, onDeleted }: { run: RunSummary; now: number; onDeleted?: () => void }) {
  const router = useRouter();
  const spent = run.usage.promptTokens + run.usage.completionTokens;
  const total = Math.max(1, run.tasks.total);
  const live = !!run.pid;
  const failed = run.status === "failed";
  const pct = Math.round((run.tasks.done / total) * 100);

  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 2600);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteRun(run.id);
      onDeleted?.();
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => router.push(`/run?id=${run.id}`)}
      // Only navigate when the card ITSELF has focus — otherwise Enter on the
      // nested delete button bubbles here and routes away before its confirm fires.
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && router.push(`/run?id=${run.id}`)}
      className="panel panel-hover p-4 block cursor-pointer group relative"
      style={{ animation: "var(--animate-rise)", opacity: deleting ? 0.4 : 1 }}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <StatusBadge status={run.status} />
        {live ? (
          <span className="mono text-2xs text-ink-dim flex items-center gap-1.5">
            <StatusDot status="running" size={6} />
            {run.agentsActive} active
          </span>
        ) : onDeleted ? (
          <button
            onClick={remove}
            aria-label="Delete run"
            title={confirming ? "Click again to delete" : "Delete run"}
            className="btn btn-sm px-2 py-[3px] text-2xs"
            style={{
              color: confirming ? "var(--color-ink)" : "var(--color-ink-faint)",
              borderColor: confirming ? "rgb(var(--hi) / 0.5)" : "var(--color-border-soft)",
            }}
          >
            {confirming ? "delete?" : "✕"}
          </button>
        ) : null}
      </div>

      <p className="text-base leading-snug mb-3 line-clamp-2 text-ink min-h-10">
        {run.forecast && (
          <span
            className="mono text-sm font-semibold mr-2 px-1.5 py-0.5 rounded-md align-middle"
            style={{ border: "1px solid rgb(var(--hi) / 0.35)", background: "rgb(var(--hi) / 0.05)" }}
            title={`Forecast · resolves ${run.forecast.resolutionDate} · panel of ${run.forecast.n}`}
          >
            {typeof run.forecast.p === "number"
              ? `${Math.round(run.forecast.p * 100)}%`
              : typeof run.forecast.p50 === "number"
                ? run.forecast.kind === "date"
                  ? `~${daysToIso(run.forecast.p50)}`
                  : `~${fmtNum(run.forecast.p50)}${run.forecast.unit ? ` ${run.forecast.unit}` : ""}`
                : "forecast"}
          </span>
        )}
        {run.mission}
      </p>

      <div className="mb-3">
        <div className="flex items-center justify-between text-2xs mb-1.5 text-ink-faint">
          <span>
            {run.tasks.done}/{run.tasks.total} tasks
            {run.tasks.failed ? <span className="text-ink"> · {run.tasks.failed} failed</span> : null}
          </span>
          <span className="mono">{pct}%</span>
        </div>
        <div className="w-full rounded-full overflow-hidden h-1 bg-[rgb(var(--hi)/0.07)]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: failed ? "rgb(var(--hi) / 0.45)" : "var(--color-ink)" }}
          />
        </div>
      </div>

      {failed && run.statusReason && (
        <p className="text-2xs leading-snug mb-2.5 line-clamp-2 text-ink">{run.statusReason}</p>
      )}

      <div className="flex items-center justify-between text-2xs text-ink-faint">
        <span className="mono">
          {fmtTokens(spent)} tok · {fmtMoney(run.cost)}
          {(run.sourceCount ?? 0) > 0 ? ` · ⌕ ${run.sourceCount}` : ""}
        </span>
        <span>{fmtAgo(run.updatedAt || run.createdAt, now)}</span>
      </div>
    </div>
  );
}

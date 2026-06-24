"use client";

import { fmtDur } from "@/lib/format";
import type { CodeState } from "@/lib/reducer";
import type { RunStatus } from "@/lib/types";

/**
 * Live build-arc timeline (recon → build → integrate → harden → …). The engine
 * emits a phase.set for each stage with a goal + exit-criteria; this surfaces the
 * progression so a long run reads as motion, not a frozen panel. The last phase
 * is "current" while the run is live; earlier ones are done.
 */
export function BuildPhases({
  phases,
  status,
  now,
}: {
  phases: CodeState["phases"];
  status: RunStatus;
  now: number;
}) {
  if (!phases.length) return null;
  const live = !["done", "failed", "cancelled"].includes(status);
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>
        Build arc
      </div>
      <div className="flex items-stretch gap-1.5 flex-wrap">
        {phases.map((p, i) => {
          const isLast = i === phases.length - 1;
          const current = isLast && live;
          const end = isLast ? now : phases[i + 1].t;
          const dur = Math.max(0, end - p.t);
          return (
            <div
              key={`${p.name}-${i}`}
              className="tile px-3 py-2 min-w-[7rem] flex-1"
              title={[p.goal, p.exit ? `Exit: ${p.exit}` : ""].filter(Boolean).join("\n\n")}
              style={
                current
                  ? { borderColor: "rgb(var(--hi) / 0.4)", background: "rgb(var(--hi) / 0.05)" }
                  : undefined
              }
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block rounded-full"
                  style={{
                    width: 7,
                    height: 7,
                    background: current ? "var(--color-ink)" : "var(--color-ink-faint)",
                    animation: current ? "var(--animate-pulse-soft)" : undefined,
                  }}
                />
                <span className="text-sm font-medium capitalize" style={{ color: "var(--color-ink)" }}>
                  {p.name || `phase ${i + 1}`}
                </span>
              </div>
              {p.goal && (
                <div className="text-2xs mt-1 leading-snug line-clamp-2" style={{ color: "var(--color-ink-dim)" }}>
                  {p.goal}
                </div>
              )}
              <div className="mono text-2xs mt-1" style={{ color: "var(--color-ink-faint)" }}>
                {current ? "running · " : ""}
                {fmtDur(dur)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

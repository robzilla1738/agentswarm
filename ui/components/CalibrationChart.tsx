"use client";

import type { CalibrationStats } from "@/lib/types";

/**
 * Reliability diagram: each dot is a probability band — x is what the system
 * said on average, y is how often those forecasts actually resolved YES.
 * Perfect calibration sits on the diagonal; below it = overconfident YES,
 * above it = overconfident NO. Dot area scales with the band's sample size.
 */
export function CalibrationChart({ stats }: { stats: CalibrationStats }) {
  const W = 280;
  const H = 280;
  const pad = 34;
  const sx = (p: number) => pad + p * (W - 2 * pad);
  const sy = (p: number) => H - pad - p * (H - 2 * pad);
  const maxN = Math.max(...stats.bins.map((b) => b.n), 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[320px] text-ink" role="img" aria-label="Calibration reliability diagram">
      {/* grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <g key={g}>
          <line x1={sx(g)} y1={sy(0)} x2={sx(g)} y2={sy(1)} stroke="rgb(var(--hi) / 0.07)" strokeWidth="1" />
          <line x1={sx(0)} y1={sy(g)} x2={sx(1)} y2={sy(g)} stroke="rgb(var(--hi) / 0.07)" strokeWidth="1" />
        </g>
      ))}
      {/* perfect-calibration diagonal */}
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="rgb(var(--hi) / 0.3)" strokeWidth="1" strokeDasharray="4 4" />
      {/* bins */}
      {stats.bins.map((b) => (
        <circle
          key={b.lo}
          cx={sx(b.meanP)}
          cy={sy(b.hitRate)}
          r={4 + 7 * Math.sqrt(b.n / maxN)}
          fill="currentColor"
          fillOpacity="0.75"
        >
          <title>
            {`said ${Math.round(b.meanP * 100)}% → resolved YES ${Math.round(b.hitRate * 100)}% (n=${b.n})`}
          </title>
        </circle>
      ))}
      {/* axis labels */}
      {[0, 0.5, 1].map((g) => (
        <g key={`l${g}`} className="mono" fontSize="9" fill="var(--color-ink-faint)">
          <text x={sx(g)} y={H - pad + 14} textAnchor="middle">{Math.round(g * 100)}%</text>
          <text x={pad - 8} y={sy(g) + 3} textAnchor="end">{Math.round(g * 100)}%</text>
        </g>
      ))}
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--color-ink-faint)">
        forecast probability
      </text>
      <text x={10} y={H / 2} textAnchor="middle" fontSize="9" fill="var(--color-ink-faint)" transform={`rotate(-90 10 ${H / 2})`}>
        resolved YES
      </text>
      {/* Brier annotation */}
      <text x={W - pad} y={pad - 10} textAnchor="end" fontSize="10" fill="var(--color-ink-dim)" className="mono">
        {`Brier ${stats.brierMean.toFixed(3)} · n=${stats.n}`}
      </text>
    </svg>
  );
}

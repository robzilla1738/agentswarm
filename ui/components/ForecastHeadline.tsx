"use client";

import type { AggregateForecast, ForecastQuestion, Task } from "@/lib/types";

const pctOf = (p: number) => `${Math.round(p * 100)}%`;
const daysToIso = (days: number) => new Date(Math.round(days) * 86_400_000).toISOString().slice(0, 10);

/** Per-option probability bars for mc questions. */
function OptionBars({ probs }: { probs: Record<string, number> }) {
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex-1 min-w-0 space-y-1.5">
      {ranked.map(([opt, p], i) => (
        <div key={opt} className="flex items-center gap-2">
          <span className={`mono text-sm w-11 text-right shrink-0 ${i === 0 ? "font-semibold text-ink" : "text-ink-dim"}`}>
            {pctOf(p)}
          </span>
          <div className="flex-1 h-2 rounded-full bg-[rgb(var(--hi)/0.08)] relative">
            <div
              className={`absolute top-0 h-full rounded-full ${i === 0 ? "bg-[var(--color-ink)]" : "bg-[rgb(var(--hi)/0.3)]"}`}
              style={{ width: `${Math.max(1.5, p * 100)}%` }}
            />
          </div>
          <span className={`text-xs truncate max-w-[40%] ${i === 0 ? "text-ink" : "text-ink-dim"}`}>{opt}</span>
        </div>
      ))}
    </div>
  );
}

/** "panel 62% → market 58% → recalibrated 56%" — the engine's derivation. */
function chainLine(agg: AggregateForecast): string | null {
  const c = agg.components;
  if (!c || typeof c.extremized !== "number") return null;
  const steps = [`panel ${pctOf(c.extremized)} (k=${agg.k})`];
  if (c.market && typeof c.blended === "number") {
    steps.push(`⚓ ${c.market.platform} ${pctOf(c.market.probability)} (w=${c.market.weight.toFixed(2)}) → ${pctOf(c.blended)}`);
  }
  if (typeof c.recalibrated === "number") steps.push(`recalibrated ${pctOf(c.recalibrated)}`);
  return steps.length > 1 ? steps.join("  →  ") : null;
}

/** Semicircular probability gauge, house monochrome. */
function Gauge({ p, label, dim }: { p: number; label: string; dim?: boolean }) {
  const r = 52;
  const cx = 64;
  const cy = 62;
  const theta = Math.PI - Math.PI * p;
  const x = cx + r * Math.cos(theta);
  const y = cy - r * Math.sin(theta);
  return (
    <div className="relative shrink-0" style={{ width: 150 }}>
      <svg viewBox="0 0 128 70" className="w-full">
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="rgb(var(--hi) / 0.12)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {p > 0.005 && (
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            className={dim ? "text-ink-faint" : "text-ink"}
          />
        )}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className={`mono text-2xl font-semibold leading-none ${dim ? "text-ink-dim" : "text-ink"}`}>{label}</div>
      </div>
    </div>
  );
}

/** Numeric/date forecast: p10–p90 band with the median marked. */
function RangeStrip({
  agg,
  panel,
  unit,
  asDate,
}: {
  agg: { p10: number; p50: number; p90: number };
  panel: { p10: number; p50: number; p90: number }[];
  unit?: string;
  asDate?: boolean;
}) {
  const all = [agg, ...panel];
  const lo = Math.min(...all.map((q) => q.p10));
  const hi = Math.max(...all.map((q) => q.p90));
  const span = Math.max(hi - lo, 1e-9);
  const pos = (v: number) => `${(((v - lo) / span) * 90 + 5).toFixed(1)}%`;
  const fmt = (v: number) =>
    asDate ? daysToIso(v) : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toPrecision(4)));
  return (
    <div className="flex-1 min-w-0">
      <div className="mono text-2xl font-semibold text-ink mb-1">
        {fmt(agg.p50)}
        {unit ? <span className="text-sm text-ink-dim ml-1">{unit}</span> : null}
      </div>
      <div className="relative h-2 rounded-full bg-[rgb(var(--hi)/0.08)] mt-3">
        <div
          className="absolute top-0 h-full rounded-full bg-[rgb(var(--hi)/0.25)]"
          style={{ left: pos(agg.p10), width: `calc(${pos(agg.p90)} - ${pos(agg.p10)})` }}
        />
        <div className="absolute -top-1 w-1 h-4 rounded-full bg-[var(--color-ink)]" style={{ left: pos(agg.p50) }} />
      </div>
      <div className="flex justify-between mono text-2xs text-ink-faint mt-1.5">
        <span title="10th percentile — 10% chance the value lands below this">
          p10 {fmt(agg.p10)}
        </span>
        <span title="90th percentile — 10% chance the value lands above this">
          p90 {fmt(agg.p90)}
        </span>
      </div>
    </div>
  );
}

/**
 * The forecast banner for a forecast-mode run: the sharpened question, the
 * live panel (one dot per submitted forecaster), and — once the engine has
 * aggregated — the headline probability or range.
 */
export function ForecastHeadline({
  question,
  aggregate,
  tasks,
  now,
  expectedPanel,
}: {
  question: ForecastQuestion;
  aggregate: AggregateForecast | null;
  tasks: Task[];
  now: number;
  expectedPanel?: number;
}) {
  const submitted = tasks.filter((t) => t.forecast);
  const probs = submitted
    .map((t) => t.forecast!.probability)
    .filter((p): p is number => typeof p === "number")
    .sort((a, b) => a - b);
  const interimMedian = probs.length
    ? probs.length % 2
      ? probs[(probs.length - 1) / 2]
      : (probs[probs.length / 2 - 1] + probs[probs.length / 2]) / 2
    : null;

  const deadline = Date.parse(`${question.resolutionDate}T23:59:59Z`);
  const daysLeft = Math.ceil((deadline - now) / 86_400_000);
  const countdown = Number.isFinite(daysLeft)
    ? daysLeft > 1
      ? `resolves in ${daysLeft}d (${question.resolutionDate})`
      : daysLeft >= 0
        ? `resolves today (${question.resolutionDate})`
        : `resolution date passed (${question.resolutionDate})`
    : question.resolutionDate;

  const binary = question.kind === "binary";
  const headlineP = aggregate?.probability;

  return (
    <div className="panel p-5 mb-5" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="chip text-ink" style={{ borderColor: "rgb(var(--hi) / 0.4)" }}>
          Forecast
        </span>
        <span className="mono text-2xs text-ink-faint">{countdown}</span>
        {aggregate && aggregate.spread > 0.25 && (
          <span className="mono text-2xs text-ink" title="The panel disagreed substantially — read the panel breakdown in the report">
            ⚠ panel split {binary ? `${Math.round(aggregate.spread * 100)} pts` : `${Math.round(aggregate.spread * 100)}%`}
          </span>
        )}
        {aggregate && (aggregate.evidenceOverlap ?? 0) > 0.5 && (
          <span
            className="mono text-2xs text-ink-dim"
            title="Panelists cited largely the same sources — fewer independent views than the panel size suggests; extremization was scaled down accordingly"
          >
            ⚠ shared evidence {Math.round((aggregate.evidenceOverlap ?? 0) * 100)}%
          </span>
        )}
      </div>

      <div className="flex items-start gap-6 flex-wrap">
        {binary ? (
          <Gauge
            p={headlineP ?? interimMedian ?? 0}
            label={
              typeof headlineP === "number" ? pctOf(headlineP) : interimMedian !== null ? `~${pctOf(interimMedian)}` : "…"
            }
            dim={typeof headlineP !== "number"}
          />
        ) : question.kind === "mc" && aggregate?.optionProbs ? (
          <OptionBars probs={aggregate.optionProbs} />
        ) : aggregate?.quantiles ? (
          <div className="flex-1 min-w-0">
            <RangeStrip
              agg={aggregate.quantiles}
              panel={submitted.map((t) => t.forecast!.quantiles).filter((q): q is NonNullable<typeof q> => Boolean(q))}
              unit={question.unit}
              asDate={question.kind === "date"}
            />
            {question.kind === "date" && typeof aggregate.pNever === "number" && (
              <div className="mono text-2xs text-ink-faint mt-2" title="The panel's combined probability the event simply doesn't happen by the horizon">
                P(never by {question.resolutionDate}) = {pctOf(aggregate.pNever)}
              </div>
            )}
          </div>
        ) : (
          <div className="mono text-2xl font-semibold text-ink-dim shrink-0">…</div>
        )}

        <div className="flex-1 min-w-[240px]">
          <p className="text-[15px] font-semibold leading-snug text-ink">{question.text}</p>
          <p className="text-xs leading-relaxed text-ink-faint mt-1.5" title="Resolution criteria">
            {question.resolutionCriteria}
          </p>
          {aggregate && chainLine(aggregate) && (
            <p className="mono text-2xs text-ink-faint mt-1.5" title="The engine's mechanical derivation, layer by layer">
              {chainLine(aggregate)}
            </p>
          )}

          {/* Panel strip: one dot per submitted forecaster at its probability. */}
          {binary && (
            <div className="mt-4">
              <div className="relative h-1.5 rounded-full bg-[rgb(var(--hi)/0.08)]">
                {submitted.map(
                  (t) =>
                    typeof t.forecast!.probability === "number" && (
                      <span
                        key={t.id}
                        className="absolute -top-[3px] w-3 h-3 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-ink)]"
                        style={{ left: `calc(${(t.forecast!.probability * 100).toFixed(1)}% - 6px)` }}
                        title={`${t.id} [${t.forecast!.method}] → ${pctOf(t.forecast!.probability)}${typeof t.forecast!.prior === "number" ? ` (base-rate prior ${pctOf(t.forecast!.prior)})` : ""}`}
                      />
                    )
                )}
                {typeof headlineP === "number" && (
                  <span
                    className="absolute -top-[5px] w-1 h-4 rounded-full bg-[var(--color-ink)]"
                    style={{ left: `calc(${(headlineP * 100).toFixed(1)}% - 2px)` }}
                    title={`ensemble: ${pctOf(headlineP)} (extremized geometric mean of odds, k=${aggregate!.k})`}
                  />
                )}
              </div>
              <div className="flex justify-between mono text-2xs text-ink-faint mt-1.5">
                <span>0%</span>
                <span>
                  {aggregate
                    ? `panel of ${aggregate.n} · median ${pctOf(aggregate.median ?? 0)} · ensemble ${pctOf(headlineP ?? 0)}`
                    : `${submitted.length}${expectedPanel ? `/${expectedPanel}` : ""} forecaster${submitted.length === 1 ? "" : "s"} submitted${interimMedian !== null ? ` · interim median ${pctOf(interimMedian)}` : ""} — ensemble computed at synthesis`}
                </span>
                <span>100%</span>
              </div>
            </div>
          )}
          {!binary && !aggregate && (
            <div className="mono text-2xs text-ink-faint mt-4">
              {submitted.length}
              {expectedPanel ? `/${expectedPanel}` : ""} forecaster{submitted.length === 1 ? "" : "s"} submitted — range computed at synthesis
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import type { AggregateForecast, ForecastKind, SubForecast } from "@/lib/types";
import { daysToIso, domainLabel, fmtNum, splitLabel } from "@/lib/format";
import { Spinner } from "./atoms";
import { SimulationPanel } from "./SimulationPanel";

const pct = (p: number) => `${Math.round(p * 100)}%`;

function headlineValue(agg: AggregateForecast | null, kind: ForecastKind, unit?: string): string {
  if (!agg) return "…";
  if (kind === "binary") return typeof agg.probability === "number" ? pct(agg.probability) : "…";
  if (kind === "mc" && agg.optionProbs) {
    const top = Object.entries(agg.optionProbs).sort((a, b) => b[1] - a[1])[0];
    return top ? pct(top[1]) : "…";
  }
  if (agg.quantiles) {
    const v = agg.quantiles.p50;
    // "~" signals a median estimate — matches the headline range strip and the ledger.
    return kind === "date" ? `~${daysToIso(v)}` : `~${fmtNum(v)}${unit ? ` ${unit}` : ""}`;
  }
  return "…";
}

/** The leading option label for an mc aggregate, shown under its probability. */
function topOptionLabel(agg: AggregateForecast | null): string | null {
  if (!agg?.optionProbs) return null;
  return Object.entries(agg.optionProbs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The matched sportsbook line for a sports facet, e.g. "total line 224.5" or "spread home −6.5". */
function sportsLine(s: NonNullable<SubForecast["question"]["sports"]>): string | null {
  const l = s.lineAtCreate;
  if (!l) return null;
  if (s.facet === "total" && typeof l.total === "number") return `total line ${l.total}`;
  if (s.facet === "margin" && typeof l.spread === "number") {
    return `spread ${s.favorite === "home" ? s.home : s.away} −${l.spread}`;
  }
  if (s.facet === "winner" && typeof l.pHome === "number") return `line: ${s.home} ${Math.round(l.pHome * 100)}%`;
  return null;
}

/** Compact kind-aware distribution: a fill bar (binary), option bars (mc), or a p10–p90 strip. */
function CompactViz({ agg, kind, unit }: { agg: AggregateForecast; kind: ForecastKind; unit?: string }) {
  if (kind === "binary" && typeof agg.probability === "number") {
    return (
      <div className="relative h-1.5 rounded-full bg-[rgb(var(--hi)/0.08)] mt-2">
        <div className="absolute top-0 h-full rounded-full bg-[var(--color-ink)]" style={{ width: `${Math.max(1.5, agg.probability * 100)}%` }} />
      </div>
    );
  }
  if (kind === "mc" && agg.optionProbs) {
    const ranked = Object.entries(agg.optionProbs).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return (
      <div className="mt-2 space-y-1">
        {ranked.map(([opt, p], i) => (
          <div key={opt} className="flex items-center gap-2">
            <span className={`mono text-2xs w-8 text-right shrink-0 ${i === 0 ? "text-ink" : "text-ink-dim"}`}>{pct(p)}</span>
            <div className="flex-1 h-1.5 rounded-full bg-[rgb(var(--hi)/0.08)] relative min-w-0">
              <div
                className={`absolute top-0 h-full rounded-full ${i === 0 ? "bg-[var(--color-ink)]" : "bg-[rgb(var(--hi)/0.3)]"}`}
                style={{ width: `${Math.max(1.5, p * 100)}%` }}
              />
            </div>
            <span className="text-2xs truncate max-w-[45%] text-ink-dim">{opt}</span>
          </div>
        ))}
      </div>
    );
  }
  if (agg.quantiles) {
    const { p10, p50, p90 } = agg.quantiles;
    const span = Math.max(p90 - p10, 1e-9);
    const fmt = (v: number) => (kind === "date" ? daysToIso(v) : `${fmtNum(v)}${unit ? ` ${unit}` : ""}`);
    return (
      <div className="mt-2">
        <div className="relative h-1.5 rounded-full bg-[rgb(var(--hi)/0.08)]">
          <div className="absolute top-0 h-full rounded-full bg-[rgb(var(--hi)/0.25)]" style={{ left: "5%", width: "90%" }} />
          <div className="absolute -top-1 w-1 h-3.5 rounded-full bg-[var(--color-ink)]" style={{ left: `${5 + ((p50 - p10) / span) * 90}%` }} />
        </div>
        <div className="flex justify-between mono text-2xs text-ink-faint mt-1">
          <span>p10 {fmt(p10)}</span>
          <span>p90 {fmt(p90)}</span>
        </div>
      </div>
    );
  }
  return null;
}

function SubForecastCard({ sub }: { sub: SubForecast }) {
  const [showSim, setShowSim] = useState(false);
  const { question: q, aggregate: agg } = sub;
  const sim = sub.simulation;
  const pending = !agg;
  const topLabel = topOptionLabel(agg);

  return (
    <div className="tile p-4" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-start gap-3.5">
        <div className="shrink-0 min-w-[58px]">
          <div className={`mono text-xl font-semibold leading-none ${pending ? "text-ink-faint" : "text-ink"}`}>
            {headlineValue(agg, q.kind, q.unit)}
          </div>
          {topLabel && <div className="text-2xs text-ink-faint truncate max-w-[72px] mt-0.5">{topLabel}</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {q.id && <span className="mono text-2xs text-ink-faint">{q.id}</span>}
            <span className="text-2xs text-ink-faint">
              {q.kind} · resolves {q.resolutionDate}
            </span>
            {agg && (
              <span className="mono text-2xs text-ink-faint" title="independent forecasters on this sub-forecast's panel">
                · panel {agg.n}
              </span>
            )}
            {agg && agg.spread > 0.25 && (
              <span className="mono text-2xs text-ink" title="The panel disagreed substantially on this sub-forecast.">
                ⚠ {splitLabel(agg.spread, q.kind)}
              </span>
            )}
            {pending && (
              <span className="mono text-2xs text-ink-faint inline-flex items-center gap-1.5">
                <Spinner size={10} /> forecasting…
              </span>
            )}
          </div>
          <p className="text-sm font-medium leading-snug text-ink">{q.text}</p>
          {q.sports && (
            <div className="mono text-2xs text-ink-faint mt-1">
              {q.sports.away} @ {q.sports.home} · {q.sports.facet}
              {sportsLine(q.sports) ? <span className="text-ink-dim"> · {sportsLine(q.sports)}</span> : null}
            </div>
          )}
          {agg && <CompactViz agg={agg} kind={q.kind} unit={q.unit} />}
          {sim && (
            <div className="mt-2.5">
              <button
                onClick={() => setShowSim((v) => !v)}
                className="text-2xs text-ink-faint hover:text-ink transition-colors inline-flex items-center gap-1.5"
                aria-expanded={showSim}
              >
                <span style={{ fontSize: 9, transform: showSim ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
                Scenario analysis
                {sim.coherence.verdict === "high" && <span className="text-ink" title="The simulation diverges materially from the panel.">⚠</span>}
                {sim.weight > 0 && <span className="text-ink-faint">· blended w {sim.weight.toFixed(2)}</span>}
              </button>
              <div className="collapse-v" data-open={showSim}>
                <div inert={!showSim}>
                  <div className="pt-3">
                    <SimulationPanel sim={sim} kind={q.kind} unit={q.unit} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Decomposed forecast view: when an open-ended question fans out into several
 * independently-resolvable sub-forecasts, show the framing, the domain, and
 * every sub-forecast with its own headline and scenario analysis. The combined
 * answer that ties them together is synthesized in the final report.
 */
export function ForecastBreakdown({
  brief,
  domain,
  subForecasts,
  onOpenReport,
  hasReport,
}: {
  brief: string;
  domain: string | null;
  subForecasts: SubForecast[];
  onOpenReport?: () => void;
  hasReport?: boolean;
}) {
  const done = subForecasts.filter((s) => s.aggregate).length;
  return (
    <div className="panel p-5 mb-5" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="chip text-ink" style={{ borderColor: "rgb(var(--hi) / 0.4)" }}>
          Forecast
        </span>
        <span className="mono text-2xs text-ink-faint">
          decomposed · {done}/{subForecasts.length} sub-forecast{subForecasts.length === 1 ? "" : "s"} done
        </span>
        {domain && domain !== "generic" && (
          <span className="chip" title="The domain pack the engine matched — it tunes the model and data sources.">
            {domainLabel(domain)}
          </span>
        )}
      </div>

      {brief && <p className="text-sm leading-relaxed text-ink-dim mb-4">{brief}</p>}

      <div className="space-y-3">
        {subForecasts.map((sub) => (
          <SubForecastCard key={sub.questionId || sub.question.text} sub={sub} />
        ))}
      </div>

      <p className="text-2xs text-ink-faint mt-4 leading-relaxed">
        Each sub-forecast resolves and scores on its own.{" "}
        {hasReport && onOpenReport ? (
          <button onClick={onOpenReport} className="text-ink underline underline-offset-2 hover:text-ink-dim transition-colors">
            The combined answer is synthesized in the report →
          </button>
        ) : (
          <>The combined answer is synthesized in the report when the run finishes.</>
        )}
      </p>
    </div>
  );
}

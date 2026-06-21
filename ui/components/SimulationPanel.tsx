"use client";

import type { AggregateForecast, ForecastKind, SimulationView } from "@/lib/types";
import { daysToIso, fmtNum } from "@/lib/format";

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Canonical one-line headline for any aggregate, kind-aware (mirrors the engine's simulationBlock). */
function aggHeadline(agg: AggregateForecast | null | undefined, kind: ForecastKind, unit?: string): string {
  if (!agg) return "—";
  if (kind === "binary") return typeof agg.probability === "number" ? pct(agg.probability) : "—";
  if (kind === "mc" && agg.optionProbs) {
    const top = Object.entries(agg.optionProbs).sort((a, b) => b[1] - a[1])[0];
    return top ? `${top[0]} ${pct(top[1])}` : "—";
  }
  if (agg.quantiles) {
    const v = agg.quantiles.p50;
    return kind === "date" ? daysToIso(v) : `${fmtNum(v)}${unit ? ` ${unit}` : ""}`;
  }
  return "—";
}

/** Coherence carries the one "alarm": a high divergence inverts to the solid chip. */
function CoherenceChip({ coherence }: { coherence: SimulationView["coherence"] }) {
  const high = coherence.verdict === "high";
  return (
    <span
      className={`chip ${high ? "chip-solid" : ""}`}
      title={
        `Agreement between the bottom-up simulation and the top-down panel (divergence ${coherence.divergence.toFixed(3)}). ` +
        (high
          ? "High — the simulation's structure disagrees materially with the panel; read the scenarios."
          : coherence.verdict === "moderate"
            ? "Moderate — some structural disagreement with the panel."
            : "OK — the simulation corroborates the panel.")
      }
      style={!high ? { color: coherence.verdict === "moderate" ? "var(--color-ink-dim)" : "var(--color-ink-faint)" } : undefined}
    >
      {high ? "⚠ " : ""}coherence {coherence.verdict}
    </span>
  );
}

/**
 * The grounded scenario simulation for one (sub-)forecast: a bottom-up Monte
 * Carlo cross-check rendered as a driver tornado, the modal/likely scenarios,
 * and a coherence verdict against the top-down panel. Content-only — the caller
 * supplies the container (a panel when standalone, a disclosure when nested).
 */
export function SimulationPanel({ sim, kind, unit }: { sim: SimulationView; kind: ForecastKind; unit?: string }) {
  const scenarios = sim.scenarios.slice(0, 5);
  const drivers = [...sim.sensitivity]
    .sort((a, b) => b.varianceContribution - a.varianceContribution)
    .slice(0, 6);
  const maxVar = Math.max(...drivers.map((d) => d.varianceContribution), 1e-9);
  const maxFreq = Math.max(...scenarios.map((s) => s.frequency), 1e-9);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">Scenario simulation</span>
        {sim.weight > 0 ? (
          <span className="chip text-ink" style={{ borderColor: "rgb(var(--hi) / 0.4)" }} title="The simulation earned this blend weight into the headline on the resolved ledger.">
            blended · w {sim.weight.toFixed(2)}
          </span>
        ) : (
          <span className="chip" title="A cross-check only — the simulation did not move the headline (it earns headline weight only on a resolved track record).">
            cross-check only
          </span>
        )}
        <CoherenceChip coherence={sim.coherence} />
        {sim.simulated && (
          <span className="mono text-2xs text-ink-faint" title="Bottom-up outcome from the simulated worlds, before any blend.">
            bottom-up {aggHeadline(sim.simulated, kind, unit)}
          </span>
        )}
        {sim.dropped && sim.dropped.length > 0 && (
          <span
            className="chip"
            style={{ color: "var(--color-ink-faint)" }}
            title={`Proposed driver(s) excluded as ungrounded: ${sim.dropped.join(", ")}`}
          >
            {sim.dropped.length} driver{sim.dropped.length > 1 ? "s" : ""} dropped
          </span>
        )}
      </div>

      {drivers.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xs font-medium text-ink-dim">Driver sensitivity</span>
            <span className="text-2xs text-ink-faint">share of outcome variance</span>
          </div>
          <div className="space-y-1.5">
            {drivers.map((d) => (
              <div key={d.driverId} className="flex items-center gap-2">
                <span className="mono text-2xs w-10 text-right shrink-0 text-ink">{pct(d.varianceContribution)}</span>
                <div className="flex-1 h-2 rounded-full bg-[rgb(var(--hi)/0.08)] relative min-w-0">
                  <div
                    className="absolute top-0 h-full rounded-full bg-[var(--color-ink)]"
                    style={{ width: `${Math.max(1.5, (d.varianceContribution / maxVar) * 100)}%` }}
                  />
                </div>
                <span className="text-xs truncate max-w-[45%] text-ink-dim" title={d.driverLabel}>
                  {d.driverLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scenarios.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xs font-medium text-ink-dim">Most likely scenarios</span>
            <span className="text-2xs text-ink-faint">of {sim.scenarios.length} clusters · % of worlds</span>
          </div>
          <div className="space-y-1.5">
            {scenarios.map((sc, i) => (
              <div key={sc.key} className="flex items-center gap-2">
                <span className={`mono text-2xs w-9 text-right shrink-0 ${i === 0 ? "font-semibold text-ink" : "text-ink-dim"}`}>
                  {pct(sc.frequency)}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-[rgb(var(--hi)/0.08)] relative min-w-0 max-w-[90px]">
                  <div
                    className={`absolute top-0 h-full rounded-full ${i === 0 ? "bg-[var(--color-ink)]" : "bg-[rgb(var(--hi)/0.3)]"}`}
                    style={{ width: `${Math.max(3, (sc.frequency / maxFreq) * 100)}%` }}
                  />
                </div>
                <span
                  className={`text-xs truncate flex-1 min-w-0 ${i === 0 ? "text-ink" : "text-ink-dim"}`}
                  title={i === 0 ? `Modal scenario — the single most frequent world. ${sc.description}` : sc.description}
                >
                  {sc.description}
                </span>
                <span className="mono text-2xs shrink-0 text-ink-faint">→ {aggHeadline(sc.outcome, kind, unit)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {drivers.length === 0 && scenarios.length === 0 && (
        <p className="text-2xs text-ink-faint">No grounded drivers — the simulation had nothing to vary.</p>
      )}
    </div>
  );
}

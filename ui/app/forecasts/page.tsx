"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalibrationChart } from "@/components/CalibrationChart";
import { TopBar } from "@/components/TopBar";
import { EmptyState, Spinner } from "@/components/atoms";
import { api } from "@/lib/api";
import type { CalibrationStats, LedgerEntry } from "@/lib/types";

const pct = (p: number) => `${Math.round(p * 100)}%`;
const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toPrecision(4))));
const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);

function isDue(e: LedgerEntry, now: number): boolean {
  return !e.resolution && Date.parse(`${e.question.resolutionDate}T23:59:59Z`) <= now;
}

function headline(e: LedgerEntry): string {
  if (typeof e.aggregate.probability === "number") return pct(e.aggregate.probability);
  if (e.aggregate.quantiles) return `~${fmtNum(e.aggregate.quantiles.p50)}${e.question.unit ? ` ${e.question.unit}` : ""}`;
  return "—";
}

function outcomeLabel(e: LedgerEntry): string {
  const o = e.resolution?.outcome;
  if (o === undefined) return "";
  if (o === "void") return "void";
  if (o === 1) return "YES";
  if (o === 0) return "NO";
  return `${fmtNum(o as number)}${e.question.unit ? ` ${e.question.unit}` : ""}`;
}

export default function ForecastsPage() {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [calibration, setCalibration] = useState<CalibrationStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [resolving, setResolving] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      const { forecasts, calibration } = await api.forecasts();
      setEntries(forecasts);
      setCalibration(calibration);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "hub unreachable");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const due = useMemo(() => (entries ?? []).filter((e) => isDue(e, now)), [entries, now]);
  const shown = useMemo(() => {
    const list = entries ?? [];
    const filtered =
      filter === "open" ? list.filter((e) => !e.resolution) : filter === "resolved" ? list.filter((e) => e.resolution) : list;
    return [...filtered].sort((a, b) => b.t - a.t);
  }, [entries, filter]);

  const resolveNow = async (ids?: string[]) => {
    setResolving(new Set(ids ?? due.map((e) => e.id)));
    setNotice(null);
    try {
      const r = await api.resolveForecasts(ids);
      const parts: string[] = [];
      if (r.resolved.length) parts.push(`${r.resolved.length} resolved`);
      for (const s of r.skipped) parts.push(`${s.id} left open: ${s.reason}`);
      setNotice(parts.join(" · ") || "nothing was due");
      await load();
    } catch (e: any) {
      setNotice(e?.message || "resolution failed");
    } finally {
      setResolving(null);
    }
  };

  const manual = async (id: string, outcome: "yes" | "no" | "void") => {
    try {
      await api.resolveManual(id, outcome);
      await load();
    } catch (e: any) {
      setNotice(e?.message || "manual resolution failed");
    }
  };

  const openCount = (entries ?? []).filter((e) => !e.resolution).length;
  const resolvedCount = (entries ?? []).filter((e) => e.resolution).length;

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="max-w-5xl mx-auto px-5 sm:px-8 py-8">
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="font-display text-[22px] mb-1">Forecasts</h1>
            <p className="text-xs text-ink-faint">
              Every prediction the swarm has made, resolved against reality. Brier 0.25 = &quot;always say 50%&quot;; lower is better.
            </p>
          </div>
          {due.length > 0 && (
            <button className="btn btn-primary btn-sm" disabled={!!resolving} onClick={() => resolveNow()}>
              {resolving ? <Spinner size={12} dark /> : null} Resolve {due.length} due
            </button>
          )}
        </div>

        {error && (
          <div className="panel p-4 mb-6 text-sm text-ink-dim">
            Can&apos;t reach the hub: {error}. Make sure <span className="mono text-ink">swarm serve</span> is running.
          </div>
        )}
        {notice && <div className="panel p-3 mb-6 text-xs text-ink-dim">{notice}</div>}

        {/* Stat cards */}
        {entries && entries.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <Stat label="Open" value={String(openCount)} />
            <Stat label="Due for resolution" value={String(due.length)} />
            <Stat label="Resolved" value={String(resolvedCount)} />
            <Stat
              label="Mean Brier"
              value={calibration && calibration.n ? calibration.brierMean.toFixed(3) : "—"}
              hint={calibration && calibration.n ? `${calibration.n} scored` : "resolve forecasts to score"}
            />
          </div>
        )}

        {/* Calibration */}
        {calibration && calibration.n >= 3 && (
          <section className="panel p-5 mb-6 flex flex-wrap gap-8 items-start">
            <div>
              <h2 className="label mb-3">Calibration</h2>
              <CalibrationChart stats={calibration} />
            </div>
            {Object.keys(calibration.byMethod).length > 0 && (
              <div className="flex-1 min-w-[220px]">
                <h2 className="label mb-3">By panel method</h2>
                <table className="w-full text-xs">
                  <tbody>
                    {Object.entries(calibration.byMethod)
                      .sort((a, b) => a[1].brierMean - b[1].brierMean)
                      .map(([m, s]) => (
                        <tr key={m} className="border-b border-border-soft">
                          <td className="py-1.5 text-ink-dim">{m}</td>
                          <td className="py-1.5 mono text-right text-ink">{s.brierMean.toFixed(3)}</td>
                          <td className="py-1.5 mono text-right text-ink-faint">n={s.n}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="text-2xs text-ink-faint mt-2 leading-relaxed">
                  Which forecasting lens has the best track record — the engine&apos;s aggregation weighting stays mechanical,
                  but the conductor reads this when composing panels.
                </p>
              </div>
            )}
          </section>
        )}

        {/* Filters */}
        {entries && entries.length > 0 && (
          <div className="flex items-center gap-1.5 mb-4">
            {(["all", "open", "resolved"] as const).map((f) => (
              <button
                key={f}
                className="chip"
                style={filter === f ? { color: "var(--color-ink)", borderColor: "rgb(var(--hi) / 0.45)" } : undefined}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        )}

        {/* Ledger */}
        {!entries && !error && (
          <div className="panel h-32 skeleton opacity-50" />
        )}
        {entries && entries.length === 0 && (
          <EmptyState
            glyph="◔"
            title="No forecasts yet"
            sub='Launch one from the dashboard with the Forecast toggle, or run: swarm forecast "Will X happen by 2026-12-31?"'
          />
        )}
        {shown.length > 0 && (
          <div className="space-y-3">
            {shown.map((e) => {
              const dueNow = isDue(e, now);
              const busy = resolving?.has(e.id);
              return (
                <div key={e.id} className="panel p-4" style={dueNow ? { borderColor: "rgb(var(--hi) / 0.35)" } : undefined}>
                  <div className="flex items-start gap-4 flex-wrap">
                    <span className="mono text-xl font-semibold text-ink shrink-0 min-w-[64px]">{headline(e)}</span>
                    <div className="flex-1 min-w-[240px]">
                      <Link href={`/run?id=${e.runId}`} className="text-sm font-medium leading-snug text-ink hover:underline">
                        {e.question.text}
                      </Link>
                      <div className="mono text-2xs text-ink-faint mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>{fmtDate(e.t)}</span>
                        <span>· panel {e.aggregate.n}</span>
                        {typeof e.aggregate.probability === "number" && <span>· spread {Math.round(e.aggregate.spread * 100)}pts</span>}
                        <span>· resolves {e.question.resolutionDate}</span>
                      </div>
                      {e.resolution && (
                        <p className="text-2xs text-ink-faint mt-1.5 leading-relaxed">
                          {e.resolution.evidence}{" "}
                          <span className="text-ink-faint">({e.resolution.resolvedBy})</span>
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      {e.resolution ? (
                        <>
                          <div className="mono text-sm font-semibold text-ink">{outcomeLabel(e)}</div>
                          {e.resolution.brier !== undefined && (
                            <div className="mono text-2xs text-ink-faint mt-0.5">Brier {e.resolution.brier.toFixed(3)}</div>
                          )}
                          {e.resolution.intervalScore !== undefined && (
                            <div className="mono text-2xs text-ink-faint mt-0.5">interval {e.resolution.intervalScore.toFixed(2)}</div>
                          )}
                        </>
                      ) : dueNow ? (
                        <div className="flex flex-col items-end gap-1.5">
                          <button className="btn btn-sm" disabled={!!resolving} onClick={() => resolveNow([e.id])}>
                            {busy ? <Spinner size={11} /> : null} Resolve now
                          </button>
                          <span className="flex gap-1">
                            {e.question.kind === "binary" && (
                              <>
                                <button className="chip" title="Mark resolved YES (operator)" onClick={() => manual(e.id, "yes")}>YES</button>
                                <button className="chip" title="Mark resolved NO (operator)" onClick={() => manual(e.id, "no")}>NO</button>
                              </>
                            )}
                            <button className="chip" title="Mark void — the question stopped being meaningful" onClick={() => manual(e.id, "void")}>void</button>
                          </span>
                        </div>
                      ) : (
                        <span className="chip">open</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-2xs text-ink-faint mb-1">{label}</div>
      <div className="mono text-xl font-semibold text-ink">{value}</div>
      {hint && <div className="text-2xs text-ink-faint mt-0.5">{hint}</div>}
    </div>
  );
}

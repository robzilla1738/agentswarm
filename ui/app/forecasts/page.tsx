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
const daysToIso = (days: number) => new Date(Math.round(days) * 86_400_000).toISOString().slice(0, 10);

function isDue(e: LedgerEntry, now: number): boolean {
  return !e.resolution && Date.parse(`${e.question.resolutionDate}T23:59:59Z`) <= now;
}

function topOption(probs: Record<string, number>): [string, number] | null {
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return ranked[0] ?? null;
}

function headline(e: LedgerEntry): string {
  if (typeof e.aggregate.probability === "number") return pct(e.aggregate.probability);
  if (e.aggregate.optionProbs) {
    const top = topOption(e.aggregate.optionProbs);
    return top ? pct(top[1]) : "—";
  }
  if (e.aggregate.quantiles) {
    if (e.question.kind === "date") return daysToIso(e.aggregate.quantiles.p50);
    return `~${fmtNum(e.aggregate.quantiles.p50)}${e.question.unit ? ` ${e.question.unit}` : ""}`;
  }
  return "—";
}

function headlineSub(e: LedgerEntry): string | null {
  if (e.aggregate.optionProbs) return topOption(e.aggregate.optionProbs)?.[0] ?? null;
  return null;
}

function outcomeLabel(e: LedgerEntry): string {
  const o = e.resolution?.outcome;
  if (o === undefined) return "";
  if (o === "void") return "void";
  if (o === 1 && e.question.kind === "binary") return "YES";
  if (o === 0 && e.question.kind === "binary") return "NO";
  if (typeof o === "string") return o; // mc option or "never"
  if (e.question.kind === "date") return daysToIso(o as number);
  return `${fmtNum(o as number)}${e.question.unit ? ` ${e.question.unit}` : ""}`;
}

/** "panel 62% → ⚓ market 58% → 56%" — the engine's full derivation chain. */
function chainLabel(e: LedgerEntry): string | null {
  const c = e.aggregate.components;
  if (!c || typeof c.extremized !== "number") return null;
  const steps: string[] = [];
  if (typeof c.panelGmo === "number") steps.push(`GMO ${pct(c.panelGmo)}`);
  steps.push(`extremized ${pct(c.extremized)}`);
  if (c.market && typeof c.blended === "number") {
    steps.push(`market [${c.market.platform} ${pct(c.market.probability)}, w=${c.market.weight.toFixed(2)}] → ${pct(c.blended)}`);
  }
  if (typeof c.recalibrated === "number") steps.push(`recalibrated ${pct(c.recalibrated)}`);
  return steps.length > 1 ? steps.join(" → ") : null;
}

/** Tournament entries scored against the source market's price at import. */
function vsMarket(entries: LedgerEntry[]): { n: number; swarm: number; market: number } | null {
  const scored = entries.filter(
    (e) =>
      e.question.kind === "binary" &&
      typeof e.origin?.marketProbAtCreate === "number" &&
      typeof e.aggregate.probability === "number" &&
      e.resolution &&
      (e.resolution.outcome === 0 || e.resolution.outcome === 1)
  );
  if (!scored.length) return null;
  const brier = (p: number, o: number) => Math.pow(p - o, 2);
  return {
    n: scored.length,
    swarm: scored.reduce((s, e) => s + brier(e.aggregate.probability!, e.resolution!.outcome as number), 0) / scored.length,
    market: scored.reduce((s, e) => s + brier(e.origin!.marketProbAtCreate!, e.resolution!.outcome as number), 0) / scored.length,
  };
}

function downloadText(name: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCsv(entries: LedgerEntry[]): void {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["id", "created", "kind", "question", "forecast", "resolutionDate", "outcome", "brier", "logScore", "pinball", "platform", "marketAtImport", "supersedes"].join(","),
    ...entries.map((e) =>
      [
        e.id,
        fmtDate(e.t),
        e.question.kind,
        esc(e.question.text),
        typeof e.aggregate.probability === "number" ? e.aggregate.probability : e.aggregate.quantiles?.p50 ?? "",
        e.question.resolutionDate,
        e.resolution ? esc(e.resolution.outcome) : "",
        e.resolution?.brier ?? "",
        e.resolution?.logScore ?? "",
        e.resolution?.pinball ?? "",
        e.origin?.platform ?? "",
        e.origin?.marketProbAtCreate ?? "",
        e.supersedes ?? "",
      ].join(",")
    ),
  ];
  downloadText("forecast-ledger.csv", "text/csv", rows.join("\n"));
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
  const market = useMemo(() => vsMarket(entries ?? []), [entries]);
  const superseded = useMemo(() => new Set((entries ?? []).map((e) => e.supersedes).filter(Boolean) as string[]), [entries]);

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
          <div className={`grid grid-cols-2 ${market ? "sm:grid-cols-5" : "sm:grid-cols-4"} gap-4 mb-6`}>
            <Stat label="Open" value={String(openCount)} />
            <Stat label="Due for resolution" value={String(due.length)} />
            <Stat label="Resolved" value={String(resolvedCount)} />
            <Stat
              label="Mean Brier"
              value={calibration && calibration.n ? calibration.brierMean.toFixed(3) : "—"}
              hint={calibration && calibration.n ? `${calibration.n} scored` : "resolve forecasts to score"}
            />
            {market && (
              <Stat
                label="vs market"
                value={`${market.swarm < market.market ? "+" : "−"}${Math.abs(market.market - market.swarm).toFixed(3)}`}
                hint={`swarm ${market.swarm.toFixed(3)} vs market ${market.market.toFixed(3)} Brier (n=${market.n})${market.swarm < market.market ? " — beating the market" : ""}`}
              />
            )}
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

        {/* Filters + export */}
        {entries && entries.length > 0 && (
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
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
            <span className="flex-1" />
            <button
              className="chip"
              title="Download the raw ledger (JSONL, one record per line)"
              onClick={() => downloadText("forecast-ledger.jsonl", "application/jsonl", entries.map((e) => JSON.stringify(e)).join("\n"))}
            >
              ⤓ jsonl
            </button>
            <button className="chip" title="Download a flat CSV for spreadsheets/analysis" onClick={() => exportCsv(entries)}>
              ⤓ csv
            </button>
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
              const chain = chainLabel(e);
              const sub = headlineSub(e);
              const stale = superseded.has(e.id);
              return (
                <div
                  key={e.id}
                  className="panel p-4"
                  style={{
                    ...(dueNow ? { borderColor: "rgb(var(--hi) / 0.35)" } : {}),
                    ...(stale ? { opacity: 0.6 } : {}),
                  }}
                >
                  <div className="flex items-start gap-4 flex-wrap">
                    <span className="mono text-xl font-semibold text-ink shrink-0 min-w-[64px]">
                      {headline(e)}
                      {sub && <span className="block text-2xs font-normal text-ink-faint truncate max-w-[110px]">{sub}</span>}
                    </span>
                    <div className="flex-1 min-w-[240px]">
                      <Link href={`/run?id=${e.runId}`} className="text-sm font-medium leading-snug text-ink hover:underline">
                        {e.question.text}
                      </Link>
                      <div className="mono text-2xs text-ink-faint mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>{fmtDate(e.t)}</span>
                        <span>· panel {e.aggregate.n}</span>
                        {typeof e.aggregate.probability === "number" && <span>· spread {Math.round(e.aggregate.spread * 100)}pts</span>}
                        <span>· resolves {e.question.resolutionDate}</span>
                        {e.origin && (
                          <a href={e.origin.url} target="_blank" rel="noreferrer" className="hover:underline" title="Imported from this market by swarm tournament">
                            · 🏆 {e.origin.platform}
                            {typeof e.origin.marketProbAtCreate === "number" ? ` @ ${pct(e.origin.marketProbAtCreate)}` : ""}
                          </a>
                        )}
                        {e.supersedes && <span title="Trigger-driven re-forecast of an earlier entry">· supersedes {e.supersedes}</span>}
                        {stale && <span title="A newer forecast of this question exists">· superseded</span>}
                      </div>
                      {chain && (
                        <div className="mono text-2xs text-ink-faint mt-1" title="The engine's mechanical derivation, layer by layer">
                          {chain}
                        </div>
                      )}
                      {e.question.kind === "mc" && e.aggregate.optionProbs && (
                        <div className="mt-1.5 space-y-0.5">
                          {Object.entries(e.aggregate.optionProbs)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 5)
                            .map(([opt, p]) => (
                              <div key={opt} className="flex items-center gap-2 text-2xs">
                                <span className="mono text-ink-faint w-9 text-right shrink-0">{pct(p)}</span>
                                <div className="h-1.5 rounded bg-[rgb(var(--hi)/0.35)]" style={{ width: `${Math.max(2, p * 140)}px` }} />
                                <span className="text-ink-dim truncate">{opt}</span>
                              </div>
                            ))}
                        </div>
                      )}
                      {e.question.kind === "date" && e.aggregate.quantiles && (
                        <div className="mono text-2xs text-ink-faint mt-1">
                          p10 {daysToIso(e.aggregate.quantiles.p10)} · p90 {daysToIso(e.aggregate.quantiles.p90)}
                          {typeof e.aggregate.pNever === "number" && <> · P(never by horizon) {pct(e.aggregate.pNever)}</>}
                        </div>
                      )}
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
                          {e.resolution.pinball !== undefined && (
                            <div className="mono text-2xs text-ink-faint mt-0.5">pinball {e.resolution.pinball.toFixed(2)}</div>
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

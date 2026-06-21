"use client";

import { useMemo } from "react";
import { MissionComposer } from "@/components/MissionComposer";
import { RunCard } from "@/components/RunCard";
import { TopBar } from "@/components/TopBar";
import { EmptyState, LogoMark } from "@/components/atoms";
import { fmtMoney, fmtTokens } from "@/lib/format";
import { useConfig, useNow, useRuns } from "@/lib/hooks";

export default function Dashboard() {
  const { runs, loading, error, refresh } = useRuns();
  const { config } = useConfig();
  const now = useNow(2000);

  const { live, past, totals } = useMemo(() => {
    const live = runs.filter((r) => r.pid || ["planning", "running", "synthesizing"].includes(r.status));
    const past = runs.filter((r) => !live.includes(r));
    const totals = runs.reduce(
      (acc, r) => {
        acc.cost += r.cost;
        acc.tokens += r.usage.promptTokens + r.usage.completionTokens;
        acc.tasks += r.tasks.done;
        return acc;
      },
      { cost: 0, tokens: 0, tasks: 0 }
    );
    return { live, past, totals };
  }, [runs]);

  return (
    <div className="min-h-screen">
      <TopBar hideLogo />
      <main className="max-w-6xl mx-auto px-5 sm:px-8 pb-10">
        <div
          className={`max-w-3xl mx-auto flex flex-col justify-center ${
            runs.length === 0 ? "min-h-[calc(100vh-3.5rem)]" : "pt-10"
          }`}
        >
          <div className="flex flex-col items-center gap-3 mb-8" style={{ animation: "var(--animate-rise)" }}>
            <LogoMark size={64} />
            <h1 className="font-display text-2xl">
              agentswarm
            </h1>
          </div>
          <MissionComposer config={config} />
        </div>

        {error && (
          <div className="panel p-4 mt-8 text-sm text-ink-dim">
            Can&apos;t reach the hub: {error}. Make sure <span className="mono text-ink">swarm serve</span> is running.
          </div>
        )}

        {live.length > 0 && (
          <section className="mt-10">
            <h2 className="label mb-4 flex items-center gap-2">
              <span className="rounded-full bg-ink w-[7px] h-[7px] shadow-[0_0_8px_var(--color-ink)]" />
              Live now · {live.length}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {live.map((r) => (
                <RunCard key={r.id} run={r} now={now} />
              ))}
            </div>
          </section>
        )}

        {loading && runs.length === 0 && (
          <section className="mt-10">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="panel h-40 skeleton opacity-50" />
              ))}
            </div>
          </section>
        )}

        {!loading && runs.length === 0 && !error && (
          <section className="mt-10">
            <EmptyState
              glyph="◇"
              title="No missions yet"
              sub="Describe one above and launch your first swarm. It runs in an isolated workspace on this machine by default."
            />
          </section>
        )}

        {past.length > 0 && (
          <section className="mt-10">
            <div className="flex items-baseline justify-between gap-4 mb-4">
              <h2 className="label">History · {past.length}</h2>
              <span className="mono text-2xs text-ink-faint">
                {totals.tasks} tasks · {fmtTokens(totals.tokens)} tok · {fmtMoney(totals.cost)} est.
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {past.map((r) => (
                <RunCard key={r.id} run={r} now={now} onDeleted={refresh} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

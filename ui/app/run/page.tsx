"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArtifactsPanel } from "@/components/ArtifactsPanel";
import { CodePanel } from "@/components/CodePanel";
import { ForecastBreakdown } from "@/components/ForecastBreakdown";
import { ForecastHeadline } from "@/components/ForecastHeadline";
import { ReportPanel } from "@/components/ReportPanel";
import { SimulationPanel } from "@/components/SimulationPanel";
import { CancelButton, NoteComposer } from "@/components/RunControls";
import { SideRail } from "@/components/SideRail";
import { SwarmBoard } from "@/components/SwarmBoard";
import { TaskDetail } from "@/components/TaskDetail";
import { TopBar } from "@/components/TopBar";
import { BudgetBar, Spinner, StatusBadge, StatusDot } from "@/components/atoms";
import { api } from "@/lib/api";
import { fmtDur, fmtMoney, fmtTokens } from "@/lib/format";
import { useNow, useRun } from "@/lib/hooks";
import type { Task } from "@/lib/types";

function RunView() {
  const params = useSearchParams();
  const id = params.get("id");
  const { data, connected, engineLive } = useRun(id);
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"swarm" | "report" | "artifacts">("swarm");
  const [autoSwitched, setAutoSwitched] = useState(false);
  const [connectingSlow, setConnectingSlow] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // If the first events never arrive, say so instead of spinning forever
  // (bad run id, or the hub isn't running).
  useEffect(() => {
    setConnectingSlow(false);
    const t = setTimeout(() => setConnectingSlow(true), 8000);
    return () => clearTimeout(t);
  }, [id]);

  const terminal = data ? ["done", "failed", "cancelled"].includes(data.status) : false;
  useEffect(() => {
    if (terminal && !autoSwitched && (data?.finalSummary || data?.finalReportPath)) {
      setTab("report");
      setAutoSwitched(true);
    }
  }, [terminal, autoSwitched, data?.finalSummary, data?.finalReportPath]);

  const selectedTask = useMemo(
    () => (data && selected ? data.tasks.find((t) => t.id === selected) ?? null : null),
    [data, selected]
  );

  const artifactCount = useMemo(() => {
    if (!data) return 0;
    const all = new Set<string>();
    for (const t of data.tasks) for (const a of t.artifacts) all.add(a);
    if (data.finalReportPath) all.add("final-report.md");
    return all.size;
  }, [data]);

  if (!id) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <div className="max-w-3xl mx-auto p-10 text-center text-ink-dim">
          No run id. <Link href="/" className="underline">Back to dashboard</Link>
        </div>
      </div>
    );
  }

  if (!data || !data.meta) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <div className="max-w-3xl mx-auto p-16 text-center">
          <div className="flex items-center justify-center gap-3 text-ink-faint">
            <Spinner /> connecting to run…
          </div>
          {connectingSlow && (
            <div className="mt-6 text-sm leading-relaxed text-ink-dim" style={{ animation: "var(--animate-rise)" }}>
              Still connecting. This run id may not exist, or the hub isn&apos;t reachable — check that{" "}
              <span className="mono text-ink">swarm serve</span> is running.
              <div className="mt-3">
                <Link href="/" className="btn btn-sm">
                  Back to dashboard
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const meta = data.meta;
  const spent = data.usage.promptTokens + data.usage.completionTokens;
  const cap = meta.options.maxTokens;
  const live = !terminal;
  const failed = data.status === "failed";
  const authIssue = failed && /auth|api key|rejected|401/i.test(data.statusReason || "");
  // The journal says "running" but the hub reports the engine process gone:
  // the run was interrupted (crash, kill, reboot) and will not progress.
  const interrupted = live && engineLive === false;
  // Freeze the clock at the last journal event once nothing can progress.
  const elapsed = fmtDur(((terminal || interrupted) && data.updatedAt ? data.updatedAt : now) - meta.createdAt);

  const counts = {
    done: data.tasks.filter((t) => t.status === "done").length,
    failed: data.tasks.filter((t) => t.status === "failed").length,
    blocked: data.tasks.filter((t) => t.status === "blocked").length,
    total: data.tasks.length,
  };
  const cacheHitPct =
    data.usage.promptTokens > 0 ? Math.round((data.usage.cacheHitTokens / data.usage.promptTokens) * 100) : 0;

  const metaLine = [
    meta.options.model,
    meta.sandbox ? "isolated workspace" : "real directory",
    `${meta.options.maxWorkers}× parallel`,
    ...(meta.options.verification !== "off" ? [`verify ${meta.options.verification}`] : []),
  ].join(" · ");

  return (
    <div className="min-h-screen">
      <TopBar
        right={
          <span className="hidden md:flex items-center gap-2 text-2xs text-ink-faint">
            <StatusDot status={connected ? (live ? "running" : data.status) : "failed"} size={7} pulse={connected && live} />
            {connected ? (live ? "live" : "loaded") : "reconnecting…"}
          </span>
        }
      />

      <main className="max-w-[1400px] mx-auto px-5 sm:px-8 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="min-w-0">
        {failed && (
          <Banner glyph="✕" title="This run failed">
            {data.statusReason || "The run ended without completing."}
            {authIssue && (
              <Link href="/settings" className="btn btn-sm mt-3">
                Fix your API key in Settings
              </Link>
            )}
          </Banner>
        )}

        {interrupted && (
          <Banner glyph="◌" title="Engine process is not running">
            This run was interrupted before it could finish — the journal shows its last known state.
            Resuming keeps completed work and re-runs only the tasks that were in flight.
            <div className="mt-3">
              <ResumeButton id={id} />
            </div>
          </Banner>
        )}

        {data.question &&
          (data.subForecasts.length > 1 ? (
            <ForecastBreakdown
              brief={data.forecastBrief}
              domain={data.forecastDomain}
              subForecasts={data.subForecasts}
              onOpenReport={() => setTab("report")}
              hasReport={!!data.finalSummary}
            />
          ) : (
            <>
              <ForecastHeadline
                question={data.question}
                aggregate={data.aggregate}
                tasks={data.tasks}
                now={now}
                expectedPanel={meta.options.panelSize}
                dateInferred={!meta.options.resolutionDate}
                domain={data.forecastDomain}
              />
              {data.subForecasts[0]?.simulation && (
                <section className="panel p-5 mb-5" style={{ animation: "var(--animate-rise)" }}>
                  <SimulationPanel
                    sim={data.subForecasts[0].simulation}
                    kind={data.question.kind}
                    unit={data.question.unit}
                  />
                </section>
              )}
            </>
          ))}

        {data.code && <CodePanel code={data.code} />}

        {/* Header */}
        <div className="panel p-5 mb-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold leading-snug mb-1.5 text-ink">{meta.mission}</h1>
              <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
                <StatusBadge status={data.status} />
                <span className="mono text-2xs text-ink-faint">{metaLine}</span>
                <button
                  className="mono text-2xs text-ink-faint hover:text-ink-dim transition-colors"
                  aria-label="Copy run id"
                  title="Copy run id"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(id)
                      .then(() => {
                        setCopiedId(true);
                        setTimeout(() => setCopiedId(false), 1200);
                      })
                      .catch(() => {});
                  }}
                >
                  {id} {copiedId ? <span className="text-ink">✓</span> : "⧉"}
                </button>
              </div>
              {data.statusReason && terminal && (
                <p className="text-xs mt-2 text-ink-faint">{data.statusReason}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <CancelButton id={id} live={live && !interrupted} />
              {(data.finalSummary || terminal) && tab !== "report" && (
                <button onClick={() => setTab("report")} className="btn">View report</button>
              )}
            </div>
          </div>

          <div className="mono text-2xs text-ink-faint mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink-dim">{counts.done}/{counts.total} tasks</span>
            {counts.failed > 0 && <span className="text-ink font-bold">{counts.failed} failed</span>}
            {counts.blocked > 0 && <span className="text-ink font-bold">{counts.blocked} blocked</span>}
            <span>·</span>
            <span>{data.activeAgents.length} active</span>
            <span>·</span>
            <span>{fmtTokens(spent)} tok{cacheHitPct > 0 ? ` · ${cacheHitPct}% cached` : ""}</span>
            <span>·</span>
            <span title="distinct web sources touched so far — searches, fetches, and cited sources">⌕ {data.sourceCount} sources</span>
            <span>·</span>
            <span title="total artifacts saved by the swarm">↧ {artifactCount} artifacts</span>
            <span>·</span>
            <span>{fmtMoney(data.cost)}</span>
            <span>·</span>
            <span>{elapsed}</span>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <BudgetBar spent={spent} cap={cap} height={3} />
            </div>
            <span className="mono text-2xs text-ink-faint shrink-0">
              {cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0}% of {fmtTokens(cap)}
            </span>
          </div>

          {live && !interrupted && (
            <div className="mt-3">
              <NoteComposer id={id} />
            </div>
          )}
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-6 mb-5 border-b border-border-soft">
          <button className="tab" data-active={tab === "swarm"} onClick={() => setTab("swarm")}>
            Swarm
          </button>
          <button className="tab" data-active={tab === "report"} onClick={() => setTab("report")}>
            Report
            {data.finalSummary ? <span className="text-ink">✓</span> : null}
          </button>
          <button className="tab" data-active={tab === "artifacts"} onClick={() => setTab("artifacts")}>
            Artifacts
            {artifactCount > 0 && <span className="mono text-2xs text-ink-faint">{artifactCount}</span>}
          </button>
        </div>

        {tab === "swarm" ? (
          <div className="min-w-0">
            <SwarmBoard
              tasks={data.tasks}
              agents={data.agents}
              status={data.status}
              conductorLog={data.conductorLog}
              finalSummary={data.finalSummary}
              now={now}
              onSelect={(t: Task) => setSelected(t.id)}
              onOpenReport={() => setTab("report")}
            />
          </div>
        ) : tab === "report" ? (
          <ReportPanel id={id} hasFinal={!!data.finalSummary} live={live} />
        ) : (
          <ArtifactsPanel id={id} refreshKey={artifactCount} />
        )}
        </div>

        <SideRail
          runId={id}
          activity={data.activity}
          conductorLog={data.conductorLog}
          notes={data.notes}
          operatorNotes={data.operatorNotes}
          planUpdatedAt={data.planUpdatedAt}
        />
      </main>

      <TaskDetail runId={id} task={selectedTask} agents={data.agents} now={now} onClose={() => setSelected(null)} />
    </div>
  );
}

function ResumeButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "resuming" | "error">("idle");
  return (
    <button
      className="btn btn-sm"
      disabled={state === "resuming"}
      onClick={async () => {
        setState("resuming");
        try {
          await api.resume(id);
          // The SSE liveness channel flips the banner off once the engine is up.
        } catch {
          setState("error");
        }
      }}
    >
      {state === "resuming" ? <Spinner size={12} /> : null}
      {state === "error" ? "Resume failed — retry" : "Resume run"}
    </button>
  );
}

function Banner({ glyph, title, children }: { glyph: string; title: string; children: React.ReactNode }) {
  return (
    <div
      className="panel p-4 mb-5 flex items-start gap-3.5"
      style={{
        borderColor: "rgb(var(--hi) / 0.28)",
        background: "rgb(var(--hi) / 0.03)",
        animation: "var(--animate-rise)",
      }}
    >
      <span className="glyph shrink-0 text-ink w-[30px] h-[30px] text-sm">{glyph}</span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-ink">{title}</div>
        <div className="text-sm mt-0.5 leading-relaxed text-ink-dim">{children}</div>
      </div>
    </div>
  );
}

export default function RunPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen grid place-items-center text-ink-faint">
          <Spinner />
        </div>
      }
    >
      <RunView />
    </Suspense>
  );
}

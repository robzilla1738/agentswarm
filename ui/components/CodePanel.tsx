"use client";

import { useState } from "react";
import { BuildPhases } from "@/components/BuildPhases";
import { StatusDot } from "@/components/atoms";
import type { CodeState } from "@/lib/reducer";
import type { RunStatus, Task } from "@/lib/types";

/**
 * Code (build) runs: a live "Build Console" that surfaces the engine-owned
 * orchestration the way the forecast panels surface the ensemble — the build
 * arc, the acceptance checklist, the pinned plan as a wave graph with live
 * per-module status, the verification timeline (green-gate + adversarial
 * diff-review + completeness/parity critic), best-of-N ensembles, and the files
 * touched. This is what makes a long autonomous build legible while it runs.
 */
export function CodePanel({
  code,
  tasks,
  status,
  now,
}: {
  code: CodeState;
  tasks: Task[];
  status: RunStatus;
  now: number;
}) {
  const lastGate = code.gates[code.gates.length - 1];
  const lastReview = code.reviews[code.reviews.length - 1];
  const lastParity = code.completeness[code.completeness.length - 1];
  const verified = Boolean(lastGate?.green) && (lastReview ? lastReview.clean : true) && (lastParity ? lastParity.complete : true);

  return (
    <section className="panel p-5 mb-5" style={{ animation: "var(--animate-rise)" }}>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-sm font-semibold tracking-wide" style={{ color: "var(--color-ink)" }}>
          Build pipeline
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {code.specSeeded && <span className="chip" title="A failing spec test-suite was authored from the acceptance criteria before implementation (TDD).">TDD spec</span>}
          {code.map && <span className="chip" title="A deterministic symbol-map of the repo was injected into every worker.">{`repo map · ${code.map.fileCount} files`}</span>}
          {lastGate && (
            <span className={`chip ${lastGate.green ? "chip-solid" : ""}`} title={lastGate.summary}>
              {lastGate.green ? "✓ gate green" : lastGate.skipped ? "gate unverified" : "✗ gate red"}
            </span>
          )}
          {lastReview && (
            <span className={`chip ${lastReview.clean ? "" : "chip-solid"}`} title={lastReview.clean ? "Adversarial diff-review found no material issues." : lastReview.issues.join("\n")}>
              {lastReview.clean ? "review clean" : `review · ${lastReview.issues.length} issue(s)`}
            </span>
          )}
          {lastParity && (
            <span className={`chip ${lastParity.complete ? "" : "chip-solid"}`} title={lastParity.complete ? "Parity critic: the build delivers the full mission surface." : lastParity.gaps.join("\n")}>
              {lastParity.complete ? "parity ok" : `parity · ${lastParity.gaps.length} gap(s)`}
            </span>
          )}
        </div>
      </div>

      <BuildPhases phases={code.phases} status={status} now={now} />

      <CriteriaChecklist criteria={code.criteria} verified={verified} />

      <BuildPlanGraph code={code} tasks={tasks} />

      <VerificationTimeline code={code} />

      <Ensembles code={code} />

      <FilesTouched tasks={tasks} />
    </section>
  );
}

/** Acceptance criteria as a checklist with an aggregate "verified" state. */
function CriteriaChecklist({ criteria, verified }: { criteria: CodeState["criteria"]; verified: boolean }) {
  if (!criteria.length) return null;
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs uppercase tracking-wide" style={{ color: "var(--color-ink-faint)" }}>
          Acceptance criteria · {criteria.length}
        </div>
        <span className={`chip ${verified ? "chip-solid" : ""}`} title={verified ? "Green-gate, diff-review and parity critic all pass." : "Not all checks have passed yet."}>
          {verified ? "all verified" : "in progress"}
        </span>
      </div>
      <ul className="text-sm space-y-1">
        {criteria.map((c) => {
          const met = c.met || verified;
          return (
            <li key={c.id} className="flex items-start gap-2" style={{ color: "var(--color-ink-dim)" }}>
              <span className="shrink-0 mono text-2xs mt-0.5" style={{ color: met ? "var(--color-ink)" : "var(--color-ink-faint)" }}>
                {met ? "✓" : "○"}
              </span>
              <span>
                <span className="mono text-2xs mr-1" style={{ color: "var(--color-ink-faint)" }}>{c.id}</span>
                {c.text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The pinned build plan as waves of modules, each joined to its live task. */
function BuildPlanGraph({ code, tasks }: { code: CodeState; tasks: Task[] }) {
  const plan = code.buildPlan;
  if (!plan?.waves || !plan.waves.length) return null;
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>
        Build plan · {plan.modules.length} modules · {plan.waves.length} conflict-free wave(s)
      </div>
      <div className="space-y-2.5">
        {plan.waves.map((wave, i) => (
          <div key={i}>
            <div className="mono text-2xs mb-1" style={{ color: "var(--color-ink-faint)" }}>Wave {i + 1}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {wave.map((id) => {
                const m = plan.modules.find((mm) => mm.id === id);
                if (!m) return null;
                const task = taskForModule(m.id, m.files, tasks);
                return (
                  <div key={id} className="tile px-2.5 py-2 flex items-start gap-2" title={m.files.length ? `owns: ${m.files.join(", ")}` : m.purpose}>
                    <StatusDot status={task?.status ?? "pending"} size={7} pulse={task?.status === "running"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium truncate" style={{ color: "var(--color-ink)" }}>{m.id}</span>
                        {m.hard && <span className="chip" title="Quality-critical / tricky — engine runs a best-of-N ensemble.">★ hard</span>}
                        {task?.ensemble ? <span className="chip" title="Best-of-N ensemble">{`best-of-${task.ensemble}`}</span> : null}
                        {task?.modelTier === "strong" && <span className="chip" title="Built on the capable model tier.">strong</span>}
                      </div>
                      <div className="text-2xs mt-0.5 leading-snug line-clamp-2" style={{ color: "var(--color-ink-dim)" }}>{m.purpose}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Green-gate attempts + adversarial review + parity-critic findings, chronologically. */
function VerificationTimeline({ code }: { code: CodeState }) {
  if (!code.gates.length && !code.reviews.length && !code.completeness.length) return null;
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>Verification</div>
      <div className="space-y-1.5">
        {code.gates.map((g, i) => (
          <div key={`g${i}`} className="tile px-2.5 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-2xs" style={{ color: "var(--color-ink-faint)" }}>{g.clean ? "clean build" : `gate ${i + 1}`}</span>
              {g.clean && <span className="chip" title="Authoritative build from cleared caches — what the operator's first build will see.">cold</span>}
              <span className={`chip ${g.green ? "chip-solid" : ""}`}>{g.green ? "green" : g.skipped ? "unverified" : "red"}</span>
              {parseGate(g.summary).map((c, j) => (
                <span key={j} className="mono text-2xs" style={{ color: c.status === "fail" ? "var(--color-ink)" : "var(--color-ink-dim)" }} title={g.summary}>
                  {c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "–"} {c.check}{c.counts ? ` ${c.counts}` : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
        {code.reviews.filter((r) => !r.clean).map((r, i) => (
          <FindingsBlock key={`r${i}`} label={`diff-review round ${r.round}`} items={r.issues} />
        ))}
        {code.completeness.filter((c) => !c.complete).map((c, i) => (
          <FindingsBlock key={`c${i}`} label={`parity critic round ${c.round}`} items={c.gaps} />
        ))}
      </div>
    </div>
  );
}

function FindingsBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="tile px-2.5 py-2">
      <div className="mono text-2xs mb-1" style={{ color: "var(--color-ink-faint)" }}>{label} · {items.length} finding(s)</div>
      <ul className="text-sm space-y-0.5">
        {items.map((it, i) => (
          <li key={i} style={{ color: "var(--color-ink-dim)" }}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

/** Best-of-N ensembles, shown as a scored comparison. */
function Ensembles({ code }: { code: CodeState }) {
  if (!code.ensembles.length) return null;
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>Best-of-N ensembles</div>
      <div className="space-y-1.5">
        {code.ensembles.map((e, i) => (
          <div key={i} className="tile px-2.5 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" style={{ color: "var(--color-ink)" }}>{e.taskId}</span>
              <span className="mono text-2xs" style={{ color: "var(--color-ink-faint)" }}>{e.n} attempts</span>
              {e.scores.map((s) => (
                <span
                  key={s.i}
                  className={`chip ${s.i === e.winner ? "chip-solid" : ""}`}
                  title={`attempt ${s.i}${s.green ? " · gate green" : ""}`}
                >
                  #{s.i}: {s.score}{s.i === e.winner ? (e.merged ? " ✓ merged" : " (merge failed)") : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A deduped tree of files the swarm has touched so far. */
function FilesTouched({ tasks }: { tasks: Task[] }) {
  const [open, setOpen] = useState(false);
  const files = new Set<string>();
  for (const t of tasks) for (const f of t.filesTouched ?? []) files.add(f);
  if (!files.size) return null;
  const sorted = [...files].sort();
  return (
    <div>
      <button className="text-xs uppercase tracking-wide flex items-center gap-1.5" style={{ color: "var(--color-ink-faint)" }} onClick={() => setOpen((v) => !v)}>
        Files changed · {sorted.length}
        <span className="text-[9px]" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
      </button>
      {open && (
        <ul className="mono text-2xs mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
          {sorted.map((f) => (
            <li key={f} className="truncate" style={{ color: "var(--color-ink-dim)" }} title={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- helpers ----

/** Match a build-plan module to its live task: by the engine's `${id}: …` title prefix, then by owned/touched files. */
function taskForModule(moduleId: string, files: string[], tasks: Task[]): Task | undefined {
  const prefix = `${moduleId.toLowerCase()}:`;
  const byTitle = tasks.find((t) => t.title.toLowerCase().startsWith(prefix));
  if (byTitle) return byTitle;
  if (!files.length) return undefined;
  const fileset = new Set(files);
  return tasks.find(
    (t) => (t.ownedFiles ?? []).some((f) => fileset.has(f)) || (t.filesTouched ?? []).some((f) => fileset.has(f))
  );
}

/** Parse a green-gate summary ("PASS build (cmd) 1/142 in —s" per line) into compact check chips. */
function parseGate(summary: string): { status: "pass" | "fail" | "skip"; check: string; counts?: string }[] {
  const out: { status: "pass" | "fail" | "skip"; check: string; counts?: string }[] = [];
  for (const line of summary.split("\n")) {
    const m = line.trim().match(/^(PASS|FAIL|SKIP|UNVERIFIED)\s+(\S+)(.*)$/i);
    if (!m) continue;
    const st = m[1].toUpperCase();
    const cm = m[3].match(/(\d+)\s*\/\s*(\d+)/);
    out.push({
      status: st === "PASS" ? "pass" : st === "FAIL" ? "fail" : "skip",
      check: m[2],
      counts: cm ? `${cm[1]}/${cm[2]}` : undefined,
    });
  }
  return out;
}

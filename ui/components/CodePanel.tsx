"use client";

import type { CodeState } from "@/lib/reducer";

/**
 * Code (build) runs: surfaces the engine-owned orchestration the way the
 * forecast panels surface the ensemble — the pinned build plan, the TDD spec
 * oracle, the green-gate history, the adversarial diff-review, and any best-of-N
 * ensembles. This is what makes a cheap model's output trustworthy, made visible.
 */
export function CodePanel({ code }: { code: CodeState }) {
  const lastGate = code.gates[code.gates.length - 1];
  const lastReview = code.reviews[code.reviews.length - 1];
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
        </div>
      </div>

      {code.criteria.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>Acceptance criteria</div>
          <ul className="text-sm space-y-1">
            {code.criteria.map((c) => (
              <li key={c.id} style={{ color: "var(--color-ink-dim)" }}>
                <span style={{ color: "var(--color-ink-faint)" }}>{c.id}</span> {c.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {code.buildPlan?.waves && code.buildPlan.waves.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>
            Pinned build plan · {code.buildPlan.modules.length} modules · {code.buildPlan.waves.length} conflict-free wave(s)
          </div>
          <div className="space-y-2">
            {code.buildPlan.waves.map((wave, i) => (
              <div key={i} className="text-sm">
                <span style={{ color: "var(--color-ink-faint)" }}>Wave {i + 1}: </span>
                {wave.map((id) => {
                  const m = code.buildPlan!.modules.find((mm) => mm.id === id);
                  return (
                    <span key={id} className="chip mr-1" title={(m?.purpose ?? "") + (m?.files?.length ? `\nowns: ${m.files.join(", ")}` : "")}>
                      {id}{m?.hard ? " ★" : ""}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {code.ensembles.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--color-ink-faint)" }}>Best-of-N ensembles</div>
          <ul className="text-sm space-y-1">
            {code.ensembles.map((e, i) => (
              <li key={i} style={{ color: "var(--color-ink-dim)" }}>
                {e.taskId}: {e.n} isolated attempts → winner #{e.winner} {e.merged ? "merged" : "(merge failed)"}
                <span style={{ color: "var(--color-ink-faint)" }}> · scores {e.scores.map((s) => s.score).join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

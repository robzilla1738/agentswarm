# Code (build) mode

`swarm code "<build task>"` (alias `swarm build`) turns the swarm into a software-engineering pipeline. The design goal: **a cheap model, orchestrated this way, produces expert-level, far-above-its-weight code changes** — because the engine owns the structure the cheap model is worst at and verifies the result with independent, executable oracles.

```
swarm code "<build task>" [--accept "<done when>"] [--depth prototype|standard|exhaustive]
                          [--greenfield] [--no-gate] [--no-commit]
                          [--no-tdd] [--no-design] [--no-repo-map] [--no-review] [--no-ensemble] [--no-repo-facts]
```

`--cwd <dir>` runs against a real directory (on a `swarm/<run-id>` branch); the default runs in an isolated sandbox workspace.

## Build depth

`--depth` (or the composer's "Build depth" picker) sets how ambitious the build is. Left unset it is **auto-detected from the mission** — parity / clone / comprehensive / "beautiful" / production-grade asks scale up to `exhaustive`.

- **`prototype`** — fast, minimal: cheap model, tight scope, a quick working cut.
- **`standard`** — balanced: capable model for architecture + the diff-review critic and green-gate before shipping.
- **`exhaustive`** — max quality: the acceptance criteria are *expanded* into the full feature surface (never dropping a named capability), the build plan widens, **all** craft + review run on the capable model, hard/UI modules get best-of-N by default, and a completeness/parity critic plus multi-round review run before shipping. It spends freely.

## The pipeline

1. **Deterministic recon** (`reconRepo`) — language, package manager, framework, and the repo's *real* `build`/`typecheck`/`test`/`lint` commands, parsed from manifests (watch/dev scripts that never terminate are rejected). Cross-run **repo memory** fills gaps a prior run confirmed.
2. **Acceptance criteria → tracked state** — `--accept` text is split into atomic `AcceptanceItem`s the whole run reasons over; "done" is never claimed for an unverified item.
3. **Engine-owned BuildPlan** — a validated module/file partition with conflict-free waves (`partitionWaves`: no two modules own a file, no dependency cycle). Pinned into the conductor and written to `DESIGN.md`. An invalid plan degrades to the free-form doctrine.
4. **Repo symbol-map** — a deterministic map of existing top-level declarations, injected into every worker so a cheap model edits *with* the codebase instead of reinventing helpers or breaking callers.
5. **TDD spec oracle** — on a brownfield repo the engine seeds a strong-tier spec-test author that writes *failing* tests from the criteria before implementation. The green-gate then refuses to pass while **zero tests ran** — "it compiles" is not done.
6. **Disjoint-file implementation** — parallel workers each own a file set; a hard **write-lock** blocks a second live task from writing a file another owns (caught at write time, not as a late build failure). On a multi-module plan the engine **pre-creates the module tasks itself** (dependency-ordered across the conflict-free waves) so the whole wave fans out at once instead of waiting on the conductor to spawn them one batch at a time.
7. **Best-of-N ensemble** — a `ensemble:N` hard task runs N isolated attempts in separate **git worktrees** with diverse strategies, judged objectively by the gate; the winner is merged, the rest discarded. If no attempt produces a passing change, it falls back to a single worker.
8. **Engine green-gate + repair** — at quiescence the engine runs the real build→typecheck→test. On RED it spawns its *own* targeted fix task (bisected to the files changed since the last green commit, escalated to the strong tier on a repeat), rather than round-tripping the conductor.
9. **Adversarial diff-review** — once green, a blind strong critic judges the actual `git diff` against the criteria and correctness/security/convention rubrics (what "green" hides); real findings reopen the loop.
10. **Completeness / parity critic** — a strong-tier critic then judges the green tree against the **full mission** (not just the reduced criteria) and reopens the build with concrete missing-feature tasks — the net for "it compiles and passes its own tests, but isn't actually what was asked for". On by default for `exhaustive` builds.
11. **Authoritative clean build** — the per-round gate builds *incrementally* for speed, which can both hide a real error behind a warm framework cache and leave a poisoned incremental cache (a stale `.next` / `tsconfig.tsbuildinfo`) on disk so the operator's very first build fails on correct code. Once the loops converge the engine clears the regenerable caches and re-runs build→typecheck→test **from cold**: a masked error is caught (with its own small fix budget), and the tree ships with a clean, reproducible cache. This cold result is the green the report quotes. On by default (`codeCleanGate`); `exhaustive` always runs it.
12. **Synthesis** — the deliverable is the **working tree** plus a PR-style `CHANGES.md` (files changed, how to build/run, verbatim green-gate evidence, each acceptance criterion mapped to evidence or marked UNMET).

The pipeline surfaces live in the UI's **Build Console** (`CodePanel`): the build-arc phase timeline, the acceptance checklist, the pinned plan as a wave graph with per-module live status, a verification timeline (parsed gate pass-counts + diff-review + parity findings, and the final cold build labeled "clean build"), best-of-N comparisons, and a files-changed tree.

> **Model tiers.** The "strong" tier resolves to your configured strong model, falling back to the **conductor** model (not the cheap worker) — so the critics and integration always run on a capable model. An `exhaustive` build runs all craft there too. **Quality is independent of `--no-commit`:** sandbox/greenfield workspaces always snapshot a baseline, and a real repo with auto-commit off gets a read-only HEAD baseline, so the diff-review and best-of-N ensembles run either way.

## Honest-failure invariants (load-bearing — these are what make a cheap model trustworthy)

- **Commit-on-green** is serialized behind a git mutex and only fires when no other task is mid-write, so a commit captures exactly a verified tree; an interrupt resumes from a *compiling* commit.
- On a real `--cwd`: works on a `swarm/<run-id>` branch, refuses if the tree is dirty, uses its own git identity, never pushes/force-pushes/resets; the resume hard-reset-to-green is **sandbox-only**.
- No build/test command detected ⇒ the gate reports the tree **UNVERIFIED**, never a fake green, and makes no commit.
- Under TDD with criteria, a build that ran **0 tests is RED**, not green (keyed off an explicit no-tests signal, so a count-less passing runner like `go test` is not falsely red).
- The diff-review only runs on a green tree; an evidence-free verdict is rejected.
- A best-of-N winner must have produced changes **and** passed the gate; a no-op or all-red attempt never merges-and-is-called-done.
- Resume restores tracked criteria, the build plan, and the diff-review baseline from the journal — nothing is re-split or re-planned, and the review still runs after a restart.

## Flags

| Flag | Effect |
|---|---|
| `--accept "<done when>"` | Pin acceptance criteria (enables the TDD spec oracle). |
| `--greenfield` | Force a from-scratch build (treat the dir as empty). |
| `--no-gate` / `--no-commit` | Skip the engine green-gate / the auto-commits. |
| `--no-tdd` | Skip the spec-test author + the 0-test gate guard. |
| `--no-design` | Skip the engine-owned BuildPlan / DESIGN.md. |
| `--no-repo-map` | Skip the injected repo symbol-map. |
| `--no-review` | Skip the adversarial diff-review critic. |
| `--no-ensemble` | Disallow best-of-N ensembles. |
| `--no-repo-facts` | Skip cross-run repo memory. |

All default ON (config: `codeTdd`, `codeDesign`, `codeRepoMap`, `codeReview`, `codeEnsemble`, `codeRepoFacts`, plus `codeGreenGate`, `codeCleanGate`, `codeAutoCommit`, `codeGateMaxRounds`, `codeReviewMaxRounds`, `codeEnsembleN`, `codeRepoMapMaxTokens`).

See [`docs/code-mode-plan.md`](code-mode-plan.md) for the original design notes.

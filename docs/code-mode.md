# Code (build) mode

`swarm code "<build task>"` (alias `swarm build`) turns the swarm into a software-engineering pipeline. The design goal: **a cheap model, orchestrated this way, produces expert-level, far-above-its-weight code changes** — because the engine owns the structure the cheap model is worst at and verifies the result with independent, executable oracles.

```
swarm code "<build task>" [--accept "<done when>"] [--greenfield] [--no-gate] [--no-commit]
                          [--no-tdd] [--no-design] [--no-repo-map] [--no-review] [--no-ensemble] [--no-repo-facts]
```

`--cwd <dir>` runs against a real directory (on a `swarm/<run-id>` branch); the default runs in an isolated sandbox workspace.

## The pipeline

1. **Deterministic recon** (`reconRepo`) — language, package manager, framework, and the repo's *real* `build`/`typecheck`/`test`/`lint` commands, parsed from manifests (watch/dev scripts that never terminate are rejected). Cross-run **repo memory** fills gaps a prior run confirmed.
2. **Acceptance criteria → tracked state** — `--accept` text is split into atomic `AcceptanceItem`s the whole run reasons over; "done" is never claimed for an unverified item.
3. **Engine-owned BuildPlan** — a validated module/file partition with conflict-free waves (`partitionWaves`: no two modules own a file, no dependency cycle). Pinned into the conductor and written to `DESIGN.md`. An invalid plan degrades to the free-form doctrine.
4. **Repo symbol-map** — a deterministic map of existing top-level declarations, injected into every worker so a cheap model edits *with* the codebase instead of reinventing helpers or breaking callers.
5. **TDD spec oracle** — on a brownfield repo the engine seeds a strong-tier spec-test author that writes *failing* tests from the criteria before implementation. The green-gate then refuses to pass while **zero tests ran** — "it compiles" is not done.
6. **Disjoint-file implementation** — parallel workers each own a file set; a hard **write-lock** blocks a second live task from writing a file another owns (caught at write time, not as a late build failure).
7. **Best-of-N ensemble** — a `ensemble:N` hard task runs N isolated attempts in separate **git worktrees** with diverse strategies, judged objectively by the gate; the winner is merged, the rest discarded. If no attempt produces a passing change, it falls back to a single worker.
8. **Engine green-gate + repair** — at quiescence the engine runs the real build→typecheck→test. On RED it spawns its *own* targeted fix task (bisected to the files changed since the last green commit, escalated to the strong tier on a repeat), rather than round-tripping the conductor.
9. **Adversarial diff-review** — once green, a blind strong critic judges the actual `git diff` against the criteria and correctness/security/convention rubrics (what "green" hides); real findings reopen the loop.
10. **Synthesis** — the deliverable is the **working tree** plus a PR-style `CHANGES.md` (files changed, how to build/run, verbatim green-gate evidence, each acceptance criterion mapped to evidence or marked UNMET).

The pipeline surfaces live in the UI's **Build pipeline** panel (`CodePanel`): criteria, the pinned plan/waves, TDD/repo-map chips, gate + review status, and any best-of-N outcomes.

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

All default ON (config: `codeTdd`, `codeDesign`, `codeRepoMap`, `codeReview`, `codeEnsemble`, `codeRepoFacts`, plus `codeGreenGate`, `codeAutoCommit`, `codeGateMaxRounds`, `codeReviewMaxRounds`, `codeEnsembleN`, `codeRepoMapMaxTokens`).

See [`docs/code-mode-plan.md`](code-mode-plan.md) for the original design notes.

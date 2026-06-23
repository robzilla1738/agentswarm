# Code Mode — Implementation Plan

## The idea in one paragraph

`code` mode is a third `RunMode` peer to `research` and `forecast`, built with the **exact same layering pattern forecast uses**: a mode predicate (`codeMode()` beside `forecastMode()` at `executor.ts:578`), a mode-gated conductor system addendum appended after `conductorSystem` (the `forecastDoctrine` seam at `executor.ts:456-465`), a mode-gated synth addendum (`forecastSynthAddendum` seam at `executor.ts:3546`), and a lightweight pre-planning step (the `planForecast` seam at `executor.ts:453`). The generic swarm already has every mechanism a code project needs — autonomous workers with shell/file/edit tools, an adversarial `verify:true` verifier that *runs builds and tests* (rubric clause 4, `prompts.ts:300`), `team:true` sub-swarms, `checkpoint`+warm-restart, journal-replay resume, `set_phase`/`update_plan` living plan, advisory file `claim`s, and host/docker/cloud sandboxes. What it lacks is **doctrine** (it runs coding on the research doctrine, which says "PARALLELIZE AGGRESSIVELY… 10+ scouts" — `prompts.ts:28,32`), **structured knowledge of how to build the repo** (nothing detects build/test/lint commands today; `topListing` at `executor.ts:3299` only lists filenames and is host-only), **compact test output** (raw shell test logs are truncated by the collect cap, burning worker steps), and a **known-green resume point** (journal replay restores engine state, not a half-edited working tree). Code mode adds exactly those four things and reuses everything else. The result: a long-running build that recons the repo once, fans out only on disjoint files, runs the *real* detected test command after every change as a compact PASS/FAIL, commits on green so an interrupted run resumes compiling, gates the integrated tree once before synthesis, and ships a working tree + change summary + green-gate evidence instead of a prose report.

## What we REUSE unchanged vs what is genuinely NEW

**REUSED AS-IS (no new mechanism):**

| Mechanism | Where | Why it already serves code mode |
|---|---|---|
| The mode seam | `RunMode` on `meta.options.mode`, `forecastMode()` → `codeMode()` (`executor.ts:578`) | One predicate keys every code branch; grep-auditable like `forecastMode()` |
| Pre-step injection | `executor.ts:453` guard → `planCode()` sibling of `planForecast()` | Same hook the forecast sharpener uses |
| Conductor-addendum append | `executor.ts:456-465` (`forecastDoctrine`) | Appended *after* `conductorSystem`, so it wins by recency and overrides research doctrine #1/#5 |
| Synth-addendum append | `executor.ts:3546` (`forecastSynthAddendum`) | Redirects the deliverable away from `report_markdown` prose |
| `verify:true` adversarial verifier | `runVerifier`/`verifierAgent` (`executor.ts:3106-3220`), rubric `prompts.ts:296-302` | **Already runs builds/tests** (clause 4) and rejects stubs (clause 3). This is the per-task green-gate. We add ONE rubric line. |
| Pre-synthesis gap pass | `completenessPass()` (`executor.ts:2100`), called at `executor.ts:501` | The exact structural template for the single pre-synthesis green-gate |
| `note(kind:"claim")` + `checkClaim` | `executor.ts:2701` (advisory warn) | Disjoint-file discipline; kept advisory (see Risks — we do NOT flip to refuse) |
| `checkpoint` + warm restart | `recordCheckpoint` (`executor.ts:2733`), `lastCheckpoint` (`prompts.ts:229`) | Workers resume warm |
| Journal-replay resume | `seedFromState` (`executor.ts:274`), state reducer (`state.ts`) | Restores engine state; we add `code.plan` reducer + git tree-restore |
| `set_phase`/`update_plan` pinned plan | `planPin` (`executor.ts:2423`), doctrine #13/#14 | **The single pinned living doc** — we seed acceptance criteria into it, NOT a second pin |
| `team:true` sub-swarms | `executor.ts:1977` | Big subsystems fan out as their own swarm |
| Sandbox abstraction | `SandboxRuntime.exec/readFile/writeFile/localFs` (`sandbox.ts:39-53`) | Recon, run_check, git all run runtime-agnostically through `exec` |
| Toolset subsetting | `verifierToolset()` (`tools.ts:939`) | `codeWorkerToolset`/`codeVerifierToolset` follow it verbatim |
| `inferRole` | `executor.ts:3757` | Already maps build/implement/fix/refactor→`coder`, test/review→`reviewer`. No new roles. |

**GENUINELY NEW (cannot be done with what exists):**

1. **`codeConductorAddendum`** — the only thing that overrides research doctrine's aggressive fan-out (`prompts.ts:28,32`). Doctrine #4 (`prompts.ts:31`) gestures at "scaffold first… disjoint files" but is one buried line among 15; the addendum makes it authoritative.
2. **One deterministic command-detector** (`src/codeintel.ts`) — there is no build/test/lint detector anywhere. A code run today has zero structured knowledge of how to build the repo. Highest-leverage primitive.
3. **`run_check` + `parseCheckOutput`** — compact `PASS 142/142` or `FAIL 3/142` + first-N failures instead of a 2000-line truncated jest log.
4. **One git primitive** (`gitCommitGreen`) — commit-on-green so an interrupted run resumes from a compiling commit. Sandbox-default-on, **host-commit-only-never-reset**.
5. **`codeSynthAddendum`** — deliverable = working tree + change summary + green-gate evidence.

**EXPLICITLY CUT (per the critique — do not build these):**
- ❌ The per-wave **standing green-gate**. `currentWave()` (`executor.ts:2410`) is `max(task.wave)+1`, a spawn-batch counter — tasks of overlapping waves run concurrently, there is **no wave barrier** to fire at. The only true quiescence is `inflight.size===0` at run-end, where `completenessPass` already hooks. Replaced by ONE pre-synthesis green-gate.
- ❌ A second pinned `build-spec.md`/`specPin`. Acceptance criteria fold into the existing `mission-plan.md`/`planPin`.
- ❌ `codeReportTool` superset with self-reported `build_status`/`test_results`. Unverified worker claims; ground truth comes from the verifier/green-gate *running* commands. Keep `report()` as-is.
- ❌ Refuse-on-claim-conflict. Ships a deadlock with no serialization lane. Keep `checkClaim` advisory.
- ❌ Five new ROLE_HINTS. Sharpen the existing `coder` hint; `inferRole` doesn't even distinguish more.
- ❌ Greenfield generative-recon fork. Skip recon on empty dirs; the addendum's "establish a test command first" drives it.
- ❌ `apply_patch` in v1 (deferred to P3 — `replace_in_file` with `edits[]` already covers most edits).
- ❌ `git_ops` as a worker tool. Commits are **engine-owned** on green, not worker-discretionary (resolves the four-design conflict over who commits).

## Architecture: the code-mode pipeline

```
recon ──► scaffold ──► implement ──► integrate ──► [green-gate] ──► harden ──► ship
(engine)  (wave 1)     (parallel,    (verify:true   (engine, once   (conductor (synth
 once     one task     disjoint      runs build+    pre-synthesis)   reacts to  addendum)
          conductor    files)        tests; commit                   RED)
          spawns)                    on green)
```

Mapped onto the existing conductor/worker/synth loop:

- **recon** → `planCode()` runs **once** before the conductor's first turn (the `executor.ts:453` pre-step seam). Pure deterministic `reconRepo()` via `sandbox.exec`. **Skipped entirely on empty/greenfield dirs** (pure latency otherwise). Result `RepoProfile` feeds three consumers: the conductor addendum, the worker BUILD CONTEXT block, and the green-gate.
- **scaffold/implement/integrate** → ordinary `spawn_tasks` waves, but the `codeConductorAddendum` (appended at `executor.ts:465`) replaces "PARALLELIZE AGGRESSIVELY / go WIDE" with "recon-first → disjoint-file fan-out → integration task with `verify:true` per wave that runs `run_check` and commits on green."
- **per-task green-gate** → the existing `verify:true` verifier (`runVerifier`, `executor.ts:3152`). Already runs the build/tests via rubric clause 4. On pass, the engine commits (`gitCommitGreen`, hooked at the verify-pass site near `executor.ts:3034`).
- **integrated green-gate** → `greenGate()` — a `codeMode()` sibling of `completenessPass()`, called **once** at `executor.ts:501`. Runs the detected build→typecheck→test once; on RED reopens the loop via `appendConductorUpdate` + `conductorTurn` (identical machinery to `completenessPass`).
- **ship** → `codeSynthAddendum` (appended at `executor.ts:3546`) makes the deliverable the working tree + a `CHANGES.md` summary + final green-gate evidence.

## Phased implementation

### P1 — Minimal viable code mode (ships a usable mode on its own)

P1 alone gives a working `swarm code "…"`: correct doctrine, real detected commands injected everywhere, compact test results, and the right deliverable shape. No git, no green-gate engine pass yet — those are P2.

**`src/types.ts`**
- [ ] `:22` — `export type RunMode = "research" | "forecast" | "code";`
- [ ] `:469` (in `RunOptions`, beside `mode?`) — add `acceptanceCriteria?: string;` (free-text "Done when" for the whole mission) and `codeGreenfield?: boolean;` (force-skip recon).
- [ ] Add `export interface CodeCommands { build?: string; typecheck?: string; test?: string; lint?: string; install?: string; }` and `export interface RepoProfile { greenfield: boolean; primaryLanguage: string | null; packageManager: string | null; commands: CodeCommands; framework: string | null; monorepo: { tool: string | null; packages: string[] }; git: { isRepo: boolean; branch: string | null; dirty: boolean }; conventions: string[]; manifestFiles: string[]; }`
- [ ] `:691` (journal-event doc) — document `code.plan { profile: RepoProfile }` beside `forecast.plan`.

**`src/codeintel.ts` (NEW — the single merged detector; "codeintel" = recon + command-detection in one module)**
- [ ] `export async function reconRepo(exec: SandboxRuntime["exec"], workdir: string, signal: AbortSignal): Promise<RepoProfile>` — runs probes through the passed `exec` so it works on host/docker/cloud identically. **Batch all probes into ONE compound `exec`** (`git rev-parse; git status --porcelain -b; cat package.json pyproject.toml Cargo.toml go.mod Makefile 2>/dev/null; ls -A`) with a short `timeoutSec` — one round-trip, not a serial sequence, so a cold cloud sandbox adds ~1 call, not ~8. Any failure degrades a field to null; **never throws, never fails the run.**
- [ ] `export function detectCommands(manifests: {...}): CodeCommands` — pure: parse `package.json` `scripts.{build,test,typecheck,lint}` (else `tsc`/`pyproject`/`tox`/`Makefile` targets/`cargo`/`go` heuristics). **Reject** any script matching `--watch|serve|dev|start` (non-terminating). Detect package manager from lockfiles. This is the ONE detector — both `run_check` and `greenGate()` import it (no drift).
- [ ] `export function parseCheckOutput(check: keyof CodeCommands, raw: string, exitCode: number): { pass: boolean; failed: number; total: number; firstFailures: string[] }` — pure regexes per runner (`tsc` `error TS`, jest/vitest `Tests: N failed`, pytest `N failed`, eslint counts). Distills to counts + first ~5 failures. **0 collected tests = YELLOW**, surfaced as "no tests ran," never silent green.

**`src/tools.ts`**
- [ ] `:56` (`ToolCtx`) — add `codeCommands?: CodeCommands;` (lazy run-scoped cache).
- [ ] After `replace_in_file` (`~:325`) add `run_check` `{ check: "build"|"typecheck"|"test"|"lint" }` — calls `detectCommands` (cached on `ctx.codeCommands`), runs the detected cmd via `ctx.sandbox.exec` with a hard timeout, returns `parseCheckOutput` as `"PASS 142/142"` or `"FAIL 3/142\n  <first failures>"`. House style matching `shell`/`grep_files` schemas.
- [ ] `:939` style — add `export function codeWorkerToolset(cfg?): Record<string, ToolDef>` = `{shell, read_file, write_file, replace_in_file, grep_files, list_dir, save_artifact, checkpoint, note, search_notes, read_report, run_check, web_search, fetch_url}` (research kept but trimmed — drop academic/market/sports/time_series/data_feed/wiki feeds). Add `export function codeVerifierToolset()` = `verifierToolset()` + `run_check` (drop `web_search` — code is verified by running it).

**`src/prompts.ts`**
- [ ] `:362` style — add `export function codeConductorAddendum(profile: RepoProfile, acceptance?: string): string` (full prose below).
- [ ] `:443` style — add `export function codeSynthAddendum(profile: RepoProfile, gateEvidence?: string): string` (prose below).
- [ ] `:162` — sharpen the existing `coder` hint to name the real flow: *"…build/run/test after every change using the detected commands (run `run_check`, not raw shell, so failures come back as counts not log spew); leave the tree compiling; never two writers on one file."* Add ONE nuance: *"An integration task runs the full green-gate (build+typecheck+test) and only reports done when all are green."*
- [ ] `:199` (`workerSystem` opts) — add optional `repoProfile?: RepoProfile;`. After the `dirListing` line (`:244`) render a **BUILD CONTEXT** block when present: the detected build/test/typecheck/lint commands, the package manager, the conventions, and the acceptance criteria. This is the structural twin of how `isForecaster` injects `questionBlock` via `extraCraft` at `executor.ts:2826`.

**`src/executor.ts`**
- [ ] `:206` area — add `private repoProfile?: RepoProfile;`
- [ ] `:578` — add `private codeMode(): boolean { return this.mode === "root" && (this.meta.options.mode ?? "research") === "code"; }`
- [ ] `:737` style — add `private async planCode(): Promise<void>`: (1) if `this.meta.options.codeGreenfield` **or** the workdir is empty-but-for-dotfiles/README/LICENSE → set a greenfield `RepoProfile` and **skip recon entirely**; else `this.repoProfile = await reconRepo(this.sandbox.exec.bind(this.sandbox), this.meta.cwd, this.ac.signal)`. (2) `this.journal.append("code.plan", { profile: this.repoProfile })`. **No LLM call, no sharpener, no build-spec.md** — acceptance criteria ride `meta.options.acceptanceCriteria` and the conductor's own `update_plan`.
- [ ] `:453` — extend the guard: `else if (this.codeMode() && !this.repoProfile) await this.planCode();`
- [ ] `:456-465` — add `const codeDoctrine = this.codeMode() && this.repoProfile ? "\n\n" + codeConductorAddendum(this.repoProfile, this.meta.options.acceptanceCriteria) : "";` and append it to the `conductorSystem(...)` content at `:465` alongside `forecastDoctrine`.
- [ ] `:2816` (worker spawn) — when `codeMode()`, pass `repoProfile: this.repoProfile` into `workerSystem(...)` and select `codeWorkerToolset(this.cfg)` instead of `workerToolset(this.cfg)` at the `tools:` field (`:2870`).
- [ ] `:3129` (`verifierAgent`) — when `codeMode()`, use `codeVerifierToolset()`.
- [ ] `:3546` — append `+ (this.codeMode() ? codeSynthAddendum(this.repoProfile!) : "")` to the synth system.
- [ ] `:274` (`seedFromState`) — add `this.repoProfile = state.repoProfile;` so resume never re-recons.

**`src/state.ts`**
- [ ] `:85` area — add `repoProfile?: RepoProfile;`
- [ ] `:295` style — add `case "code.plan": this.repoProfile = ev.profile as RepoProfile; break;`

**`src/cli.ts`**
- [ ] `:111` style — add `case "code": case "build": await cmdRun(_.slice(1).join(" "), { ...flags, mode: "code" }); break;`
- [ ] `:222` — extend allow-list to `["research", "forecast", "code"]` and its error string.
- [ ] `:186` (`optionOverrides`) — map a `--accept "<criteria>"` flag to `o.acceptanceCriteria` and `--greenfield` (add to `BOOL_FLAGS`) to `o.codeGreenfield`.
- [ ] `:1320` usage — add `swarm code "<build task>"`.

**`src/run.ts`** — no change (mode flows via `overrides` through `optionsFromConfig`).

**`ui/lib/types.ts`** — `:24` extend `RunMode` to include `"code"`.

**`ui/components/MissionComposer.tsx`** — `:66` widen `mode` union to `"code"`; add a third toggle segment; show an acceptance-criteria textarea when `mode === "code"` (mirroring the per-mode forecast knobs); gate the forecast-only knobs behind `mode === "forecast"`.

**After P1:** `swarm code "build X"` recons the repo, drives a recon-first/disjoint-file orchestration with the real build/test commands injected into every agent, workers get compact `run_check` results, and the deliverable is the tree + change summary. The `verify:true` integration task already runs builds/tests. This is a usable code mode.

### P2 — Known-green resume (the long-horizon payoff)

Adds the engine-owned commit-on-green primitive and the single pre-synthesis green-gate.

**`src/codeintel.ts`**
- [ ] Add `export async function gitPrepare(exec, workdir, opts: { isSandbox: boolean; safeMode: boolean }): Promise<{ ok: boolean; branch: string | null; reason?: string }>` — three-tier brownfield safety (see Key Code). Sandbox: `git init` freely if not a repo. Non-repo host cwd: `git init` under a fixed swarm identity. Real host repo: create/checkout a `swarm/<runid>` branch; **refuse (return `ok:false`) if the tree is dirty**. Never touches operator config, never pushes.
- [ ] Add `export async function gitCommitGreen(exec, workdir, message: string): Promise<string | null>` — `git add -A && git commit` with a fixed swarm identity (`-c user.name=… -c user.email=…`, never inheriting operator config); returns the SHA or null if nothing changed. **Never resets.**

**`src/executor.ts`**
- [ ] In `planCode()` — after recon, call `gitPrepare(...)`. If it returns `ok:false` (dirty real repo), journal a clear warning and **disable commit-on-green for this run** (the run still proceeds; it just won't auto-commit). Store `this.codeBranch`/`this.codeCommit = true|false`.
- [ ] At the verify-pass site (`~:3034`, where `runVerifier` returns true) — when `codeMode() && this.codeCommit`, `const sha = await gitCommitGreen(...)` and `this.journal.append("code.checkpoint", { sha, taskId })`. **Engine-owned, gated strictly on a passing verifier — never on mere task-done.**
- [ ] Add `private async greenGate(): Promise<boolean>` modeled 1:1 on `completenessPass()` (`:2100`): guard on `codeMode() && this.cfg.codeGreenGate && !budgetExceeded() && !aborted`; run `detectCommands` once (cache on `this.codeCommands`); exec build→typecheck→test fail-fast via `sandbox.exec`; parse to a `CodeGateResult`. If green → journal `code.gate` green, return `false`. If RED → `this.finishing = false; appendConductorUpdate("GREEN-GATE RED before synthesis:\n<structured failures>\nSpawn a focused fix task on the failing files."); await this.conductorTurn();` return `lastConductorAction === "spawn"`. Bound by a `codeGateMaxRounds` guard (default 2) so a perpetually-red tree winds down.
- [ ] `:501` — extend: `if (await this.completenessPass()) await this.mainLoop(); if (await this.greenGate()) await this.mainLoop();` (the green-gate runs **once** at the same run-quiescence point completenessPass uses — the only real barrier).
- [ ] `:274` (`seedFromState`) — restore `this.codeBranch`, and **only inside a sandbox**, hard-reset the tree to the last `code.checkpoint` SHA. **On the host, NEVER reset** — restore engine state only and let the conductor see the partially-edited tree (the green-gate will catch it). This is the single most dangerous line in the four designs; it is sandbox-only.

**`src/types.ts`**
- [ ] `:691` doc — add `code.checkpoint { sha, taskId }` and `code.gate { green, summary }`.
- [ ] Add `CodeGateResult { green: boolean; summary: string; ran: { check: string; pass: boolean; failed: number; total: number }[] }`.

**`src/state.ts`** — add `lastGreenSha?: string;`; `case "code.checkpoint": this.lastGreenSha = ev.sha; break;` so resume knows the green commit.

**`src/config.ts`**
- [ ] `:88` / `:196` / `:415` — add `codeGreenGate: boolean` (default `true`), `codeGateMaxRounds: number` (default `2`), `codeAutoCommit: boolean` (default `true`) to `SwarmConfig` + `DEFAULT_CONFIG` + `SETTABLE_KEYS`.
- [ ] `:445` `NUM_RANGES` — `codeGateMaxRounds: [1, 4]`.
- [ ] `:485` bool-coerce branch — add `codeGreenGate`, `codeAutoCommit`.

**`ui/components/MissionComposer.tsx`** — add `codeGate` on/off and `autoCommit` on/off toggles under the code mode panel.

**After P2:** an interrupted long sandbox run resumes from a compiling commit; host runs commit-on-green to a `swarm/<runid>` branch (refusing if dirty) but never reset; one green-gate before synthesis guarantees the shipped tree builds.

### P3 — Full power (deferred, only if P1/P2 prove it)

- [ ] **`apply_patch`** `{ patch: string }` in `tools.ts` — multi-hunk unified-diff apply, all-or-nothing exact per-hunk context match, reports the failing hunk index. Only when `replace_in_file`'s `edits[]` proves insufficient on overlapping-context edits in practice.
- [ ] **Dependency-install bootstrap** — `planCode()` detects a missing-deps signal (no `node_modules` but a lockfile present) and the `codeConductorAddendum` mandates **wave 1 = one bootstrap+recon task** that runs the detected `install` command before any green-gate. (This closes the critique's real gap: a green-gate running `npm test` with no `node_modules` goes RED for environmental reasons on wave 1.)
- [ ] **`CHANGES.md` finalization** — after `writeFinal`, the engine appends a generated diff summary (files, +/- counts, final SHA) as a durable artifact.
- [ ] **Monorepo-scoped green-gate** — `run_check`/`greenGate` accept a package target from `RepoProfile.monorepo.packages`.

## Key new code

**The code-mode conductor doctrine addendum** (`prompts.ts`, overrides research doctrine #1/#5 by recency):

```
THIS IS A CODE (BUILD) MISSION. The deliverable is a WORKING TREE that builds and
passes its tests — not a report. The generic "parallelize aggressively / go wide
with 10+ scouts" doctrine DOES NOT APPLY here; follow this instead.

REPO (detected automatically — these are the real commands; use them, don't guess):
- Language/stack: ${profile.primaryLanguage} ${profile.framework ? `(${profile.framework})` : ""}
- Build:     ${profile.commands.build ?? "(none detected — establish one)"}
- Typecheck: ${profile.commands.typecheck ?? "(none)"}
- Test:      ${profile.commands.test ?? "(none detected — your FIRST task must establish a test command)"}
- Lint:      ${profile.commands.lint ?? "(none)"}
- Conventions: ${profile.conventions.join("; ")}
${acceptance ? `ACCEPTANCE CRITERIA (done when): ${acceptance}` : ""}

BUILD PIPELINE (structure the run exactly like this):
1. WAVE 1 = ONE task only — recon + scaffold (read the code, confirm it builds with the
   command above; if greenfield, choose the stack and ESTABLISH the test command as the
   first acceptance criterion; if deps aren't installed, install them). Do NOT fan out yet.
2. IMPLEMENT WAVES — parallel tasks on STRICTLY DISJOINT files/modules. NEVER two writers
   on one file. Each task: read before editing, match conventions, run run_check after every
   change, leave its files compiling.
3. Every wave ENDS with an INTEGRATION task (verify:true) that deps on all implementers,
   runs the full build+typecheck+test, and reports done ONLY when green. The verifier runs
   the commands itself and fails it back on red. On green the engine commits the tree, so an
   interrupted run resumes compiling.
4. The engine runs ONE green-gate before final synthesis — if the integrated tree is red it
   returns to you with the exact failures; spawn a focused fix task on the failing files.
5. finish only when the tree is green and the acceptance criteria are met. Maintain the plan
   with update_plan (mission-plan.md) — seed the acceptance criteria into it as a checklist
   and tick items as green-gates pass.
```

**The repo-recon `RepoProfile`** — produced once by `reconRepo()` via a single batched `sandbox.exec`, journaled as `code.plan`, rehydrated in `seedFromState`. Greenfield/empty dirs skip recon and get `{ greenfield: true, commands: {} }`. Signature:

```ts
async function reconRepo(
  exec: SandboxRuntime["exec"],
  workdir: string,
  signal: AbortSignal,
): Promise<RepoProfile>   // never throws; degrades fields to null on any probe failure
```

**The new tool + green-gate hook.** `run_check` (worker-facing, compact results) and `greenGate()` (engine-facing, pre-synthesis) **share `detectCommands()`** so they run identical commands. The green-gate hooks at `executor.ts:501` next to `completenessPass`, the **only true run-quiescence barrier** — explicitly NOT per-wave (`currentWave()` is a counter, not a barrier):

```ts
private async greenGate(): Promise<boolean> {   // returns true if it reopened the loop
  if (!this.codeMode() || !this.cfg.codeGreenGate || this.budgetExceeded() || this.ac.signal.aborted) return false;
  this.codeCommands ??= detectCommands(await this.readManifests());
  const result = await this.runDetectedChecks(); // build → typecheck → test, fail-fast
  this.journal.append("code.gate", { green: result.green, summary: result.summary });
  if (result.green) return false;
  if (++this.gateRounds > this.cfg.codeGateMaxRounds) { this.finishing = true; return false; }
  this.finishing = false;
  this.appendConductorUpdate(`GREEN-GATE RED before synthesis:\n${result.summary}\nSpawn a focused fix task on the failing files. This is the final round.`);
  await this.conductorTurn();
  return this.lastConductorAction === "spawn";
}
```

**The code synth addendum** (`prompts.ts`, appended at `executor.ts:3546`):

```
CODE DELIVERABLE
This was a build mission. The deliverable is the WORKING TREE, not a prose report.
Structure report_markdown as a concise PR-style change summary:
1. # <what was built> — one sentence on the outcome and whether it builds/tests green.
2. ## Changes — a table of files touched (path | what changed | +/-). Group by module.
3. ## How to build & run — the exact detected commands: ${profile.commands.build}, ${profile.commands.test}.
4. ## Test evidence — the final green-gate result verbatim (build/typecheck/test pass counts).
5. ## What's left / known gaps — anything not done, with why. Be honest; do not claim green if red.
Do NOT write a long essay. Save a CHANGES.md artifact with this summary. The code is the product.
```

**Git-commit checkpointing with the brownfield guardrail** — engine-owned, gated strictly on a passing verifier (`executor.ts:~3034`), with three-tier safety in `gitPrepare`:

```ts
// sandbox            → git init freely; commit-on-green ON; resume hard-resets to last green SHA.
// non-repo host cwd  → git init under swarm identity; commit-on-green ON; resume NEVER resets.
// real host repo     → checkout swarm/<runid>; REFUSE commit-on-green if dirty (run proceeds,
//                      just no auto-commit); resume NEVER resets. Never push, never force, never
//                      touch operator branches or operator git config.
```

## Risks & guardrails

- **Operator's real `--cwd` git safety (the highest-stakes risk).** `meta.cwd` defaults to `process.cwd()` (`cli.ts:273`); a no-sandbox run operates in the operator's actual checkout (`conductorSystem:16`). Guardrails, all enforced: (1) commit-on-green is **engine-owned and gated on a passing verifier**, never on task-done; (2) on a real host repo we **branch first** (`swarm/<runid>`) and **refuse to auto-commit if the tree is dirty**; (3) we use a **fixed swarm git identity** via `-c`, never inheriting/mutating operator config; (4) **never push, never force, never reset on the host** — the dangerous `git reset --hard` in `seedFromState` is **sandbox-only**; on the host, resume restores engine state and lets the green-gate catch a half-edited tree.
- **Resume/journal determinism.** `code.plan`/`code.checkpoint` reduce exactly like `forecast.plan` (`state.ts:295`), so recon never re-runs and the last green SHA survives a crash. `gitCommitGreen` is idempotent (returns null if nothing changed), so a crash between commit and journal append cannot double-commit meaningfully.
- **Not breaking forecast/research.** Every code branch is keyed by the single `codeMode()` predicate (grep-auditable, exactly as `forecastMode()` is today). `planCode` only runs when `codeMode() && !this.repoProfile`. The addenda are empty strings outside code mode. New config keys default to safe values. `codeWorkerToolset` is a sibling of `workerToolset`, not a mutation of it. Forecast and research code paths are untouched.
- **False-green / unrunnable detected command.** `detectCommands` rejects `watch|serve|dev|start` scripts; the green-gate hard-timeouts (timeout → RED with "set the command explicitly"); `0 collected tests = YELLOW` ("no tests ran"), never silent green. The `verify:true` integration task *runs* the command, so an environmental failure (missing deps) surfaces as verifier feedback rather than a synth claiming green — and P3's bootstrap wave closes that gap structurally.
- **Recon latency on cold cloud sandboxes.** Mandatory mitigation (not optional): all probes batched into **one compound `exec`** with a short `timeoutSec`; greenfield/empty dirs **skip recon entirely**.
- **Mid-file write collision.** Kept advisory (`checkClaim` warns, `prompts.ts:252`) — we deliberately do NOT flip to refuse (no serialization lane exists; refuse trades collision for deadlock). The `codeConductorAddendum`'s strict disjoint-file doctrine is the real mechanism, reinforced by the per-wave integration task that catches any collision as a build failure.

## Acceptance criteria for "code mode works"

Demo on a real long-running build (e.g. *"add a REST API with auth, tests, and OpenAPI docs to this Express repo"* run with `--cwd` on a brownfield repo, and a greenfield *"build a CLI todo app in Rust"* with `--greenfield`):

1. **Doctrine fires:** the conductor's wave 1 is a **single** recon/scaffold task (not 6 parallel scouts); subsequent waves touch disjoint files; every wave ends with a `verify:true` integration task. Confirm via the journal task table, not a screenshot.
2. **Real commands everywhere:** the detected `build`/`test` commands appear verbatim in the conductor addendum, every worker's BUILD CONTEXT block, and the green-gate — and they are the repo's *actual* commands (e.g. `npm test`, `cargo test`), confirmed against `package.json`/`Cargo.toml`.
3. **Compact test signal:** a worker that breaks a test gets `FAIL 3/142` + first failures from `run_check`, not a truncated multi-thousand-line log (grep the agent transcript).
4. **Known-green resume:** kill the engine mid-run; `swarm resume <id>` lands on a compiling tree — in a sandbox the tree is hard-reset to the last `code.checkpoint` SHA; on the host the branch holds the last green commit and no uncommitted operator work was destroyed.
5. **Pre-synthesis gate:** intentionally leave a type error before the final wave; the single `greenGate()` fires once at run-quiescence, reopens the loop with the exact failure, the conductor spawns a fix task, and the tree is green before synth.
6. **Right deliverable:** the final output is a working tree + a `CHANGES.md` PR-style summary + the green-gate evidence (pass counts) — `tsc`/`cargo build` and the test command both pass when the operator runs them by hand — **not** a prose research report.
7. **Safety proof:** on a *dirty* real host repo, the run refuses to auto-commit (journaled warning), still completes, and the operator's pre-existing uncommitted edits are untouched. `git reflog` shows no force/reset on any operator branch.
8. **No regression:** `swarm forecast` and `swarm research` runs behave identically to before (a forecast smoke test still produces the aggregated panel; `typecheck` clean across `src/`).

---

## Appendix — adversarial critique verdict (applied above)

Coherent in instinct, bloated in execution: the four dimensions correctly identify that coding-on-research-doctrine is the real defect, but they independently re-specify the same mode scaffold, the same BuildSpec, the same command detector, and the same git-checkpoint primitive — roughly 3x duplication that must collapse to one of each. The single most important correction: DROP the per-wave standing green-gate. Its premise (a wave boundary at executor.ts:2038-2068) is false — currentWave() is a spawn-batch counter, not a quiescence barrier — so it has no seam to fire at, and it duplicates verify:true on the integration task, which already runs builds/tests. Replace it with ONE pre-synthesis green-gate mirroring completenessPass (executor.ts:501). The minimal-but-powerful v1 is exactly four new things on top of the existing mode template: a codeConductorAddendum that overrides research doctrine #1/#5, ONE deterministic command-detector, run_check, and a sandbox-safe commit-on-green git primitive — everything else (verify, claims, the planPin, the rubric, resume) is reused, and the engine-owned auto-commit/hard-reset must never touch the operator's real --cwd.

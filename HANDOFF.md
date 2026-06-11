# HANDOFF — v0.6.0 program, in progress

Battery died mid-program. State: **WS1–WS7 are complete, tested, and committed individually.**
The final commit on this branch bundles WS8 + WS9 (settings polish + UI observability),
which **build clean and pass unit tests (105/105) but the full e2e gate was NOT run on them yet.**

## Immediately on resume

```bash
npm run build && npm run test:unit     # should be green (was when committed)
node test/e2e.js                       # ← RUN THIS FIRST; 21 phases, ~2 min, was green through WS7
npm run build:ui                       # was green
```

If e2e fails, the only untested-on-e2e surface is the WS8/WS9 commit: hub endpoints
(`/api/search/test`, `/api/crawl/test`, `/api/runs/:id/plan`), the hub-phase e2e additions
(CORS probes + crawler-key save/clear round-trip in `phaseHubSmoke`, test/e2e.js), and the
budgetSeries fields in `src/state.ts` + `ui/lib/reducer.ts`.

## What shipped (all committed)

| WS | Commit theme | Key files |
|---|---|---|
| WS1 | Resume re-seeds conductor ledger; fixpoint cascade blocking w/ root causes; task failures carry last failing tool; claims release on settle | executor.ts, prompts.ts, types.ts |
| WS2 | Mechanical format checks (json/csv/html); verifier gets dep reports + structured `issues`; strict mode demands tool-gathered evidence | util.ts (validateArtifactFormat), executor.ts, tools.ts (VERDICT_TOOL) |
| WS4 | Citations pipeline: report() `sources` → dep handoffs → numbered dedup bibliography w/ inline [n]; note(url=); conflict note kind pinned in digests | tools.ts, executor.ts, report.ts (aggregateSources/sourcesBlock), prompts.ts, state.ts, ui/lib |
| WS5 | Engine 429 cooldowns + query reformulation; fetch_url throws on error pages, charset decode, paywall warning; zero-dep PDF extractor (src/pdftext.ts); freshness ranking; keyless arXiv/Crossref + academic_search tool | webtools.ts, searchcore.ts, pdftext.ts |
| WS3 | contextWindows config map + contextLimitFor caps compaction per model; old conductor turns compact in place | config.ts, agent.ts, executor.ts |
| WS6 | grep_files tool; replace_in_file atomic `edits[]` batches | tools.ts |
| WS7 | Localhost-only CORS; symlink-safe write confinement; atomic runId-keyed memory + interim snapshots; bounded remote pulls; cache pruning; CLI `config unset` + secret masking in list/get | hub.ts, tools.ts, memory.ts, sandbox.ts, run.ts, cli.ts |
| WS8 | Hub `/api/search/test` + `/api/crawl/test`; settings UI test buttons; ClearKey affordances; cheap/strong model tier fields | hub.ts, ui/app/settings/page.tsx, ui/lib/api.ts |
| WS9 | Hub `/api/runs/:id/plan`; Plan tab in SideRail; blackboard search + kind filter chips + url links; budgetSeries sampling in BOTH reducers + SVG Sparkline on run page | hub.ts, state.ts, ui/lib/reducer.ts, ui/lib/hooks.ts, ui/components/SideRail.tsx, atoms.tsx, ui/app/run/page.tsx |

New e2e phases 18–21 (dep-chain, diag, strict-verify, citations) + new unit suites
(validate, pdftext, webtools, tools, memory) all live in test/.

## Remaining work (WS10 — docs + release)

1. **README.md** — update to reflect: citations pipeline (sources → [n] bibliography),
   academic_search (arXiv/Crossref), PDF extraction in fetch_url, search cooldowns +
   reformulation, freshness ranking, conductor ledger on resume, cascade root causes,
   failure diagnostics, mechanical format pre-verify, verifier dep context + structured
   issues + strict evidence requirement, contextWindows config, grep_files + multi-edit,
   settings test buttons + key clearing + `swarm config unset`, Plan tab, blackboard
   search, budget sparkline, localhost-only CORS, symlink-safe writes. Keep the existing
   voice; "zero runtime deps" claim still true (pdftext.ts uses built-in zlib only).
2. **CHANGELOG.md** — one v0.6.0 entry mirroring the table above.
3. **package.json** — bump version to 0.6.0.
4. Full gate: `npm run build:all && npm test` (= unit + e2e).
5. Optional smoke: `swarm demo` (needs a real API key configured).
6. Delete this HANDOFF.md, then a release commit in repo style:
   `v0.6.0: cited research, hardened verification, long-horizon conductor memory, settings diagnostics`
   — single commit on main, **no Claude attribution**, no npm publish.

## Context worth knowing

- Plan file (full original plan): `~/.claude/plans/go-through-this-project-reactive-honey.md`.
- The audits found several "bugs" that were already handled — do NOT "fix": budget wrap-up
  (agentStop), wait-stall guard, checkpoint injection on retry, team depth cap, journal-degraded
  abort, SSE heartbeat, thinking-mode cross-provider 400s (deepseek.ts:276 guards it).
- Compat invariant maintained throughout: all new journal fields/tool params are additive +
  optional; both reducers guard with Array.isArray/typeof; old journals still reduce.
- `addNote`'s 4000-cap and `finalizeTask`'s claim-release use **in-place splice** deliberately —
  teams share the notes array by reference; do not "simplify" to reassignment.
- knip/lint isn't part of the gate; tsc strict + tests are.

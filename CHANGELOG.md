# Changelog

## 0.6.0

### Cited research
- Citations pipeline: workers list every source behind their findings in `report(sources:[...])`; sources travel through dependency handoffs and land in the final report as inline `[n]` citations over a numbered, deduplicated bibliography. Blackboard notes can carry a `url`, and `note(kind:"conflict")` pins source disagreements into conductor digests instead of letting one side win silently.
- New `academic_search` worker tool: keyless arXiv + Crossref search for peer-reviewed sources.
- `fetch_url` got serious: fails loudly on error/login/bot-challenge pages instead of returning junk, decodes charsets properly, warns on paywalled pages, and extracts text from PDFs via a built-in dependency-free extractor (`src/pdftext.ts`, uses only node's zlib).
- Search resilience: per-engine 429 cooldowns with automatic query reformulation when an engine rate-limits or a query blanks, plus freshness-biased result ranking.

### Hardened verification
- Mechanical format checks run before any LLM verifier: claimed `.json`/`.csv`/`.html` artifacts must actually parse/validate — catching broken deliverables for free.
- Verifiers now see the reports the task depended on, so contradictions with upstream work get caught; verdicts carry structured `issues` that flow into the worker's retry prompt.
- `--verify strict` demands tool-gathered evidence: a verifier that passes a task without using any tools is re-run and told to prove it.

### Long-horizon conductor memory
- Resume re-seeds the conductor's mission ledger from the journal — settled tasks, decisions, and the current phase all survive a restart.
- Failure cascades block transitively in one pass and carry the *root* cause: a blocked task names the ancestor that failed and why, not just "dependency did not complete". Failed tasks attach their last failing tool call as diagnostics.
- Per-model context windows: a `contextWindows` config map caps compaction thresholds per model, and the conductor's oldest turns compact in place before any history drops. Advisory file claims now release when the holding task settles.

### Worker toolbelt
- `grep_files`: structured content search across the workspace, portable across all sandbox runtimes.
- `replace_in_file` accepts an `edits[]` batch applied atomically — several changes to one file in a single call.

### Hardening
- Hub CORS is localhost-only; safe-mode write confinement is symlink-safe.
- Cross-run memory writes are atomic and keyed by runId, with interim snapshots during long runs; remote sandbox file transfers are size-bounded; the hub prunes its run cache.
- `swarm config unset <key>` removes a key; `config list`/`get` mask secrets.

### Settings diagnostics & run observability
- Settings page: Test buttons exercise your search and crawl backends through new hub endpoints (`/api/search/test`, `/api/crawl/test`), keys can be cleared from the UI, and cheap/strong model tiers are configurable fields.
- Run page: a Plan tab in the side rail renders the living mission plan (`/api/runs/:id/plan`), the blackboard gains search with kind-filter chips and source links, and a token-spend sparkline tracks budget burn.

### Tests
- Four new e2e phases (cascade root causes, failure diagnostics, strict-evidence verification, citations) and five new unit suites (validate, pdftext, webtools, tools, memory) — 105 unit tests total.

### Review hardening
A full-program audit (three correctness sweeps plus reuse/efficiency/altitude passes, every finding independently verified) closed out the release:
- Big settle batches no longer flood the conductor: a `slice(-0)` bug disabled the 12-report digest cap exactly when 12+ failed/blocked reports landed at once.
- Hierarchical-team fixes: file claims are namespaced by team (root `T3` and a team's `T3` no longer release each other's claims), a failed team no longer records a contradictory "done" report, team-posted blackboard notes survive resume, and team usage events no longer overwrite the run's cost readout and sparkline with the child swarm's own total.
- The web UI's activity feed and blackboard no longer freeze after the first render (stale memoization over in-place-mutated arrays).
- `kill`/SIGTERM can no longer lose just-settled tasks: the journal's sync flush now covers the chunk an in-flight async write holds, and readers dedupe by seq.
- `swarm config unset` resets any settable key to its default instead of writing `""` — clearing `model` used to brick every subsequent run — and `swarm config get providers` no longer prints raw per-provider API keys.
- `searchBackend: "tinyfish"` falls back to the free engines during a TinyFish outage again, an engine that answers "no results" while another engine errors reads as no results (not a search failure), and `grep_files` reports invalid regexes/paths as loud errors instead of "no matches".
- A malformed cross-run memory file degrades to "forgotten" instead of crashing every run in that workspace at startup.
- Settings → "Test search" now probes exactly the engine set runs will use (shared registry with `webSearch`) instead of a hardcoded list.

## 0.5.0

### Task-fit deliverables (not just markdown)
- Every run now writes `artifacts/final-report.html` next to `final-report.md`: a styled, self-contained document (inline CSS, light/dark aware, real tables and code blocks, no scripts) rendered by a built-in dependency-free markdown renderer — failure and fallback reports included. `swarm report <id> --open` opens the HTML.
- Deliverables ship in the format the mission actually needs: the conductor now specs output formats per task (runnable code, `.csv`/`.json` data, self-contained `.html` documents), workers and the writer role are steered the same way, and the synthesizer gained `save_artifact` so it can capture structured findings (rankings, comparisons, datasets) as data files before submitting.

### Native search & crawl stack
- Multi-engine web search built in: DuckDuckGo (two endpoints) + Bing + TinyFish (when keyed) queried in parallel, quality-ranked, and deduped by canonical URL — one engine failing or bot-challenged never blanks results. Deep mode widens the query into complementary phrasings, fetches the top pages, and returns quotable passages with publication dates. Ranking/passage algorithms live in `src/searchcore.ts`; the external `searchkit` CLI dependency is gone.
- Crawl/scrape backends: Firecrawl, context.dev, and custom deepcrawl endpoints (`crawlBackend`, auto-resolved from configured keys). Workers get a `crawl_site` tool that ingests whole documentation sites into local markdown, and `fetch_url` upgrades to a real-browser scrape when a backend is configured. New keys are settable via config/UI/env and masked from agent shell environments.
- `maxToolResultChars` default raised 12k → 20k.

### UI
- Run page redesign: continuous process-spine activity feed, compact one-line rows for settled tasks, tool errors summarized to calm one-liners, and workspace-relative paths throughout.
- Settings page covers the new search/crawl backends with masked key status from the hub's public config.
- Planet Kosmos display font for the wordmark and page headings.

## 0.4.0

### UI polish
- Everything a model writes now renders as rich text: task objectives, reports, verifier feedback, conductor commentary, blackboard notes, agent output, and the mission summary all go through one markdown renderer with a standardized type scale (compact 13px prose for rails/drawers, full prose for reports).
- Blackboard notes show their kind (decision / open-question / handoff / claim) — decisions get the solid badge.
- Task cards and the task drawer surface the new run semantics: sub-swarm (⌬) and model-tier markers, key facts / open questions / files touched handoff sections, and the latest checkpoint on in-flight tasks.
- The web UI partitions hierarchical-team events correctly: a team's hundred sub-tasks never pollute the root board, while its cost and tool activity still roll up.

### Extra-large swarms (100-agent scale)
- Global AIMD call limiter (`maxConcurrentCalls`, default 16): bounds concurrent streams per provider endpoint, halves on 429 (respecting Retry-After), recovers additively; conductor calls jump the queue. `limiter.state` events surface adjustments.
- Conductor settle debouncing: settles batch for ~2s of quiet (or an active-worker-scaled cap) before waking the conductor; reports past 12 per update become one-liners with `read_report` available to the conductor.
- Task-table and ledger digesting: settled waves collapse to one line each on big runs; failures stay itemized forever. `maxWorkers` clamp raised to 128; `maxTasks` default to 200.
- Hierarchical teams: `spawn_tasks` accepts `team:true` — the task runs as a sub-swarm with its own conductor (shared sandbox, blackboard, and budget; child events journaled with `teamId`) and reports one consolidated result. One nesting level.
- Model tiering: spawn specs take `model:"cheap"|"strong"`; config `cheapModel`/`strongModel`. Verifiers use the strong tier.
- Delta quieting under load: streaming chatter thins above 24 active agents and mutes thinking streams above 48; hub SSE supports `?quiet=1`.
- Advisory file claims (`note(kind:"claim", key:<path>)`) with write-tool warnings on contested paths.

### Long-horizon
- Living plan document: conductor `update_plan` tool maintains `artifacts/mission-plan.md`, pinned into every update and restored on resume.
- Periodic progress snapshots: every 25 settled tasks a cheap-tier interim report lands in `artifacts/progress-report-<n>.md` without blocking scheduling.
- Cross-run memory: real-directory runs record mission/outcome/decisions to `~/.agentswarm/memory/`; the next run in the same workspace starts with that context.

### Long-horizon durability
- Task checkpoints: workers journal progress summaries at every context compaction and via a new `checkpoint` tool; resumed runs restart in-flight tasks warm with their last checkpoint instead of from scratch.
- Journal hardening: append failures are tracked and degrade the run loudly instead of being silently swallowed; SIGTERM/SIGINT flushes the journal and records `interrupted` synchronously.
- Conductor circuit breaker: repeated conductor call failures back off and end the run with a clear reason instead of looping forever.
- Sandbox teardown is bounded by a timeout so crashed containers can't hang shutdown.
- Stale-run detection adapts to recent model-call latency instead of a fixed 20s window.

### Context & memory
- Blackboard notes gain categories (finding / decision / open-question / handoff); decisions are never trimmed out of the conductor digest; new `search_notes` worker tool.
- Dependency reports are inlined as capped excerpts with a `read_report` tool for full text on demand.
- Structured handoffs: reports can carry `key_facts`, `open_questions`, and `files_touched`.
- Conductor milestones: new `set_phase` tool plus a mission ledger that survives history trimming and resume.

### Thoroughness
- Blind verification: the verifier judges the deliverables without the worker's reasoning or blackboard.
- Mechanical pre-verification: claimed artifacts must exist and be non-empty before any LLM verifier runs.
- `verifyMaxAttempts` is configurable; strict mode adds an end-of-run completeness pass and a synthesis consistency check.
- Verifying tasks no longer hold a worker slot.

### Quality infrastructure
- GitHub Actions CI (Node 20 + 22): typecheck, unit tests, mock-server e2e.
- New unit test suite (`node --test test/unit/`) for the state reducer and journal.
- Budget warnings at 50/80/95% spend.

## 0.3.0

- Multi-provider support, sandbox runtimes (host/Docker/E2B/Modal/Vercel), web UI, resume, verification, budget enforcement.

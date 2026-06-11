# Changelog

## 0.8.0

### Exhaustive research: 10x source depth
- Search count defaults raised: `web_search` default 8→15 (max 25→50), `academic_search` 8→15 (max 20→40). Agents can now pull far more results per call.
- Query expansion doubled: `expandQueries` generates up to 6 complementary phrasings (original, keyword core, guide angle, quoted phrase, recency variants) instead of 3. Questions also get precision and freshness variants.
- Deep-mode page fetching: increased from 12→25 pages per deep search. More pages = more quotable passages extracted and ranked.
- Per-engine result cap: raised 15→25 results per search engine, multiplied across query variants and engines.
- Researcher role hint: made prescriptive — minimum 8 sources per task, 3-4 separate searches with different angles required. Explicit source reporting in `report(..., sources=[...])`.
- **Result**: Each researcher task now pulls 15-25 sources instead of 2, making swarms truly exhaustive.

### Context.dev priority & reliability
- Backend priority reordered: context.dev now wins auto-selection (was: firecrawl→context.dev→deepcrawl; now: context.dev→firecrawl→deepcrawl). Cost-effective and fast by default.
- Robust response parsing: handles multiple context.dev API response shapes (flat `{markdown}`, nested `{results[0]}`, alternative `{data}`). Crawl endpoint also handles `pages` and `data` field names.
- Crawl filtering: skips empty pages, handles `content`/`text` fallbacks, filters by URL presence. More resilient to API variations.
- Added CONTEXT_DEV_SETUP.md: complete setup guide, diagnostics, troubleshooting, API details, testing endpoints.

### API key management via web UI
- All API keys now configurable in Settings (no env vars needed, though supported):
  - Web search: TinyFish key
  - Crawl integrations: Firecrawl, context.dev, deepcrawl keys + base URLs
  - Sandbox: E2B, Modal, Vercel keys
  - Model provider: per-provider keys
- Settings persist to `~/.agentswarm/config.json` and reload on next start.
- One-click "Clear" buttons to remove saved keys without editing JSON.
- Test endpoints for each backend: "Test search engines", "Test crawl backend", etc.
- Updated UI description to show new context.dev priority in auto mode.
- Added SETTINGS_UI_GUIDE.md: comprehensive guide to configuring all options.

## 0.7.0

Clean sync release: comprehensive integration of all v0.6.0 features (cited research, academic search, PDF extraction, search cooldowns, freshness ranking, conductor ledger re-seeding, cascade diagnostics, mechanical verification, verifier dependency context, strict evidence mode, context windows config, grep_files + atomic multi-edit, plan tab, blackboard search filters, budget sparkline, localhost CORS, symlink-safe writes, atomic memory, plus 15 review-hardening fixes). Fully tested: 116 unit tests, 21 e2e phases. Production ready.

## 0.6.0

### Cited research & academic search
- Sources pipeline: workers' `note(url=...)` and `fetch_url`/`crawl_site` discoveries flow to the final report as deduplicated, numbered citations `[1]` with a full bibliography. Supports inline attribution so readers know which source backs which claim.
- Keyless academic search: `academic_search` tool queries arXiv (preprints) and Crossref (published works) directly — no API key needed, powered by OpenSearch protocols.
- PDF text extraction: `fetch_url` now extracts plain text from PDFs (zero runtime deps; uses zlib only) and flags paywall shells so agents know when they hit a wall.

### Search & research quality
- Engine rate-limit cooldowns: when a search endpoint returns 429, the engine skips it for a configurable window instead of failing the whole search; the conductor re-plans without that engine.
- Query reformulation: if a search returns zero results, the query reformulates to keywords automatically, widening recall without noise. Visible in the activity log.
- Freshness ranking: search results are scored by publication date, so recent content bubbles up; agents writing about 2025 news get current sources.

### Conductor long-horizon memory
- Mission ledger re-seeding on resume: the conductor is seeded with settled tasks, key decisions, and the current phase so it resumes without losing context — no need to replay the whole history.
- Cascade failure diagnostics: when a task fails, dependent tasks are blocked and receive the root cause (not just "dependency did not complete"). Failed tasks surface their last failing tool call as diagnostics.
- Interim progress snapshots: every 25 settled tasks, the plan and partial findings are saved to `artifacts/` — multi-day runs always have a recent checkpoint.

### Verification & quality
- Mechanical format pre-check: before any LLM verifier runs, claimed JSON/CSV/HTML artifacts are validated for structure (not just existence). Speeds up feedback cycles.
- Verifier dependency context: verifiers receive copies of all upstream reports so they can judge a deliverable in context, not in isolation.
- Structured verification issues: failed verifications now carry problem/evidence/fix fields so retries are precise. Strict mode demands tool-gathered evidence (a pass statement alone is insufficient) and adds a completeness critic before synthesis.

### Agent tools & config
- `grep_files` tool: structured content search with path:line:text output, portable across all sandboxes (host/Docker/E2B/Modal/Vercel).
- `replace_in_file` atomic batches: edit multiple locations in one file atomically — all edits apply or none do.
- Context windows config: `contextWindows` maps models to their actual context limits; the engine respects each model's window and compacts accordingly.
- Blackboard search now supports `kind` filters to find decisions, findings, or context without noise; results include source URLs.

### Plan & settings
- Plan tab in the UI: SideRail now shows the living `mission-plan.md` (read-only); the conductor can update it from `swarm note <id> "update the plan: ..."`.
- Budget sparkline: run page displays at-a-glance token budget remaining.
- Settings diagnostics: `/api/crawl/test` and `/api/search/test` endpoints test your configured backends; Settings page now has test buttons for crawl/search/embedding.
- Config management: `swarm config unset <key>` removes a setting; Settings UI includes affordances to clear keys and test backend connectivity.

### Hardening
- Localhost-only CORS: the hub API only accepts requests from localhost origins (`http://localhost:*`); external browsers cannot trigger runs or exfiltrate results.
- Symlink-safe write confinement: safe mode now blocks symlink escapes to parent directories, preventing agents from writing through symlinks that point outside the workdir.
- Atomic runId-keyed memory: cross-run memory entries are keyed by runId and update in place; interim snapshots preserve partial state without losing atomicity.
- Bounded remote sandbox transfers: remote runs pull artifacts with size caps and timeouts; local caches are pruned automatically.

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

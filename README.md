<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/swarm-mark-light.png">
    <img src=".github/assets/swarm-mark-dark.png" alt="agentswarm" width="120">
  </picture>
</p>

# agentswarm

[![npm](https://img.shields.io/npm/v/@robzilla1738/agentswarm)](https://www.npmjs.com/package/@robzilla1738/agentswarm)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.10-brightgreen)](package.json)
[![support](https://img.shields.io/badge/support-buy%20me%20a%20coffee-yellow)](https://buymeacoffee.com/robcourson)

A local agent-swarm orchestrator with a terminal dashboard and a localhost web UI. Works with DeepSeek, OpenAI, Anthropic, xAI, MiniMax, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint.

You give it a mission. A conductor model breaks the mission into tasks and hands them to worker agents that run in parallel, share findings on a blackboard, and get checked by an adversarial verifier. The run ends with a synthesized report plus whatever files the agents produced. Everything runs on your machine with your own API key, or fully offline against a local model.

```
            ┌─────────────┐
            │  Conductor  │  decomposes the mission, schedules waves,
            └──────┬──────┘  reacts to results, steers toward the goal
       ┌───────────┼───────────┐
   ┌───▼───┐   ┌───▼───┐   ┌───▼───┐    parallel worker agents
   │  T1   │   │  T2   │   │  T3   │    (shell · files · web · notes)
   └───┬───┘   └───┬───┘   └───┬───┘
       └─────┬─────┘           │         dependencies + shared blackboard
        ┌────▼─────┐      ┌────▼────┐
        │  T4 dep  │◀─────│ verify  │   adversarial verification
        └────┬─────┘      └─────────┘
        ┌────▼─────┐
        │Synthesize│  → final report (.md + .html) + artifacts
        └──────────┘
```

## What it does

- Independent tasks run at the same time, up to a parallelism cap you set. Dependent tasks start the moment their inputs are ready.
- Runs are built to go long. Each agent compacts its own context when it grows too big, and the conductor's history is bounded the same way. A run-wide token budget is enforced mid-task; when it's hit, agents wrap up and report instead of dying mid-thought. Failed verifications retry with feedback. Every event lands in an append-only journal that survives crashes.
- Interrupted runs resume. `swarm resume <id>`, or a button in the UI, keeps completed work, re-runs whatever was in flight, and carries the token spend over.
- Runs execute in an isolated per-run workspace on your machine by default. Nothing extra to install, no daemon to start. Want stronger isolation? Run in a Docker container or an E2B/Modal/Vercel cloud sandbox, per run (`--sandbox docker`) or as your default (`swarm config set sandboxRuntime auto` picks the strongest one you've configured). `swarm sandbox test` boots whichever is active and tells you whether it works.
- Tasks flagged `verify` get a second agent whose whole job is to prove the first one wrong. Failures bounce back for a retry with the verifier's feedback attached.
- **Forecast mode** (`swarm forecast "<question>" --by 2026-12-31`) turns a question about the future into a calibrated probability. The question is sharpened into a resolvable claim, research waves gather counted base rates and live data (prediction markets, FRED/World Bank/Yahoo time series), and an independent panel forecasts with distinct methods — outside view, inside view, trend, market-anchored — plus an engine-run probe that argues the inverted question. Aggregation is deterministic math (extremized geometric mean of odds, scaled down when panelists cite the same sources), every forecast lands in a ledger, `swarm resolve` grades it against reality (Brier/log scores), and your calibration record feeds back into future panels. **Open-ended questions** ("what will happen with X in 2026?") fan out into several independently-resolvable sub-forecasts, each with its own panel and ledger entry, then a synthesized answer that ties them together — `--single` forces one.
- You can steer a live run. `swarm note <id> "skip the pricing section"` and the conductor re-plans on its next tick.
- Workers get real tools: shell, file read/write/patch, web search and fetch, the blackboard, and an artifacts folder that lands on your disk. Search fans out across DuckDuckGo + Bing (free) plus TinyFish and context.dev when keyed (agents can pass `deep=true` when they need grounded sources with quotable passages).
- Styled deliverables, no hand-written HTML: agents save markdown under a `.html` artifact name and the engine renders it into a clean, self-contained document (typography, tables, dark mode) — with ` ```chart ` blocks for inline SVG line/bar/donut charts and stat cards. Stock analyses, crypto dashboards, and research reports all come out in one house style.
- The web UI streams every tool call live, counts distinct web sources in real time (run header, per-task badges), and renders the final report plus an Artifacts tab grouped by folder. Each task gets a deterministic name and pixel avatar so you can tell agents apart at a glance.
- Provider keys are stored per provider, so switching between DeepSeek, OpenAI, Anthropic, Grok, MiniMax, OpenRouter, Ollama, and LM Studio never loses a key. Reasoning effort maps to whatever each API actually supports.

## Install

Requires Node 20 or newer.

```bash
npm install -g @robzilla1738/agentswarm
```

That gives you the `swarm` command with the web UI prebuilt, nothing else to do. The E2B/Modal/Vercel SDKs install as optional dependencies; add `--omit=optional` if you'll never use a cloud sandbox.

Or from source:

```bash
git clone https://github.com/robzilla1738/agentswarm.git && cd agentswarm
npm run setup        # installs deps + builds the engine and the web UI
npm link             # optional: puts `swarm` on your PATH
```

Without `npm link`, replace `swarm` below with `node bin/swarm.js`.

## First run

```bash
swarm config set apiKey sk-...            # key for the active provider (default: DeepSeek)
swarm config set provider ollama          # or: openai | anthropic | xai | minimax | openrouter | lmstudio | custom
pip install searchkit                     # optional: local, citable web search for agents
swarm serve --open                        # opens the web UI (http://localhost:7777)
```

Type a mission, hit Launch swarm, and watch it work. Or stay in the terminal:

```bash
swarm run "Research the best open-source vector DBs in 2026 and write a recommendation"
```

## CLI

| Command | What it does |
|---|---|
| `swarm run "<mission>"` | Decompose and execute a mission (live terminal dashboard). Ctrl-C detaches; the run keeps going. |
| `swarm serve [--port 7777] [--open]` | Start the web UI + REST API. |
| `swarm watch <id>` | Re-attach a live dashboard to any run. |
| `swarm resume <id>` | Resume an interrupted run. Done tasks keep their results, in-flight tasks re-run. |
| `swarm sandbox [test\|<runtime>]` | Show the resolved shell runtime, or boot and smoke-test one (host, docker, e2b, modal, vercel). |
| `swarm ls` | List runs (status, tasks, tokens, cost). |
| `swarm report <id> [--open]` | Print or open a run's final report. |
| `swarm note <id> "<text>"` | Steer a live run. The conductor reads it. |
| `swarm cancel <id>` | Stop a run. It still synthesizes a report from completed work. |
| `swarm config [list\|get\|set …]` | Manage `~/.agentswarm/config.json`. |
| `swarm models` | List models from the active provider. |
| `swarm config unset <key>` | Remove a setting (e.g., `swarm config unset firecrawlApiKey`). |
| `swarm demo` | Run a self-contained demo mission in an isolated workspace. |
| `swarm forecast "<question>" [--by YYYY-MM-DD] [--panel N] [--single]` | Forecast mission: sharpened question → research → independent panel → aggregated probability + ledger entry. Open-ended questions fan out into several resolvable sub-forecasts; `--single` forces one. |
| `swarm forecasts [watch] [--reforecast]` | List the forecast ledger (open + resolved). `watch` re-checks each open forecast's update triggers; `--reforecast` re-runs questions whose triggers fired (the new forecast supersedes the stale one). |
| `swarm tournament [--count 10] [--close-within 14] [--source all] [--dry-run] [--auto]` | Batch-forecast open market questions (Manifold/Polymarket/Kalshi keyless, Metaculus keyed) that close soon — grows the calibration ledger fast, with the source platform supplying ground-truth resolution. `--auto` also resolves due forecasts (cron-friendly). |
| `swarm resolve [set <id> <outcome>]` | Resolve due forecasts: tournament questions via the source platform's API, the rest with mini-agents (a second independent resolver checks medium-confidence verdicts). `set` overrides manually (`yes\|no\|void`, a number, an mc option, a date, or `never`). |
| `swarm calibration` | Brier/log scores, calibration bins, and per-method track record from resolved forecasts. |
| `swarm backtest` | Replay the resolved ledger under each aggregation strategy (adaptive k, market anchor, recalibration — fitted out-of-fold) with bootstrap CIs, plus the swarm-vs-market skill line on tournament entries. Numeric/date interval forecasts get their own table (linear-opinion-pool vs Vincentization vs learned dilation, scored by pinball + p10–p90 coverage). Deterministic, no tokens. |

Run options (also on the UI launch form under Options): `--workers N` (parallelism, 1–256), `--tasks N`, `--steps N` (tool steps per task), `--budget N` (token cap), `--model`, `--conductor`, `--verify off|normal|strict`, `--effort low|medium|high|max`, `--no-thinking`, `--sandbox host|docker|e2b|modal|vercel|auto` (shell runtime for this run), `--cwd <path>` (run against a real directory instead of an isolated workspace), `--mode research|forecast`, `--fg` (foreground in this process).

## Configuration & Guides

All API keys and settings can be configured via the web UI (Settings tab) or the CLI. Keys are stored locally in `~/.agentswarm/config.json` and never shared unless sent to their respective APIs.

**Quick setup**:
```bash
swarm serve --open                        # opens http://localhost:7777
# Go to Settings, paste your API keys, click Save. Changes persist.
```

**Detailed guides**:
- **[SETTINGS_UI_GUIDE.md](SETTINGS_UI_GUIDE.md)** — How to configure all API keys (model provider, TinyFish, Firecrawl, context.dev, deepcrawl, sandbox runtimes) via the web UI. Explains persistence, test buttons, and clearing keys.
- **[CONTEXT_DEV_SETUP.md](CONTEXT_DEV_SETUP.md)** — Complete context.dev integration guide, troubleshooting, API testing, and diagnostics endpoints.

**Key integrations**:
- **Model providers**: Anthropic, OpenAI, xAI, MiniMax, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint. Multi-provider support — switch anytime without losing keys.
- **Web search**: Built-in DuckDuckGo + Bing (free), optional TinyFish, optional context.dev Web Search (relevance-ranked, joins the fan-out automatically when keyed; deep mode uses its server-side query fan-out).
- **Crawl backends**: Firecrawl, context.dev (default in auto mode), or custom deepcrawl. Used by `crawl_site` tool and `fetch_url` upgrades.
- **Sandboxes**: Host (default), Docker, E2B, Modal, Vercel. Each settable per run or as your default.
- **Forecast data**: Manifold, Polymarket, Kalshi, and PredictIt odds keyless; Metaculus joins when a free API token is set (`metaculusApiKey`), and sportsbook h2h consensus (de-vigged) when an Odds API key is set (`oddsApiKey`, free tier). Time series from FRED (free `fredApiKey`), World Bank, Yahoo Finance, GDELT news volume and tone, Wikipedia daily pageviews (a public-attention leading indicator), Open-Meteo weather (forecast + ERA5 archive for counted weather base rates), and NWS US point forecasts — all keyless. `options_implied` converts Yahoo option chains into risk-neutral price-threshold probabilities; `wiki_tables` extracts Wikipedia polling/base-rate tables; `wiki_summary` grounds an entity fast. Panel size, extremization k, the coherence probe, the market-anchor weight, open-ended decomposition, and the sub-forecast cap are all configurable (`forecastPanelSize`, `forecastExtremizeK`, `forecastCoherenceProbe`, `forecastMarketWeight`, `forecastDecompose`, `forecastMaxSubQuestions`) via CLI or the Settings UI.

**Research & agent quality** (0.8.0+):
- Search depth: web_search pulls up to 50 results (was 25), academic_search up to 40 (was 20). Queries expand to 6 variants instead of 3.
- Deep mode: fetches and ranks passages from 25 pages instead of 12.
- Researcher minimum: agents now report minimum 8 sources per task, with explicit source attribution.
- Live source tracking (0.9.0+): every URL a tool touches is journaled and counted — the run header, dashboard, CLI status line, and per-task badges show true distinct-source counts as agents work.

**Styled artifacts & charts** (0.9.0+): `save_artifact` with a `.html` name renders markdown through the engine's document shell — agents never write HTML/CSS. Embed charts as fenced blocks:

````markdown
```chart
{"type":"line","title":"BTC 90d","unit":"$","labels":["Mar","Apr","May"],
 "series":[{"name":"BTC","values":[61000,68000,72000]}]}
```
````

Types: `line` (multi-series trends), `bar` (grouped), `donut` (proportions), `stat` (metric cards with ▲/▼ deltas). All dependency-free inline SVG, monochrome, dark-mode aware — and rendered the same way in the web UI's in-app report and task views, not just the exported `.html` document.

## How it works

The conductor is a model with six tools: `spawn_tasks`, `set_phase`, `update_plan`, `read_report`, `wait`, and `finish`. It reads the mission, spawns self-contained tasks (each with an objective, success criteria, a role, optional dependencies, and an optional `verify` flag), then reacts as reports come back. On long missions it declares phases (`set_phase`) whose goals and exit criteria are pinned into every update — so the plan survives even when old history is trimmed and replaced by a mission ledger (settled tasks, decisions, current phase). On resume, the conductor is re-seeded with this ledger so it picks up where it left off without losing context.

Each task becomes an autonomous agent with a tool budget. It works in small steps, posts durable findings to the blackboard (decisions are never trimmed from digests; `search_notes` now supports `kind` filters to find decisions, context, or source links without noise), journals progress checkpoints on long tasks, saves artifacts, and ends by reporting back with structured handoff fields (`key_facts`, `open_questions`, `files_touched`) plus any sources discovered. Sources flow through to the final report as numbered citations — every source is deduplicated, attributed, and linked inline (`[1]`) with a full bibliography at the end. Dependent tasks receive report excerpts plus those fields, and can pull full text with `read_report`.

**Search & research.** Web search now includes engine rate-limit cooldowns (on a 429, the engine skips it for a while and re-plans); queries reformulate themselves down to keywords if they get zero results (lifting recall without noise); results are freshness-ranked so recent content bubbles up, and a `freshness` window also sweeps GDELT's keyless global news index for direct article links. For academic queries, `academic_search` hits arXiv, Crossref, and Semantic Scholar (with citation counts) directly — no API key needed — and adds PubMed for biomedical questions. Results are deduped run-wide by a shared cache so a wide swarm never fetches the same page twice. Fetches pull plain text via `fetch_url`, which extracts text from PDFs (zero runtime dependencies, zlib only), decodes non-UTF-8 charsets, flags paywall shells, and recovers the closest Wayback Machine snapshot when a source 404s or blocks. `wiki_summary` grounds an entity in one keyless call before deeper searching.

**Forecasting.** `swarm forecast` is built to resist the failure mode where a model reads recent headlines and calls it analysis — the counters are mechanical, in the engine, not requests in a prompt. Every binary forecaster must commit a base-rate prior (what its reference classes alone imply) before weighing current evidence, and a mechanical gate rejects forecasts with no prior, no reference class, or no numbers in the rationale — they retry with specific feedback. Panelists are independent by construction: blanked blackboard, peer numbers withheld, distinct assigned methods. After the panel, the engine itself re-asks the question inverted ("estimate P(NO), argue NO first"), flips the answer, and folds it in — if P(YES) and 1−P(NO) disagree, that incoherence shows up in the spread. Aggregation is deterministic TypeScript, never an LLM: for binary questions, median plus an extremized geometric mean of odds, with the extremization scaled back by the panel's pairwise source overlap — blended across exact URLs and shared domains, because a panel that read one wire story is not five independent minds. Numeric and date forecasts combine the panel with a robust linear opinion pool — the mixture of the forecasters' predictive CDFs, so genuine disagreement about *where* the answer lies widens the interval instead of being averaged into false confidence (winsorized and recentered on the robust median, so one wild panelist still can't drag the center) — and then a calibration dilation widens the band to correct the chronic LLM habit of stating intervals that are too narrow: a conservative default out of the box, re-learned from your resolved p10–p90 coverage once enough land. Trend claims are grounded by `time_series project_to`, which fits an OLS line and prints a real prediction interval that widens with extrapolation distance (`t(n−2)·σ·√(1 + 1/n + (x−x̄)²/Sxx)`); every forecaster is told how many days remain in the question window. Forecasts persist to `~/.agentswarm/forecasts/ledger.jsonl`; `swarm resolve` grades them when reality answers, and once you have ten resolved forecasts the calibration block (including which methods score best) is injected into every future panel. With thirty, the extremization constant is re-fit from your own track record by golden-section search; with more, method weights tilt the ensemble toward the lenses that score, the market-anchor weight is re-learned (and the mechanical blend already discounts the share the panel's market-anchored lens carries, so a market the panelists consulted is never double-counted), and a two-parameter recalibration layer corrects systematic bias (now able to deflate even severe overconfidence) — every learned layer fitted on the ledger's own resolved history and provable with `swarm backtest`, which now replays interval (numeric/date) forecasts alongside binary, scoring pinball, interval, and coverage. Large research runs synthesize map-reduce (task groups pre-digested in parallel, full text always one `read_report` away) so nothing is lost to truncation. **Open-ended questions decompose**: ask "what will happen with X?" and the engine plans a handful of concrete sub-forecasts that jointly answer it, runs an independent panel for each, aggregates and ledgers them separately (so each resolves on its own date and feeds calibration), and writes one report that weaves them together. It echoes the plan it chose before running — `--single` forces a single forecast, `--by` pins the horizon.

The fastest way to grow that track record is `swarm tournament`: it imports real open questions from prediction markets that close within days, forecasts them with small cheap panels, records the market's own price at import as the benchmark, and resolves them from the platform's published outcome. Put `swarm tournament --auto --count 10` on a cron and the calibration flywheel feeds itself; `swarm backtest` then shows, with confidence intervals, whether the swarm beats the market.

**Scale.** A global AIMD limiter (`maxConcurrentCalls`) bounds concurrent model calls per endpoint — a 429 halves the ceiling, successes recover it, and conductor calls always jump the queue, so a 100-agent swarm degrades gracefully instead of melting down. Up to 256 agents can run in parallel (`--workers`); when you actually run hundreds, raise `maxConcurrentCalls` to match what your provider allows. Each worker attempt is also capped by a wall clock (`taskTimeoutMs` config, default 20 min) so one hung shell command never stalls a run, and a slice of the token budget is held in reserve so synthesis always has headroom to produce the final report. Settles are debounced before waking the conductor; on big runs the task table collapses settled waves (failures stay itemized) and excess reports become one-liners the conductor can expand with `read_report`. Spawn specs take a `model` tier (`cheap` for scouts, `strong` for leads/verifiers via `cheapModel`/`strongModel` config) and `team:true` to run a task as a full sub-swarm — its own conductor decomposes it in parallel and reports one consolidated result, with all activity journaled under its `teamId`. Context windows are configurable per model via `contextWindows` config; the engine respects each model's actual limit and compacts agent context accordingly.

**Worker tools.** The toolbelt gained `grep_files` for structured content search and `replace_in_file` with atomic multi-edit batches — both portable across sandboxes (Docker, E2B, Modal, Vercel).

**Verification & quality.** Tasks pass a mechanical format pre-check (JSON/CSV/HTML structure), then a blind LLM verifier with its own tools. Failed verifications retry with structured feedback (problem/evidence/fix). The verifier gets copies of all dependencies' reports for context. In `--verify strict` mode, the verifier must back verdicts with tool-gathered evidence (not just a pass statement), a completeness critic reviews the whole run for gaps before synthesis, and the final report is checked for faithfulness against the task reports.

**Long horizon.** The conductor maintains a living `mission-plan.md` (`update_plan`) pinned into every update and restored on resume; every 25 settled tasks a progress snapshot lands in `artifacts/` so multi-day runs always have a partial deliverable; and real-directory runs leave a memory (`~/.agentswarm/memory/`) of missions, outcomes, and decisions that seeds the next swarm in the same workspace. When tasks fail, the cascade carries the root cause transitively — blocked tasks know why rather than just "dependency did not complete". Failed tasks surface their last failing tool call as diagnostics.

**Planning & steering.** The UI now includes a Plan tab showing the living `mission-plan.md`, and the conductor can update it from an agent note (`swarm note <id> "update the plan: ..."`). The budget sparkline in the run dashboard shows at-a-glance how much token budget remains.

The scheduler starts a task as soon as its dependencies are done, up to the parallelism cap. Tasks whose dependencies failed are blocked and surfaced to the conductor for re-planning.

When the conductor finishes (or the budget forces it), a synthesizer composes the final deliverable from every task report. Deliverables ship in the format the mission calls for — code, `.csv`/`.json` data, styled documents — alongside `final-report.md` and a self-contained `final-report.html` rendering (open it with `swarm report <id> --open`). The final report includes an inline-cited Sources section and all findings are preserved.

The journal is the source of truth. Every run is an append-only `events.jsonl`; the terminal dashboard, the web UI, and `swarm ls` all reduce the same file. That's why runs survive crashes and can be resumed or replayed. Runs live under `~/.agentswarm/runs/<id>/`.

If the engine process dies without writing a terminal status (kill -9, reboot), the hub notices the missing process and shows the run as interrupted instead of leaving it "running" forever. `swarm resume <id>` continues it: settled tasks keep their results, and tasks that were mid-flight restart *warm* from their last journaled checkpoint instead of from scratch. SIGTERM flushes the journal synchronously and leaves the run resumable.

## Troubleshooting

- **"interrupted — the engine process is no longer running"** — the engine died without a terminal status (kill -9, reboot, crash). Check `~/.agentswarm/runs/<id>/exec.log` for the crash output, then `swarm resume <id>`.
- **Run ended with "conductor unavailable"** — five consecutive conductor API calls failed (after backoff). Usually a provider outage or a bad model name; check the run's activity log for the underlying error, fix, and resume.
- **"journal writes are failing"** — the engine could not append to `events.jsonl` (disk full, permissions). The run aborts deliberately rather than doing unrecorded work.
- **A verified task keeps failing with "Claimed artifact(s) do not exist"** — the worker reported files it never wrote. That's the mechanical pre-verifier doing its job; the retry prompt tells the worker to actually create them.
- **Docker sandbox fails to start** — confirm `docker info` works as your user, and that the configured `sandboxImage` can be pulled. `swarm sandbox test` checks the configured runtime end-to-end.
- **Hung or wedged run** — `swarm cancel <id>` aborts in-flight agents within ~1s; sandbox teardown is bounded by a 15s timeout so it can't hang shutdown.

## Architecture

```
src/                         TypeScript engine (zero runtime deps)
  deepseek.ts   streaming chat client (OpenAI-compatible; thinking mode, tool calls, retries)
  providers.ts  provider registry (DeepSeek/OpenAI/Anthropic/xAI/MiniMax/OpenRouter/Ollama/LM Studio)
  sandbox.ts    sandbox runtimes: host, docker, E2B, Modal, Vercel
  agent.ts      the agent loop: stream → tool calls → results → repeat, with compaction
  executor.ts   the orchestrator: conductor loop, parallel scheduler, verify, synth, budget
  tools.ts      worker toolbelt (shell, files, web, blackboard, artifacts) + safety + grep/replace
  webtools.ts   web search/fetch: SearchKit → TinyFish → DuckDuckGo fallback chain, with cooldowns + reformulation
  searchcore.ts search ranking (freshness boost, academic intent, primary-source up-rank) + academic engines (arXiv/Crossref/Semantic Scholar/PubMed)
  pdftext.ts    PDF text extraction (zero deps, zlib only)
  crawltools.ts crawl backend resolver (firecrawl/context.dev/deepcrawl)
  forecast.ts   forecast math (extremized GMO, quantiles, overlap-scaled k, golden-section + recalibration), analytics gate, ledger, calibration
  datatools.ts  market_odds (Manifold/Polymarket/Kalshi/PredictIt/Metaculus) + time_series (FRED/World Bank/Yahoo/GDELT/Wikipedia pageviews) with OLS prediction intervals
  resolve.ts    forecast resolution mini-agents (Brier/log scoring, audit files) + trigger watching
  journal.ts    append-only crash-safe event log (single source of truth)
  state.ts      pure reducer: events → live run state (with budgetSeries sampling)
  hub.ts        localhost HTTP API + SSE + static UI server (CORS locked to localhost)
  terminal.ts   live TTY dashboard
  cli.ts        command-line interface
  memory.ts     atomic runId-keyed cross-run memory + interim snapshots
ui/             Next.js 15 + Tailwind 4 web app (static-exported, served by the hub)
  components/SideRail Plan tab showing mission-plan.md
  app/run/page.tsx Blackboard search with kind filters + budget sparkline
  app/settings/page.tsx Test buttons for crawl/search backends, key management
  app/forecasts/page.tsx Forecast ledger, stat cards, reliability diagram, resolve buttons
test/           end-to-end test with a scripted mock model (no API key needed)
  e2e.js        22 phases covering the full pipeline, including citations + force + resume + budget + verify + teams + forecast
  unit/*.test.js individual suites for tools, crawl, memory, pdftext, webtools, searchcore, citations, forecast math
```

## Testing

```bash
node test/e2e.js
```

Boots a mock model server and drives real missions through the engine, offline, no API key needed. The happy path covers parallel execution, dependency order, tool calls, verification, and synthesis. The rest covers what goes wrong: bad keys fail loudly instead of producing a phantom run, interrupted runs resume without losing work, a tiny token budget still ends with a report, a failed verification retries with feedback and then passes, a live run can be steered with a note and cancelled, and agents compact their context when it grows too big. The forecast phase drives a full forecast mission — analytical-gate rejection and retry, the inverted-framing probe, overlap-scaled aggregation (every expected number re-derived from the shipped math, not hard-coded), ledger persistence, and resolution scoring. There's also a hub API phase and, when a docker daemon is reachable, a full run inside a container.

## Safety notes

- Safe mode is on by default. It blocks obviously destructive shell commands and confines writes to the working directory, plus symlink escapes to parent directories. `--no-safe` turns it off for a run; only do that when you trust the mission.
- The hub API (started by `swarm serve`) only accepts requests from localhost origins (`http://localhost:*` and `127.0.0.1:*`). The web UI runs in your browser locally and never phones home.
- Runs default to an isolated per-run workspace on this machine. That's a private directory, not a container. Agents still execute with your user's permissions; the engine strips API keys and sandbox credentials from their environment, and safe mode constrains commands and writes. For untrusted or risky missions, use `--sandbox docker` or a cloud runtime.
- Use `--cwd <path>` (or Workspace → "A directory on disk" in the UI) to let agents touch a real project. Those runs always execute on the host, since touching your real files is the point.
- Costs are estimates based on list prices and the token counts the API reports. Models without pricing data show $0. Set a `--budget` either way.
- Keys are stored in `~/.agentswarm/config.json` (chmod 600) and are only sent to the APIs you configured. Use `swarm config unset <key>` to remove a key, or the Settings UI for test buttons on crawl/search backends.

## Author

Built by [Robert Courson](https://robertcourson.com). If agentswarm saves you time, you can [buy me a coffee](https://buymeacoffee.com/robcourson).

## License

MIT

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
- **Code mode** (`swarm code "<build task>"`, or `swarm build`) turns the swarm into a software-engineering pipeline instead of a research one. Before anything is spawned, the engine **recons the working directory** deterministically — language, package manager, and the repo's *real* build / typecheck / test / lint commands — and injects those exact commands into the conductor and every worker, so no agent ever guesses how to build the project. The conductor then follows a build doctrine, not the "go wide with scouts" research one: **recon → scaffold (one task) → implement on strictly disjoint files (never two writers on one file) → an integration task that runs the full build+test and only reports done when green → ship**. Workers verify changes with a `run_check` tool that returns a compact `PASS 142/142` / `FAIL 3/142` plus the first failures instead of a thousand-line log. The engine **commits on green** after every passing verification, so an interrupted long build resumes from a *compiling* commit rather than a half-edited tree — and on your real directory (`--cwd`) it does this safely: it works on a `swarm/<run-id>` branch, refuses if your tree is dirty, uses its own git identity, and never pushes, force-pushes, or resets your work. Before the final report a single engine **green-gate** runs the real build+typecheck+test once; if the tree is red it hands the exact failures back to the conductor for a focused fix. The deliverable is a **working tree plus a PR-style change summary** (files changed, how to build & run, test evidence, what's left) — not a prose report. `--accept "done when …"` pins acceptance criteria, `--greenfield` forces a from-scratch build, `--no-gate` / `--no-commit` opt out of the gate or the auto-commits. **As of 0.22.0** the engine also pins a validated module/file **BuildPlan** before fan-out, authors a **failing spec test-suite** from the acceptance criteria so the gate is a real oracle (not "it compiles"), injects a **repo symbol-map** into every worker, runs hard tasks as a **best-of-N ensemble** in isolated git worktrees, **repairs** a red gate with its own targeted fix task, runs an **adversarial diff-review** of the change once green, and carries **cross-run repo memory** — see [docs/code-mode.md](docs/code-mode.md).
- **Forecast mode** (`swarm forecast "<question>" --by 2026-12-31`) turns a question about the future into a calibrated probability. The question is sharpened into a resolvable claim, research waves gather counted base rates and live data (prediction markets, FRED/World Bank/Yahoo time series), and an independent panel forecasts with distinct methods — outside view, inside view, trend, market-anchored — plus an engine-run probe that argues the inverted question. Aggregation is deterministic math (extremized geometric mean of odds, scaled down when panelists cite the same sources), every forecast lands in a ledger, `swarm resolve` grades it against reality (Brier/log scores), and your calibration record feeds back into future panels. **Open-ended questions** ("what will happen with X in 2026?") fan out into several independently-resolvable sub-forecasts, each with its own panel and ledger entry, then a synthesized answer that ties them together — `--single` forces one. A grounded **scenario simulation** (`--simulate`, automatic on decomposed questions) then runs tens of thousands of correlated Monte Carlo "worlds" over the sub-forecasts as drivers — producing ranked scenarios, a driver tornado, and a bottom-up cross-check of the headline that starts at zero influence and only earns weight on the resolved ledger, like every other learned layer. **Sports games** are a special case the engine owns: name both teams of a real upcoming game and it decomposes it into winner, combined total, and margin of victory — each anchored to the sharp sportsbook line (de-vigged moneyline, median spread/total across books, via the free Odds API) and resolved straight from the official box score, then scored against the line itself (Brier vs the moneyline, pinball vs the line, closing-line value).
- **Domain packs** make forecasting general-purpose. The engine detects what kind of question you're asking — **finance** (a ticker closing above a price), **macro** (rates/inflation/unemployment), **construction** (project delivery), **elections**, **business**, or **sports** — and builds a model custom to it: a data-grounded Monte Carlo from the option market's own probability + an OLS price trend + a volatility regime for finance; milestone decomposition into a schedule-risk model for construction; FRED-series trends for macro. Each domain **learns its own calibration** (every parameter fits on that domain's resolved history, backing off to the global fit when thin), gathers **structured data** beyond headlines — SEC EDGAR fundamentals & filings, federal contracts (USAspending), BLS/EIA, prediction markets, FRED/Yahoo/options — and resolves *exactly* where ground truth exists (a finance close, a macro print). Anything no pack claims takes the same generic panel+research path as before.
- **Save and reuse a model.** Any forecast setup — domain + tunables — can be saved and re-applied from the composer's dropdown; a **frozen** model also captures the learned fit (recalibration, weights, dilation) so a run is reproducible and shareable, while a **live** one re-learns each run. Each saved model accrues its own track record. The forecast composer shows almost nothing by default — your question, the auto-detected domain (overridable), and a model picker — with every other knob behind an Options disclosure, scoped to the detected domain.
- You can steer a live run. `swarm note <id> "skip the pricing section"` and the conductor re-plans on its next tick.
- Workers get real tools: shell, file read/write/patch, web search and fetch, the blackboard, and an artifacts folder that lands on your disk. Search fans out across DuckDuckGo + Bing (free) plus TinyFish and context.dev when keyed (agents can pass `deep=true` when they need grounded sources with quotable passages).
- Styled deliverables, no hand-written HTML: agents save markdown under a `.html` artifact name and the engine renders it into a clean, self-contained document (typography, tables, dark mode) — with ` ```chart ` blocks for inline SVG line/bar/donut charts and stat cards. Stock analyses, crypto dashboards, and research reports all come out in one house style.
- The web UI streams every tool call live, counts distinct web sources in real time (run header, per-task badges), and renders the final report plus an Artifacts tab grouped by folder. Each task gets a deterministic name and pixel avatar so you can tell agents apart at a glance. **Forecast runs visualize the whole structure as it computes** — the headline probability or range with the panel spread and the engine's full derivation chain (`GMO → extremized → ⚓ market → recalibrated → sim`), the sub-forecast decomposition (every facet with its own headline, distribution, and matched sportsbook line), and the grounded scenario simulation as a driver tornado, ranked scenarios, and a coherence verdict against the panel — all reconstructed live from the run's event stream, no report wait.
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
| `swarm config [list\|get\|set\|unset\|path]` | Manage `~/.agentswarm/config.json` — set/unset keys (e.g. `swarm config unset firecrawlApiKey`); `path` prints the file location. |
| `swarm models` | List models from the active provider. |
| `swarm demo [--mission "..."]` | Run a self-contained demo mission in an isolated workspace (`--mission` overrides the canned prompt). |
| `swarm code "<build task>" [--accept "<done when>"] [--greenfield] [--no-gate] [--no-commit]` | Code (build) mission: recon the repo's real build/test commands → scaffold → implement on disjoint files → integration task runs the full build+test → engine green-gate before ship. Commits on green so an interrupt resumes compiling (on a real `--cwd`: works on a `swarm/<run-id>` branch, refuses if dirty, never pushes/resets). Deliverable is a working tree + PR-style change summary. `swarm build` is an alias. |
| `swarm forecast "<question>" [--by YYYY-MM-DD] [--panel N] [--single] [--simulate]` | Forecast mission: sharpened question → research → independent panel → aggregated probability + ledger entry. Open-ended questions fan out into several resolvable sub-forecasts; `--single` forces one. A head-to-head sports matchup decomposes into winner/total/margin, each anchored to the sportsbook line and resolved from the box score (needs `oddsApiKey`). `--simulate` runs the grounded scenario Monte Carlo (auto on decomposed questions): ranked scenarios + a driver tornado, as a cross-check that earns headline weight only on the resolved ledger. |
| `swarm forecasts [watch] [--reforecast]` | List the forecast ledger (open + resolved). `watch` re-checks each open forecast's update triggers; `--reforecast` re-runs questions whose triggers fired (the new forecast supersedes the stale one). |
| `swarm tournament [--count 10] [--close-within 14] [--source all] [--dry-run] [--auto]` | Batch-forecast open market questions (Manifold/Polymarket/Kalshi keyless, Metaculus keyed) that close soon — grows the calibration ledger fast, with the source platform supplying ground-truth resolution. `--auto` also resolves due forecasts (cron-friendly). |
| `swarm resolve [set <id> <outcome>]` | Resolve due forecasts: tournament questions via the source platform's API, the rest with mini-agents (a second independent resolver checks medium-confidence verdicts). `set` overrides manually (`yes\|no\|void`, a number, an mc option, a date, or `never`). |
| `swarm calibration` | Brier/log scores, calibration bins, and per-method track record from resolved forecasts — plus a "sports vs the market" verdict (Brier vs the moneyline, pinball vs the line, closing-line value) and an outside-view discipline check (do the panel's deviations from its committed base-rate prior actually pay off?). |
| `swarm refclass [seed\|list]` | `seed` imports a bundled, provenance-documented corpus of counted historical base rates (construction overruns, business survival, recession frequency, incumbency) so the outside-view drivers are live on day one — idempotent, keeps your own resolutions. `list` shows the current counted classes. |
| `swarm sports close` | Capture the closing sportsbook line for open games near tip-off — the CLV baseline. Cron-friendly (every ~15 min); needs `oddsApiKey`. |
| `swarm backtest` | Replay the resolved ledger under each aggregation strategy (adaptive k + method weights, market anchor, recalibration, beta-calibration alt — fitted **time-respecting** out-of-fold) with bootstrap CIs, plus the swarm-vs-market skill line. Separate tables for numeric/date intervals (LOP vs Vincent vs learned/asymmetric dilation, scored by pinball + coverage), multiple-choice (kMc + mc recalibration), and a walk-forward **projector gate** (OLS vs random-walk-with-drift vs damped trend on your stored series). Deterministic, no tokens. |

Run options (also on the UI launch form under Options): `--workers N` (parallelism, 1–256), `--tasks N`, `--steps N` (tool steps per task), `--budget N` (token cap), `--model`, `--conductor`, `--verify off|normal|strict`, `--effort low|medium|high|max`, `--no-thinking`, `--no-safe` (disable command/path safety guards — careful), `--simulate` (force the grounded scenario simulation), `--sandbox host|docker|e2b|modal|vercel|auto` (shell runtime for this run), `--cwd <path>` (run against a real directory instead of an isolated workspace), `--mode research|forecast`, `--fg` (foreground in this process).

## Configuration & Guides

All API keys and settings can be configured via the web UI (Settings tab) or the CLI. Keys are stored locally in `~/.agentswarm/config.json` and never shared unless sent to their respective APIs.

**Quick setup**:
```bash
swarm serve --open                        # opens http://localhost:7777
# Go to Settings, paste your API keys, click Save. Changes persist.
```

**Detailed guides**:
- **[docs/code-mode.md](docs/code-mode.md)** — Code (build) mode end to end: the engine-owned BuildPlan, TDD spec oracle, repo symbol-map, best-of-N worktree ensemble, engine-driven repair, adversarial diff-review, cross-run repo memory, and the honest-failure invariants — plus every `--no-*` flag.
- **[SETTINGS_UI_GUIDE.md](SETTINGS_UI_GUIDE.md)** — How to configure all API keys (model provider, TinyFish, Firecrawl, context.dev, deepcrawl, sandbox runtimes) via the web UI. Explains persistence, test buttons, and clearing keys.
- **[CONTEXT_DEV_SETUP.md](CONTEXT_DEV_SETUP.md)** — Complete context.dev integration guide, troubleshooting, API testing, and diagnostics endpoints.

**Key integrations**:
- **Model providers**: Anthropic, OpenAI, xAI, MiniMax, OpenRouter, Ollama, LM Studio, or any OpenAI-compatible endpoint. Multi-provider support — switch anytime without losing keys.
- **Web search**: Built-in DuckDuckGo + Bing (free), optional TinyFish, optional context.dev Web Search (relevance-ranked, joins the fan-out automatically when keyed; deep mode uses its server-side query fan-out).
- **Crawl backends**: Firecrawl, context.dev (default in auto mode), or custom deepcrawl. Used by `crawl_site` tool and `fetch_url` upgrades.
- **Sandboxes**: Host (default), Docker, E2B, Modal, Vercel. Each settable per run or as your default.
- **Forecast data**: Manifold, Polymarket, Kalshi, and PredictIt odds keyless; Metaculus joins when a free API token is set (`metaculusApiKey`), and sportsbook lines when an Odds API key is set (`oddsApiKey`, free tier) — Shin-de-vigged h2h consensus in `market_odds` (the Shin method corrects the favorite-longshot bias proportional normalization leaves in), the `sports_odds` tool (de-vigged moneyline + spread + total for one game), and the engine's market-anchored decomposition of a game into winner/total/margin (resolved from the box score via `/scores`, CLV-tracked with `swarm sports close`). Time series from FRED (free `fredApiKey`, plus plain-word aliases like `unemployment`/`cpi`/`fedfunds`/`10y`/`lumber`/`vix`), World Bank, Yahoo Finance (incl. futures: `CL=F`, `LBS=F`, `HG=F`), **SEC EDGAR XBRL fundamentals** (`secfacts`, e.g. `AAPL:Revenues` — keyless), **USAspending** federal contract obligations (keyless), **BLS** employment/wages and **EIA** energy (optional free keys, `blsApiKey`/`eiaApiKey`), GDELT news volume and tone, Wikipedia daily pageviews (a public-attention leading indicator), Open-Meteo weather (forecast + ERA5 archive for counted weather base rates), and NWS US point forecasts — all keyless unless noted. The `data_feed` tool returns SEC filing lists and company profiles; `options_implied` converts Yahoo option chains into price-threshold probabilities (implied vol interpolated to the target date in total-variance space; the tool reports the market's risk-neutral price, while the engine's own driver applies a real-world drift); `wiki_tables` extracts Wikipedia polling/base-rate tables; `wiki_summary` grounds an entity fast. Fetched series are cached and accumulate across runs (size-bounded), and resolved outcomes accumulate into a reference-class store so a domain reads a *counted*, Jeffreys-smoothed base rate, not a guess — seed a provenance-documented starter corpus with `swarm refclass seed` so the outside view is live before your own ledger fills. Panel size, extremization k, the coherence probe, the market-anchor weight, the sports-line weight, open-ended decomposition, the sub-forecast cap, and the scenario simulation are all configurable (`forecastPanelSize`, `forecastExtremizeK`, `forecastCoherenceProbe`, `forecastMarketWeight`, `forecastSportsMarketWeight`, `forecastDecompose`, `forecastMaxSubQuestions`, `forecastSimulate`) via CLI or the Settings UI.

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

**Forecasting.** `swarm forecast` is built to resist the failure mode where a model reads recent headlines and calls it analysis — the counters are mechanical, in the engine, not requests in a prompt. Every binary forecaster must commit a base-rate prior (what its reference classes alone imply) before weighing current evidence, and a mechanical gate rejects forecasts with no prior, no reference class, or no numbers in the rationale — they retry with specific feedback. Panelists are independent by construction: blanked blackboard, peer numbers withheld, distinct assigned methods. After the panel, the engine itself re-asks the question inverted ("estimate P(NO), argue NO first"), flips the answer, and folds it in — if P(YES) and 1−P(NO) disagree, that incoherence shows up in the spread. Aggregation is deterministic TypeScript, never an LLM: for binary questions, median plus an extremized geometric mean of odds, with the extremization scaled back by the panel's pairwise source overlap — blended across exact URLs and shared domains, because a panel that read one wire story is not five independent minds. Numeric and date forecasts combine the panel with a robust linear opinion pool — the mixture of the forecasters' predictive CDFs, so genuine disagreement about *where* the answer lies widens the interval instead of being averaged into false confidence (winsorized and recentered on the robust median, so one wild panelist still can't drag the center) — and then a calibration dilation widens the band to correct the chronic LLM habit of stating intervals that are too narrow — now **asymmetric**, widening each tail by its own learned factor so lopsided miscoverage is fixed on the side that needs it: a conservative default out of the box, re-learned per-tail from your resolved coverage once enough land. Trend claims are grounded by `time_series project_to`, which projects the series — **random-walk-with-drift by default** (it beats a linear extrapolation out-of-sample), with OLS and damped-trend available and a walk-forward `swarm backtest` gate that proves which generalizes best — and prints a real Student-t prediction interval that widens with extrapolation distance; every forecaster is told how many days remain in the question window. Forecasts persist to `~/.agentswarm/forecasts/ledger.jsonl`; `swarm resolve` grades them when reality answers, and once you have ten resolved forecasts the calibration block (including which methods score best) is injected into every future panel. With thirty, the extremization constant is re-fit from your own track record by golden-section search — against the estimator that is actually *served* (overlap-scaled and method-weighted), not a raw proxy, with multiple-choice questions getting their own exponent; with more, method weights tilt the ensemble toward the lenses that score, the market-anchor weight is re-learned (and the mechanical blend already discounts the share the panel's market-anchored lens carries, so a market the panelists consulted is never double-counted), and a two-parameter recalibration layer corrects systematic bias (now able to deflate even severe overconfidence; multiple-choice gets its own shared recalibration too) — every learned layer fitted **out-of-fold by a time-respecting expanding window** so future outcomes can't flatter it, partial-pooled per domain toward the global fit, and provable with `swarm backtest`, which replays binary, interval (numeric/date), and multiple-choice forecasts plus the trend-projector gate. Large research runs synthesize map-reduce (task groups pre-digested in parallel, full text always one `read_report` away) so nothing is lost to truncation. **Open-ended questions decompose**: ask "what will happen with X?" and the engine plans a handful of concrete sub-forecasts that jointly answer it, runs an independent panel for each, aggregates and ledgers them separately (so each resolves on its own date and feeds calibration), and writes one report that weaves them together. It echoes the plan it chose before running — `--single` forces a single forecast, `--by` pins the horizon. **Grounded scenario simulation** then closes the loop the decomposition opened: a panel that splits a question into sub-forecasts and recombines them only in prose has thrown away the joint structure. Instead the engine treats each grounded signal — a sub-forecast's aggregated distribution, the verified market price — as a random variable whose marginal is *already computed*, asks the model for the **structure only** (which drivers, how they combine into the outcome via a closed JSON combiner DSL, and which move together), and then does the math itself: tens of thousands of seeded, correlated Monte Carlo draws through a Gaussian copula (or, per domain, a fat-tailed Student-t copula so correlated shocks co-occur in the tails — finance uses it), each pushed through the combiner and rolled back into the same binary/interval/option representation the pipeline already speaks. The model never supplies a number — the catalog is engine-built and a grounding gate drops any driver or combiner leaf that points outside it, so the simulation is structurally unable to smuggle in a bare probability. Out of the same sample fall a **ranked scenario table** (the modal world is "the winning scenario"), a **driver tornado** (first-order sensitivity by correlation ratio η², so the condition that collapses the most uncertainty is visible), and a **bottom-up cross-check** against the top-down panel. Like the market anchor and recalibration before it, the simulation starts at **zero headline influence** and earns a capped blend weight only once thirty resolved simulated forecasts prove it helps — until then it explains the number without moving it. The report renders it as a "Scenario analysis" section with the scenario and tornado charts, and the live web UI shows the same driver tornado, ranked scenarios, and coherence verdict per sub-forecast as the run computes — not just after it finishes. Auto-on for decomposed questions, `--simulate` forces it. **Sports games** get their own engine-owned decomposition, on the principle that the sharp closing line is the most accurate public predictor of a game: name both teams of a real upcoming match and the engine builds three resolvable facets — winner, combined total, and favorite margin — anchors each to the sportsbook line (the Shin-de-vigged moneyline for the winner, the median spread/total mapped to quantiles through a per-sport game-to-game σ for the numerics; 3-way soccer books de-vig the draw too), and lets the panel move off the line only with a concrete, line-relevant edge. Resolution is the official box score (The Odds API `/scores`, matched on the stored event id so a team that plays twice in the window can't settle the wrong game) — never a web agent reading a live score. And the verdict is honest: `swarm calibration` scores the sports record *against the line it anchored to* — winner Brier vs the moneyline, total/margin pinball vs predicting the line itself, and closing-line value (did the forecast lead the line's open→close move, captured by `swarm sports close` near tip-off) — so "did we actually beat the market" is a number, not a claim. Classification is conservative: single-team totals, props, and binary cover/over-under bets fall through to the normal panel rather than being silently reshaped.

**Code (build) missions.** `swarm code` keeps the same conductor/worker/verify/synth machinery but swaps the doctrine, because a long build fails differently than a research sweep — it fails by fanning out before the repo is understood, by two agents editing one file, by shipping a tree that doesn't compile, and by losing a half-day's work to an interrupt. So before the conductor's first turn the engine **recons the working directory** in a single deterministic pass — language, package manager, framework, and the repo's actual `build` / `typecheck` / `test` / `lint` commands (it parses `package.json` scripts, `pyproject`/`Cargo`/`go.mod`/`Makefile`, and *rejects* watch/dev-server scripts that never terminate) — and threads those real commands into the conductor's doctrine and every worker's prompt. The build doctrine replaces "parallelize aggressively, go wide with scouts" with **recon → scaffold → implement on strictly disjoint files → integrate → green-gate → ship**: one scaffold task first, then parallel implementers that each own a disjoint set of files, then an integration task (`verify:true`) that runs the full build+test and only reports done when green. Workers don't pipe raw test logs around — a `run_check` tool runs the detected command and returns a parsed `PASS 142/142` or `FAIL 3/142` with the first failures, so a broken test costs one step, not twenty. The engine **commits on green** after each passing verification (serialized, and only when no other task is mid-write, so a commit captures exactly the verified tree), which means an interrupted run resumes from a *compiling* commit instead of a torn working tree. On your real directory (`--cwd`) that commit path is deliberately conservative: it works on a `swarm/<run-id>` branch, refuses to auto-commit if your tree is dirty, uses its own git identity, never pushes/force-pushes/resets, and re-asserts those invariants on resume — and the one hard-reset-to-green that resume can do is restricted to isolated sandbox workspaces, never your files. Before the final report a single engine **green-gate** runs the real build+typecheck+test once against the quiesced tree; if it's red the conductor gets the exact failures and a bounded number of fix rounds, and if no test command exists the gate reports the tree *unverified* rather than pretending it passed. The deliverable the synthesizer writes is a **working tree plus a PR-style change summary** — files changed, how to build & run, the green-gate's test evidence verbatim, and what's left against the acceptance criteria — never a research essay. `--accept "done when …"` pins acceptance criteria into the living plan, `--greenfield` forces a from-scratch build, and `--no-gate` / `--no-commit` opt out of the gate or the auto-commits.

**Domain packs.** What sports made concrete — engine-owned decomposition, structured data, exact resolution — generalizes into a registry of domains. A pure, free matcher detects the domain (`finance`, `macro`, `construction`, `elections`, `business`, `sports`); only when every matcher abstains does one cheap LLM classifier run, and only over domains that opt in — so a sports question is byte-identical to before and a generic question is unchanged. A matched domain can build a **data-grounded Monte Carlo** instead of one panel guess: finance composes the option market's risk-neutral probability, an OLS price trend, and a VIX regime; construction decomposes a delivery question into milestone sub-forecasts (permits, funding, phase completion, schedule slip) that the simulation rolls into a schedule-risk model; macro grounds numerics in a real FRED series. It can also **auto-resolve from authoritative data** — a finance question from the closing price, a macro rate from the official print — never a web agent. Every learned layer is now fit **per domain**, with a two-level backoff (the domain's own resolved history → the global fit → the default), so a domain calibrates itself exactly where it has earned the data and is identical to the global behavior everywhere else; `swarm calibration` and the forecasts page show the per-domain track record. Resolved outcomes accumulate into a reference-class store (`~/.agentswarm/refstore/`) so a pack reads a *counted*, Jeffreys-smoothed base rate (a re-forecast of the same event counts once) rather than parsing one from prose — and `swarm refclass seed` makes it live from day one with a starter corpus. And any setup is **saveable as a reusable model** (domain + tunables); a *frozen* model additionally captures the learned fit verbatim for a reproducible, shareable run, while a *live* model re-learns each run — each accruing its own ledger track record. The precedence for every knob is explicit: an operator pin beats a frozen model beats the ledger-learned value beats the configured default.

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
  tools.ts      worker toolbelt (shell, files, web, blackboard, artifacts) + safety + grep/replace + run_check (code mode)
  codeintel.ts  code-mode repo intelligence: deterministic recon → RepoProfile (build/test/lint detection), check-output parsing, the validated BuildPlan partition (partitionWaves) + repo symbol-map, and the commit-on-green / worktree / branch-safety git primitives
  codeledger.ts cross-run repo memory: per-repo confirmed commands/conventions keyed by repo identity + manifest hash (bootstraps recon next run)
  webtools.ts   web search/fetch: SearchKit → TinyFish → DuckDuckGo fallback chain, with cooldowns + reformulation
  searchcore.ts search ranking (freshness boost, academic intent, primary-source up-rank) + academic engines (arXiv/Crossref/Semantic Scholar/PubMed)
  pdftext.ts    PDF text extraction (zero deps, zlib only)
  crawltools.ts crawl backend resolver (firecrawl/context.dev/deepcrawl)
  forecast.ts   forecast math (extremized GMO, quantiles, overlap-scaled k, golden-section + recalibration), per-domain calibration backoff, fitted-params snapshot, analytics gate, ledger, calibration (incl. by-domain), sports line→quantiles + "vs the market" stats, scenario driver catalog + grounding gate + ledger-fitted sim weight
  simulation.ts grounded scenario Monte Carlo: Gaussian/Student-t copula over driver marginals, combiner DSL, scenario clustering, correlation-ratio tornado, panel coherence check
  domains/      domain-pack registry (intent detect → decompose → data-grounded drivers → anchor → auto-resolve): sports, finance, macro, elections, construction, business
  refstore.ts   persistence: memoized + compacting series cache, long-TTL reference tables (e.g. SEC ticker→CIK), and a counted reference-class store
  models.ts     saved/reusable forecast models (tunables + frozen fitted-parameter artifact), track records derived from the ledger
  datatools.ts  market_odds (Manifold/Polymarket/Kalshi/PredictIt/Metaculus) + sportsbook lines & box scores (The Odds API: de-vig, sports_odds, /events + /scores) + time_series (FRED+aliases/World Bank/Yahoo/SEC XBRL/USAspending/BLS/EIA/GDELT/Wikipedia) with OLS prediction intervals + the data_feed tool (SEC filings/company)
  resolve.ts    forecast resolution: box-score settlement for sports, pack auto-resolution (finance close, macro print), mini-agents elsewhere (Brier/log scoring, audit files) + trigger watching
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
  e2e.js        31 phases covering the full pipeline, including citations + force + resume + budget + verify + teams + forecast + scenario simulation + code mode (brownfield, best-of-N ensemble, engine repair, honest-unverified, ensemble fallback, greenfield)
  unit/*.test.js individual suites for tools, crawl, memory, pdftext, webtools, searchcore, citations, forecast math, sports line anchoring + resolution, scenario simulation, and code mode (codeintel partition/repo-map, codeledger, lock-key normalization, resume reducer)
```

## Testing

```bash
node test/e2e.js
```

Boots a mock model server and drives real missions through the engine, offline, no API key needed. The happy path covers parallel execution, dependency order, tool calls, verification, and synthesis. The rest covers what goes wrong: bad keys fail loudly instead of producing a phantom run, interrupted runs resume without losing work, a tiny token budget still ends with a report, a failed verification retries with feedback and then passes, a live run can be steered with a note and cancelled, and agents compact their context when it grows too big. The forecast phase drives a full forecast mission — analytical-gate rejection and retry, the inverted-framing probe, overlap-scaled aggregation (every expected number re-derived from the shipped math, not hard-coded), ledger persistence, resolution scoring, and a grounded scenario simulation that records a durable cross-check (base ledger record + an `updated` patch carrying the scenario tornado) while provably leaving the headline untouched at weight 0. There's also a hub API phase and, when a docker daemon is reachable, a full run inside a container.

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

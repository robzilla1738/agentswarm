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
- Runs are built to go long. Each agent compacts its own context when it grows too big — thresholds adapt to each model's actual context window (`contextWindows` config) — and the conductor compacts its oldest turns in place before any history is dropped. A run-wide token budget is enforced mid-task; when it's hit, agents wrap up and report instead of dying mid-thought. Failed verifications retry with feedback. Every event lands in an append-only journal that survives crashes.
- Interrupted runs resume. `swarm resume <id>`, or a button in the UI, keeps completed work, re-runs whatever was in flight, and carries the token spend over.
- Runs execute in an isolated per-run workspace on your machine by default. Nothing extra to install, no daemon to start. Want stronger isolation? Run in a Docker container or an E2B/Modal/Vercel cloud sandbox, per run (`--sandbox docker`) or as your default (`swarm config set sandboxRuntime auto` picks the strongest one you've configured). `swarm sandbox test` boots whichever is active and tells you whether it works.
- Tasks flagged `verify` get a second agent whose whole job is to prove the first one wrong. Failures bounce back for a retry with the verifier's feedback attached.
- You can steer a live run. `swarm note <id> "skip the pricing section"` and the conductor re-plans on its next tick.
- Workers get real tools: shell, file read/write/grep, atomic single- or multi-edit patches, web search and fetch, the blackboard, and an artifacts folder that lands on your disk. Search is built in — multiple engines queried in parallel (plus TinyFish if you have a key), freshness-ranked, with automatic cooldowns and query reformulation when an engine rate-limits; agents pass `deep=true` when they need quotable passages. `academic_search` covers arXiv and Crossref with no key, and `fetch_url` reads PDFs, decodes charsets, flags paywalls, and fails loudly on error pages instead of feeding agents junk.
- Research runs end in a *cited* report. Workers report every source their findings rest on, those sources travel through dependency handoffs, and the final report ships inline `[n]` citations with a numbered, deduplicated bibliography. When sources disagree, workers flag the conflict instead of silently picking one.
- The web UI streams every tool call live and renders the final report. Each task gets a deterministic name and pixel avatar so you can tell agents apart at a glance. The run page has a Plan tab showing the conductor's living mission plan, a searchable blackboard with kind filters and source links, and a token-spend sparkline; the settings page can test your search and crawl backends in place and clear keys you no longer want stored.
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
| `swarm config [list\|get\|set\|unset …]` | Manage `~/.agentswarm/config.json`. Secrets are masked in `list`/`get`; `unset` resets a key to its default. |
| `swarm models` | List models from the active provider. |
| `swarm demo` | Run a self-contained demo mission in an isolated workspace. |

Run options (also on the UI launch form under Options): `--workers N` (parallelism), `--tasks N`, `--steps N` (tool steps per task), `--budget N` (token cap), `--model`, `--conductor`, `--verify off|normal|strict`, `--effort low|medium|high|max`, `--no-thinking`, `--sandbox host|docker|e2b|modal|vercel|auto` (shell runtime for this run), `--cwd <path>` (run against a real directory instead of an isolated workspace), `--fg` (foreground in this process).

## How it works

The conductor is a model with six tools: `spawn_tasks`, `set_phase`, `update_plan`, `read_report`, `wait`, and `finish`. It reads the mission, spawns self-contained tasks (each with an objective, success criteria, a role, optional dependencies, and an optional `verify` flag), then reacts as reports come back. On long missions it declares phases (`set_phase`) whose goals and exit criteria are pinned into every update — so the plan survives even when old history is trimmed and replaced by a mission ledger (settled tasks, decisions, current phase). On resume the ledger is re-seeded from the journal, so a restarted conductor knows everything its predecessor settled instead of starting from an empty memory.

Each task becomes an autonomous agent with a tool budget. It works in small steps, posts durable findings to the blackboard (decisions and source conflicts are never trimmed from digests; `search_notes` searches the full history), journals progress checkpoints on long tasks, saves artifacts, and ends by reporting back with structured handoff fields (`key_facts`, `open_questions`, `files_touched`, `sources`). Dependent tasks receive report excerpts plus those fields, and can pull full text with `read_report`.

**Scale.** A global AIMD limiter (`maxConcurrentCalls`) bounds concurrent model calls per endpoint — a 429 halves the ceiling, successes recover it, and conductor calls always jump the queue, so a 100-agent swarm degrades gracefully instead of melting down. Settles are debounced before waking the conductor; on big runs the task table collapses settled waves (failures stay itemized) and excess reports become one-liners the conductor can expand with `read_report`. Spawn specs take a `model` tier (`cheap` for scouts, `strong` for leads/verifiers via `cheapModel`/`strongModel` config) and `team:true` to run a task as a full sub-swarm — its own conductor decomposes it in parallel and reports one consolidated result, with all activity journaled under its `teamId`.

**Long horizon.** The conductor maintains a living `mission-plan.md` (`update_plan`) pinned into every update and restored on resume; every 25 settled tasks a progress snapshot lands in `artifacts/` so multi-day runs always have a partial deliverable; and real-directory runs leave a memory (`~/.agentswarm/memory/`) of missions, outcomes, and decisions that seeds the next swarm in the same workspace.

Verified tasks pass two gates: a free mechanical check (claimed artifacts must exist, be non-empty, and actually parse if they claim to be `.json`/`.csv`/`.html`), then a blind LLM verifier that judges the deliverables against the objective with its own tools — it never sees the worker's blackboard, but it does see the reports the task depended on, so it can catch contradictions with upstream work. Verdicts carry structured `issues` that flow into the retry prompt. In `--verify strict` mode a pass verdict must be backed by tool-gathered evidence — a verifier that approves without checking anything is re-run and told to prove it — and a completeness critic reviews the whole run for gaps before synthesis (the conductor gets one round to fill them), with the final report checked for faithfulness against the task reports.

The scheduler starts a task as soon as its dependencies are done, up to the parallelism cap. Tasks whose dependencies failed are blocked and surfaced to the conductor for re-planning — the whole downstream chain blocks in one pass, and each blocked task carries the *root* failure (which ancestor failed, and why), not just "dependency did not complete". Failed tasks also carry their last failing tool call as diagnostics, so the conductor re-plans around what actually went wrong.

When the conductor finishes (or the budget forces it), a synthesizer composes the final deliverable from every task report. Deliverables ship in the format the mission calls for — code, `.csv`/`.json` data, styled documents — alongside `final-report.md` and a self-contained `final-report.html` rendering (open it with `swarm report <id> --open`). Sources the workers reported are deduplicated into a numbered bibliography, and the synthesizer cites them inline as `[n]`.

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
  tools.ts      worker toolbelt (shell, files, web, blackboard, artifacts) + safety
  webtools.ts   web search/fetch: multi-engine search, arXiv/Crossref, PDF + paywall handling
  searchcore.ts ranking, dedup, passage extraction, freshness scoring
  crawltools.ts crawl/scrape backends (Firecrawl, context.dev, deepcrawl)
  pdftext.ts    dependency-free PDF text extraction (built-in zlib only)
  journal.ts    append-only crash-safe event log (single source of truth)
  state.ts      pure reducer: events → live run state
  hub.ts        localhost HTTP API + SSE + static UI server
  terminal.ts   live TTY dashboard
  cli.ts        command-line interface
ui/             Next.js 15 + Tailwind 4 web app (static-exported, served by the hub)
test/           e2e suite + unit suites, driven by a scripted mock model (no API key needed)
```

## Testing

```bash
npm test            # unit suites + e2e
node test/e2e.js    # just the e2e
```

The e2e boots a mock model server and drives real missions through the engine, offline, no API key needed. The happy path covers parallel execution, dependency order, tool calls, verification, and synthesis. The rest covers what goes wrong: bad keys fail loudly instead of producing a phantom run, interrupted runs resume without losing work, a tiny token budget still ends with a report, a failed verification retries with feedback and then passes, a live run can be steered with a note and cancelled, agents compact their context when it grows too big, failure cascades surface their root cause, strict mode forces a verifier to gather evidence, and worker sources end up cited in the final report. There's also a hub API phase and, when a docker daemon is reachable, a full run inside a container.

## Safety notes

- Safe mode is on by default. It blocks obviously destructive shell commands and confines writes to the working directory (symlink-safe — a link pointing outside the workspace doesn't get around it). `--no-safe` turns it off for a run; only do that when you trust the mission.
- The hub binds to localhost and rejects cross-origin requests, so a malicious web page you happen to have open can't drive your swarm.
- Runs default to an isolated per-run workspace on this machine. That's a private directory, not a container. Agents still execute with your user's permissions; the engine strips API keys and sandbox credentials from their environment, and safe mode constrains commands and writes. For untrusted or risky missions, use `--sandbox docker` or a cloud runtime.
- Use `--cwd <path>` (or Workspace → "A directory on disk" in the UI) to let agents touch a real project. Those runs always execute on the host, since touching your real files is the point.
- Costs are estimates based on list prices and the token counts the API reports. Models without pricing data show $0. Set a `--budget` either way.
- Keys are stored in `~/.agentswarm/config.json` (chmod 600) and are only sent to the APIs you configured.

## Author

Built by [Robert Courson](https://robertcourson.com). If agentswarm saves you time, you can [buy me a coffee](https://buymeacoffee.com/robcourson).

## License

MIT

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
        │Synthesize│  → final-report.md + artifacts
        └──────────┘
```

## What it does

- Independent tasks run at the same time, up to a parallelism cap you set. Dependent tasks start the moment their inputs are ready.
- Runs are built to go long. Each agent compacts its own context when it grows too big, and the conductor's history is bounded the same way. A run-wide token budget is enforced mid-task; when it's hit, agents wrap up and report instead of dying mid-thought. Failed verifications retry with feedback. Every event lands in an append-only journal that survives crashes.
- Interrupted runs resume. `swarm resume <id>`, or a button in the UI, keeps completed work, re-runs whatever was in flight, and carries the token spend over.
- Runs execute in an isolated per-run workspace on your machine by default. Nothing extra to install, no daemon to start. Want stronger isolation? Run in a Docker container or an E2B/Modal/Vercel cloud sandbox, per run (`--sandbox docker`) or as your default (`swarm config set sandboxRuntime auto` picks the strongest one you've configured). `swarm sandbox test` boots whichever is active and tells you whether it works.
- Tasks flagged `verify` get a second agent whose whole job is to prove the first one wrong. Failures bounce back for a retry with the verifier's feedback attached.
- You can steer a live run. `swarm note <id> "skip the pricing section"` and the conductor re-plans on its next tick.
- Workers get real tools: shell, file read/write/patch, web search and fetch, the blackboard, and an artifacts folder that lands on your disk. Search uses [SearchKit](https://github.com/robzilla1738/script-search) if it's installed (local, returns quotable passages; agents can pass `deep=true` when they need grounded sources), TinyFish if you have a key, DuckDuckGo otherwise.
- The web UI streams every tool call live and renders the final report. Each task gets a deterministic name and pixel avatar so you can tell agents apart at a glance.
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
| `swarm demo` | Run a self-contained demo mission in an isolated workspace. |

Run options (also on the UI launch form under Options): `--workers N` (parallelism), `--tasks N`, `--steps N` (tool steps per task), `--budget N` (token cap), `--model`, `--conductor`, `--verify off|normal|strict`, `--effort low|medium|high|max`, `--no-thinking`, `--sandbox host|docker|e2b|modal|vercel|auto` (shell runtime for this run), `--cwd <path>` (run against a real directory instead of an isolated workspace), `--fg` (foreground in this process).

## How it works

The conductor is a model with three tools: `spawn_tasks`, `wait`, and `finish`. It reads the mission, spawns self-contained tasks (each with an objective, success criteria, a role, optional dependencies, and an optional `verify` flag), then reacts as reports come back.

Each task becomes an autonomous agent with a tool budget. It works in small steps, posts durable findings to the blackboard, saves artifacts, and ends by reporting back. The report is the only thing the conductor sees, which keeps reports specific.

The scheduler starts a task as soon as its dependencies are done, up to the parallelism cap. Tasks whose dependencies failed are blocked and surfaced to the conductor for re-planning.

When the conductor finishes (or the budget forces it), a synthesizer composes `final-report.md` from every task report.

The journal is the source of truth. Every run is an append-only `events.jsonl`; the terminal dashboard, the web UI, and `swarm ls` all reduce the same file. That's why runs survive crashes and can be resumed or replayed. Runs live under `~/.agentswarm/runs/<id>/`.

If the engine process dies without writing a terminal status (kill -9, reboot), the hub notices the missing process and shows the run as interrupted instead of leaving it "running" forever.

## Architecture

```
src/                         TypeScript engine (zero runtime deps)
  deepseek.ts   streaming chat client (OpenAI-compatible; thinking mode, tool calls, retries)
  providers.ts  provider registry (DeepSeek/OpenAI/Anthropic/xAI/MiniMax/OpenRouter/Ollama/LM Studio)
  sandbox.ts    sandbox runtimes: host, docker, E2B, Modal, Vercel
  agent.ts      the agent loop: stream → tool calls → results → repeat, with compaction
  executor.ts   the orchestrator: conductor loop, parallel scheduler, verify, synth, budget
  tools.ts      worker toolbelt (shell, files, web, blackboard, artifacts) + safety
  webtools.ts   web search/fetch: SearchKit → TinyFish → DuckDuckGo fallback chain
  journal.ts    append-only crash-safe event log (single source of truth)
  state.ts      pure reducer: events → live run state
  hub.ts        localhost HTTP API + SSE + static UI server
  terminal.ts   live TTY dashboard
  cli.ts        command-line interface
ui/             Next.js 15 + Tailwind 4 web app (static-exported, served by the hub)
test/           end-to-end test with a scripted mock model (no API key needed)
```

## Testing

```bash
node test/e2e.js
```

Boots a mock model server and drives real missions through the engine, offline, no API key needed. The happy path covers parallel execution, dependency order, tool calls, verification, and synthesis. The rest covers what goes wrong: bad keys fail loudly instead of producing a phantom run, interrupted runs resume without losing work, a tiny token budget still ends with a report, a failed verification retries with feedback and then passes, a live run can be steered with a note and cancelled, and agents compact their context when it grows too big. There's also a hub API phase and, when a docker daemon is reachable, a full run inside a container.

## Safety notes

- Safe mode is on by default. It blocks obviously destructive shell commands and confines writes to the working directory. `--no-safe` turns it off for a run; only do that when you trust the mission.
- Runs default to an isolated per-run workspace on this machine. That's a private directory, not a container. Agents still execute with your user's permissions; the engine strips API keys and sandbox credentials from their environment, and safe mode constrains commands and writes. For untrusted or risky missions, use `--sandbox docker` or a cloud runtime.
- Use `--cwd <path>` (or Workspace → "A directory on disk" in the UI) to let agents touch a real project. Those runs always execute on the host, since touching your real files is the point.
- Costs are estimates based on list prices and the token counts the API reports. Models without pricing data show $0. Set a `--budget` either way.
- Keys are stored in `~/.agentswarm/config.json` (chmod 600) and are only sent to the APIs you configured.

## Author

Built by [Robert Courson](https://robertcourson.com). If agentswarm saves you time, you can [buy me a coffee](https://buymeacoffee.com/robcourson).

## License

MIT

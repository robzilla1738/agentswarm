# Changelog

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

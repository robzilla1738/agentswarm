import * as fs from "fs";
import * as path from "path";
import { estimateMessages, runAgent } from "./agent";
import { SwarmConfig, runDir } from "./config";
import { ControlReader } from "./control";
import { ChatMsg, ChatResult, chat, gateFor, isFatalAuthError, validateAuth } from "./deepseek";
import { JournalLike, TeamJournal } from "./journal";
import {
  CONDUCTOR_READ_REPORT_TOOL,
  SUBMIT_FINAL_TOOL,
  UPDATE_PLAN_TOOL,
  SET_PHASE_TOOL,
  SPAWN_TASKS_TOOL,
  WAIT_TOOL,
  FINISH_TOOL,
  REPORT_TOOL,
  VERDICT_TOOL,
  ToolCtx,
  synthToolset,
  verifierToolset,
  workerToolset,
} from "./tools";
import {
  budgetLine,
  completenessPrompt,
  conductorInitialUpdate,
  conductorSystem,
  conductorUpdate,
  depReportBlock,
  reportBlock,
  synthCheckPrompt,
  synthSystem,
  SYNTH_KICKOFF,
  taskTable,
  verifierSystem,
  VERIFIER_KICKOFF,
  workerSystem,
  WORKER_KICKOFF,
} from "./prompts";
import { appendMemory, memoryBlock } from "./memory";
import { renderFinalHtml } from "./report";
import { SandboxRuntime, createSandbox } from "./sandbox";
import { RunState } from "./state";
import { RunMeta, RunStatus, Task, TaskSpec, Usage, usageCost } from "./types";
import { clip, ensureDir, errMsg, oneLine, rid, sleep, truncateMiddle } from "./util";


export interface ExecutorOptions {
  /** "team": this executor orchestrates a sub-swarm for one parent task — no
   *  run lifecycle events, no sandbox boot, no synthesis; finish produces a
   *  consolidated report instead. */
  mode?: "root" | "team";
  teamId?: string;
  /** Injected by the parent in team mode (the team shares its sandbox). */
  sandbox?: SandboxRuntime;
  /** Forward usage to the parent so its budget stays the single truth. */
  onUsageForward?: (model: string, usage: Usage) => void;
  /** Parent's abort signal (team cancellation). */
  parentSignal?: AbortSignal;
  /** Share the parent's blackboard. */
  sharedNotes?: { taskId?: string; key?: string; kind?: string; text: string }[];
  /** Team mode: write into the parent's run directory (artifacts, control). */
  runDirPath?: string;
}

export class Executor {
  private cfg: SwarmConfig;
  private meta: RunMeta;
  private runDirPath: string;
  private journal: JournalLike;
  private control: ControlReader;
  private ac = new AbortController();

  private tasks = new Map<string, Task>();
  private taskOrder: string[] = [];
  private taskCounter = 0;
  private inflight = new Map<string, Promise<void>>();
  private settledSinceUpdate: string[] = [];
  private notes: { taskId?: string; key?: string; kind?: string; text: string }[] = [];
  private phase: { name: string; goal?: string; exitCriteria?: string } | null = null;

  private conductorMessages: ChatMsg[] = [];
  private spentTokens = 0;
  private cost = 0;
  private finishing = false;
  private finishNotes = "";
  private finishReason = "";
  private fatal: string | null = null;
  private lastConductorAction: "spawn" | "wait" | "finish" | "none" = "none";
  private conductorFailures = 0;
  /** True when the last conductor turn ended in a call error, not a decision. */
  private lastConductorErrored = false;
  private resumed = false;

  private sandbox: SandboxRuntime;
  private mode: "root" | "team";
  private teamId?: string;
  private opts: ExecutorOptions;
  /** Team-mode result: the consolidated report handed back to the parent task. */
  teamReport = "";

  constructor(cfg: SwarmConfig, meta: RunMeta, journal: JournalLike, opts: ExecutorOptions = {}) {
    this.cfg = cfg;
    this.meta = meta;
    this.runDirPath = opts.runDirPath ?? runDir(meta.id);
    this.journal = journal;
    this.control = new ControlReader(this.runDirPath);
    this.mode = opts.mode ?? "root";
    this.teamId = opts.teamId;
    this.opts = opts;
    if (opts.sharedNotes) this.notes = opts.sharedNotes;
    ensureDir(path.join(this.runDirPath, "artifacts"));
    if (opts.sandbox) {
      this.sandbox = opts.sandbox;
    } else {
      // "A directory on disk" runs always execute on the host — touching the
      // operator's real files is the entire point of that mode.
      const kind = meta.sandbox ? meta.options.sandboxRuntime ?? "host" : "host";
      this.sandbox = createSandbox(kind, { runId: meta.id, hostDir: meta.cwd, cfg });
    }
    if (opts.parentSignal) {
      if (opts.parentSignal.aborted) this.ac.abort();
      else opts.parentSignal.addEventListener("abort", () => this.ac.abort(), { once: true });
    }
  }

  cancel(): void {
    this.finishing = true;
    this.finishReason = "cancelled by operator";
    this.ac.abort();
  }

  /**
   * Seed orchestration state from a reduced journal (resume after an
   * interrupt). Settled tasks keep their results and never re-run; `resets`
   * are tasks that were in flight when the engine died — they go back to
   * pending and re-run from scratch. Token spend and cost carry over so the
   * run-wide budget stays a single honest number.
   */
  seedFromState(state: RunState, resets: string[]): void {
    const reset = new Set(resets);
    for (const t of state.taskList()) {
      const copy: Task = { ...t, deps: [...t.deps], artifacts: [...t.artifacts], agentIds: [...t.agentIds] };
      if (reset.has(copy.id)) {
        copy.status = "pending";
        copy.startedAt = undefined;
        copy.endedAt = undefined;
      }
      this.tasks.set(copy.id, copy);
      this.taskOrder.push(copy.id);
      const n = Number(/^T(\d+)$/.exec(copy.id)?.[1] ?? 0);
      this.taskCounter = Math.max(this.taskCounter, n);
    }
    this.notes = state.notes.map((n) => ({ taskId: n.taskId, key: n.key, kind: n.kind, text: n.text }));
    const lastPhase = state.phases[state.phases.length - 1];
    if (lastPhase) this.phase = { name: lastPhase.name, goal: lastPhase.goal, exitCriteria: lastPhase.exitCriteria };
    this.spentTokens = state.totalUsage.promptTokens + state.totalUsage.completionTokens;
    this.cost = state.cost;
    try {
      // The living plan survives restarts from disk, not from the journal.
      this.planDoc = fs.readFileSync(path.join(this.runDirPath, "artifacts", this.planFileName()), "utf8");
    } catch {
      /* no plan yet */
    }
    this.resumed = true;
  }

  private setStatus(status: RunStatus, reason?: string): void {
    // A team is one task of the parent run, not a run of its own.
    if (this.mode === "team") return;
    this.journal.append("run.status", { status, reason });
  }

  private budgetWarned = new Set<number>();

  private onUsage = (model: string, usage: Usage) => {
    this.spentTokens += usage.promptTokens + usage.completionTokens;
    this.cost += usageCost(usage, this.cfg.pricing[model]);
    this.journal.append("usage", { model, usage, cost: this.cost });
    // Team spend also counts against the parent's (authoritative) budget.
    this.opts.onUsageForward?.(model, usage);
    const cap = this.meta.options.maxTokens;
    if (cap > 0) {
      const pct = (this.spentTokens / cap) * 100;
      for (const threshold of [50, 80, 95]) {
        if (pct >= threshold && !this.budgetWarned.has(threshold)) {
          this.budgetWarned.add(threshold);
          this.journal.append("log", {
            level: threshold >= 95 ? "warn" : "info",
            msg: `budget: ${threshold}% of the run's token cap used (est. $${this.cost.toFixed(2)})`,
          });
        }
      }
    }
  };

  private budgetExceeded(): boolean {
    return this.spentTokens >= this.meta.options.maxTokens;
  }

  private blackboardDigest(max = 1800): string {
    if (!this.notes.length) return "";
    const fmt = (n: (typeof this.notes)[number]) =>
      `• ${n.kind && n.kind !== "finding" ? `[${n.kind}] ` : ""}${n.key ? `[${n.key}] ` : ""}${oneLine(n.text, 160)}${n.taskId ? ` (${n.taskId})` : ""}`;
    // Decisions anchor mission-wide coherence and are never trimmed out of the
    // digest; everything else shows only its recent tail.
    const decisions = this.notes.filter((n) => n.kind === "decision").map(fmt);
    const rest = this.notes.filter((n) => n.kind !== "decision").slice(-80).map(fmt);
    let tail = rest.join("\n");
    const budget = Math.max(400, max - decisions.join("\n").length);
    if (tail.length > budget) tail = tail.slice(tail.length - budget);
    return [decisions.join("\n"), tail].filter(Boolean).join("\n");
  }

  private searchNotes(query: string): string {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return "empty query";
    const scored = this.notes
      .map((n) => {
        const hay = `${n.key ?? ""} ${n.kind ?? ""} ${n.text}`.toLowerCase();
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
        return { n, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (!scored.length) return "no notes matched";
    return scored
      .map(({ n }) => `• ${n.kind ? `[${n.kind}] ` : ""}${n.key ? `[${n.key}] ` : ""}${clip(n.text, 400)}${n.taskId ? ` (${n.taskId})` : ""}`)
      .join("\n");
  }

  // ---------------------------------------------------------------- main

  async run(): Promise<void> {
    this.setStatus("planning");

    if (this.mode === "root") {
      // Surface AIMD limiter adjustments (429 pressure) in the journal/UI.
      gateFor(this.cfg).onState = (s) => {
        this.journal.append("limiter.state", { ceiling: s.ceiling, active: s.active, queued: s.queued });
      };

      // Preflight: validate auth before doing any work so the operator gets an
      // instant, clear error instead of a phantom "done" run. (Teams inherit a
      // parent that already passed.)
      const auth = await validateAuth(this.cfg);
      if (auth.status === "invalid") {
        this.fatal = `Provider authentication failed — ${auth.message || "invalid API key"}. Set a valid key in Settings (or: swarm config set apiKey <...>).`;
        this.finishReason = this.fatal;
        this.journal.append("log", { level: "error", msg: this.fatal });
        await this.fail(this.fatal);
        return;
      }

      // Boot the sandbox before any work — a dead Docker daemon or a bad cloud
      // key must fail the run instantly with a clear reason, not mid-mission.
      // (Teams share the parent's already-running sandbox.)
      try {
        await this.sandbox.start((msg) => this.journal.append("log", { level: "info", msg }));
        this.journal.append("log", { level: "info", msg: `sandbox: ${this.sandbox.label}` });
      } catch (e) {
        this.fatal = `Sandbox failed to start — ${errMsg(e)}`;
        this.finishReason = this.fatal;
        this.journal.append("log", { level: "error", msg: this.fatal });
        await this.fail(this.fatal);
        return;
      }
    }

    // Operator control must land while agents are mid-task, not only when the
    // scheduler wakes up — a Stop click aborts in-flight work within ~1s.
    const controlTimer = setInterval(() => {
      try {
        this.drainControl();
      } catch {
        /* control polling must never kill the run */
      }
    }, 750);

    // Real-directory runs remember: prior missions in the same workspace feed
    // the conductor so it builds on settled decisions instead of starting cold.
    const memory = this.mode === "root" && !this.meta.sandbox ? memoryBlock(this.meta.cwd) : "";
    this.conductorMessages = [
      { role: "system", content: conductorSystem(this.meta) + (memory ? `\n\n${memory}` : "") },
      {
        role: "user",
        content: this.resumed
          ? conductorUpdate({
              blackboard: this.blackboardDigest(),
              nextId: this.nextId(),
              taskTable: taskTable(this.taskList()),
              budgetLine: budgetLine({ total: this.spentTokens, cost: this.cost }, this.meta.options.maxTokens),
              extra:
                "This run was interrupted (engine restart) and has just been RESUMED. " +
                "The task table above is the current truth: completed tasks keep their results; " +
                "tasks that were in flight were reset to pending and will re-run automatically. " +
                "Spawn tasks only if the plan has a gap — otherwise wait.",
            })
          : conductorInitialUpdate(this.meta, this.nextId()),
      },
    ];

    try {
      await this.conductorTurn();
      this.setStatus("running");
      await this.mainLoop();
      // Strict verification: one completeness review before synthesis; if it
      // finds real gaps the conductor gets one chance to fill them.
      if (await this.completenessPass()) await this.mainLoop();
    } catch (e) {
      if (!this.ac.signal.aborted) {
        this.journal.append("log", { level: "error", msg: `executor error: ${errMsg(e)}` });
        this.finishReason = this.finishReason || `error: ${errMsg(e)}`;
      }
    }

    clearInterval(controlTimer);

    // Drain any still-running tasks before synthesis (cancellation aborts them).
    if (this.inflight.size) {
      await Promise.allSettled([...this.inflight.values()]);
    }
    this.drainSettled();

    if (this.mode === "team") {
      await this.consolidateTeam();
      return; // the parent owns the sandbox, final flush, and run status
    }

    await this.synthesize();
    // Teardown is best-effort AND bounded — a wedged container must not hang
    // the engine after the report is already written.
    await Promise.race([
      this.sandbox.destroy().catch(() => {}),
      new Promise((r) => setTimeout(r, 15_000).unref()),
    ]);
    await this.journal.flush();
  }

  // ---------------------------------------------------------------- teams

  /** All artifacts reported by this (team) executor's tasks. */
  teamArtifacts(): string[] {
    return [...new Set(this.taskList().flatMap((t) => t.artifacts))];
  }

  /** Whether any task here actually completed. */
  anyTaskDone(): boolean {
    return this.taskList().some((t) => t.status === "done");
  }

  /** Team-mode finale: one consolidated report instead of run synthesis. */
  private async consolidateTeam(): Promise<void> {
    const tasks = this.taskList();
    const reports = tasks.length ? tasks.map(reportBlock).join("\n\n") : "(no tasks were completed)";
    try {
      const res = await chat(this.cfg, {
        model: this.meta.options.conductorModel,
        priority: "high",
        messages: [
          {
            role: "user",
            content:
              `You led a sub-team inside a larger agent swarm. Consolidate your team's work into ONE report for the parent conductor: what was accomplished (with evidence and exact paths), what failed or remains open, and the key facts the rest of the mission needs.\n\nTEAM OBJECTIVE\n${this.meta.mission}\n\nOUTCOME: ${this.finishReason || "completed"}\nLead's closing notes: ${this.finishNotes || "(none)"}\n\nTASK REPORTS\n${truncateMiddle(reports, 60_000, "chars")}\n\nReply with the consolidated report only.`,
          },
        ],
        thinking: false,
        maxTokens: 4096,
        signal: new AbortController().signal, // consolidation runs even when cancelled
      });
      this.onUsage(this.meta.options.conductorModel, res.usage);
      this.teamReport = (res.content || "").trim();
    } catch (e) {
      this.journal.append("log", { level: "warn", msg: `team consolidation failed: ${errMsg(e)}` });
    }
    if (!this.teamReport) {
      this.teamReport = tasks
        .map((t) => `${t.id} [${t.status}] ${t.title}: ${oneLine(t.report ?? t.error ?? "(no output)", 200)}`)
        .join("\n");
    }
  }

  /** Run a team:true task as a sub-swarm sharing this run's everything. */
  private async runTeam(task: Task): Promise<void> {
    const remaining = Math.max(0, this.meta.options.maxTokens - this.spentTokens);
    const childMeta: RunMeta = {
      ...this.meta,
      mission: `${task.objective}${task.context ? `\n\nContext from the parent conductor:\n${task.context}` : ""}`,
      options: {
        ...this.meta.options,
        maxWorkers: task.teamMaxWorkers || Math.max(2, Math.min(16, Math.floor(this.meta.options.maxWorkers / 2))),
        maxTokens: Math.min(remaining, task.teamBudgetTokens || Math.max(50_000, Math.floor(remaining / 4))),
        maxTasks: Math.min(this.meta.options.maxTasks, 24),
      },
    };
    this.journal.append("team.created", {
      taskId: task.id,
      maxWorkers: childMeta.options.maxWorkers,
      budgetTokens: childMeta.options.maxTokens,
    });
    const child = new Executor(this.cfg, childMeta, new TeamJournal(this.journal, task.id), {
      mode: "team",
      teamId: task.id,
      sandbox: this.sandbox,
      runDirPath: this.runDirPath,
      onUsageForward: (model, usage) => {
        // Absorb tokens/cost only — the child already journaled the usage event.
        this.spentTokens += usage.promptTokens + usage.completionTokens;
        this.cost += usageCost(usage, this.cfg.pricing[model]);
      },
      parentSignal: this.ac.signal,
      sharedNotes: this.notes,
    });
    await child.run();
    if (this.ac.signal.aborted) {
      this.finalizeTask(task, "failed", "run cancelled");
      return;
    }
    const report = child.teamReport || "(team produced no consolidated report)";
    for (const a of child.teamArtifacts()) if (!task.artifacts.includes(a)) task.artifacts.push(a);
    task.report = report;
    task.reportStatus = "done";
    this.journal.append("team.report", { taskId: task.id, report, artifacts: task.artifacts });
    this.journal.append("task.report", { taskId: task.id, status: "done", report, artifacts: task.artifacts });
    this.finalizeTask(task, child.anyTaskDone() ? "done" : "failed", report);
  }

  private async mainLoop(): Promise<void> {
      while (!this.finishing) {
        this.drainControl();
        if (this.finishing) break;
        if (this.budgetExceeded()) {
          this.finishing = true;
          this.finishReason = "token budget reached";
          break;
        }
        if (this.journal.degraded) {
          // The journal is the source of truth; if it can't be written, the
          // run must stop loudly rather than burn tokens on unrecorded work.
          this.finishing = true;
          this.finishReason = "journal writes are failing — run state is no longer durable";
          this.ac.abort();
          break;
        }

        this.startReadyTasks();

        if (this.inflight.size === 0) {
          const runnable = this.runnableTasks();
          if (runnable.length > 0) continue; // loop starts them
          // Nothing running, nothing runnable. Include any reports that
          // settled while the conductor was mid-turn — they must not be lost.
          this.blockStuckTasks();
          const reports = this.drainSettled();
          if (!this.hasOpenWork()) {
            // Everything is terminal. Ask the conductor for a final decision.
            this.appendConductorUpdate("All tasks have settled and no tasks are runnable.", reports);
            await this.conductorTurn();
            // An errored turn is not a decision — keep looping so the breaker
            // can retry (and eventually trip) instead of misreading the error
            // as "the conductor chose to stop".
            if (this.lastConductorAction !== "spawn" && !this.lastConductorErrored) {
              this.finishing = true;
              this.finishReason = this.finishReason || "all tasks settled";
            }
          } else {
            // Stuck: pending tasks exist but can't run (failed/blocked deps).
            this.appendConductorUpdate(
              "Some tasks cannot run because their dependencies failed or were blocked. Re-plan around them or finish.",
              reports
            );
            await this.conductorTurn();
            if (this.lastConductorAction === "wait" && !this.lastConductorErrored) {
              this.finishing = true;
              this.finishReason = "stalled: dependencies unmet and conductor chose to wait";
            }
          }
          continue;
        }

        // Tasks are running — wait for at least one to settle, then debounce:
        // at 100 agents, settles arrive constantly, and waking the conductor
        // for every one of them serializes the whole swarm on its turns.
        await Promise.race([...this.inflight.values()]);
        const debounceMs = Number(process.env.SWARM_SETTLE_DEBOUNCE_MS ?? "2000");
        const settleCap = Math.max(3, Math.ceil(this.activeWorkerCount() / 8));
        while (debounceMs > 0 && this.inflight.size > 0 && this.settledSinceUpdate.length < settleCap) {
          const before = this.settledSinceUpdate.length;
          await Promise.race([...this.inflight.values(), sleep(debounceMs)]);
          if (this.settledSinceUpdate.length === before) break; // quiet period — flush to the conductor
          this.drainControl();
          if (this.finishing) break;
          this.startReadyTasks(); // settles free dep chains; don't idle workers during the debounce
        }
        this.drainControl();
        const reports = this.drainSettled();
        if (reports.length && !this.finishing) {
          this.appendConductorUpdate(undefined, reports);
          await this.conductorTurn();
        }
      }
  }

  /**
   * Strict-mode gap review before synthesis. Returns true when the conductor
   * accepted gap-filling work (the main loop must run again).
   */
  private gapPassDone = false;

  private async completenessPass(): Promise<boolean> {
    if (this.mode === "team") return false; // the root run owns gap review
    if (this.cfg.verification !== "strict" || this.gapPassDone) return false;
    if (this.fatal || this.ac.signal.aborted || this.budgetExceeded()) return false;
    if (this.finishReason.includes("cancel") || this.finishReason.includes("conductor unavailable")) return false;
    if (!this.taskList().some((t) => t.status === "done")) return false;
    this.gapPassDone = true;
    let verdict = "";
    try {
      const res = await chat(this.cfg, {
        model: this.meta.options.conductorModel,
        messages: [
          {
            role: "user",
            content: completenessPrompt(
              this.meta.mission,
              taskTable(this.taskList()),
              truncateMiddle(this.taskList().map(reportBlock).join("\n\n"), 80_000, "chars")
            ),
          },
        ],
        thinking: false,
        maxTokens: 2048,
        signal: this.ac.signal,
      });
      this.onUsage(this.meta.options.conductorModel, res.usage);
      verdict = (res.content || "").trim();
    } catch (e) {
      this.journal.append("log", { level: "warn", msg: `completeness review failed: ${errMsg(e)}` });
      return false;
    }
    if (!verdict || /^COMPLETE\b/i.test(verdict)) {
      this.journal.append("log", { level: "info", msg: "completeness review: no gaps found" });
      return false;
    }
    this.journal.append("log", { level: "info", msg: `completeness review found gaps:\n${clip(verdict, 1500)}` });
    this.finishing = false;
    this.appendConductorUpdate(
      `COMPLETENESS REVIEW found gaps before final synthesis:\n${clip(verdict, 2000)}\n` +
        "Spawn focused tasks to close the REAL gaps (or finish if you judge them immaterial). This is the final round."
    );
    await this.conductorTurn();
    if (this.lastConductorAction === "spawn") return true;
    this.finishing = true;
    this.finishReason = this.finishReason || "all tasks settled";
    return false;
  }

  // ---------------------------------------------------------------- conductor

  private nextId(): number {
    return this.taskCounter + 1;
  }

  private async conductorTurn(): Promise<void> {
    if (this.finishing) return;
    // Re-bound the history every turn — the nudge loop and tool-result pushes
    // below grow it outside appendConductorUpdate's trim.
    this.trimConductorHistory();
    const tools = [SPAWN_TASKS_TOOL, SET_PHASE_TOOL, UPDATE_PLAN_TOOL, CONDUCTOR_READ_REPORT_TOOL, WAIT_TOOL, FINISH_TOOL];
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: ChatResult;
      try {
        res = await chat(this.cfg, {
          model: this.meta.options.conductorModel,
          messages: this.conductorMessages,
          tools,
          // "auto" rather than "required" for cross-provider safety; the prompt
          // mandates a tool call and the no-tool nudge loop below enforces it.
          toolChoice: "auto",
          // The conductor is the swarm's brain: it must never queue behind a
          // hundred worker streams.
          priority: "high",
          thinking: this.meta.options.thinking,
          reasoningEffort: this.meta.options.reasoningEffort,
          // Generous: with thinking enabled, reasoning + a large spawn_tasks
          // batch can overflow a small cap and truncate the tool-call JSON.
          maxTokens: 16384,
          signal: this.ac.signal,
          onDelta: () => {},
        });
      } catch (e) {
        if (this.ac.signal.aborted) return;
        const msg = errMsg(e);
        this.journal.append("log", { level: "error", msg: `conductor call failed: ${msg}` });
        if (isFatalAuthError(e)) {
          // No point continuing — every call will fail the same way.
          this.fatal = `Provider authentication failed — ${msg}. Set a valid key in Settings.`;
          this.finishing = true;
          this.finishReason = this.fatal;
          return;
        }
        // Circuit breaker: a transient failure degrades to "wait" so the loop
        // keeps draining tasks, but repeated consecutive failures must end the
        // run with a clear reason rather than spin forever.
        this.conductorFailures++;
        if (this.conductorFailures >= 5) {
          this.finishing = true;
          this.finishReason = `conductor unavailable: ${this.conductorFailures} consecutive call failures (last: ${msg})`;
          return;
        }
        const scale = Number(process.env.SWARM_BACKOFF_SCALE || "1") || 1;
        const backoff = [2_000, 5_000, 15_000, 30_000][Math.min(this.conductorFailures - 1, 3)] * scale;
        await new Promise((r) => setTimeout(r, backoff));
        this.lastConductorAction = "wait";
        this.lastConductorErrored = true;
        return;
      }
      this.conductorFailures = 0;
      this.lastConductorErrored = false;
      this.onUsage(this.meta.options.conductorModel, res.usage);

      if (res.content.trim()) this.journal.append("conductor.say", { text: clip(res.content, 4000) });

      if (res.toolCalls.length === 0) {
        this.conductorMessages.push({ role: "assistant", content: res.content, reasoning_content: res.reasoning });
        this.conductorMessages.push({
          role: "user",
          content: "Respond only by calling spawn_tasks, wait, or finish.",
        });
        continue;
      }

      this.conductorMessages.push({
        role: "assistant",
        content: res.content || null,
        reasoning_content: res.reasoning,
        tool_calls: res.toolCalls,
      });

      let acted: typeof this.lastConductorAction = "none";
      for (const call of res.toolCalls) {
        const args = safeArgs(call.function.arguments);
        let toolResult = "ok";
        if (call.function.name === "spawn_tasks") {
          toolResult = this.handleSpawn(args);
          acted = "spawn";
        } else if (call.function.name === "finish") {
          this.finishing = true;
          this.finishNotes = String(args.notes ?? "");
          this.finishReason = this.finishReason || "conductor declared mission complete";
          toolResult = "Acknowledged. Synthesizing the final deliverable.";
          acted = "finish";
        } else if (call.function.name === "update_plan") {
          const md = String(args.markdown ?? "");
          if (md.trim()) {
            this.planDoc = md;
            try {
              fs.writeFileSync(path.join(this.runDirPath, "artifacts", this.planFileName()), md, "utf8");
            } catch (e) {
              this.journal.append("log", { level: "warn", msg: `plan write failed: ${errMsg(e)}` });
            }
            this.journal.append("plan.updated", { teamScoped: this.mode === "team" || undefined, excerpt: clip(md, 1200) });
            toolResult = `Plan saved to artifacts/${this.planFileName()}.`;
          } else {
            toolResult = "Plan was empty — not saved.";
          }
          // Bookkeeping, not a scheduling decision — falls through to the nudge.
        } else if (call.function.name === "read_report") {
          toolResult = truncateMiddle(this.readReportText(String(args.task_id ?? "")), 8000, "chars");
          // Information lookup, not a scheduling decision — falls through to
          // the nudge loop if the conductor stopped here.
        } else if (call.function.name === "set_phase") {
          const name = clip(String(args.name ?? ""), 80);
          this.phase = {
            name,
            goal: args.goal ? String(args.goal) : undefined,
            exitCriteria: args.exit_criteria ? String(args.exit_criteria) : undefined,
          };
          this.journal.append("phase.set", { name, goal: this.phase.goal, exit_criteria: this.phase.exitCriteria });
          toolResult = `Phase set: ${name}. Now also call spawn_tasks, wait, or finish.`;
          // Not a scheduling decision by itself — fall through to the nudge
          // loop if the conductor stopped here.
        } else if (call.function.name === "wait") {
          toolResult = "Waiting for running tasks to report.";
          if (acted === "none") acted = "wait";
        } else {
          toolResult = `unknown tool ${call.function.name}`;
        }
        this.conductorMessages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
      if (acted === "none") {
        // set_phase (or an unknown tool) alone is not a scheduling decision —
        // ask again rather than letting the run misread it as "wait"/"finish".
        this.conductorMessages.push({ role: "user", content: "Now call spawn_tasks, wait, or finish." });
        continue;
      }
      this.lastConductorAction = acted;
      this.journal.append("conductor.action", { kind: acted });
      return;
    }
    // Conductor refused to use tools 3x — default to waiting.
    this.lastConductorAction = "wait";
  }

  private handleSpawn(args: Record<string, unknown>): string {
    const specs = Array.isArray(args.tasks) ? (args.tasks as TaskSpec[]) : [];
    if (!specs.length) return "No tasks provided.";
    const remaining = this.meta.options.maxTasks - this.tasks.size;
    if (remaining <= 0) {
      return `Task cap reached (${this.meta.options.maxTasks}). Consolidate or finish — no more tasks can be created.`;
    }
    const accepted = specs.slice(0, remaining);
    // Pre-assign ids so deps within this batch resolve.
    const batchIds: string[] = accepted.map(() => this.allocId());
    const created: string[] = [];
    const warnings: string[] = [];
    // One wave per spawn batch — computed before inserting, otherwise each
    // task would see its predecessor and claim a new wave of its own.
    const wave = this.currentWave();

    accepted.forEach((spec, i) => {
      const id = batchIds[i];
      // A dep may reference any existing task or an *earlier* task in this
      // batch. Self/later-batch references can never become runnable (cycle)
      // and would silently deadlock the run, so they are dropped loudly.
      const allowed = new Set([...this.tasks.keys(), ...batchIds.slice(0, i)]);
      const deps = [...new Set((spec.deps ?? []).map(String))].filter((d) => {
        if (allowed.has(d)) return true;
        const idx = batchIds.indexOf(d);
        warnings.push(
          `${id}: dropped dep "${d}" (${idx >= i ? "same-batch later task — would deadlock" : "unknown task"})`
        );
        return false;
      });
      const rawSpec = spec as TaskSpec & { team_max_workers?: number; team_budget_tokens?: number };
      const task: Task = {
        id,
        title: clip(String(spec.title ?? "task"), 120),
        objective: String(spec.objective ?? spec.title ?? ""),
        role: (spec.role ? String(spec.role) : inferRole(spec)).toLowerCase(),
        deps,
        verify: Boolean(spec.verify) && this.cfg.verification !== "off",
        context: spec.context ? String(spec.context) : undefined,
        modelTier: ["cheap", "strong"].includes(String(spec.model)) ? (spec.model as Task["modelTier"]) : undefined,
        team: Boolean(spec.team) && this.mode === "root",
        teamMaxWorkers: Number(rawSpec.team_max_workers ?? rawSpec.teamMaxWorkers) || undefined,
        teamBudgetTokens: Number(rawSpec.team_budget_tokens ?? rawSpec.teamBudgetTokens) || undefined,
        status: "pending",
        attempt: 1,
        wave,
        artifacts: [],
        createdAt: Date.now(),
        agentIds: [],
      };
      this.tasks.set(id, task);
      this.taskOrder.push(id);
      created.push(id);
      this.journal.append("task.created", { task });
    });

    if (specs.length > accepted.length) {
      warnings.push(`only ${accepted.length}/${specs.length} accepted (task cap)`);
    }
    return `Created ${created.join(", ")}.${warnings.length ? " Notes: " + warnings.join("; ") + "." : ""}`;
  }

  private allocId(): string {
    this.taskCounter++;
    return `T${this.taskCounter}`;
  }

  private currentWave(): number {
    let w = 0;
    for (const t of this.tasks.values()) w = Math.max(w, t.wave);
    return w + 1;
  }

  /** The conductor's living plan document (mission-plan.md). */
  private planDoc = "";

  private planFileName(): string {
    return this.mode === "team" ? `mission-plan-${this.teamId}.md` : "mission-plan.md";
  }

  private planPin(): string | undefined {
    if (!this.planDoc) return undefined;
    return `MISSION PLAN (artifacts/${this.planFileName()}, maintained via update_plan):\n${clip(this.planDoc, 1500)}`;
  }

  private phaseLine(): string | undefined {
    if (!this.phase) return undefined;
    return `CURRENT PHASE: ${this.phase.name}${this.phase.goal ? ` — ${this.phase.goal}` : ""}${this.phase.exitCriteria ? ` (exit: ${this.phase.exitCriteria})` : ""}`;
  }

  /** Full text for the reports that matter, one-liners past the cap. */
  private digestReports(reports: Task[]): string[] {
    const CAP = 12;
    if (reports.length <= CAP) return reports.map(reportBlock);
    const important = reports.filter((t) => t.status !== "done");
    const done = reports.filter((t) => t.status === "done");
    const fullDone = done.slice(-Math.max(0, CAP - important.length));
    const briefDone = done.slice(0, done.length - fullDone.length);
    return [
      ...important.map(reportBlock),
      ...fullDone.map(reportBlock),
      ...briefDone.map(
        (t) => `── ${t.id} (${t.role}) "${clip(t.title, 60)}" → DONE — ${oneLine(t.report ?? "", 140)} (full text: read_report)`
      ),
    ];
  }

  private appendConductorUpdate(extra?: string, reports?: Task[]): void {
    const ops = this.consumeOperatorNotes();
    this.conductorMessages.push({
      role: "user",
      content: conductorUpdate({
        reports: reports ? this.digestReports(reports) : undefined,
        operatorNotes: ops,
        blackboard: this.blackboardDigest(),
        phase: this.phaseLine(),
        plan: this.planPin(),
        nextId: this.nextId(),
        taskTable: taskTable(this.taskList()),
        budgetLine: budgetLine({ total: this.spentTokens, cost: this.cost }, this.meta.options.maxTokens),
        extra,
      }),
    });
    // Keep the conductor's own history from growing without bound.
    this.trimConductorHistory();
  }

  /**
   * One-screen summary of everything durable about the run so far. Replaces
   * trimmed history so the conductor never loses the plot on long missions —
   * rebuilt fresh each trim from current state, so it also survives resume.
   */
  private missionLedger(): string {
    const lines: string[] = ["[Earlier orchestration history was trimmed. MISSION LEDGER — durable state so far:]"];
    if (this.phase) lines.push(this.phaseLine()!);
    const settled = this.taskList().filter((t) => ["done", "failed", "blocked"].includes(t.status));
    if (settled.length) {
      lines.push("Settled tasks:");
      const failures = settled.filter((t) => t.status !== "done");
      const done = settled.filter((t) => t.status === "done");
      // Failures stay itemized forever; done tasks collapse by wave once the
      // run gets big (a 500-task ledger must still fit on one screen).
      if (done.length > 30) {
        const waves = [...new Set(done.map((t) => t.wave))].sort((a, b) => a - b);
        for (const w of waves) {
          const ws = done.filter((t) => t.wave === w);
          lines.push(`- wave ${w}: ${ws.length} done (${ws.map((t) => t.id).join(",")})`);
        }
      } else {
        for (const t of done) lines.push(`- ${t.id} [done] ${clip(t.title, 60)}${t.report ? ` — ${oneLine(t.report, 120)}` : ""}`);
      }
      for (const t of failures) {
        lines.push(`- ${t.id} [${t.status}] ${clip(t.title, 60)}${t.error ? ` — ${oneLine(t.error, 80)}` : ""}`);
      }
    }
    const decisions = this.notes.filter((n) => n.kind === "decision");
    if (decisions.length) {
      lines.push("Decisions:");
      for (const d of decisions.slice(-20)) lines.push(`- ${oneLine(d.text, 140)}`);
    }
    return clip(lines.join("\n"), 8000);
  }

  private trimConductorHistory(): void {
    const MAX = 60;
    const LEDGER_MARK = "MISSION LEDGER";
    const setLedger = () => {
      const msg = { role: "user" as const, content: this.missionLedger() };
      if (this.conductorMessages[1]?.content?.includes(LEDGER_MARK)) this.conductorMessages[1] = msg;
      else this.conductorMessages.splice(1, 0, msg);
    };
    if (this.conductorMessages.length > MAX) {
      const system = this.conductorMessages[0];
      const tail = this.conductorMessages.slice(-(MAX - 2));
      // Don't begin the tail on an orphic tool result.
      while (tail.length && tail[0].role === "tool") tail.shift();
      this.conductorMessages = [system, ...tail];
      setLedger();
    }
    // Count alone doesn't bound size: every update embeds the full task table,
    // so a deep run can blow the model window long before 60 messages. The
    // mission itself lives in the system message and always survives.
    const budget = Math.floor(this.cfg.contextTokenLimit * 0.75);
    if (estimateMessages(this.conductorMessages) <= budget) return;
    setLedger();
    while (estimateMessages(this.conductorMessages) > budget && this.conductorMessages.length > 10) {
      this.conductorMessages.splice(2, 1);
      // Never leave tool results whose assistant turn was dropped.
      while (this.conductorMessages[2]?.role === "tool") this.conductorMessages.splice(2, 1);
    }
  }

  // ---------------------------------------------------------------- scheduling

  private taskList(): Task[] {
    return this.taskOrder.map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  private runnableTasks(): Task[] {
    return this.taskList().filter(
      (t) => t.status === "pending" && t.deps.every((d) => this.tasks.get(d)?.status === "done")
    );
  }

  private hasOpenWork(): boolean {
    return this.taskList().some((t) => ["pending", "running", "verifying"].includes(t.status));
  }

  private blockStuckTasks(): void {
    for (const t of this.taskList()) {
      if (t.status !== "pending") continue;
      const bad = t.deps.find((d) => {
        const s = this.tasks.get(d)?.status;
        return s === "failed" || s === "blocked";
      });
      if (bad) {
        t.status = "blocked";
        t.error = `dependency ${bad} did not complete`;
        t.endedAt = Date.now();
        this.journal.append("task.status", { taskId: t.id, status: "blocked", attempt: t.attempt, reason: t.error });
        this.settledSinceUpdate.push(t.id);
      }
    }
  }

  /** Tasks occupying a worker slot: running, not those awaiting verification. */
  private activeWorkerCount(): number {
    let n = 0;
    for (const id of this.inflight.keys()) {
      if (this.tasks.get(id)?.status === "running") n++;
    }
    return n;
  }

  private startReadyTasks(): void {
    while (this.activeWorkerCount() < this.meta.options.maxWorkers && !this.finishing) {
      const next = this.runnableTasks()[0];
      if (!next) break;
      next.status = "running";
      next.startedAt = Date.now();
      this.journal.append("task.status", { taskId: next.id, status: "running", attempt: next.attempt });
      const p = this.runTaskPipeline(next).finally(() => this.inflight.delete(next.id));
      this.inflight.set(next.id, p);
    }
  }

  private drainSettled(): Task[] {
    const ids = this.settledSinceUpdate.splice(0);
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = this.tasks.get(id);
      if (t) out.push(t);
    }
    return out;
  }

  // ---------------------------------------------------------------- task pipeline

  private depReportsFor(task: Task): string {
    if (!task.deps.length) return "";
    // Excerpts, not full reports: a fan-in task with many deps must not blow
    // its context window on day one. Workers fetch full text with read_report.
    return task.deps
      .map((d) => {
        const dep = this.tasks.get(d);
        if (!dep) return `(${d}: missing)`;
        return depReportBlock(dep);
      })
      .join("\n\n");
  }

  private makeToolCtx(agentId: string, task: Task | null): ToolCtx {
    return {
      cfg: this.cfg,
      meta: this.meta,
      runDirPath: this.runDirPath,
      workdir: this.sandbox.workdir,
      sandbox: this.sandbox,
      agentId,
      taskId: task?.id,
      signal: this.ac.signal,
      addCheckpoint: task ? (summary) => this.recordCheckpoint(task, agentId, summary) : undefined,
      addNote: (text, key, kind) => {
        this.notes.push({ taskId: task?.id, key, kind, text });
        // Only the recent tail ever feeds digests; without a cap a multi-day
        // run accumulates every note in memory. Decisions are kept regardless.
        if (this.notes.length > 4000) {
          const decisions = this.notes.filter((n) => n.kind === "decision");
          const rest = this.notes.filter((n) => n.kind !== "decision");
          rest.splice(0, rest.length - Math.max(0, 4000 - decisions.length));
          this.notes = [...decisions, ...rest];
        }
        this.journal.append("note.added", { taskId: task?.id, agentId, key, kind, text: clip(text, 1200) });
      },
      searchNotes: (q) => this.searchNotes(q),
      readReport: (taskId) => this.readReportText(taskId),
      checkClaim: (rel) => {
        const norm = rel.replace(/^\.\//, "");
        const claim = this.notes.find(
          (n) =>
            n.kind === "claim" &&
            n.key === norm &&
            n.taskId &&
            n.taskId !== task?.id &&
            ["running", "verifying"].includes(this.tasks.get(n.taskId)?.status ?? "")
        );
        return claim
          ? `⚠ ${claim.taskId} holds a claim on ${norm} ("${oneLine(claim.text, 80)}") — coordinate via the blackboard before further edits.`
          : null;
      },
      addArtifact: (rel) => {
        if (task && !task.artifacts.includes(rel)) task.artifacts.push(rel);
      },
      readBlackboard: () => this.blackboardDigest(),
      log: (level, msg) => {
        this.journal.append("log", { level, msg, agentId, taskId: task?.id });
      },
    };
  }

  private readReportText(taskId: string): string {
    const t = this.tasks.get(taskId.trim().toUpperCase());
    if (!t) return `no such task: ${taskId}`;
    if (!t.report) return `${t.id} has not reported yet (status: ${t.status})`;
    return `${t.id} "${t.title}" → ${t.status}\n${t.report}${t.artifacts.length ? `\nartifacts: ${t.artifacts.join(", ")}` : ""}`;
  }

  private recordCheckpoint(task: Task, agentId: string, summary: string): void {
    task.lastCheckpoint = clip(summary, 4000);
    this.journal.append("task.checkpoint", {
      taskId: task.id,
      agentId,
      attempt: task.attempt,
      summary: task.lastCheckpoint,
    });
  }

  private async runTaskPipeline(task: Task): Promise<void> {
    if (task.team) {
      try {
        await this.runTeam(task);
      } catch (e) {
        this.finalizeTask(task, "failed", `team error: ${errMsg(e)}`);
      }
      return;
    }
    for (;;) {
      try {
        const outcome = await this.runWorker(task);
        if (this.ac.signal.aborted) {
          this.finalizeTask(task, "failed", "run cancelled");
          return;
        }
        if (outcome === "retry") {
          if (this.finishing || this.budgetExceeded()) {
            this.finalizeTask(task, "failed", task.feedback || task.error || "not retried: run is winding down");
            return;
          }
          if (task.attempt < this.cfg.verifyMaxAttempts) {
            task.attempt++;
            task.status = "running";
            this.journal.append("task.status", { taskId: task.id, status: "running", attempt: task.attempt });
            continue;
          }
          this.finalizeTask(task, "failed", task.feedback || task.error || "verification failed after retries");
          return;
        }
        return; // worker already finalized the task
      } catch (e) {
        if (this.ac.signal.aborted) {
          this.finalizeTask(task, "failed", "run cancelled");
          return;
        }
        if (task.attempt < this.cfg.verifyMaxAttempts && !this.finishing && !this.budgetExceeded()) {
          task.attempt++;
          task.error = errMsg(e);
          task.status = "running";
          this.journal.append("task.status", { taskId: task.id, status: "running", attempt: task.attempt, reason: task.error });
          continue;
        }
        this.finalizeTask(task, "failed", `worker error: ${errMsg(e)}`);
        return;
      }
    }
  }

  private resolveModel(tier?: Task["modelTier"]): string {
    if (tier === "cheap") return this.cfg.cheapModel || this.meta.options.model;
    if (tier === "strong") return this.cfg.strongModel || this.meta.options.model;
    return this.meta.options.model;
  }

  /** Returns "retry" to request another attempt, or "done" when finalized. */
  private async runWorker(task: Task): Promise<"retry" | "done"> {
    const agentId = rid("w");
    const model = this.resolveModel(task.modelTier);
    task.agentIds.push(agentId);
    const dirListing = this.topListing();
    const system = workerSystem({
      agentId,
      role: task.role,
      meta: this.meta,
      task,
      maxSteps: this.meta.options.maxStepsPerTask,
      depReports: this.depReportsFor(task),
      blackboard: this.blackboardDigest(),
      operatorNotes: this.peekOperatorNotes(),
      dirListing,
    });
    this.journal.append("agent.spawned", {
      agentId,
      taskId: task.id,
      role: task.role,
      model,
      purpose: task.title,
    });

    const outcome = await runAgent({
      cfg: this.cfg,
      agentId,
      model,
      thinking: this.meta.options.thinking,
      reasoningEffort: this.meta.options.reasoningEffort,
      system,
      kickoff: WORKER_KICKOFF,
      tools: workerToolset(this.cfg),
      terminal: [REPORT_TOOL],
      maxSteps: this.meta.options.maxStepsPerTask,
      signal: this.ac.signal,
      ctx: this.makeToolCtx(agentId, task),
      hooks: {
        ...this.agentHooks(agentId, task.id),
        onCheckpoint: (summary: string) => this.recordCheckpoint(task, agentId, summary),
      },
      stop: this.agentStop,
    });
    this.flushDeltas(agentId);
    this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });

    if (this.ac.signal.aborted) return "done";

    if (!outcome.terminal) {
      task.error = "worker ended without reporting";
      return "retry";
    }
    const a = outcome.terminal.args as {
      status?: string;
      report?: string;
      artifacts?: string[];
      key_facts?: string[];
      open_questions?: string[];
      files_touched?: string[];
    };
    const report = String(a.report ?? "(empty report)");
    const reportStatus: "done" | "blocked" = a.status === "blocked" ? "blocked" : "done";
    const reportedArtifacts = Array.isArray(a.artifacts) ? a.artifacts.map(String) : [];
    for (const art of reportedArtifacts) if (!task.artifacts.includes(art)) task.artifacts.push(art);
    task.report = report;
    task.reportStatus = reportStatus;
    const strList = (v: unknown, max: number) =>
      Array.isArray(v) ? v.map((x) => clip(String(x), 300)).slice(0, max) : undefined;
    task.keyFacts = strList(a.key_facts, 8);
    task.openQuestions = strList(a.open_questions, 6);
    task.filesTouched = strList(a.files_touched, 40);
    this.journal.append("task.report", {
      taskId: task.id,
      status: reportStatus,
      report,
      artifacts: task.artifacts,
      keyFacts: task.keyFacts,
      openQuestions: task.openQuestions,
      filesTouched: task.filesTouched,
    });

    if (reportStatus === "blocked") {
      this.finalizeTask(task, "blocked", report);
      return "done";
    }

    if (task.verify && this.cfg.verification !== "off") {
      task.status = "verifying";
      this.journal.append("task.status", { taskId: task.id, status: "verifying", attempt: task.attempt });
      // Mechanical checks first: free, instant, and they catch the most common
      // fabrications (claimed artifacts that don't exist) without an LLM call.
      const mech = this.preVerify(task);
      if (mech) {
        task.feedback = mech;
        this.journal.append("verify.result", { taskId: task.id, pass: false, feedback: mech, mechanical: true });
        return "retry";
      }
      const pass = await this.runVerifier(task);
      if (!pass) return "retry";
    }

    this.finalizeTask(task, "done", report);
    return "done";
  }

  /** Zero-token sanity checks before the LLM verifier. Returns failure feedback or null. */
  private preVerify(task: Task): string | null {
    const report = task.report ?? "";
    if (report.trim().length < 40) {
      return "Report is too thin to verify. Re-do the task and report concretely: what was done, what was verified, exact paths.";
    }
    const missing: string[] = [];
    // Remote sandboxes own their filesystem — only check host-visible paths.
    if (this.sandbox.localFs) {
      const okAt = (p: string) => {
        try {
          return fs.statSync(p).size > 0;
        } catch {
          return false;
        }
      };
      for (const rel of task.artifacts) {
        const inArtifacts = path.join(this.runDirPath, "artifacts", rel);
        const inWorkdir = path.resolve(this.meta.cwd, rel);
        if (!okAt(inArtifacts) && !okAt(inWorkdir)) missing.push(rel);
      }
    }
    if (missing.length) {
      return `Claimed artifact(s) do not exist or are empty: ${missing.join(", ")}. Actually create them (use save_artifact), then report again.`;
    }
    return null;
  }

  private async runVerifier(task: Task): Promise<boolean> {
    const agentId = rid("v");
    // Verification gets the strong tier when configured — a weak verifier
    // rubber-stamps exactly the tasks that most need scrutiny.
    const model = this.cfg.strongModel || this.meta.options.model;
    task.agentIds.push(agentId);
    this.journal.append("agent.spawned", {
      agentId,
      taskId: task.id,
      role: "verifier",
      model,
      purpose: `verify ${task.id}`,
    });
    const outcome = await runAgent({
      cfg: this.cfg,
      agentId,
      model,
      thinking: this.meta.options.thinking,
      reasoningEffort: this.meta.options.reasoningEffort,
      system: verifierSystem(this.meta, task),
      kickoff: VERIFIER_KICKOFF,
      tools: verifierToolset(),
      terminal: [VERDICT_TOOL],
      maxSteps: Math.min(14, this.meta.options.maxStepsPerTask),
      signal: this.ac.signal,
      // Blind verification: the verifier judges deliverables against the
      // objective with its own tools — it must not inherit the swarm's shared
      // beliefs (blackboard) or the worker's narrative beyond the claims.
      ctx: { ...this.makeToolCtx(agentId, task), readBlackboard: () => "", searchNotes: undefined },
      hooks: this.agentHooks(agentId, task.id),
      stop: this.agentStop,
    });
    this.flushDeltas(agentId);
    this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });
    if (this.ac.signal.aborted) return true;

    const v = (outcome.terminal?.args ?? {}) as { pass?: boolean; feedback?: string };
    const strict = this.cfg.verification === "strict";
    // No verdict returned: in strict mode fail closed, otherwise accept.
    const pass = outcome.terminal ? Boolean(v.pass) : !strict;
    const feedback = String(v.feedback ?? (outcome.terminal ? "" : "verifier produced no verdict"));
    task.feedback = feedback;
    this.journal.append("verify.result", { taskId: task.id, pass, feedback });
    return pass;
  }

  private finalizeTask(task: Task, status: Task["status"], reason?: string): void {
    task.status = status;
    task.endedAt = Date.now();
    if (reason && status !== "done") task.error = reason;
    this.journal.append("task.status", { taskId: task.id, status, attempt: task.attempt, reason });
    this.settledSinceUpdate.push(task.id);
    this.maybeSnapshot();
  }

  // ---------------------------------------------------------------- progress snapshots

  private snapshotCounter = 0;
  private settledSinceSnapshot = 0;
  private snapshotInflight = false;

  /**
   * Periodic partial deliverable: every N settled tasks, write a cheap-tier
   * progress report to artifacts/. Fire-and-forget — a multi-day run always
   * has something readable, and a snapshot failure never blocks scheduling.
   */
  private maybeSnapshot(): void {
    if (this.mode !== "root" || this.finishing || this.snapshotInflight) return;
    const every = Number(process.env.SWARM_SNAPSHOT_EVERY ?? "25");
    if (!every || every < 1) return;
    if (++this.settledSinceSnapshot < every) return;
    this.settledSinceSnapshot = 0;
    this.snapshotInflight = true;
    const n = ++this.snapshotCounter;
    const model = this.cfg.cheapModel || this.meta.options.conductorModel;
    const tasks = this.taskList();
    const settled = tasks.filter((t) => ["done", "failed", "blocked"].includes(t.status));
    chat(this.cfg, {
      model,
      messages: [
        {
          role: "user",
          content: `Write a concise interim progress report (markdown) for an in-flight agent-swarm mission. Cover: what has been accomplished so far (with concrete results/paths from the reports), what failed, what is currently running, and what remains. This is a partial deliverable for the operator — informative, no filler.\n\nMISSION\n${this.meta.mission}\n\nTASKS\n${taskTable(tasks)}\n\nSETTLED REPORTS\n${truncateMiddle(settled.map(reportBlock).join("\n\n"), 50_000, "chars")}`,
        },
      ],
      thinking: false,
      maxTokens: 4096,
      signal: this.ac.signal,
    })
      .then((res) => {
        this.onUsage(model, res.usage);
        if (!res.content.trim()) return;
        const rel = `progress-report-${n}.md`;
        fs.writeFileSync(path.join(this.runDirPath, "artifacts", rel), res.content, "utf8");
        this.journal.append("log", { level: "info", msg: `progress snapshot written: artifacts/${rel}` });
      })
      .catch((e) => {
        if (!this.ac.signal.aborted) this.journal.append("log", { level: "warn", msg: `progress snapshot failed: ${errMsg(e)}` });
      })
      .finally(() => {
        this.snapshotInflight = false;
      });
  }

  private topListing(): string {
    // Remote sandboxes own their filesystem; a host listing would be a lie.
    if (!this.sandbox.localFs) return "";
    try {
      const entries = fs
        .readdirSync(this.meta.cwd, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      return entries.join("  ");
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------- agent hooks → journal

  /** Ends in-flight agents gracefully when the run must wind down. */
  private agentStop = (): string | null => {
    if (this.budgetExceeded()) return "The run's token budget is exhausted.";
    if (this.finishing) return "The run is finishing.";
    return null;
  };

  /**
   * Streaming deltas arrive one small chunk at a time; writing each as its own
   * journal line bloats events.jsonl enormously on long runs. Coalesce per
   * agent+channel and flush on size, on a short timer, and before any event
   * that must order after the text (tool calls, agent.done).
   */
  private deltaBuf = new Map<string, { agentId: string; taskId: string; channel: "text" | "think"; text: string }>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  private thinkDropLogged = false;

  private queueDelta(agentId: string, taskId: string, channel: "text" | "think", text: string): void {
    // Deltas are UI sugar, never state — thin them under load so a 100-agent
    // swarm doesn't write gigabytes of streaming chatter into the journal.
    const load = this.activeWorkerCount();
    if (channel === "think" && load > 48) {
      if (!this.thinkDropLogged) {
        this.thinkDropLogged = true;
        this.journal.append("log", { level: "info", msg: `thinking streams muted above 48 active agents (currently ${load})` });
      }
      return;
    }
    const flushChars = load > 24 ? 2000 : 480;
    const flushMs = load > 24 ? 1000 : 200;
    const key = `${agentId}:${channel}`;
    const buf = this.deltaBuf.get(key);
    if (buf) buf.text += text;
    else this.deltaBuf.set(key, { agentId, taskId, channel, text });
    if (this.deltaBuf.get(key)!.text.length >= flushChars) {
      this.flushDeltas(agentId);
    } else if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), flushMs);
    }
  }

  private flushDeltas(onlyAgent?: string): void {
    if (!onlyAgent && this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    for (const [key, buf] of [...this.deltaBuf]) {
      if (onlyAgent && buf.agentId !== onlyAgent) continue;
      this.deltaBuf.delete(key);
      this.journal.append("agent.delta", {
        agentId: buf.agentId,
        taskId: buf.taskId,
        channel: buf.channel,
        text: buf.text,
      });
    }
  }

  private agentHooks(agentId: string, taskId: string) {
    return {
      onDelta: (channel: "text" | "think", text: string) => {
        this.queueDelta(agentId, taskId, channel, text);
      },
      onToolCall: (callId: string, name: string, args: unknown) => {
        this.flushDeltas(agentId);
        this.journal.append("tool.call", { agentId, taskId, callId, name, args });
      },
      onToolResult: (callId: string, name: string, ok: boolean, summary: string) => {
        this.journal.append("tool.result", { agentId, taskId, callId, name, ok, summary });
      },
      onUsage: this.onUsage,
      onLog: (level: "info" | "warn" | "error", msg: string) => {
        this.journal.append("log", { level, msg });
      },
    };
  }

  // ---------------------------------------------------------------- operator control

  private operatorQueue: string[] = [];

  private drainControl(): void {
    // Only the root executor consumes operator control; teams are cancelled
    // via the parent's abort signal and would otherwise steal queued notes.
    if (this.mode === "team") return;
    for (const msg of this.control.poll()) {
      if (msg.kind === "cancel") {
        this.journal.append("operator.note", { text: "⛔ Cancel requested by operator." });
        this.cancel();
      } else if (msg.kind === "note" && msg.text) {
        this.operatorQueue.push(msg.text);
        this.journal.append("operator.note", { text: msg.text });
      }
    }
  }

  private peekOperatorNotes(): string[] {
    return [...this.operatorQueue];
  }

  private consumeOperatorNotes(): string[] {
    const out = [...this.operatorQueue];
    this.operatorQueue = [];
    for (let i = 0; i < out.length; i++) this.journal.append("operator.note.consumed", {});
    return out;
  }

  // ---------------------------------------------------------------- synthesis

  /** Write the final report file, set terminal status, emit run.final, flush. */
  private async writeFinal(
    status: "done" | "failed" | "cancelled",
    reason: string,
    reportMarkdown: string,
    summary: string
  ): Promise<void> {
    this.flushDeltas();
    const reportPath = path.join(this.runDirPath, "artifacts", "final-report.md");
    ensureDir(path.dirname(reportPath));
    fs.writeFileSync(reportPath, reportMarkdown, "utf8");
    // Always ship a readable, shareable HTML rendering alongside the raw
    // markdown; a rendering bug must never block run finalization.
    let htmlPath: string | undefined;
    try {
      htmlPath = path.join(this.runDirPath, "artifacts", "final-report.html");
      fs.writeFileSync(
        htmlPath,
        renderFinalHtml({
          markdown: reportMarkdown,
          mission: this.meta.mission,
          runId: this.meta.id,
          status,
          finishedAt: Date.now(),
        }),
        "utf8"
      );
    } catch (e) {
      htmlPath = undefined;
      this.journal.append("log", { level: "warn", msg: `final-report.html render failed: ${errMsg(e)}` });
    }
    this.setStatus(status, reason);
    this.journal.append("run.final", { summary, reportPath, htmlPath, reason, status });
    await this.journal.flush();
  }

  /** Terminate the run as failed without any further model calls. */
  private async fail(reason: string): Promise<void> {
    const md = [
      `# Run failed`,
      ``,
      `**Mission:** ${this.meta.mission}`,
      ``,
      `**What happened:** ${reason}`,
      ``,
      this.fatal && /auth/i.test(this.fatal)
        ? `## Fix\n1. Get a key at https://platform.deepseek.com\n2. Settings → paste your real DeepSeek key (it should look like \`sk-\` + ~32 characters), or run \`swarm config set apiKey <sk-...>\`\n3. Launch the mission again.`
        : `## Next steps\nReview the error above and retry.`,
    ].join("\n");
    await this.writeFinal("failed", reason, md, reason);
  }

  private async synthesize(): Promise<void> {
    // Fatal (e.g. bad API key): don't attempt an LLM synth that will just fail
    // again — fail loudly with a clear, actionable report.
    if (this.fatal) {
      await this.fail(this.fatal);
      return;
    }

    this.setStatus("synthesizing", this.finishReason);
    const tasks = this.taskList();
    const reports = tasks.length
      ? tasks.map(reportBlock).join("\n\n")
      : "(no tasks were completed)";
    const artifactList = this.listArtifacts().join("\n") || "(none)";
    const agentId = rid("synth");

    let summary = "";
    let reportMarkdown = "";
    const synthOnce = async (extraNote?: string): Promise<void> => {
      const outcome = await runAgent({
        cfg: this.cfg,
        agentId,
        model: this.meta.options.conductorModel,
        thinking: this.meta.options.thinking,
        reasoningEffort: this.meta.options.reasoningEffort,
        system: synthSystem({
          meta: this.meta,
          finishNotes: [this.finishNotes, extraNote].filter(Boolean).join("\n\n"),
          reports: truncateMiddle(reports, 300_000, "chars"),
          blackboard: this.blackboardDigest(6000),
          artifactList,
          reason: this.finishReason || "completed",
        }),
        kickoff: SYNTH_KICKOFF,
        tools: synthToolset(),
        terminal: [SUBMIT_FINAL_TOOL],
        maxSteps: 24,
        maxTokensOut: 32000,
        signal: new AbortController().signal, // synthesis should finish even if run was cancelled
        ctx: this.makeToolCtx(agentId, null),
        hooks: this.agentHooks(agentId, ""),
      });
      const a = (outcome.terminal?.args ?? {}) as { report_markdown?: string; summary?: string };
      reportMarkdown = String(a.report_markdown ?? outcome.finalText ?? "");
      summary = String(a.summary ?? "");
    };
    try {
      await synthOnce();
      // Strict mode: check the final report's claims against the task reports
      // (the ground truth) and re-synthesize once if it misrepresents them.
      if (this.cfg.verification === "strict" && reportMarkdown.trim() && tasks.length) {
        try {
          const res = await chat(this.cfg, {
            model: this.meta.options.conductorModel,
            messages: [
              {
                role: "user",
                content: synthCheckPrompt(
                  this.meta.mission,
                  truncateMiddle(reports, 60_000, "chars"),
                  truncateMiddle(reportMarkdown, 60_000, "chars")
                ),
              },
            ],
            thinking: false,
            maxTokens: 2048,
            signal: new AbortController().signal,
          });
          this.onUsage(this.meta.options.conductorModel, res.usage);
          const check = (res.content || "").trim();
          if (check && !/^OK\b/i.test(check)) {
            this.journal.append("log", { level: "warn", msg: `synthesis check found discrepancies:\n${clip(check, 1500)}` });
            await synthOnce(
              `A faithfulness review of your previous draft found these discrepancies — fix them, claiming only what the task reports support:\n${clip(check, 2000)}`
            );
          }
        } catch (e) {
          this.journal.append("log", { level: "warn", msg: `synthesis check failed: ${errMsg(e)}` });
        }
      }
    } catch (e) {
      this.journal.append("log", { level: "error", msg: `synthesis failed: ${errMsg(e)}` });
    }

    if (!reportMarkdown.trim()) {
      reportMarkdown = this.fallbackReport(tasks);
      summary = summary || "Synthesis unavailable; assembled a fallback report from task results.";
    }

    // Truthful terminal status: failed if the conductor produced no tasks, or
    // every task it produced failed/blocked.
    const cancelled = this.finishReason.includes("cancel");
    const anyDone = tasks.some((t) => t.status === "done");
    const noWork = this.taskCounter === 0;
    const allFailed = tasks.length > 0 && !anyDone;
    let status: "done" | "failed" | "cancelled" = "done";
    let reason = this.finishReason;
    if (cancelled) {
      status = "cancelled";
    } else if (noWork) {
      status = "failed";
      reason = "The conductor produced no tasks (it may have failed to respond). Check the activity log.";
    } else if (allFailed) {
      status = "failed";
      reason = `All ${tasks.length} task(s) failed or were blocked.`;
    }
    await this.writeFinal(status, reason, reportMarkdown, summary || clip(reportMarkdown, 600));

    // Cross-run memory: real-directory runs leave a trace for the next swarm.
    if (!this.meta.sandbox && status !== "cancelled") {
      appendMemory(this.meta.cwd, {
        mission: this.meta.mission,
        finishedAt: Date.now(),
        status,
        summary: clip(summary || reportMarkdown, 600),
        keyDecisions: this.notes.filter((n) => n.kind === "decision").slice(-10).map((n) => n.text),
      });
    }
  }

  private fallbackReport(tasks: Task[]): string {
    const lines = [`# ${this.meta.mission}`, ``, `_Run ${this.meta.id} — ${this.finishReason}_`, ``];
    for (const t of tasks) {
      lines.push(`## ${t.id} ${t.title} (${t.status})`);
      lines.push(t.report || t.error || "(no output)");
      if (t.artifacts.length) lines.push(`Artifacts: ${t.artifacts.join(", ")}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  private listArtifacts(): string[] {
    const dir = path.join(this.runDirPath, "artifacts");
    const out: string[] = [];
    const walk = (d: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + "/");
        else {
          let size = 0;
          try { size = fs.statSync(path.join(d, e.name)).size; } catch { /* race */ }
          out.push(`${prefix}${e.name} (${size}b)`);
        }
      }
    };
    walk(dir, "");
    return out;
  }
}

function inferRole(spec: TaskSpec): string {
  const s = (spec.title + " " + spec.objective).toLowerCase();
  if (/\b(test|verify|review|audit|check)\b/.test(s)) return "reviewer";
  if (/\b(research|investigate|find|search|gather)\b/.test(s)) return "researcher";
  if (/\b(write|draft|document|summary|report)\b/.test(s)) return "writer";
  if (/\b(data|csv|dataset|scrape|parse|clean)\b/.test(s)) return "data-wrangler";
  if (/\b(analy|compare|evaluate|benchmark)\b/.test(s)) return "analyst";
  if (/\b(code|implement|build|fix|refactor|api|function|component)\b/.test(s)) return "coder";
  return "generalist";
}

function safeArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

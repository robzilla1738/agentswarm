import * as fs from "fs";
import * as path from "path";
import { estimateMessages, runAgent } from "./agent";
import { SwarmConfig, runDir } from "./config";
import { ControlReader } from "./control";
import { ChatMsg, ChatResult, chat, isFatalAuthError, validateAuth } from "./deepseek";
import { Journal } from "./journal";
import {
  SUBMIT_FINAL_TOOL,
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
  conductorInitialUpdate,
  conductorSystem,
  conductorUpdate,
  reportBlock,
  synthSystem,
  SYNTH_KICKOFF,
  taskTable,
  verifierSystem,
  VERIFIER_KICKOFF,
  workerSystem,
  WORKER_KICKOFF,
} from "./prompts";
import { SandboxRuntime, createSandbox } from "./sandbox";
import { RunState } from "./state";
import { RunMeta, RunStatus, Task, TaskSpec, Usage, usageCost } from "./types";
import { clip, ensureDir, errMsg, oneLine, rid, truncateMiddle } from "./util";

const VERIFY_MAX_ATTEMPTS = 2;

export class Executor {
  private cfg: SwarmConfig;
  private meta: RunMeta;
  private runDirPath: string;
  private journal: Journal;
  private control: ControlReader;
  private ac = new AbortController();

  private tasks = new Map<string, Task>();
  private taskOrder: string[] = [];
  private taskCounter = 0;
  private inflight = new Map<string, Promise<void>>();
  private settledSinceUpdate: string[] = [];
  private notes: { taskId?: string; key?: string; text: string }[] = [];

  private conductorMessages: ChatMsg[] = [];
  private spentTokens = 0;
  private cost = 0;
  private finishing = false;
  private finishNotes = "";
  private finishReason = "";
  private fatal: string | null = null;
  private lastConductorAction: "spawn" | "wait" | "finish" | "none" = "none";
  private resumed = false;

  private sandbox: SandboxRuntime;

  constructor(cfg: SwarmConfig, meta: RunMeta, journal: Journal) {
    this.cfg = cfg;
    this.meta = meta;
    this.runDirPath = runDir(meta.id);
    this.journal = journal;
    this.control = new ControlReader(this.runDirPath);
    ensureDir(path.join(this.runDirPath, "artifacts"));
    // "A directory on disk" runs always execute on the host — touching the
    // operator's real files is the entire point of that mode.
    const kind = meta.sandbox ? meta.options.sandboxRuntime ?? "host" : "host";
    this.sandbox = createSandbox(kind, { runId: meta.id, hostDir: meta.cwd, cfg });
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
    this.notes = state.notes.map((n) => ({ taskId: n.taskId, key: n.key, text: n.text }));
    this.spentTokens = state.totalUsage.promptTokens + state.totalUsage.completionTokens;
    this.cost = state.cost;
    this.resumed = true;
  }

  private setStatus(status: RunStatus, reason?: string): void {
    this.journal.append("run.status", { status, reason });
  }

  private onUsage = (model: string, usage: Usage) => {
    this.spentTokens += usage.promptTokens + usage.completionTokens;
    this.cost += usageCost(usage, this.cfg.pricing[model]);
    this.journal.append("usage", { model, usage, cost: this.cost });
  };

  private budgetExceeded(): boolean {
    return this.spentTokens >= this.meta.options.maxTokens;
  }

  private blackboardDigest(max = 1800): string {
    if (!this.notes.length) return "";
    const lines = this.notes
      .slice(-40)
      .map((n) => `• ${n.key ? `[${n.key}] ` : ""}${oneLine(n.text, 160)}${n.taskId ? ` (${n.taskId})` : ""}`);
    let out = lines.join("\n");
    if (out.length > max) out = out.slice(out.length - max);
    return out;
  }

  // ---------------------------------------------------------------- main

  async run(): Promise<void> {
    this.setStatus("planning");

    // Preflight: validate auth before doing any work so the operator gets an
    // instant, clear error instead of a phantom "done" run.
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

    // Operator control must land while agents are mid-task, not only when the
    // scheduler wakes up — a Stop click aborts in-flight work within ~1s.
    const controlTimer = setInterval(() => {
      try {
        this.drainControl();
      } catch {
        /* control polling must never kill the run */
      }
    }, 750);

    this.conductorMessages = [
      { role: "system", content: conductorSystem(this.meta) },
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

      while (!this.finishing) {
        this.drainControl();
        if (this.finishing) break;
        if (this.budgetExceeded()) {
          this.finishing = true;
          this.finishReason = "token budget reached";
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
            if (this.lastConductorAction !== "spawn") {
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
            if (this.lastConductorAction === "wait") {
              this.finishing = true;
              this.finishReason = "stalled: dependencies unmet and conductor chose to wait";
            }
          }
          continue;
        }

        // Tasks are running — wait for at least one to settle.
        await Promise.race([...this.inflight.values()]);
        this.drainControl();
        const reports = this.drainSettled();
        if (reports.length && !this.finishing) {
          this.appendConductorUpdate(undefined, reports);
          await this.conductorTurn();
        }
      }
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

    await this.synthesize();
    await this.sandbox.destroy().catch(() => {
      /* container/sandbox teardown is best-effort */
    });
    await this.journal.flush();
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
    const tools = [SPAWN_TASKS_TOOL, WAIT_TOOL, FINISH_TOOL];
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
        }
        // Treat a transient conductor failure as a wait so the loop keeps draining tasks.
        this.lastConductorAction = "wait";
        return;
      }
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
        } else if (call.function.name === "wait") {
          toolResult = "Waiting for running tasks to report.";
          if (acted === "none") acted = "wait";
        } else {
          toolResult = `unknown tool ${call.function.name}`;
        }
        this.conductorMessages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
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
      const task: Task = {
        id,
        title: clip(String(spec.title ?? "task"), 120),
        objective: String(spec.objective ?? spec.title ?? ""),
        role: (spec.role ? String(spec.role) : inferRole(spec)).toLowerCase(),
        deps,
        verify: Boolean(spec.verify) && this.cfg.verification !== "off",
        context: spec.context ? String(spec.context) : undefined,
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

  private appendConductorUpdate(extra?: string, reports?: Task[]): void {
    const ops = this.consumeOperatorNotes();
    this.conductorMessages.push({
      role: "user",
      content: conductorUpdate({
        reports: reports?.map(reportBlock),
        operatorNotes: ops,
        blackboard: this.blackboardDigest(),
        nextId: this.nextId(),
        taskTable: taskTable(this.taskList()),
        budgetLine: budgetLine({ total: this.spentTokens, cost: this.cost }, this.meta.options.maxTokens),
        extra,
      }),
    });
    // Keep the conductor's own history from growing without bound.
    this.trimConductorHistory();
  }

  private trimConductorHistory(): void {
    const MAX = 60;
    const TRIM_NOTICE = "[Earlier orchestration history was trimmed. Current swarm state is below.]";
    if (this.conductorMessages.length > MAX) {
      const system = this.conductorMessages[0];
      const tail = this.conductorMessages.slice(-(MAX - 2));
      // Don't begin the tail on an orphic tool result.
      while (tail.length && tail[0].role === "tool") tail.shift();
      this.conductorMessages = [system, { role: "user", content: TRIM_NOTICE }, ...tail];
    }
    // Count alone doesn't bound size: every update embeds the full task table,
    // so a deep run can blow the model window long before 60 messages. The
    // mission itself lives in the system message and always survives.
    const budget = Math.floor(this.cfg.contextTokenLimit * 0.75);
    if (estimateMessages(this.conductorMessages) <= budget) return;
    if (this.conductorMessages[1]?.content !== TRIM_NOTICE) {
      this.conductorMessages.splice(1, 0, { role: "user", content: TRIM_NOTICE });
    }
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

  private startReadyTasks(): void {
    while (this.inflight.size < this.meta.options.maxWorkers && !this.finishing) {
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
    return task.deps
      .map((d) => {
        const dep = this.tasks.get(d);
        if (!dep) return `(${d}: missing)`;
        return reportBlock(dep);
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
      addNote: (text, key) => {
        this.notes.push({ taskId: task?.id, key, text });
        // Only the recent tail ever feeds digests; without a cap a multi-day
        // run accumulates every note in memory.
        if (this.notes.length > 2000) this.notes.splice(0, this.notes.length - 2000);
        this.journal.append("note.added", { taskId: task?.id, agentId, key, text: clip(text, 1200) });
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

  private async runTaskPipeline(task: Task): Promise<void> {
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
          if (task.attempt < VERIFY_MAX_ATTEMPTS) {
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
        if (task.attempt < VERIFY_MAX_ATTEMPTS && !this.finishing && !this.budgetExceeded()) {
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

  /** Returns "retry" to request another attempt, or "done" when finalized. */
  private async runWorker(task: Task): Promise<"retry" | "done"> {
    const agentId = rid("w");
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
      model: this.meta.options.model,
      purpose: task.title,
    });

    const outcome = await runAgent({
      cfg: this.cfg,
      agentId,
      model: this.meta.options.model,
      thinking: this.meta.options.thinking,
      reasoningEffort: this.meta.options.reasoningEffort,
      system,
      kickoff: WORKER_KICKOFF,
      tools: workerToolset(),
      terminal: [REPORT_TOOL],
      maxSteps: this.meta.options.maxStepsPerTask,
      signal: this.ac.signal,
      ctx: this.makeToolCtx(agentId, task),
      hooks: this.agentHooks(agentId, task.id),
      stop: this.agentStop,
    });
    this.flushDeltas(agentId);
    this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });

    if (this.ac.signal.aborted) return "done";

    if (!outcome.terminal) {
      task.error = "worker ended without reporting";
      return "retry";
    }
    const a = outcome.terminal.args as { status?: string; report?: string; artifacts?: string[] };
    const report = String(a.report ?? "(empty report)");
    const reportStatus: "done" | "blocked" = a.status === "blocked" ? "blocked" : "done";
    const reportedArtifacts = Array.isArray(a.artifacts) ? a.artifacts.map(String) : [];
    for (const art of reportedArtifacts) if (!task.artifacts.includes(art)) task.artifacts.push(art);
    task.report = report;
    task.reportStatus = reportStatus;
    this.journal.append("task.report", {
      taskId: task.id,
      status: reportStatus,
      report,
      artifacts: task.artifacts,
    });

    if (reportStatus === "blocked") {
      this.finalizeTask(task, "blocked", report);
      return "done";
    }

    if (task.verify && this.cfg.verification !== "off") {
      task.status = "verifying";
      this.journal.append("task.status", { taskId: task.id, status: "verifying", attempt: task.attempt });
      const pass = await this.runVerifier(task);
      if (!pass) return "retry";
    }

    this.finalizeTask(task, "done", report);
    return "done";
  }

  private async runVerifier(task: Task): Promise<boolean> {
    const agentId = rid("v");
    task.agentIds.push(agentId);
    this.journal.append("agent.spawned", {
      agentId,
      taskId: task.id,
      role: "verifier",
      model: this.meta.options.model,
      purpose: `verify ${task.id}`,
    });
    const outcome = await runAgent({
      cfg: this.cfg,
      agentId,
      model: this.meta.options.model,
      thinking: this.meta.options.thinking,
      reasoningEffort: this.meta.options.reasoningEffort,
      system: verifierSystem(this.meta, task),
      kickoff: VERIFIER_KICKOFF,
      tools: verifierToolset(),
      terminal: [VERDICT_TOOL],
      maxSteps: Math.min(14, this.meta.options.maxStepsPerTask),
      signal: this.ac.signal,
      ctx: this.makeToolCtx(agentId, task),
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

  private queueDelta(agentId: string, taskId: string, channel: "text" | "think", text: string): void {
    const key = `${agentId}:${channel}`;
    const buf = this.deltaBuf.get(key);
    if (buf) buf.text += text;
    else this.deltaBuf.set(key, { agentId, taskId, channel, text });
    if (this.deltaBuf.get(key)!.text.length >= 480) {
      this.flushDeltas(agentId);
    } else if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), 200);
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
    this.setStatus(status, reason);
    this.journal.append("run.final", { summary, reportPath, reason, status });
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
    try {
      const outcome = await runAgent({
        cfg: this.cfg,
        agentId,
        model: this.meta.options.conductorModel,
        thinking: this.meta.options.thinking,
        reasoningEffort: this.meta.options.reasoningEffort,
        system: synthSystem({
          meta: this.meta,
          finishNotes: this.finishNotes,
          reports: truncateMiddle(reports, 120_000, "chars"),
          blackboard: this.blackboardDigest(4000),
          artifactList,
          reason: this.finishReason || "completed",
        }),
        kickoff: SYNTH_KICKOFF,
        tools: synthToolset(),
        terminal: [SUBMIT_FINAL_TOOL],
        maxSteps: 12,
        maxTokensOut: 16384,
        signal: new AbortController().signal, // synthesis should finish even if run was cancelled
        ctx: this.makeToolCtx(agentId, null),
        hooks: this.agentHooks(agentId, ""),
      });
      const a = (outcome.terminal?.args ?? {}) as { report_markdown?: string; summary?: string };
      reportMarkdown = String(a.report_markdown ?? outcome.finalText ?? "");
      summary = String(a.summary ?? "");
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

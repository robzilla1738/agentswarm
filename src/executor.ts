import * as fs from "fs";
import * as path from "path";
import { AgentOutcome, estimateMessages, runAgent } from "./agent";
import { SwarmConfig, contextLimitFor, runDir } from "./config";
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
  submitForecastTool,
  synthToolset,
  verifierToolset,
  workerToolset,
} from "./tools";
import {
  aggregateBlock,
  budgetLine,
  completenessPrompt,
  conductorInitialUpdate,
  conductorSystem,
  conductorUpdate,
  depReportBlock,
  FORECASTER_KICKOFF,
  forecastConductorAddendum,
  forecastPlanPrompt,
  forecastSynthAddendum,
  questionBlock,
  reportBlock,
  sharpenQuestionPrompt,
  simStructurePrompt,
  simulationBlock,
  synthCheckPrompt,
  synthSystem,
  SYNTH_KICKOFF,
  taskTable,
  verifierSystem,
  VERIFIER_KICKOFF,
  workerSystem,
  WORKER_KICKOFF,
} from "./prompts";
import {
  aggregateBinary,
  aggregateMc,
  aggregateQuantiles,
  appendLedger,
  applyQuantileDilation,
  applyRecalibration,
  blendOptionProbs,
  blendQuantiles,
  blendWithMarket,
  calibrationBlock,
  canonicalMethodLabel,
  chooseExtremizeK,
  chooseMarketWeight,
  chooseSimulationWeight,
  clampProb,
  daysToIso,
  evidenceOverlap,
  extractMethodLabel,
  extractQuestionRef,
  fitQuantileCalibration,
  fitRecalibration,
  ISO_DATE,
  isoToDays,
  type LedgerCreated,
  liquidityFactor,
  loadLedger,
  MANIFOLD_VOLUME_DISCOUNT,
  methodWeights,
  monotoneQuantiles,
  normalizeOptionProbs,
  parseForecastPlan,
  parseQuestionJson,
  parseSimStructure,
  scaleK,
  validateForecastAnalytics,
  validateSimStructure,
} from "./forecast";
import { MarketHit, marketOdds } from "./datatools";
import { runSimulation } from "./simulation";
import { appendMemory, memoryBlock } from "./memory";
import { canonicalizeUrl } from "./searchcore";
import { aggregateSources, renderFinalHtml, sourcesBlock } from "./report";
import { SandboxRuntime, createSandbox } from "./sandbox";
import { RunState } from "./state";
import { AggregateForecast, Forecast, ForecastQuestion, MarketAnchor, RunMeta, RunStatus, SimDriver, SourceRef, Task, TaskSpec, Usage, usageCost } from "./types";
import { canonicalArtifactRel, clip, ensureDir, errMsg, oneLine, rid, sleep, truncateMiddle, validateArtifactFormat, withTimeout } from "./util";


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
  sharedNotes?: SwarmNote[];
  /** Team mode: write into the parent's run directory (artifacts, control). */
  runDirPath?: string;
}

/**
 * A blackboard note. Root and team tasks share one T1..Tn id namespace, so
 * claim bookkeeping must key on (teamId, taskId), not taskId alone.
 */
export interface SwarmNote {
  taskId?: string;
  teamId?: string;
  key?: string;
  kind?: string;
  text: string;
  url?: string;
}

/**
 * Tokens held back from the schedulable budget so synthesis always has
 * headroom: 3% of the cap clamped to [30K, 120K] for root runs, a flat 8K for
 * teams (their finale is a single consolidation call) — but never more than a
 * quarter of the cap, so a deliberately tiny budget still schedules real work.
 * Exported for tests.
 */
export function synthReserve(cap: number, mode: "root" | "team"): number {
  if (cap <= 0) return 0;
  const quarter = Math.floor(cap / 4);
  if (mode === "team") return Math.min(8_000, quarter);
  return Math.min(quarter, Math.min(120_000, Math.max(30_000, Math.floor(cap * 0.03))));
}

/**
 * Above this many tasks, synthesis goes map-reduce: parallel cheap-model
 * digests of ~10-task groups feed the synthesizer instead of the raw report
 * blob, which at that size would blow the 300K-char window and silently lose
 * whole tasks to middle-truncation. The synthesizer keeps read_report for
 * drill-down, so the digests are an index, not a ceiling.
 */
export const SYNTH_MAPREDUCE_THRESHOLD = 40;
const SYNTH_GROUP_SIZE = 10;

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
  private notes: SwarmNote[] = [];
  private phase: { name: string; goal?: string; exitCriteria?: string } | null = null;
  /** Run-scoped fetch/search cache — wide swarms hit the same pages and queries constantly. */
  private webCache = new Map<string, Promise<string>>();

  private conductorMessages: ChatMsg[] = [];
  private spentTokens = 0;
  private cost = 0;
  private finishing = false;
  private finishNotes = "";
  private finishReason = "";
  private fatal: string | null = null;
  /** "error" = the turn ended in a call failure, not a decision. */
  private lastConductorAction: "spawn" | "wait" | "finish" | "none" | "error" = "none";
  private conductorFailures = 0;
  private resumed = false;

  /**
   * Forecast mode: the sub-forecasts this run answers (1 for a clean question,
   * 2-6 when an open question decomposes), set before the conductor seeds.
   */
  private questions: ForecastQuestion[] = [];
  /** Forecast mode: the framing the sub-forecasts together answer (open questions). */
  private forecastBrief = "";
  /** Forecast mode: mechanical panel aggregates, keyed by question id, computed at synthesis. */
  private aggregates = new Map<string, AggregateForecast>();
  /** Forecast mode: panel tasks behind each aggregate (latest per method, per question). */
  private panelTasksByQ = new Map<string, Task[]>();
  /**
   * Forecast mode: the base "created" ledger record per sub-forecast (written
   * inline at aggregation for crash durability). The scenario-simulation stage
   * later appends an "updated" patch keyed to the same id — so a crash before
   * the simulation leaves a clean, sim-less record rather than losing it.
   */
  private forecastLedgerByQ = new Map<string, LedgerCreated>();

  /** The primary (first) sub-forecast — back-compat for readers that only need one. */
  private get question(): ForecastQuestion | null {
    return this.questions[0] ?? null;
  }
  /** The primary aggregate — back-compat for the summary/fallback singular readers. */
  private get aggregate(): AggregateForecast | null {
    const id = this.questions[0]?.id;
    return id ? (this.aggregates.get(id) ?? null) : null;
  }

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
    // Drop claims held by settled tasks — they were released on task end and
    // must not resurrect across a restart.
    const settled = new Set(
      state.taskList().filter((t) => ["done", "failed", "blocked"].includes(t.status) && !reset.has(t.id)).map((t) => t.id)
    );
    this.notes = state.notes
      .map((n) => ({ taskId: n.taskId, teamId: n.teamId, key: n.key, kind: n.kind, text: n.text, url: n.url }))
      // Team claims always drop: the owning child executor died with the
      // crash, and a re-run team task re-claims from scratch.
      .filter((n) => !(n.kind === "claim" && (n.teamId || (n.taskId && settled.has(n.taskId)))));
    const lastPhase = state.phases[state.phases.length - 1];
    if (lastPhase) this.phase = { name: lastPhase.name, goal: lastPhase.goal, exitCriteria: lastPhase.exitCriteria };
    // A sharpened/decomposed question set survives restarts via the journal —
    // never re-plan. Likewise computed aggregates: a crash between
    // forecast.aggregated and run.final must not re-aggregate and append
    // duplicate ledger records (aggregateAndLedger skips questions already
    // aggregated).
    this.questions = state.questions.length ? state.questions : state.question ? [state.question] : [];
    this.forecastBrief = state.forecastBrief;
    for (const a of state.aggregates) this.aggregates.set(a.questionId, a.aggregate);
    for (const q of this.questions) {
      if (q.id && this.aggregates.has(q.id)) this.panelTasksByQ.set(q.id, this.panelFromTasks(q.id));
    }
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

  private synthReserveTokens(): number {
    return synthReserve(this.meta.options.maxTokens, this.mode);
  }

  /**
   * "Exhausted" leaves a reserve for synthesis: scheduling and retries stop
   * while there is still headroom to compose the final report, so a run that
   * hits its cap ends with a deliverable instead of a budget error mid-synth.
   */
  private budgetExceeded(): boolean {
    return this.spentTokens >= this.meta.options.maxTokens - this.synthReserveTokens();
  }

  private blackboardDigest(max = 1800): string {
    if (!this.notes.length) return "";
    const fmt = (n: (typeof this.notes)[number]) =>
      `• ${n.kind && n.kind !== "finding" ? `[${n.kind}] ` : ""}${n.key ? `[${n.key}] ` : ""}${oneLine(n.text, 160)}${n.url ? ` <${n.url}>` : ""}${n.taskId ? ` (${n.taskId})` : ""}`;
    // Decisions and conflicts anchor mission-wide coherence and are never
    // trimmed out of the digest; everything else shows only its recent tail.
    const pinned = this.notes.filter((n) => n.kind === "decision" || n.kind === "conflict").map(fmt);
    const rest = this.notes.filter((n) => n.kind !== "decision" && n.kind !== "conflict").slice(-80).map(fmt);
    let tail = rest.join("\n");
    const budget = Math.max(400, max - pinned.join("\n").length);
    if (tail.length > budget) tail = tail.slice(tail.length - budget);
    return [pinned.join("\n"), tail].filter(Boolean).join("\n");
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

    // Forecast missions pin a precisely resolvable question before any
    // orchestration — the question's structure is engine-owned, not LLM-owned.
    // (Resumed runs already re-read it from the journal in seedFromState.)
    if (this.forecastMode() && !this.questions.length) {
      await this.planForecast();
    }
    const forecastDoctrine =
      this.forecastMode() && this.questions.length
        ? `\n\n${forecastConductorAddendum(this.questions, this.panelSize(), this.safeCalibrationBlock(), Boolean(this.meta.options.forecastOrigin), this.forecastBrief)}`
        : "";

    // Real-directory runs remember: prior missions in the same workspace feed
    // the conductor so it builds on settled decisions instead of starting cold.
    const memory = this.mode === "root" && !this.meta.sandbox ? memoryBlock(this.meta.cwd) : "";
    this.conductorMessages = [
      { role: "system", content: conductorSystem(this.meta) + forecastDoctrine + (memory ? `\n\n${memory}` : "") },
      {
        role: "user",
        content: this.resumed
          ? conductorUpdate({
              blackboard: this.blackboardDigest(),
              phase: this.phaseLine(),
              plan: this.planPin(),
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
    if (this.resumed) {
      // The conductor's reasoning history died with the old process. Re-seed
      // the durable facts into the same slot trimConductorHistory() maintains,
      // so a resumed conductor knows what settled and what was decided.
      this.conductorMessages.splice(1, 0, {
        role: "user",
        content: this.missionLedger("This run was resumed — prior orchestration history is gone."),
      });
    }

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

  // ---------------------------------------------------------------- forecasting

  /** Forecast behavior is root-only: team sub-swarms inherit meta.options but never run the pipeline. */
  private forecastMode(): boolean {
    return this.mode === "root" && (this.meta.options.mode ?? "research") === "forecast";
  }

  private panelSize(): number {
    const n = Number(this.meta.options.panelSize) || this.cfg.forecastPanelSize || 5;
    return Math.min(11, Math.max(3, Math.round(n)));
  }

  /** calibrationBlock reads the ledger from disk — a corrupt file must never kill a run. */
  private safeCalibrationBlock(): string {
    try {
      return calibrationBlock();
    } catch {
      return "";
    }
  }

  /**
   * Pre-step for forecast runs: turn the mission into the set of resolvable
   * sub-forecasts that best answers it. A clean question yields one; an
   * open-ended question fans out into several (each independently resolvable).
   * Best-effort and never blocks — decomposition → single-question sharpening
   * → a mechanically-built binary question, so a flaky model costs sharpness,
   * never the run. The chosen plan is journaled (forecast.plan) so the operator
   * sees exactly what is being forecast.
   */
  private async planForecast(): Promise<void> {
    const commit = (qs: ForecastQuestion[], brief: string) => {
      this.questions = qs.map((q, i) => ({ ...q, id: q.id ?? `sf${i + 1}` }));
      this.forecastBrief = brief;
      this.journal.append("forecast.plan", { brief, questions: this.questions });
      // Per-question events keep the primary-question state path working.
      for (const q of this.questions) this.journal.append("forecast.question", { question: q });
      // Human-readable echo so a detached run surfaces its interpretation in
      // the dashboard/log — best-effort transparency, never blocks.
      const echo =
        this.questions.length > 1
          ? `forecasting ${this.questions.length} sub-forecasts${brief ? ` — ${brief}` : ""}:\n` +
            this.questions.map((q) => `  • [${q.id}] (${q.kind}, by ${q.resolutionDate}) ${oneLine(q.text, 110)}`).join("\n")
          : `forecasting: ${oneLine(this.questions[0]?.text ?? "", 140)} (${this.questions[0]?.kind}, resolves ${this.questions[0]?.resolutionDate})`;
      this.journal.append("log", { level: "info", msg: echo });
    };

    // Tournament imports arrive already sharp (the platform wrote the precise
    // question and criteria) — re-planning would drift from what it resolves on.
    const preset = this.meta.options.presetQuestion;
    if (preset?.text && preset.resolutionCriteria && ISO_DATE.test(preset.resolutionDate ?? "")) {
      commit([preset], "");
      return;
    }

    const today = new Date(this.meta.createdAt).toISOString().slice(0, 10);
    const operatorDate = this.meta.options.resolutionDate;
    const maxN = Math.max(1, this.cfg.forecastMaxSubQuestions ?? 6);
    const decompose = this.cfg.forecastDecompose && !this.meta.options.forecastSingle;
    const ask = async (prompt: string, maxTokens: number): Promise<string> => {
      const res = await chat(this.cfg, {
        model: this.meta.options.conductorModel,
        priority: "high",
        messages: [{ role: "user", content: prompt }],
        thinking: false,
        maxTokens,
        signal: this.ac.signal,
      });
      this.onUsage(this.meta.options.conductorModel, res.usage);
      return res.content || "";
    };

    // 1) Open-ended decomposition (may return one sub-forecast for a clean mission).
    if (decompose) {
      let lastErr = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await ask(
            forecastPlanPrompt(this.meta.mission, today, operatorDate) +
              (lastErr ? `\n\nYour previous reply was unusable (${lastErr}). Reply with ONLY the JSON object.` : ""),
            2048
          );
          const plan = parseForecastPlan(out, operatorDate, today, maxN);
          if (plan) {
            commit(plan.questions, plan.brief);
            return;
          }
          lastErr = "not a valid {brief, questions:[...]} object";
        } catch (e) {
          if (this.ac.signal.aborted) return;
          lastErr = errMsg(e);
        }
      }
    }

    // 2) Single-question sharpening (--single, decomposition disabled, or it failed).
    let parsed: ForecastQuestion | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const out = await ask(
          sharpenQuestionPrompt(this.meta.mission, today, operatorDate) +
            (lastErr ? `\n\nYour previous reply was unusable (${lastErr}). Reply with ONLY the JSON object.` : ""),
          1024
        );
        parsed = parseQuestionJson(out, operatorDate);
        if (!parsed) lastErr = "not valid JSON with the required fields";
      } catch (e) {
        if (this.ac.signal.aborted) return;
        lastErr = errMsg(e);
      }
    }

    // 3) Mechanical fallback.
    if (!parsed) {
      const fallbackDate =
        operatorDate && ISO_DATE.test(operatorDate)
          ? operatorDate
          : new Date(this.meta.createdAt + 90 * 86_400_000).toISOString().slice(0, 10);
      parsed = {
        text: oneLine(this.meta.mission, 300),
        kind: "binary",
        resolutionCriteria:
          "Resolves YES if the event described in the question has occurred by the resolution date, per authoritative public reporting.",
        resolutionDate: fallbackDate,
      };
      this.journal.append("log", {
        level: "warn",
        msg: "question planning failed — using the mission verbatim as a binary question",
      });
    }
    commit([parsed], "");
  }

  /**
   * Validate and clamp a submit_forecast payload into a Forecast, or null
   * when the numbers are unusable (the task retries with a fresh agent).
   */
  private intakeForecast(args: Record<string, unknown>, q: ForecastQuestion | null): Forecast | null {
    if (!q) return null;
    const strList = (v: unknown, max: number) =>
      Array.isArray(v) && v.length ? v.map((x) => clip(String(x), 300)).slice(0, max) : undefined;
    const f: Forecast = {
      // Stamp the sub-forecast id so the panel partitions correctly when an
      // open question decomposed (omitted for single-question runs).
      ...(this.questions.length > 1 && q.id ? { questionId: q.id } : {}),
      method: canonicalMethodLabel(oneLine(String(args.method ?? "unspecified"), 60)),
      rationale: String(args.rationale ?? "").trim(),
      baseRates: strList(args.base_rates, 6),
      keyDrivers: strList(args.key_drivers, 8),
      updateTriggers: strList(args.update_triggers, 8),
      submittedAt: Date.now(),
    };
    if (q.kind === "binary") {
      let p = Number(args.probability);
      if (!Number.isFinite(p)) return null;
      // The schema asks for a 1-99 percentage; tolerate a 0-1 fraction. A bare
      // "1" is read as 1% (the schema's scale), not as certainty.
      if (p > 1) p = p / 100;
      else if (p === 1) p = 0.01;
      f.probability = clampProb(p);
      // Lenient: a missing prior never voids the intake — the analytical gate
      // enforces it with feedback the panelist can actually act on.
      const rawPrior = Number(args.prior);
      if (Number.isFinite(rawPrior)) {
        let pr = rawPrior;
        if (pr > 1) pr = pr / 100;
        else if (pr === 1) pr = 0.01;
        f.prior = clampProb(pr);
      }
    } else if (q.kind === "mc") {
      const probs = normalizeOptionProbs(args.option_probs, q.options ?? []);
      if (!probs) return null;
      f.optionProbs = probs;
    } else if (q.kind === "date") {
      // Quantiles arrive as ISO dates; the engine works in epoch-days.
      const partial: Partial<Record<"p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95", number>> = {};
      for (const key of ["p5", "p10", "p25", "p50", "p75", "p90", "p95"] as const) {
        if (args[key] === undefined) continue;
        const d = isoToDays(String(args[key]));
        if (d !== null) partial[key] = d;
      }
      const quantiles = monotoneQuantiles(partial);
      if (!quantiles) return null;
      f.quantiles = quantiles;
      let pn = Number(args.p_never);
      if (Number.isFinite(pn)) {
        if (pn > 1) pn = pn / 100;
        f.pNever = clampProb(pn);
      }
    } else {
      const partial: Partial<Record<"p5" | "p10" | "p25" | "p50" | "p75" | "p90" | "p95", number>> = {};
      for (const key of ["p5", "p10", "p25", "p50", "p75", "p90", "p95"] as const) {
        const v = Number(args[key]);
        if (args[key] !== undefined && Number.isFinite(v)) partial[key] = v;
      }
      const quantiles = monotoneQuantiles(partial);
      if (!quantiles) return null;
      f.quantiles = quantiles;
    }
    return f;
  }

  /** Human-readable headline for one panelist's forecast. */
  private forecastHeadline(f: Forecast): string {
    if (this.question?.kind === "mc" && f.optionProbs) {
      const ranked = Object.entries(f.optionProbs).sort((a, b) => b[1] - a[1]);
      return ranked.map(([opt, p]) => `"${oneLine(opt, 40)}" ${Math.round(p * 100)}%`).slice(0, 4).join(" · ");
    }
    if (this.question?.kind === "date" && f.quantiles) {
      const never = typeof f.pNever === "number" ? ` · P(never by horizon) ${Math.round(f.pNever * 100)}%` : "";
      return `p10 ${daysToIso(f.quantiles.p10)} / p50 ${daysToIso(f.quantiles.p50)} / p90 ${daysToIso(f.quantiles.p90)}${never}`;
    }
    if (this.question?.kind === "binary" || f.probability !== undefined) {
      return `P(YES) = ${Math.round((f.probability ?? 0.5) * 100)}%`;
    }
    const u = this.question?.unit ? ` ${this.question.unit}` : "";
    return `p10 ${f.quantiles!.p10}${u} / p50 ${f.quantiles!.p50}${u} / p90 ${f.quantiles!.p90}${u}`;
  }

  /** "prior 55% → final 62%" when the panelist committed a base-rate prior. */
  private priorNote(f: Forecast): string {
    return typeof f.prior === "number" && typeof f.probability === "number"
      ? ` (base-rate prior ${Math.round(f.prior * 100)}% → final ${Math.round(f.probability * 100)}%)`
      : "";
  }

  /**
   * Classic report derived from a structured forecast — shared by panelist
   * intake (runWorker) and the engine's coherence probe so every downstream
   * consumer (conductor digests, red-team, verifier, synthesizer, UI) sees
   * the same shape.
   */
  private forecastReportFields(f: Forecast): { report: string; keyFacts: string[] } {
    const headline = `${this.forecastHeadline(f)}${this.priorNote(f)}`;
    const report = [
      `FORECAST [${f.method}]: ${headline}`,
      "",
      f.rationale,
      f.baseRates?.length ? `\nBase rates:\n${f.baseRates.map((b) => `- ${b}`).join("\n")}` : "",
      f.keyDrivers?.length ? `\nKey drivers:\n${f.keyDrivers.map((d) => `- ${d}`).join("\n")}` : "",
      f.updateTriggers?.length ? `\nUpdate triggers:\n${f.updateTriggers.map((u) => `- ${u}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { report, keyFacts: [`${f.method} forecast: ${headline}`, ...(f.keyDrivers ?? []).slice(0, 4)] };
  }

  /** Structured sources from a terminal tool's args — only real http(s) URLs survive. */
  private parseSources(v: unknown): SourceRef[] {
    if (!Array.isArray(v)) return [];
    return (v as Record<string, unknown>[])
      .filter((s) => s && typeof s === "object" && /^https?:\/\//.test(String(s.url ?? "")))
      .slice(0, 80)
      .map((s) => ({
        url: clip(String(s.url), 500),
        title: s.title ? clip(String(s.title), 200) : undefined,
        date: s.date ? clip(String(s.date), 40) : undefined,
        note: s.note ? clip(String(s.note), 300) : undefined,
      }));
  }

  /** Resolve which sub-forecast a forecaster task answers; defaults to the primary. */
  private questionFor(task: Task): ForecastQuestion | null {
    if (!this.questions.length) return null;
    const id = task.questionId ?? extractQuestionRef(`${task.objective}\n${task.context ?? ""}`);
    return (id && this.questions.find((q) => q.id === id)) || this.questions[0];
  }

  /**
   * Latest usable forecast per method label for one sub-forecast — revisions
   * and the probe replace/extend originals. With one question (the common
   * case) every forecaster matches; with several, panelists are partitioned by
   * the question id stamped on their forecast.
   */
  private panelFromTasks(questionId?: string): Task[] {
    const q = questionId ? this.questions.find((x) => x.id === questionId) : this.question;
    if (!q) return [];
    const qid = q.id;
    const single = this.questions.length <= 1;
    const byMethod = new Map<string, Task>();
    for (const t of this.taskList()) {
      if (t.status !== "done" || !t.forecast) continue;
      // Partition by question id once decomposed; a forecast with no id belongs to the primary.
      if (!single && (t.forecast.questionId ?? this.questions[0].id) !== qid) continue;
      const prev = byMethod.get(t.forecast.method);
      if (!prev || prev.forecast!.submittedAt <= t.forecast.submittedAt) byMethod.set(t.forecast.method, t);
    }
    return [...byMethod.values()].filter((t) =>
      q.kind === "binary"
        ? typeof t.forecast!.probability === "number"
        : q.kind === "mc"
          ? Boolean(t.forecast!.optionProbs)
          : Boolean(t.forecast!.quantiles)
    );
  }

  /**
   * Engine-injected time-window discipline: a "by DATE" probability is about
   * the remaining window, not the topic in general. Computed at worker-spawn
   * time so multi-day runs don't drift. Scoped to the sub-forecast the task answers.
   */
  private hazardLine(q: ForecastQuestion | null = this.question): string {
    if (!q) return "";
    const today = new Date().toISOString().slice(0, 10);
    const deadline = Date.parse(`${q.resolutionDate}T23:59:59Z`);
    if (!Number.isFinite(deadline)) return "";
    const days = Math.ceil((deadline - Date.now()) / 86_400_000);
    return days >= 0
      ? `TIME WINDOW: today is ${today}; the question resolves ${q.resolutionDate} — ${days} day(s) remain. A "by date" probability is about THIS window: think in per-period hazard rates, and remember that less remaining time means less probability, whatever the headlines say.`
      : `TIME WINDOW: today is ${today}; the stated resolution date (${q.resolutionDate}) has already passed — forecast whether the event had occurred by that date, on the evidence available now.`;
  }

  /**
   * Mechanical panel aggregation + the persistent ledger record. Runs once,
   * at the top of synthesis: median + extremized geometric mean of odds for
   * binary panels, trimmed-mean quantiles for numeric ones. The latest
   * forecast per method label wins, so red-team revision rounds replace their
   * originals instead of double-counting. Binary aggregates are then anchored
   * toward a verified matching market price (best-effort, engine-owned).
   */
  private async aggregateAndLedger(): Promise<void> {
    if (!this.forecastMode() || !this.questions.length) return;
    // Read the resolved ledger once and reuse across every sub-forecast.
    let ledger: ReturnType<typeof loadLedger> = [];
    try {
      ledger = loadLedger();
    } catch {
      /* no ledger yet — defaults apply */
    }
    for (const q of this.questions) {
      if (!q.id || this.aggregates.has(q.id)) continue; // idempotent on resume
      await this.aggregateOne(q, ledger);
    }
    // Scenario simulation runs AFTER every panel aggregate exists (drivers may
    // span sub-forecasts). Base ledger records are already durable; the stage
    // appends an "updated" patch carrying the sim cross-check (best-effort).
    try {
      await this.simulationStage(ledger);
    } catch (e) {
      this.journal.append("log", { level: "warn", msg: `scenario simulation failed: ${errMsg(e)}` });
    }
  }

  /** Aggregate + ledger one sub-forecast. The math is the v0.13.0 pipeline, scoped to question q. */
  private async aggregateOne(q: ForecastQuestion, ledger: ReturnType<typeof loadLedger>): Promise<void> {
    const panel = this.panelFromTasks(q.id);
    if (!panel.length) {
      this.journal.append("log", {
        level: "warn",
        msg: `forecast: no panel forecasts submitted for ${q.id ?? "question"} — no aggregate`,
      });
      return;
    }
    let k = this.cfg.forecastExtremizeK;
    try {
      k = chooseExtremizeK(ledger, this.cfg.forecastExtremizeK);
    } catch {
      /* keep the configured k */
    }
    // Extremization assumes independent evidence: a panel that cited the same
    // pages holds fewer independent views than it has members, so k shrinks
    // with the panel's source overlap. Probability-shaped kinds only.
    const overlap =
      q.kind === "binary" || q.kind === "mc"
        ? evidenceOverlap(panel.map((t) => (t.sources ?? []).map((s) => s.url)))
        : 0;
    let mw: Record<string, number> = {};
    try {
      mw = q.kind === "binary" || q.kind === "mc" ? methodWeights(ledger) : {};
    } catch {
      /* equal weights */
    }
    const weights = panel.map((t) => mw[t.forecast!.method] ?? 1);
    let agg: AggregateForecast;
    try {
      agg =
        q.kind === "binary"
          ? aggregateBinary(panel.map((t) => t.forecast!.probability!), scaleK(k, overlap), weights)
          : q.kind === "mc"
            ? aggregateMc(panel.map((t) => t.forecast!.optionProbs!), q.options ?? [], scaleK(k, overlap), weights)
            : aggregateQuantiles(panel.map((t) => t.forecast!.quantiles!), k);
    } catch (e) {
      this.journal.append("log", { level: "error", msg: `forecast aggregation failed (${q.id}): ${errMsg(e)}` });
      return;
    }
    if (q.kind === "mc") agg.evidenceOverlap = overlap;
    // Date questions carry a separate never-mass. P(never-by-horizon) is a
    // binary forecast in disguise, so it gets the same extremized,
    // overlap-scaled GMO treatment as a binary panel — not the raw GMO.
    if (q.kind === "date") {
      const pNevers = panel
        .map((t) => t.forecast!.pNever)
        .filter((p): p is number => typeof p === "number")
        .map(clampProb);
      if (pNevers.length) {
        const dateOverlap = evidenceOverlap(panel.map((t) => (t.sources ?? []).map((s) => s.url)));
        const lo = pNevers.reduce((s, p) => s + Math.log(p / (1 - p)), 0) / pNevers.length;
        const kEff = pNevers.length > 1 ? scaleK(k, dateOverlap) : 1;
        const odds = Math.pow(Math.exp(lo), kEff);
        agg.pNever = clampProb(odds / (1 + odds));
      }
    }
    // Numeric & date intervals: correct systematic LLM over-confidence by
    // dilating the combined quantiles away from p50 (the within-forecaster
    // share the LOP can't fix). The factor is learned from the resolved record
    // and falls back to a conservative default; the pre-dilation quantiles are
    // kept so the next fit refits on un-dilated values — never circular. pNever
    // is a separate binary-style mass and stays untouched.
    if ((q.kind === "numeric" || q.kind === "date") && agg.quantiles) {
      const cal = fitQuantileCalibration(ledger);
      agg.predilationQuantiles = agg.quantiles;
      agg.dilation = { d: cal.d, source: cal.source, n: cal.n };
      if (cal.d !== 1) {
        agg.quantiles = applyQuantileDilation(agg.quantiles, cal.d, Boolean(agg.logSpace));
        this.journal.append("log", {
          level: "info",
          msg: `interval dilation (${q.id}, ×${cal.d}, ${cal.source}, n=${cal.n}): p10–p90 widened around the median`,
        });
      }
    }
    if (q.kind === "binary") {
      agg.evidenceOverlap = overlap;
      agg.components = { panelGmo: agg.gmo, extremized: agg.probability };
      // Market anchor: blend toward a verified market price in log-odds space
      // AFTER extremization (the market is already an aggregate).
      const anchor = await this.marketAnchor(q);
      if (anchor) {
        // The panel already carries ~one share of the market via its
        // market-anchored lens (forecasters consult market_odds), so the
        // mechanical blend must add only the RESIDUAL market weight — subtract
        // 1/n. 1/n is a deliberate upper bound on the embedded share (a future
        // learnable constant); store the effective weight so the ledger and
        // logs reflect what was actually applied.
        const wEff = Math.max(0, anchor.weight - 1 / panel.length);
        anchor.weight = Number(wEff.toFixed(4));
        const blended = blendWithMarket(agg.probability!, anchor.probability, wEff);
        agg.components.market = anchor;
        agg.components.blended = blended;
        agg.probability = blended;
        this.journal.append("log", {
          level: "info",
          msg: `market anchor (${q.id}): [${anchor.platform}] ${Math.round(anchor.probability * 100)}% (residual weight ${wEff.toFixed(2)} after −1/${panel.length} panel share) — panel ${Math.round(agg.components.extremized! * 100)}% → blended ${Math.round(blended * 100)}%`,
        });
      }
      // Recalibration: fitted on the ledger's own resolved record (pre-recalibration values).
      try {
        const recal = fitRecalibration(ledger);
        if (recal) {
          const r = applyRecalibration(agg.probability!, recal);
          agg.components.recalibrated = r;
          if (Math.abs(r - agg.probability!) >= 0.005) {
            this.journal.append("log", {
              level: "info",
              msg: `recalibration (${q.id}, a=${recal.a}, b=${recal.b}, n=${recal.n}): ${Math.round(agg.probability! * 100)}% → ${Math.round(r * 100)}%`,
            });
          }
          agg.probability = r;
        }
      } catch {
        /* recalibration is best-effort */
      }
    }
    if (q.id) {
      this.aggregates.set(q.id, agg);
      this.panelTasksByQ.set(q.id, panel);
    }
    const panelRecs = panel.map((t, i) => ({
      taskId: t.id,
      method: t.forecast!.method,
      probability: t.forecast!.probability,
      prior: t.forecast!.prior,
      quantiles: t.forecast!.quantiles,
      ...(t.forecast!.optionProbs ? { optionProbs: t.forecast!.optionProbs } : {}),
      ...(typeof t.forecast!.pNever === "number" ? { pNever: t.forecast!.pNever } : {}),
      ...(weights[i] !== 1 ? { weight: Number(weights[i].toFixed(3)) } : {}),
    }));
    const ledgerId = rid("f");
    this.journal.append("forecast.aggregated", { questionId: q.id, question: q, aggregate: agg, panel: panelRecs, ledgerId });
    // Cancelled runs keep the aggregate for the report but stay out of the
    // ledger — a half-run panel is not a forecast the system should be scored on.
    if (this.finishReason.includes("cancel")) return;
    const triggers = [...new Set(panel.flatMap((t) => t.forecast!.updateTriggers ?? []))].slice(0, 12);
    const origin = this.meta.options.forecastOrigin;
    const supersedes = this.meta.options.supersedes;
    const multi = this.questions.length > 1;
    const rec: LedgerCreated = {
      v: 1,
      rec: "created",
      id: ledgerId,
      runId: this.meta.id,
      t: Date.now(),
      question: q,
      aggregate: agg,
      panel: panelRecs,
      ...(triggers.length ? { triggers } : {}),
      ...(q.kind === "binary" || q.kind === "mc" ? { evidenceOverlap: overlap } : {}),
      ...(origin ? { origin } : {}),
      ...(supersedes ? { supersedes } : {}),
      // Sub-forecasts of one open question group by the run id + share the brief.
      ...(multi ? { setId: this.meta.id, brief: this.forecastBrief } : {}),
    };
    // Write the base record durably NOW (JSON.stringify snapshots the pre-sim
    // aggregate). The simulation stage appends an "updated" patch afterward, so
    // a crash in between can never lose the forecast — at worst it loses the
    // sim cross-check, leaving a clean base record.
    try {
      appendLedger(rec);
    } catch (e) {
      this.journal.append("log", { level: "warn", msg: `forecast ledger write failed: ${errMsg(e)}` });
    }
    if (q.id) this.forecastLedgerByQ.set(q.id, rec);
  }

  /**
   * Find a liquid market that is verifiably the same question and compute its
   * blend weight. Best-effort by design: any failure (no match, thin volume,
   * model hiccup, network) returns null and the panel number stands. A WRONG
   * anchor is worse than none, so the match must clear a term-overlap bar AND
   * a cheap-model same-question check.
   */
  private async marketAnchor(q: ForecastQuestion): Promise<MarketAnchor | null> {
    let base = this.cfg.forecastMarketWeight;
    if (!(base > 0)) return null;
    // Tournament leakage rule: a question imported FROM a market must not be
    // anchored back to market prices — the ledger's "did the panel beat the
    // market" signal (and every weight fitted on it) would become circular.
    if (this.meta.options.forecastOrigin) return null;
    try {
      base = chooseMarketWeight(loadLedger(), this.cfg.forecastMarketWeight);
    } catch {
      /* keep the configured weight */
    }
    const deadline = withTimeout(this.ac.signal, 45_000);
    try {
      const hits = await marketOdds(this.cfg, q.text, 8, deadline.signal);
      const terms = q.text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      if (!terms.length) return null;
      const relevance = (h: MarketHit) => {
        const hay = h.title.toLowerCase();
        return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) / terms.length;
      };
      // Manifold's play-money volumes are discounted to real-money-equivalent
      // terms BEFORE the floor and the liquidity weight — 25K mana clears the
      // same bar as $500. The discounted value is also what gets stored, so
      // chooseMarketWeight and the backtest refit on the weight actually used.
      const liquidity = (h: MarketHit) => {
        const raw = h.volume ?? (h.forecasters ? h.forecasters * 100 : 0);
        return h.platform === "manifold" ? raw / MANIFOLD_VOLUME_DISCOUNT : raw;
      };
      const candidates = hits
        .filter((h) => typeof h.probability === "number" && relevance(h) >= 0.5 && liquidity(h) >= 500)
        .sort((a, b) => liquidity(b) - liquidity(a));
      const best = candidates[0];
      if (!best) return null;
      const weight = base * liquidityFactor(liquidity(best));
      if (weight < 0.02) return null;
      // Same-question check: term overlap can't tell direction or deadline
      // apart ("Will X happen by June?" vs "Will X be banned by June?").
      const model = this.cfg.cheapModel || this.meta.options.model;
      const res = await chat(this.cfg, {
        model,
        priority: "high",
        messages: [
          {
            role: "user",
            content: `A forecasting engine wants to anchor its estimate to a prediction-market price, but only if the market is genuinely the SAME question.

QUESTION: ${q.text}
Resolution criteria: ${q.resolutionCriteria}
Resolution date: ${q.resolutionDate}

MARKET: [${best.platform}] ${best.title}${best.closes ? ` (closes ${best.closes})` : ""}

Same event, same direction (the market's YES means this question's YES), compatible deadline? Reply with exactly YES or NO.`,
          },
        ],
        thinking: false,
        maxTokens: 8,
        signal: deadline.signal,
      });
      this.onUsage(model, res.usage);
      if (!/^\s*YES\b/i.test(res.content || "")) return null;
      return {
        platform: best.platform,
        url: best.url,
        title: best.title,
        probability: clampProb(best.probability!),
        // Discounted (real-money-equivalent) volume — the number liquidityFactor saw.
        volume: liquidity(best),
        weight,
      };
    } catch (e) {
      this.journal.append("log", { level: "info", msg: `market anchor skipped: ${errMsg(e)}` });
      return null;
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Whether to run the grounded scenario simulation. Forced by the --simulate
   * flag (or the forecastSimulate config); otherwise auto-triggered when the
   * mission decomposed into 2+ sub-forecasts — the case where genuine grounded
   * sub-conditions exist to compose. Never blocks the run.
   */
  private shouldRunSimulation(): boolean {
    if (this.meta.options.forecastSimulate || this.cfg.forecastSimulate) return true;
    return this.questions.length >= 2;
  }

  /**
   * Build the grounded driver catalog for question q — the ONLY legal driver
   * universe, assembled entirely from deterministic-math outputs. The LLM may
   * reference these by handle but can neither extend the catalog nor supply a
   * marginal of its own. Primary drivers are genuine sub-conditions (sibling
   * sub-forecasts + q's verified market). Reference-class base rates are added
   * ONLY as a fallback when fewer than two primary drivers exist — using a base
   * rate of q as a "driver" of q is partly circular, so it is a last resort for
   * single-question runs, not material on a decomposed question.
   */
  private buildDriverCatalog(q: ForecastQuestion): SimDriver[] {
    const drivers: SimDriver[] = [];
    // Other sub-forecasts are the cleanest grounded sub-conditions.
    for (const sf of this.questions) {
      if (!sf.id || sf.id === q.id) continue;
      const agg = this.aggregates.get(sf.id);
      if (!agg) continue;
      const label = oneLine(sf.text, 80);
      if (sf.kind === "binary" && typeof agg.probability === "number") {
        drivers.push({ id: `sf_${sf.id}`, label, marginal: { kind: "binary", probability: clampProb(agg.probability) }, provenance: { kind: "sub-forecast", ref: sf.id, label } });
      } else if ((sf.kind === "numeric" || sf.kind === "date") && agg.quantiles) {
        drivers.push({
          id: `sf_${sf.id}`,
          label,
          marginal: { kind: "quantiles", quantiles: agg.quantiles, logSpace: Boolean(agg.logSpace) },
          threshold: agg.quantiles.p50,
          provenance: { kind: "sub-forecast", ref: sf.id, label },
        });
      }
      // mc sub-forecasts are not used as copula drivers in this version.
    }
    // The verified market anchor on q (binary only) is a grounded signal.
    const mkt = q.kind === "binary" && q.id ? this.aggregates.get(q.id)?.components?.market : undefined;
    if (mkt && typeof mkt.probability === "number") {
      const label = `market: ${oneLine(mkt.title ?? mkt.platform, 70)}`;
      drivers.push({ id: "mkt_0", label, marginal: { kind: "binary", probability: clampProb(mkt.probability) }, provenance: { kind: "market", ref: mkt.url, label } });
    }
    // Fallback only: reference-class base rates committed by the panel (numeric
    // percentages). Added solely to give an otherwise-driverless single question
    // something to compose — kept out of the decomposed case where the sibling
    // sub-forecasts are the clean, non-circular drivers.
    if (drivers.length < 2) {
      const panel = (q.id ? this.panelTasksByQ.get(q.id) : null) ?? this.panelFromTasks(q.id);
      const seen = new Set<number>();
      let bi = 0;
      for (const t of panel) {
        if (bi >= 4) break;
        for (const br of t.forecast?.baseRates ?? []) {
          if (bi >= 4) break;
          const m = /(\d+(?:\.\d+)?)\s*%/.exec(br); // requires an explicit % — avoids the 0.15-vs-15% ambiguity
          if (!m) continue;
          const p = Number(m[1]) / 100;
          if (!(p > 0.01 && p < 0.99)) continue;
          const bucket = Math.round(p * 100);
          if (seen.has(bucket)) continue;
          seen.add(bucket);
          const label = `base rate: ${oneLine(br, 70)}`;
          drivers.push({ id: `br_${bi}`, label, marginal: { kind: "binary", probability: clampProb(p) }, provenance: { kind: "base-rate", ref: br.slice(0, 120), label } });
          bi++;
        }
      }
    }
    return drivers;
  }

  /**
   * Engine-owned scenario simulation: a grounded forward Monte Carlo over the
   * first sub-forecast that has ≥2 grounded drivers. Best-effort and
   * conductor-independent (mirrors coherenceProbe). The LLM proposes only the
   * structure; the engine builds the catalog, runs the deterministic draws, and
   * blends the result into the headline ONLY at a weight the ledger has earned
   * (zero until then — a pure cross-check). Never blocks the run.
   */
  private async simulationStage(ledger: ReturnType<typeof loadLedger>): Promise<void> {
    if (!this.forecastMode() || !this.shouldRunSimulation()) return;
    if (this.ac.signal.aborted || this.finishReason.includes("cancel")) return;
    // Stage-level idempotence: exactly one simulation runs per run (the headline
    // outcome). If any question already carries a result — e.g. restored from the
    // journal on resume — the stage has already run; don't start a second one on
    // a different question.
    if (this.questions.some((q) => q.id && this.aggregates.get(q.id)?.simulationResult)) return;
    const forced = Boolean(this.meta.options.forecastSimulate || this.cfg.forecastSimulate);
    for (const q of this.questions) {
      if (!q.id) continue;
      const agg = this.aggregates.get(q.id);
      if (!agg || agg.simulationResult) continue; // idempotent across resume
      const catalog = this.buildDriverCatalog(q);
      if (catalog.length < 2) continue;
      if (this.budgetExceeded()) {
        this.journal.append("log", { level: "info", msg: "scenario simulation skipped — budget is in the synthesis reserve" });
        return;
      }
      await this.simulationStageOne(q, agg, catalog, ledger);
      return; // one simulation per run (the headline outcome) — bounds cost
    }
    // The operator explicitly asked for a simulation but nothing was eligible —
    // say so rather than silently producing no scenario analysis.
    if (forced) {
      this.journal.append("log", {
        level: "warn",
        msg: "scenario simulation requested (--simulate) but skipped — fewer than 2 grounded drivers (a single question with no matching market and no parseable base-rate percentages). Decompose the question or widen the panel.",
      });
    }
  }

  /** Elicit structure, run the Monte Carlo, and fold the result into one aggregate. */
  private async simulationStageOne(q: ForecastQuestion, agg: AggregateForecast, catalog: SimDriver[], ledger: ReturnType<typeof loadLedger>): Promise<void> {
    const research = this.taskList().filter((t) => t.status === "done" && !t.forecast);
    const evidence = research.length ? truncateMiddle(research.map(reportBlock).join("\n\n"), 12_000, "chars") : "";
    const model = this.cfg.cheapModel || this.meta.options.model;
    let proposal: ReturnType<typeof parseSimStructure> = null;
    try {
      const res = await chat(this.cfg, {
        model,
        priority: "high",
        messages: [{ role: "user", content: simStructurePrompt(q, catalog, evidence) }],
        thinking: false,
        maxTokens: 1500,
        signal: this.ac.signal,
      });
      this.onUsage(model, res.usage);
      proposal = parseSimStructure(res.content || "");
    } catch (e) {
      const why = this.ac.signal.aborted ? "cancelled" : `structure call failed: ${errMsg(e)}`;
      this.journal.append("log", { level: "info", msg: `scenario simulation (${q.id}): ${why}` });
      return;
    }
    if (!proposal) {
      this.journal.append("log", { level: "info", msg: `scenario simulation (${q.id}): structure parse failed — skipped` });
      return;
    }
    const v = validateSimStructure(proposal, catalog, q.kind, q.options);
    if (!v.ok || !v.spec) {
      this.journal.append("log", { level: "info", msg: `scenario simulation (${q.id}) rejected: ${v.reason}${v.dropped.length ? ` (dropped ungrounded: ${v.dropped.join(", ")})` : ""}` });
      return;
    }
    const result = runSimulation(v.drivers, v.spec, v.deps, 10_000, 1738, agg);
    let w = 0;
    try {
      w = chooseSimulationWeight(ledger, q.kind);
    } catch {
      /* weight stays 0 — pure cross-check */
    }
    const c = (agg.components = agg.components ?? {});
    const sa = result.simulatedAggregate;
    const pct = (p: number) => Math.round(p * 100);
    if (q.kind === "binary" && typeof sa.probability === "number") {
      c.simulated = sa.probability;
      const pre = c.recalibrated ?? c.blended ?? c.extremized ?? agg.probability ?? 0.5;
      const lod = (p: number) => Math.log(clampProb(p) / (1 - clampProb(p)));
      c.simDivergence = Number(Math.abs(lod(sa.probability) - lod(pre)).toFixed(3));
      c.simBlendWeight = w;
      if (w > 0) {
        agg.probability = blendWithMarket(pre, sa.probability, w);
        this.journal.append("log", { level: "info", msg: `simulation blend (${q.id}): panel ${pct(pre)}% + sim ${pct(sa.probability)}% (w=${w}) → ${pct(agg.probability)}%` });
      }
    } else if ((q.kind === "numeric" || q.kind === "date") && sa.quantiles) {
      c.simulatedQ = sa.quantiles;
      c.simDivergence = Number(result.coherence.divergence.toFixed(3));
      c.simBlendWeight = w;
      if (w > 0 && agg.quantiles) {
        agg.quantiles = blendQuantiles(agg.quantiles, sa.quantiles, w);
        this.journal.append("log", { level: "info", msg: `simulation blend (${q.id}): interval blended toward the bottom-up sim at w=${w}` });
      }
    } else if (q.kind === "mc" && sa.optionProbs) {
      c.simulatedOptionProbs = sa.optionProbs;
      c.simDivergence = Number(result.coherence.divergence.toFixed(3));
      c.simBlendWeight = w;
      if (w > 0 && agg.optionProbs) {
        agg.optionProbs = blendOptionProbs(agg.optionProbs, sa.optionProbs, w);
        this.journal.append("log", { level: "info", msg: `simulation blend (${q.id}): option probabilities blended toward the sim at w=${w}` });
      }
    }
    agg.simulationResult = result;
    // Patch the durable base ledger record with the sim-augmented aggregate.
    // Best-effort: the base record already stands on its own if this fails.
    // The base id comes from this run's map, or — on a resumed run where the map
    // is empty — from the already-written ledger record for this question.
    const baseId =
      (q.id ? this.forecastLedgerByQ.get(q.id)?.id : undefined) ??
      ledger.find((e) => e.runId === this.meta.id && e.question.id === q.id)?.id;
    if (baseId && !this.finishReason.includes("cancel")) {
      try {
        appendLedger({ v: 1, rec: "updated", id: baseId, t: Date.now(), aggregate: agg, simulationRan: true });
      } catch (e) {
        this.journal.append("log", { level: "warn", msg: `forecast ledger sim-update failed: ${errMsg(e)}` });
      }
    }
    // Carry the post-sim aggregate so a resumed run restores the simulation
    // (and any blended headline) and the idempotence gate fires — see state.ts.
    this.journal.append("forecast.simulated", {
      questionId: q.id,
      aggregate: agg,
      simulated: sa,
      scenarios: result.scenarios,
      sensitivity: result.sensitivity,
      coherence: result.coherence,
      drivers: result.drivers,
      weight: w,
      dropped: v.dropped,
    });
    const tag = w > 0 ? `blended at w=${w}` : "cross-check only";
    const div = result.coherence.verdict === "high" ? " — ⚠ diverges from the panel; see scenario analysis" : "";
    this.journal.append("log", {
      level: "info",
      msg: `scenario simulation (${q.id}): ${v.drivers.length} grounded drivers, ${result.scenarios.length} scenarios, modal "${oneLine(result.modalScenario?.description ?? "", 80)}" (${tag})${div}`,
    });
  }

  /** The simulation cross-check block for the synthesizer (the first simulated sub-forecast). */
  private forecastSimBlock(): string {
    for (const q of this.questions) {
      const agg = q.id ? this.aggregates.get(q.id) : null;
      if (agg?.simulationResult) return simulationBlock(q, agg.simulationResult, agg.components?.simBlendWeight ?? 0);
    }
    return "";
  }

  /**
   * The exact-numbers block(s) the synthesizer must echo. For a decomposed
   * question this is the brief plus one block per sub-forecast (in plan order);
   * for a single question it is one block, byte-identical to before.
   */
  private forecastBlocks(): string {
    const blocks: string[] = [];
    for (const q of this.questions) {
      const agg = q.id ? this.aggregates.get(q.id) : null;
      if (!agg) continue;
      const panelLines = (q.id ? (this.panelTasksByQ.get(q.id) ?? []) : []).map(
        (t) =>
          `- ${t.id} [${t.forecast!.method}] → ${this.forecastHeadline(t.forecast!)}${this.priorNote(t.forecast!)} — ${oneLine(t.forecast!.rationale, 160)}`
      );
      blocks.push(aggregateBlock(q, agg, panelLines));
    }
    if (!blocks.length) return "";
    if (blocks.length === 1) return blocks[0];
    const header = this.forecastBrief
      ? `OVERALL QUESTION: ${this.meta.mission}\nBRIEF: ${this.forecastBrief}\n${blocks.length} sub-forecasts:`
      : `${blocks.length} sub-forecasts:`;
    return `${header}\n\n${blocks.map((b, i) => `── SUB-FORECAST ${i + 1} ──\n${b}`).join("\n\n")}`;
  }

  /**
   * Engine-owned de-biasing probe: LLMs systematically inflate "Will X
   * happen?" because affirmative text dominates retrieval (P(X)+P(¬X) ≠ 1
   * when asked separately). The engine re-asks the question INVERTED with one
   * cheap agent, flips the answer, and folds it into the panel as method
   * "inverted-framing" — conductor-independent and deterministic.
   *
   * Atomic journaling: nothing is journaled until the probe completes, so it
   * never exists in a resumable "running" state — a crash mid-probe simply
   * loses it and the idempotence gate re-probes on resume.
   */
  private async coherenceProbe(): Promise<void> {
    if (!this.cfg.forecastCoherenceProbe || !this.forecastMode()) return;
    if (this.ac.signal.aborted || this.finishReason.includes("cancel")) return;
    // Probe each binary sub-forecast (cap to bound cost on a wide decomposition).
    const binaryQs = this.questions.filter((q) => q.kind === "binary").slice(0, 4);
    const primaryId = this.questions[0]?.id;
    for (const q of binaryQs) {
      if (this.budgetExceeded()) {
        this.journal.append("log", { level: "info", msg: "coherence probe skipped — budget is in the synthesis reserve" });
        return;
      }
      if (!this.panelFromTasks(q.id).length) continue;
      // Idempotent across resume, scoped per sub-forecast: the (method, question) pair is the marker.
      if (
        this.taskList().some(
          (t) => t.forecast?.method === "inverted-framing" && (t.forecast.questionId ?? primaryId) === q.id
        )
      )
        continue;
      await this.coherenceProbeOne(q);
    }
  }

  /** One inverted-framing probe for a single binary sub-forecast q. */
  private async coherenceProbeOne(q: ForecastQuestion): Promise<void> {
    const multi = this.questions.length > 1;
    const research = this.taskList().filter((t) => t.status === "done" && !t.forecast);
    const digest = research.length ? truncateMiddle(research.map(reportBlock).join("\n\n"), 30_000, "chars") : "";
    const agentId = rid("p");
    const model = this.cfg.cheapModel || this.meta.options.model;
    const system = `You are an independent forecaster answering the INVERTED form of a question — a deliberate check against affirmative-framing bias. Argue the NO case first.

${questionBlock(q)}

YOUR TASK: estimate the probability this question resolves NO — that the event does NOT occur per the criteria by the date.
${digest ? `\nRESEARCH GATHERED BY THE SWARM\n${digest}\n` : ""}
PROTOCOL
- Argue the strongest case for NO first (the status quo usually wins — count how often "nothing happens" won in comparable situations), then the strongest case for YES, then weigh them.
- Use web_search / fetch_url / market_odds only for load-bearing facts the research above doesn't cover; you have at most 8 tool steps.
- In submit_forecast, "probability" and "prior" mean P(NO) here. The engine flips them mechanically — just answer the question as asked, never 0 or 100.
- End with submit_forecast(...).`;

    // No stop hook (the run is finishing by design) and a tight wall clock —
    // operator control is no longer polled during synthesis, so a wedged
    // probe must kill itself.
    const all = workerToolset(this.cfg);
    const deadline = withTimeout(new AbortController().signal, 240_000);
    try {
      const outcome = await runAgent({
        cfg: this.cfg,
        agentId,
        model,
        thinking: this.meta.options.thinking,
        reasoningEffort: this.meta.options.reasoningEffort,
        system,
        kickoff: "Work the inverted question now, then call submit_forecast(...).",
        tools: { web_search: all.web_search, fetch_url: all.fetch_url, market_odds: all.market_odds },
        terminal: [submitForecastTool("binary")],
        maxSteps: 8,
        signal: deadline.signal,
        ctx: { ...this.makeToolCtx(agentId, null, deadline.signal), readBlackboard: () => "", searchNotes: undefined },
        // Quiet hooks: only usage counts; events are journaled atomically below.
        hooks: { onUsage: this.onUsage },
      });
      if (outcome.terminal?.name !== "submit_forecast") {
        this.journal.append("log", { level: "warn", msg: "coherence probe produced no forecast — panel unchanged" });
        return;
      }
      const args = outcome.terminal.args as Record<string, unknown>;
      const f = this.intakeForecast(args, q);
      if (!f || typeof f.probability !== "number") {
        this.journal.append("log", { level: "warn", msg: "coherence probe forecast was unusable — panel unchanged" });
        return;
      }
      // Flip into P(YES) space. The prior was committed in P(NO) space too —
      // drop it rather than risk a half-flipped pair (exempt from the gate).
      f.probability = clampProb(1 - f.probability);
      f.prior = undefined;
      f.method = "inverted-framing"; // engine-owned: dedup, ledger, and idempotence key on this label
      if (multi && q.id) f.questionId = q.id;
      f.rationale = `(Inverted-framing probe: the agent estimated P(NO); the engine flipped it to P(YES).) ${f.rationale}`;
      const derived = this.forecastReportFields(f);
      const sources = this.parseSources(args.sources);
      const now = Date.now();
      const task: Task = {
        id: this.allocId(), // deliberately exempt from maxTasks: exactly one engine task per run
        title: "Coherence probe — inverted framing",
        objective:
          "Engine-run de-biasing probe: forecast the inverted question (probability of NO), flipped back to P(YES) before aggregation.",
        role: "forecaster",
        deps: [],
        verify: false,
        status: "done",
        attempt: 1,
        wave: this.currentWave(),
        artifacts: [],
        createdAt: now,
        startedAt: now,
        endedAt: Date.now(),
        agentIds: [agentId],
        forecast: f,
        ...(multi && q.id ? { questionId: q.id } : {}),
        report: derived.report,
        reportStatus: "done",
        keyFacts: derived.keyFacts,
        sources: sources.length ? sources : undefined,
      };
      this.tasks.set(task.id, task);
      this.taskOrder.push(task.id);
      this.journal.append("task.created", { task });
      this.journal.append("agent.spawned", { agentId, taskId: task.id, role: "forecaster", model, purpose: task.title });
      this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });
      this.journal.append("forecast.submitted", { taskId: task.id, agentId, forecast: f });
      this.journal.append("task.report", {
        taskId: task.id,
        status: "done",
        report: task.report,
        artifacts: [],
        keyFacts: task.keyFacts,
        sources: task.sources,
      });
      this.journal.append("task.status", { taskId: task.id, status: "done", attempt: 1 });
      this.journal.append("log", {
        level: "info",
        msg: `coherence probe: P(NO) estimate flipped to P(YES)=${Math.round(f.probability * 100)}% and joined the panel as "inverted-framing"`,
      });
    } finally {
      deadline.dispose();
    }
  }

  /** Run a team:true task as a sub-swarm sharing this run's everything. */
  private async runTeam(task: Task): Promise<void> {
    const remaining = Math.max(0, this.meta.options.maxTokens - this.spentTokens);
    // A conductor-requested team size is honored but never above the run's own
    // parallelism cap; the default is half the parent, ceilinged at 32.
    const defaultWorkers = Math.max(2, Math.min(32, Math.floor(this.meta.options.maxWorkers / 2)));
    const workers = Math.min(task.teamMaxWorkers || defaultWorkers, this.meta.options.maxWorkers);
    const childMeta: RunMeta = {
      ...this.meta,
      mission: `${task.objective}${task.context ? `\n\nContext from the parent conductor:\n${task.context}` : ""}`,
      options: {
        ...this.meta.options,
        maxWorkers: workers,
        maxTokens: Math.min(remaining, task.teamBudgetTokens || Math.max(50_000, Math.floor(remaining / 4))),
        maxTasks: Math.min(this.meta.options.maxTasks, 24),
      },
    };
    // Clamps are visible, not silent: the operator should know when a team got
    // less than the conductor asked for, and why.
    if (task.teamMaxWorkers && workers < task.teamMaxWorkers) {
      this.journal.append("log", {
        level: "warn",
        msg: `${task.id}: team workers clamped ${task.teamMaxWorkers} → ${workers} (run maxWorkers)`,
      });
    }
    if (task.teamBudgetTokens && childMeta.options.maxTokens < task.teamBudgetTokens) {
      this.journal.append("log", {
        level: "warn",
        msg: `${task.id}: team budget clamped ${task.teamBudgetTokens} → ${childMeta.options.maxTokens} (remaining run budget)`,
      });
    }
    this.journal.append("team.created", {
      taskId: task.id,
      maxWorkers: childMeta.options.maxWorkers,
      budgetTokens: childMeta.options.maxTokens,
      requestedWorkers: task.teamMaxWorkers,
      requestedBudget: task.teamBudgetTokens,
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
    // The sub-swarm is over: claims its tasks left behind (e.g. after a child
    // cancellation) are no longer live and must not haunt the shared board.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.kind === "claim" && n.teamId === task.id) this.notes.splice(i, 1);
    }
    if (this.ac.signal.aborted) {
      this.finalizeTask(task, "failed", "run cancelled");
      return;
    }
    const report = child.teamReport || "(team produced no consolidated report)";
    for (const a of child.teamArtifacts()) if (!task.artifacts.includes(a)) task.artifacts.push(a);
    const ok = child.anyTaskDone();
    const reportStatus: "done" | "blocked" = ok ? "done" : "blocked";
    task.report = report;
    task.reportStatus = reportStatus;
    this.journal.append("team.report", { taskId: task.id, report, artifacts: task.artifacts });
    this.journal.append("task.report", { taskId: task.id, status: reportStatus, report, artifacts: task.artifacts });
    this.finalizeTask(task, ok ? "done" : "failed", report);
  }

  private async mainLoop(): Promise<void> {
      while (!this.finishing) {
        this.drainControl();
        if (this.finishing) break;
        if (this.budgetExceeded()) {
          this.finishing = true;
          this.finishReason = "token budget reached";
          const reserve = this.synthReserveTokens();
          if (reserve > 0) {
            this.journal.append("log", {
              level: "info",
              msg: `token budget reached — winding down with ~${Math.round(reserve / 1000)}K tokens reserved for synthesis`,
            });
          }
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
            if (this.lastConductorAction !== "spawn" && this.lastConductorAction !== "error") {
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
        this.lastConductorAction = "error";
        return;
      }
      this.conductorFailures = 0;
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

  /**
   * Forecast mode: every panelist must work a DISTINCT method, or the
   * latest-per-method dedup silently shrinks the panel ("five outside-views"
   * aggregate as one). Enforced at spawn time so no work is wasted; the whole
   * batch is rejected BEFORE id allocation, so the conductor's task-id
   * arithmetic stays intact and it simply re-spawns with corrected labels.
   * Revision tasks (depending on the red-team) legitimately reuse a label.
   * Unparseable labels degrade to advisory — never block.
   */
  private validatePanelDiversity(specs: TaskSpec[]): string | null {
    // Uniqueness is per sub-forecast: the same method label may appear once on
    // EACH sub-question's panel, but not twice on one. Key = questionId|label.
    const primaryId = this.questions[0]?.id ?? "sf1";
    const qOf = (text: string): string => extractQuestionRef(text) ?? primaryId;
    const seen = new Map<string, string>();
    for (const t of this.taskList()) {
      if (t.role !== "forecaster" || t.status === "failed" || t.status === "blocked") continue;
      const label = t.forecast?.method ?? extractMethodLabel(`${t.objective}\n${t.context ?? ""}`);
      if (label) seen.set(`${t.questionId ?? qOf(`${t.objective}\n${t.context ?? ""}`)}|${label}`, t.id);
    }
    for (const spec of specs) {
      if (String(spec.role ?? "").toLowerCase() !== "forecaster") continue;
      const text = `${spec.objective ?? ""}\n${spec.context ?? ""}`;
      const label = extractMethodLabel(text);
      if (!label) continue;
      const isRevision = (spec.deps ?? []).some((d) => this.tasks.get(String(d))?.role === "red-team");
      if (isRevision) continue;
      const key = `${qOf(text)}|${label}`;
      const dup = seen.get(key);
      if (dup) {
        const scope = this.questions.length > 1 ? ` for ${qOf(text)}` : "";
        return `Rejected — no tasks were created: forecaster method label "${label}" duplicates ${dup}${scope}. Every panelist on a sub-forecast needs a DISTINCT method (write "METHOD: <label>"${this.questions.length > 1 ? ' and "QUESTION: <id>"' : ""} in each forecaster objective; only red-team revision tasks may reuse a label). Re-spawn the batch with corrected labels.`;
      }
      seen.set(key, "this batch");
    }
    return null;
  }

  private handleSpawn(args: Record<string, unknown>): string {
    const specs = Array.isArray(args.tasks) ? (args.tasks as TaskSpec[]) : [];
    if (!specs.length) return "No tasks provided.";
    if (this.forecastMode()) {
      const diversity = this.validatePanelDiversity(specs);
      if (diversity) return diversity;
    }
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
      const role = (spec.role ? String(spec.role) : inferRole(spec)).toLowerCase();
      // Stamp the sub-forecast a forecaster answers (only when decomposed; one
      // question needs no tag and stays byte-identical to single-question runs).
      const questionId =
        role === "forecaster" && this.questions.length > 1
          ? (extractQuestionRef(`${spec.objective ?? ""}\n${spec.context ?? ""}`) ?? this.questions[0]?.id)
          : undefined;
      const task: Task = {
        id,
        title: clip(String(spec.title ?? "task"), 120),
        objective: String(spec.objective ?? spec.title ?? ""),
        role,
        ...(questionId ? { questionId } : {}),
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
    const room = Math.max(0, CAP - important.length);
    const fullDone = room > 0 ? done.slice(-room) : []; // slice(-0) would return everything
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
  private missionLedger(intro = "Earlier orchestration history was trimmed."): string {
    const lines: string[] = [`[${intro} MISSION LEDGER — durable state so far:]`];
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
    // Old conductor turns carry the bulk in thinking traces and verbose prose;
    // the durable decisions live in the ledger and the plan pin. Compact them
    // in place before resorting to dropping whole messages. (sanitizeMessages
    // backfills reasoning_content with "" for DeepSeek tool-call turns.)
    for (let i = 1; i < this.conductorMessages.length - 6; i++) {
      const m = this.conductorMessages[i];
      if (m.role !== "assistant") continue;
      if (m.reasoning_content) m.reasoning_content = "";
      if (m.content && m.content.length > 400) m.content = clip(m.content, 400);
    }
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
    const budget = Math.floor(contextLimitFor(this.cfg, this.meta.options.conductorModel) * 0.75);
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

  /** Walk a failed/blocked dep chain down to the task that actually failed. */
  private rootFailure(id: string): Task | undefined {
    let cur = this.tasks.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const next = cur.deps
        .map((d) => this.tasks.get(d))
        .find((t): t is Task => !!t && (t.status === "failed" || t.status === "blocked"));
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }

  private blockStuckTasks(): void {
    // Fixpoint: a failed dep chain T1→T2→T5 must block the whole chain in one
    // pass, not one level per conductor turn.
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of this.taskList()) {
        if (t.status !== "pending") continue;
        const bad = t.deps.find((d) => {
          const s = this.tasks.get(d)?.status;
          return s === "failed" || s === "blocked";
        });
        if (!bad) continue;
        // Carry the root cause so the conductor re-plans around the actual
        // failure, not a chain of "dependency did not complete".
        const root = this.rootFailure(bad);
        const cause = root ? oneLine(root.feedback ?? root.error ?? "unknown failure", 160) : "";
        t.status = "blocked";
        t.error =
          root && root.id !== bad
            ? `dependency ${bad} did not complete (root cause ${root.id}: ${cause})`
            : `dependency ${bad} did not complete${cause ? ` (${cause})` : ""}`;
        t.endedAt = Date.now();
        this.journal.append("task.status", { taskId: t.id, status: "blocked", attempt: t.attempt, reason: t.error });
        this.settledSinceUpdate.push(t.id);
        changed = true;
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

  private depReportsFor(task: Task, withholdForecasts = false): string {
    if (!task.deps.length) return "";
    // Excerpts, not full reports: a fan-in task with many deps must not blow
    // its context window on day one. Workers fetch full text with read_report.
    return task.deps
      .map((d) => {
        const dep = this.tasks.get(d);
        if (!dep) return `(${d}: missing)`;
        // Panel independence: even when the conductor mis-wires a forecaster
        // onto another forecaster, the number never reaches it.
        if (withholdForecasts && dep.forecast) {
          return `── dep ${dep.id} (${dep.role}) — WITHHELD: another panelist's forecast. Panel members stay independent; forecast from the research evidence alone.`;
        }
        return depReportBlock(dep);
      })
      .join("\n\n");
  }

  private makeToolCtx(agentId: string, task: Task | null, signal: AbortSignal = this.ac.signal): ToolCtx {
    return {
      cfg: this.cfg,
      meta: this.meta,
      runDirPath: this.runDirPath,
      workdir: this.sandbox.workdir,
      sandbox: this.sandbox,
      agentId,
      taskId: task?.id,
      signal,
      addCheckpoint: task ? (summary) => this.recordCheckpoint(task, agentId, summary) : undefined,
      addNote: (text, key, kind, url) => {
        this.notes.push({ taskId: task?.id, teamId: this.teamId, key, kind, text, url });
        // A note that cites a URL is evidence: stage it on the task so it
        // reaches the bibliography even if the agent forgets to repeat it in
        // report(sources:[...]) — report-time intake merges, not overwrites.
        if (task && url && /^https?:\/\//.test(url)) {
          const canon = canonicalizeUrl(url);
          task.sources = task.sources ?? [];
          if (task.sources.length < 80 && !task.sources.some((s) => canonicalizeUrl(s.url) === canon)) {
            task.sources.push({ url: clip(url, 500), note: clip(text, 200) });
          }
        }
        // Only the recent tail ever feeds digests; without a cap a multi-day
        // run accumulates every note in memory. Decisions and conflicts are
        // kept regardless. In-place splice: teams share this array by reference.
        if (this.notes.length > 4000) {
          const keep = (n: (typeof this.notes)[number]) => n.kind === "decision" || n.kind === "conflict";
          const pinnedCount = this.notes.filter(keep).length;
          let toDrop = this.notes.length - Math.max(pinnedCount, 4000);
          for (let i = 0; i < this.notes.length && toDrop > 0; ) {
            if (!keep(this.notes[i])) {
              this.notes.splice(i, 1);
              toDrop--;
            } else i++;
          }
        }
        this.journal.append("note.added", { taskId: task?.id, agentId, key, kind, url, text: clip(text, 1200) });
      },
      searchNotes: (q) => this.searchNotes(q),
      readReport: (taskId) => this.readReportText(taskId),
      checkClaim: (rel) => {
        const norm = rel.replace(/^\.\//, "");
        const claim = this.notes.find((n) => {
          if (n.kind !== "claim" || n.key !== norm || !n.taskId) return false;
          // Another executor's claim: its tasks aren't in this.tasks, but
          // claims are spliced out when their task settles (and when a team
          // ends), so presence alone means the holder is still live.
          if (n.teamId !== this.teamId) return true;
          return n.taskId !== task?.id && ["running", "verifying"].includes(this.tasks.get(n.taskId)?.status ?? "");
        });
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
      webCache: this.webCache,
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
            this.journal.append("task.status", {
              taskId: task.id,
              status: "running",
              attempt: task.attempt,
              reason: task.feedback || task.error,
            });
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
          task.error = `${errMsg(e)}${task.lastToolError ? ` (last tool failure: ${task.lastToolError})` : ""}`;
          task.status = "running";
          this.journal.append("task.status", { taskId: task.id, status: "running", attempt: task.attempt, reason: task.error });
          continue;
        }
        this.finalizeTask(task, "failed", `worker error: ${errMsg(e)}${task.lastToolError ? ` (last tool failure: ${task.lastToolError})` : ""}`);
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
    task.lastToolError = undefined; // diagnostics are per-attempt
    const dirListing = this.topListing();
    // Forecaster panelists run isolated (verifier-style): dep research reports
    // only, no blackboard, no note search — another panelist's number reaching
    // them would anchor the panel and undo the ensemble.
    const isForecaster = this.forecastMode() && this.questions.length > 0 && task.role === "forecaster";
    // The sub-forecast this panelist answers (the primary for single-question runs).
    const taskQ = isForecaster ? this.questionFor(task) : null;
    const system = workerSystem({
      agentId,
      role: task.role,
      meta: this.meta,
      task,
      maxSteps: this.meta.options.maxStepsPerTask,
      depReports: this.depReportsFor(task, isForecaster),
      blackboard: isForecaster ? "" : this.blackboardDigest(),
      operatorNotes: this.peekOperatorNotes(),
      dirListing,
      extraCraft: isForecaster
        ? [taskQ && this.questions.length > 1 ? questionBlock(taskQ) : "", this.hazardLine(taskQ), this.safeCalibrationBlock()]
            .filter(Boolean)
            .join("\n\n") || undefined
        : undefined,
      terminalName: isForecaster ? "submit_forecast" : "report",
    });
    const workerCtx = (signal: AbortSignal): ToolCtx =>
      isForecaster
        ? {
            ...this.makeToolCtx(agentId, task, signal),
            readBlackboard: () => "",
            searchNotes: undefined,
            // Another panelist's report is off-limits even via the tool.
            readReport: (taskId) => {
              const t = this.tasks.get(taskId.trim().toUpperCase());
              if (t?.forecast) return `${t.id} is another panelist — forecasts stay independent; you may not read it.`;
              return this.readReportText(taskId);
            },
          }
        : this.makeToolCtx(agentId, task, signal);
    this.journal.append("agent.spawned", {
      agentId,
      taskId: task.id,
      role: task.role,
      model,
      purpose: task.title,
    });

    // Per-attempt wall clock: a hung shell or stalled fetch aborts only this
    // attempt — run cancellation still flows through this.ac and is checked
    // separately below, so a timeout is never mistaken for a cancelled run.
    const timeoutMs = this.meta.options.taskTimeoutMs ?? 1_200_000;
    const deadline = withTimeout(this.ac.signal, timeoutMs);
    let outcome: Awaited<ReturnType<typeof runAgent>>;
    try {
      outcome = await runAgent({
        cfg: this.cfg,
        agentId,
        model,
        thinking: this.meta.options.thinking,
        reasoningEffort: this.meta.options.reasoningEffort,
        system,
        kickoff: isForecaster ? FORECASTER_KICKOFF : WORKER_KICKOFF,
        tools: workerToolset(this.cfg),
        terminal: isForecaster && taskQ ? [submitForecastTool(taskQ.kind, taskQ.options)] : [REPORT_TOOL],
        maxSteps: this.meta.options.maxStepsPerTask,
        signal: deadline.signal,
        ctx: workerCtx(deadline.signal),
        hooks: {
          ...this.agentHooks(agentId, task.id, task),
          onCheckpoint: (summary: string) => this.recordCheckpoint(task, agentId, summary),
        },
        stop: this.agentStop,
      });
    } catch (e) {
      if (deadline.timedOut() && !this.ac.signal.aborted) {
        this.flushDeltas(agentId);
        this.journal.append("agent.done", { agentId, taskId: task.id, steps: 0, timedOut: true });
        this.journal.append("log", {
          level: "warn",
          msg: `${task.id}: attempt ${task.attempt} timed out after ${Math.round(timeoutMs / 60_000)} min of wall-clock time`,
          agentId,
          taskId: task.id,
        });
        task.error = `task timed out after ${Math.round(timeoutMs / 60_000)} min of wall-clock time`;
        return "retry";
      }
      throw e;
    } finally {
      deadline.dispose();
    }
    this.flushDeltas(agentId);
    this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });

    if (this.ac.signal.aborted) return "done";

    if (!outcome.terminal) {
      const lastWords = oneLine(outcome.finalText ?? "", 200);
      task.error =
        "worker ended without reporting" +
        (task.lastToolError ? ` — last tool failure: ${task.lastToolError}` : "") +
        (lastWords ? `; last words: ${lastWords}` : "");
      return "retry";
    }
    if (outcome.terminal.name === "submit_forecast") {
      const args = outcome.terminal.args as Record<string, unknown>;
      const f = this.intakeForecast(args, taskQ);
      if (!f || !f.rationale) {
        task.error = "submit_forecast was missing a usable probability/quantiles or rationale";
        return "retry";
      }
      // Mechanical analytical gate: a forecast must be grounded (explicit
      // base-rate prior, named reference classes, real numbers) — prompts ask,
      // this enforces. Retry only while the run can afford it: at wind-down
      // or the attempt cap, a usable-but-ungrounded number still beats
      // shrinking the panel.
      const gate = taskQ ? validateForecastAnalytics(f, taskQ.kind) : null;
      if (gate) {
        if (task.attempt < this.cfg.verifyMaxAttempts && !this.finishing && !this.budgetExceeded()) {
          task.feedback = gate;
          this.journal.append("verify.result", { taskId: task.id, pass: false, feedback: gate, mechanical: true });
          return "retry";
        }
        this.journal.append("log", {
          level: "warn",
          msg: `${task.id}: forecast accepted without full analytical grounding (${task.attempt >= this.cfg.verifyMaxAttempts ? "attempt limit reached" : "run is winding down"})`,
        });
      }
      task.forecast = f;
      this.journal.append("forecast.submitted", { taskId: task.id, agentId, forecast: f });
      // Derive a classic report from the structured forecast so every
      // downstream consumer — conductor digests, dep handoffs, the red-team,
      // the verifier, the synthesizer, the UI — works unchanged. The
      // structured payload rides in task.forecast + the journal event.
      const derived = this.forecastReportFields(f);
      args.status = "done";
      args.report = derived.report;
      args.key_facts = derived.keyFacts;
    }
    const a = outcome.terminal.args as {
      status?: string;
      report?: string;
      artifacts?: string[];
      key_facts?: string[];
      open_questions?: string[];
      files_touched?: string[];
      sources?: unknown;
    };
    const report = String(a.report ?? "(empty report)");
    const reportStatus: "done" | "blocked" = a.status === "blocked" ? "blocked" : "done";
    // Normalize before merging: "artifacts/x.md", "workspace/x.md", "./x.md"
    // and absolute paths are all the same file save_artifact registered as
    // "x.md" — verbatim merging used to create phantom entries the mechanical
    // verifier then failed as "missing". When the canonical form resolves to
    // nothing but the verbatim name does (a real artifacts/ subdir in a
    // user-supplied cwd), the verbatim name wins; an unresolvable name is kept
    // verbatim so preVerify can fail it honestly instead of it vanishing.
    const artDir = path.join(this.runDirPath, "artifacts");
    const fileAt = (rel: string) =>
      this.artifactStat(path.join(artDir, rel)) || this.artifactStat(path.resolve(this.meta.cwd, rel));
    const reportedArtifacts = Array.isArray(a.artifacts)
      ? a.artifacts
          .map((x) => {
            const raw = String(x).trim();
            const canon = canonicalArtifactRel(raw, artDir, this.meta.cwd);
            if (!canon) return raw;
            if (canon !== raw && this.sandbox.localFs && !fileAt(canon) && fileAt(raw)) return raw;
            return canon;
          })
          .filter(Boolean)
      : [];
    for (const art of reportedArtifacts) if (!task.artifacts.includes(art)) task.artifacts.push(art);
    task.report = report;
    task.reportStatus = reportStatus;
    const strList = (v: unknown, max: number) =>
      Array.isArray(v) ? v.map((x) => clip(String(x), 300)).slice(0, max) : undefined;
    task.keyFacts = strList(a.key_facts, 8);
    task.openQuestions = strList(a.open_questions, 6);
    task.filesTouched = strList(a.files_touched, 40);
    // Structured sources: the citation pipeline's entry point. Only real
    // http(s) URLs survive; they flow into dep handoffs and the bibliography.
    // Reported sources merge with URLs the task posted via note(url=...)
    // during the run — reported entries win the dedup (they carry titles).
    const reported = this.parseSources(a.sources);
    const merged: SourceRef[] = [];
    const seen = new Set<string>();
    for (const s of [...reported, ...(task.sources ?? [])]) {
      const key = canonicalizeUrl(s.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
      if (merged.length >= 80) break;
    }
    task.sources = merged.length ? merged : undefined;
    if (task.role === "researcher" && !task.sources?.length) {
      this.journal.append("log", {
        level: "warn",
        msg: `${task.id} (researcher) reported with no sources — its findings cannot be cited in the final report`,
      });
    }
    this.journal.append("task.report", {
      taskId: task.id,
      status: reportStatus,
      report,
      artifacts: task.artifacts,
      keyFacts: task.keyFacts,
      openQuestions: task.openQuestions,
      filesTouched: task.filesTouched,
      sources: task.sources,
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

  /** True iff `p` is a non-empty regular file — directories never count as artifacts. */
  private artifactStat(p: string): boolean {
    try {
      const st = fs.statSync(p);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  /** Zero-token sanity checks before the LLM verifier. Returns failure feedback or null. */
  private preVerify(task: Task): string | null {
    const report = task.report ?? "";
    if (report.trim().length < 40) {
      return "Report is too thin to verify. Re-do the task and report concretely: what was done, what was verified, exact paths.";
    }
    const missing: string[] = [];
    const malformed: string[] = [];
    // Remote sandboxes own their filesystem — only check host-visible paths.
    if (this.sandbox.localFs) {
      const okAt = (p: string) => this.artifactStat(p);
      const artDir = path.join(this.runDirPath, "artifacts");
      for (const rel of task.artifacts) {
        // Check the canonical form too — names are normalized at report
        // intake, but resumed runs may carry pre-normalization entries.
        const canon = canonicalArtifactRel(rel, artDir, this.meta.cwd);
        const candidates = [...new Set([rel, canon].filter(Boolean))].flatMap((r) => [
          path.join(artDir, r),
          path.resolve(this.meta.cwd, r),
        ]);
        const found = candidates.find(okAt);
        if (!found) {
          missing.push(rel);
          continue;
        }
        // A deliverable that exists only in the workspace is invisible to the
        // operator (the hub serves runDir/artifacts) — copy it in so the
        // Artifacts tab link works. Best-effort: verification already passed.
        const inArtifacts = path.join(artDir, canon || rel);
        if (!found.startsWith(artDir + path.sep) && !okAt(inArtifacts)) {
          try {
            fs.mkdirSync(path.dirname(inArtifacts), { recursive: true });
            fs.copyFileSync(found, inArtifacts);
          } catch {
            /* leave it where it is */
          }
        }
        // Structural format check (json parses, csv is rectangular, html is
        // not a stub) — free, and catches what the LLM verifier wastes a whole
        // agent run discovering.
        const problem = validateArtifactFormat(found);
        if (problem) malformed.push(`${rel}: ${problem}`);
      }
    }
    if (missing.length) {
      return `Claimed artifact(s) do not exist or are empty: ${missing.join(", ")}. Actually create them (use save_artifact), then report again.`;
    }
    if (malformed.length) {
      return `Claimed artifact(s) are malformed — fix them and report again: ${malformed.join("; ")}`;
    }
    return null;
  }

  /** One verifier agent pass; returns the outcome plus how many evidence-gathering tool calls it made. */
  private async verifierAgent(task: Task, kickoff: string): Promise<{ outcome: AgentOutcome; evidenceCalls: number }> {
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
    let evidenceCalls = 0;
    const baseHooks = this.agentHooks(agentId, task.id);
    const outcome = await runAgent({
      cfg: this.cfg,
      agentId,
      model,
      thinking: this.meta.options.thinking,
      reasoningEffort: this.meta.options.reasoningEffort,
      system: verifierSystem(this.meta, task, this.depReportsFor(task)),
      kickoff,
      tools: verifierToolset(),
      terminal: [VERDICT_TOOL],
      maxSteps: Math.min(14, this.meta.options.maxStepsPerTask),
      signal: this.ac.signal,
      // Blind verification: the verifier judges deliverables against the
      // objective with its own tools — it must not inherit the swarm's shared
      // beliefs (blackboard) or the worker's narrative beyond the claims.
      // (Dep reports are settled upstream outputs, not the worker's story.)
      ctx: { ...this.makeToolCtx(agentId, task), readBlackboard: () => "", searchNotes: undefined },
      hooks: {
        ...baseHooks,
        onToolCall: (callId: string, name: string, args: unknown) => {
          if (name !== "verdict") evidenceCalls++;
          baseHooks.onToolCall(callId, name, args);
        },
      },
      stop: this.agentStop,
    });
    this.flushDeltas(agentId);
    this.journal.append("agent.done", { agentId, taskId: task.id, steps: outcome.steps });
    return { outcome, evidenceCalls };
  }

  private async runVerifier(task: Task): Promise<boolean> {
    const strict = this.cfg.verification === "strict";
    let { outcome, evidenceCalls } = await this.verifierAgent(task, VERIFIER_KICKOFF);
    if (this.ac.signal.aborted) return true;

    // Strict mode: a pass verdict backed by zero tool calls is an opinion,
    // not a verification. One re-run demanding evidence; a second tool-free
    // pass FAILS the task back to the worker — strict means verified, and an
    // unverifiable pass is exactly what strict mode exists to refuse.
    if (strict && outcome.terminal && Boolean((outcome.terminal.args as { pass?: boolean }).pass) && evidenceCalls === 0) {
      this.journal.append("log", {
        level: "info",
        msg: `verifier passed ${task.id} without evidence — re-running with a tools-required kickoff`,
      });
      const second = await this.verifierAgent(
        task,
        "A previous verdict on this task cited no tool-gathered evidence. Verify concretely NOW — read the claimed files, run the commands — then call verdict(...)."
      );
      if (this.ac.signal.aborted) return true;
      if (second.outcome.terminal) {
        outcome = second.outcome;
        if (second.evidenceCalls === 0 && Boolean((second.outcome.terminal.args as { pass?: boolean }).pass)) {
          this.journal.append("log", {
            level: "warn",
            msg: `verifier passed ${task.id} twice without gathering evidence — failing closed (strict)`,
          });
          task.feedback =
            "Verification could not be completed with concrete evidence. Make the deliverable independently checkable: exact file paths, runnable commands, and source URLs in the report.";
          this.journal.append("verify.result", { taskId: task.id, pass: false, feedback: task.feedback });
          return false;
        }
      }
    }

    const v = (outcome.terminal?.args ?? {}) as { pass?: boolean; feedback?: string; issues?: unknown };
    // No verdict returned: in strict mode fail closed, otherwise accept.
    const pass = outcome.terminal ? Boolean(v.pass) : !strict;
    let feedback = String(v.feedback ?? (outcome.terminal ? "" : "verifier produced no verdict"));
    // Structured issues become the retry's worklist — numbered, with evidence.
    const issues = Array.isArray(v.issues)
      ? (v.issues as Record<string, unknown>[])
          .filter((i) => i && typeof i === "object" && i.problem)
          .slice(0, 5)
          .map((i) => ({
            problem: oneLine(String(i.problem), 300),
            evidence: i.evidence ? oneLine(String(i.evidence), 300) : undefined,
            fix: i.fix ? oneLine(String(i.fix), 300) : undefined,
          }))
      : [];
    if (!pass && issues.length) {
      feedback = [
        feedback,
        ...issues.map(
          (i, n) =>
            `${n + 1}. ${i.problem}${i.evidence ? `\n   evidence: ${i.evidence}` : ""}${i.fix ? `\n   fix: ${i.fix}` : ""}`
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }
    task.feedback = feedback;
    this.journal.append("verify.result", {
      taskId: task.id,
      pass,
      feedback,
      ...(issues.length ? { issues } : {}),
    });
    return pass;
  }

  private finalizeTask(task: Task, status: Task["status"], reason?: string): void {
    task.status = status;
    task.endedAt = Date.now();
    if (reason && status !== "done") task.error = reason;
    // A settled task holds no file claims — release them so the digest and
    // search_notes don't accumulate dead claims on long runs. In-place splice:
    // teams share this array by reference.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.kind === "claim" && n.taskId === task.id && n.teamId === this.teamId) this.notes.splice(i, 1);
    }
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
        // Interim memory: a multi-day run that dies before synthesis still
        // leaves the next swarm in this workspace something to build on.
        if (!this.meta.sandbox) {
          appendMemory(this.meta.cwd, {
            runId: this.meta.id,
            mission: this.meta.mission,
            finishedAt: Date.now(),
            status: "in-progress",
            summary: clip(res.content, 600),
            keyDecisions: this.notes.filter((nt) => nt.kind === "decision").slice(-10).map((nt) => nt.text),
          });
        }
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
    // inflight.size over-counts verifying tasks slightly, but these are fuzzy
    // thresholds and this runs per streaming token — O(1) matters here.
    const load = this.inflight.size;
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

  private agentHooks(agentId: string, taskId: string, trackErrorsOn?: Task) {
    return {
      onDelta: (channel: "text" | "think", text: string) => {
        this.queueDelta(agentId, taskId, channel, text);
      },
      onToolCall: (callId: string, name: string, args: unknown) => {
        this.flushDeltas(agentId);
        this.journal.append("tool.call", { agentId, taskId, callId, name, args });
      },
      onToolResult: (callId: string, name: string, ok: boolean, summary: string, urls?: string[]) => {
        if (!ok && trackErrorsOn) trackErrorsOn.lastToolError = `${name}: ${oneLine(summary, 200)}`;
        this.journal.append("tool.result", { agentId, taskId, callId, name, ok, summary, ...(urls ? { urls } : {}) });
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
    // Forecast runs: first the engine's inverted-framing probe joins the
    // panel (de-biases affirmative framing), then the panel is combined
    // mechanically before any synthesis prose exists, and the exact numbers
    // are pinned into the synth prompt. Both are best-effort: a probe or
    // aggregation failure must never block the final report.
    try {
      await this.coherenceProbe();
    } catch (e) {
      this.journal.append("log", { level: "warn", msg: `coherence probe failed: ${errMsg(e)}` });
    }
    try {
      await this.aggregateAndLedger();
    } catch (e) {
      this.journal.append("log", { level: "error", msg: `forecast aggregation failed: ${errMsg(e)}` });
    }
    const tasks = this.taskList();
    let reports = tasks.length
      ? tasks.map(reportBlock).join("\n\n")
      : "(no tasks were completed)";
    // Map-reduce for large runs: pre-digest task groups in parallel so the
    // synthesizer integrates ALL findings instead of a middle-truncated blob.
    if (tasks.length >= SYNTH_MAPREDUCE_THRESHOLD) {
      try {
        reports = await this.mapReduceReports(tasks);
      } catch (e) {
        this.journal.append("log", {
          level: "warn",
          msg: `group pre-digest failed — synthesizing from raw (truncated) reports: ${errMsg(e)}`,
        });
      }
    }
    const artifactList = this.listArtifacts().join("\n") || "(none)";
    // The citation pipeline's last hop: every source any worker reported,
    // deduplicated and numbered, becomes the synthesizer's bibliography.
    const allSources = aggregateSources(tasks);
    const sourcesText = allSources.length ? truncateMiddle(sourcesBlock(allSources), 40_000, "chars") : "";
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
        system:
          synthSystem({
            meta: this.meta,
            finishNotes: [this.finishNotes, extraNote].filter(Boolean).join("\n\n"),
            reports: truncateMiddle(reports, 300_000, "chars"),
            blackboard: this.blackboardDigest(6000),
            artifactList,
            reason: this.finishReason || "completed",
            sources: sourcesText,
          }) + (this.aggregates.size ? `\n${forecastSynthAddendum(this.forecastBlocks(), this.aggregates.size, this.forecastBrief, this.forecastSimBlock())}` : ""),
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
    } catch (e) {
      // The whole run's work funnels through this one call — a transient
      // failure here must not collapse everything into the lossy fallback.
      this.journal.append("log", { level: "warn", msg: `synthesis failed (will retry once): ${errMsg(e)}` });
      try {
        await synthOnce();
      } catch (e2) {
        this.journal.append("log", { level: "error", msg: `synthesis retry failed: ${errMsg(e2)}` });
      }
    }
    if (!reportMarkdown.trim() && tasks.length) {
      // Succeeded-but-empty is the other path into the fallback; ask once more.
      try {
        await synthOnce("Your previous attempt returned an empty report. Produce the full final report now.");
      } catch (e) {
        this.journal.append("log", { level: "warn", msg: `empty-report synthesis retry failed: ${errMsg(e)}` });
      }
    }
    // Faithfulness check: compare the final report's claims against the task
    // reports (the ground truth) and re-synthesize once on discrepancies.
    // Strict mode always checks; normal mode checks once the run is big
    // enough that silent misrepresentation has room to hide (≥5 tasks).
    const checkFaithfulness =
      this.cfg.verification === "strict" || (this.cfg.verification === "normal" && tasks.length >= 5);
    if (checkFaithfulness && reportMarkdown.trim() && tasks.length) {
      try {
        const res = await chat(this.cfg, {
          model: this.meta.options.conductorModel,
          messages: [
            {
              role: "user",
              content: synthCheckPrompt(
                this.meta.mission,
                truncateMiddle(reports, 60_000, "chars"),
                truncateMiddle(reportMarkdown, 60_000, "chars"),
                sourcesText ? truncateMiddle(sourcesText, 20_000, "chars") : undefined
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
        runId: this.meta.id,
        mission: this.meta.mission,
        finishedAt: Date.now(),
        status,
        summary: clip(summary || reportMarkdown, 600),
        keyDecisions: this.notes.filter((n) => n.kind === "decision").slice(-10).map((n) => n.text),
      });
    }
  }

  /**
   * Pre-digest task reports for a large run: group by role (digests stay
   * coherent), chunk to SYNTH_GROUP_SIZE, summarize every group with parallel
   * cheap-model calls, and hand the synthesizer the digests plus a pointer to
   * read_report for full text. Any group failure falls back to that group's
   * raw (clipped) report blocks — the synthesizer never sees a hole.
   */
  private async mapReduceReports(tasks: Task[]): Promise<string> {
    const byRole = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = byRole.get(t.role) ?? [];
      list.push(t);
      byRole.set(t.role, list);
    }
    const groups: Task[][] = [];
    for (const list of byRole.values()) {
      for (let i = 0; i < list.length; i += SYNTH_GROUP_SIZE) groups.push(list.slice(i, i + SYNTH_GROUP_SIZE));
    }
    const model = this.cfg.cheapModel || this.meta.options.conductorModel;
    const digests = await Promise.all(
      groups.map(async (group, i) => {
        const ids = group.map((t) => t.id).join(", ");
        const raw = group.map(reportBlock).join("\n\n");
        try {
          const res = await chat(this.cfg, {
            model,
            priority: "high",
            messages: [
              {
                role: "user",
                content: `You are pre-digesting one group of task reports from a large agent-swarm run so the final synthesizer can integrate ALL of them without truncation.\n\nMISSION: ${this.meta.mission}\n\nCompress these ${group.length} ${group[0].role} task reports (group ${i + 1}/${groups.length}) into a dense digest of at most 500 words. PRESERVE: every distinct finding with its numbers, exact artifact paths, source URLs that anchor key claims, which task said what (cite task ids), and any disagreement between tasks. Drop process narration. Plain text only.\n\n${truncateMiddle(raw, 60_000, "chars")}`,
              },
            ],
            thinking: false,
            maxTokens: 2000,
            signal: new AbortController().signal,
          });
          this.onUsage(model, res.usage);
          const text = (res.content || "").trim();
          if (!text) throw new Error("empty digest");
          return `── group ${i + 1}/${groups.length} (${group[0].role}: ${ids})\n${text}`;
        } catch (e) {
          this.journal.append("log", { level: "warn", msg: `digest of group ${i + 1} failed (${errMsg(e)}) — using raw blocks` });
          return raw;
        }
      })
    );
    return (
      `(${tasks.length} tasks, pre-digested in ${groups.length} groups — full text of ANY task: read_report(task_id))\n\n` +
      digests.join("\n\n")
    );
  }

  private fallbackReport(tasks: Task[]): string {
    const lines = [`# ${this.meta.mission}`, ``, `_Run ${this.meta.id} — ${this.finishReason}_`, ``];
    // A forecast run's aggregate is the deliverable — it survives even when
    // the synthesizer doesn't.
    if (this.aggregates.size) lines.push(this.aggregates.size > 1 ? "## Forecasts" : "## Forecast", "", this.forecastBlocks(), "");
    // Even without a synthesizer, surface the cross-task essentials first.
    const facts = tasks.flatMap((t) => (t.keyFacts ?? []).map((f) => `- ${f} _(${t.id})_`));
    if (facts.length) lines.push(`## Key facts`, ...facts.slice(0, 60), "");
    for (const t of tasks) {
      lines.push(`## ${t.id} ${t.title} (${t.status})`);
      lines.push(t.report || t.error || "(no output)");
      if (t.artifacts.length) lines.push(`Artifacts: ${t.artifacts.join(", ")}`);
      lines.push("");
    }
    const sources = aggregateSources(tasks);
    if (sources.length) {
      lines.push(`## Sources`);
      for (const s of sources.slice(0, 100)) {
        lines.push(`${s.n}. [${s.title || s.url}](${s.url})${s.date ? ` (${s.date})` : ""}`);
      }
      if (sources.length > 100) lines.push(`…and ${sources.length - 100} more in the task reports.`);
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

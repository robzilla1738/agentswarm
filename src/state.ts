import {
  AggregateForecast,
  Forecast,
  ForecastQuestion,
  RunMeta,
  RunStatus,
  RunSummary,
  SwarmEvent,
  Task,
  Usage,
  ZERO_USAGE,
  addUsage,
  usageCost,
} from "./types";
import { ModelPrice } from "./types";
import { canonicalizeUrl } from "./searchcore";
import { WEB_SOURCE_TOOLS } from "./util";

export interface AgentView {
  id: string;
  taskId: string;
  role: string;
  model: string;
  purpose: string;
  status: "running" | "done";
  steps: number;
  startedAt: number;
  endedAt?: number;
  lastText: string;
  lastThink: string;
  lastTool?: string;
}

export interface BlackboardNote {
  t: number;
  taskId?: string;
  /** Set when a team agent posted it — task ids only disambiguate per team. */
  teamId?: string;
  agentId?: string;
  key?: string;
  /** finding | decision | conflict | open-question | handoff | claim (default finding) */
  kind?: string;
  text: string;
  /** Source URL backing the note, when it came from the web. */
  url?: string;
}

export interface PhaseInfo {
  t: number;
  name: string;
  goal?: string;
  exitCriteria?: string;
}

/**
 * Pure reducer over the journal. Both the live executor and the read-only hub
 * build identical state from the same events — the journal is the truth.
 */
export class RunState {
  meta: RunMeta | null = null;
  status: RunStatus = "planning";
  statusReason = "";
  tasks = new Map<string, Task>();
  taskOrder: string[] = [];
  agents = new Map<string, AgentView>();
  notes: BlackboardNote[] = [];
  phases: PhaseInfo[] = [];
  planExcerpt = "";
  conductorLog: { t: number; text: string }[] = [];
  operatorNotes: { t: number; text: string; consumed: boolean }[] = [];
  usageByModel = new Map<string, Usage>();
  totalUsage: Usage = { ...ZERO_USAGE };
  cost = 0;
  /** Sampled cumulative token spend over time (budget sparkline). */
  budgetSeries: { t: number; tokens: number; cost: number }[] = [];
  /** Distinct web sources touched (fetches, search hits, cited sources) — canonical URLs. */
  sourceUrls = new Set<string>();
  /** Forecast mode: the sharpened question, the panel's aggregate, and its ledger id. */
  question: ForecastQuestion | null = null;
  aggregate: AggregateForecast | null = null;
  forecastPanel: { taskId: string; method: string; probability?: number; quantiles?: { p10: number; p50: number; p90: number } }[] = [];
  ledgerId?: string;
  finalSummary?: string;
  finalReportPath?: string;
  lastSeq = 0;
  lastT = 0;
  createdAt = 0;
  updatedAt = 0;

  private pricing: Record<string, ModelPrice>;

  constructor(pricing: Record<string, ModelPrice> = {}) {
    this.pricing = pricing;
  }

  /** Sub-states for hierarchical teams, keyed by the owning task id. */
  teams = new Map<string, RunState>();

  apply(ev: SwarmEvent): void {
    this.lastSeq = ev.seq;
    this.lastT = ev.t;
    this.updatedAt = ev.t;
    // Team-stamped events reduce into their team's sub-state so a sub-swarm's
    // hundred tasks never pollute the root task list. Usage still rolls up
    // here — the run's budget/cost is one number.
    const teamId = typeof ev.teamId === "string" ? (ev.teamId as string) : undefined;
    if (teamId) {
      let team = this.teams.get(teamId);
      if (!team) {
        team = new RunState(this.pricing);
        this.teams.set(teamId, team);
      }
      const { teamId: _omit, ...rest } = ev;
      team.apply(rest as SwarmEvent);
      if (ev.type === "usage") {
        const u = ev.usage as Usage;
        const model = (ev.model as string) ?? "unknown";
        this.usageByModel.set(model, addUsage(this.usageByModel.get(model) ?? { ...ZERO_USAGE }, u));
        this.totalUsage = addUsage(this.totalUsage, u);
        this.cost += usageCost(u, this.pricing[model]);
        this.pushBudgetPoint(ev.t);
      } else if (ev.type === "note.added") {
        // The blackboard is shared swarm-wide at runtime, so team notes are
        // root facts too — without this, a resume would forget every note a
        // team agent posted (decisions included).
        this.pushNote(ev, teamId);
      } else if (ev.type === "tool.call" || ev.type === "tool.result") {
        // Sources roll up to the root like usage — a sub-swarm's research is
        // the run's research.
        this.trackSourceEvent(ev);
      }
      return;
    }
    switch (ev.type) {
      case "run.created": {
        this.meta = ev.meta as RunMeta;
        this.createdAt = this.meta.createdAt;
        if (this.meta.options) {
          // pricing may be passed through meta for the hub
        }
        break;
      }
      case "run.status":
        this.status = ev.status as RunStatus;
        if (ev.reason) this.statusReason = String(ev.reason);
        break;
      case "run.resumed": {
        // Tasks that were in flight when the engine died re-run from scratch;
        // agents the dead process owned can no longer be running.
        const resets = Array.isArray(ev.resets) ? (ev.resets as string[]) : [];
        for (const id of resets) {
          const t = this.tasks.get(id);
          if (t) {
            t.status = "pending";
            t.startedAt = undefined;
            t.endedAt = undefined;
          }
        }
        for (const a of this.agents.values()) {
          if (a.status === "running") {
            a.status = "done";
            a.endedAt = ev.t;
          }
        }
        this.statusReason = "";
        break;
      }
      case "task.created": {
        const t = ev.task as Task;
        if (!this.tasks.has(t.id)) this.taskOrder.push(t.id);
        this.tasks.set(t.id, { ...t });
        break;
      }
      case "task.status": {
        const t = this.tasks.get(ev.taskId as string);
        if (t) {
          t.status = ev.status as Task["status"];
          if (typeof ev.attempt === "number") t.attempt = ev.attempt;
          if (ev.status === "running" && !t.startedAt) t.startedAt = ev.t;
          if (["done", "failed", "blocked"].includes(String(ev.status))) t.endedAt = ev.t;
          if (ev.reason) t.error = String(ev.reason);
        }
        break;
      }
      case "task.report": {
        const t = this.tasks.get(ev.taskId as string);
        if (t) {
          t.report = ev.report as string;
          t.reportStatus = ev.status as "done" | "blocked";
          t.artifacts = (ev.artifacts as string[]) ?? t.artifacts;
          if (Array.isArray(ev.keyFacts)) t.keyFacts = ev.keyFacts as string[];
          if (Array.isArray(ev.openQuestions)) t.openQuestions = ev.openQuestions as string[];
          if (Array.isArray(ev.filesTouched)) t.filesTouched = ev.filesTouched as string[];
          if (Array.isArray(ev.sources)) {
            t.sources = ev.sources as Task["sources"];
            for (const s of t.sources ?? []) this.addSource(s.url);
          }
        }
        break;
      }
      case "task.checkpoint": {
        const t = this.tasks.get(ev.taskId as string);
        if (t) t.lastCheckpoint = ev.summary as string;
        break;
      }
      case "verify.result": {
        const t = this.tasks.get(ev.taskId as string);
        if (t) t.feedback = ev.feedback as string;
        break;
      }
      case "agent.spawned":
        this.agents.set(ev.agentId as string, {
          id: ev.agentId as string,
          taskId: ev.taskId as string,
          role: (ev.role as string) ?? "agent",
          model: (ev.model as string) ?? "",
          purpose: (ev.purpose as string) ?? "",
          status: "running",
          steps: 0,
          startedAt: ev.t,
          lastText: "",
          lastThink: "",
        });
        break;
      case "agent.delta": {
        const a = this.agents.get(ev.agentId as string);
        if (a) {
          if (ev.channel === "text") a.lastText = clipTail(a.lastText + (ev.text as string), 4000);
          else a.lastThink = clipTail(a.lastThink + (ev.text as string), 4000);
        }
        break;
      }
      case "agent.done": {
        const a = this.agents.get(ev.agentId as string);
        if (a) {
          a.status = "done";
          a.endedAt = ev.t;
          a.steps = (ev.steps as number) ?? a.steps;
        }
        break;
      }
      case "tool.call": {
        this.trackSourceEvent(ev);
        const a = this.agents.get(ev.agentId as string);
        if (a) {
          a.lastTool = ev.name as string;
          a.steps++;
        }
        break;
      }
      case "tool.result":
        this.trackSourceEvent(ev);
        break;
      case "plan.updated":
        this.planExcerpt = String(ev.excerpt ?? "");
        break;
      case "phase.set":
        this.phases.push({
          t: ev.t,
          name: String(ev.name ?? ""),
          goal: ev.goal as string | undefined,
          exitCriteria: ev.exit_criteria as string | undefined,
        });
        break;
      case "note.added":
        this.pushNote(ev);
        break;
      case "conductor.say":
        this.conductorLog.push({ t: ev.t, text: ev.text as string });
        if (this.conductorLog.length > 300) this.conductorLog.splice(0, this.conductorLog.length - 300);
        break;
      case "operator.note":
        this.operatorNotes.push({ t: ev.t, text: ev.text as string, consumed: false });
        break;
      case "operator.note.consumed": {
        const idx = this.operatorNotes.findIndex((n) => !n.consumed);
        if (idx >= 0) this.operatorNotes[idx].consumed = true;
        break;
      }
      case "usage": {
        const u = ev.usage as Usage;
        const model = (ev.model as string) ?? "unknown";
        this.usageByModel.set(model, addUsage(this.usageByModel.get(model) ?? { ...ZERO_USAGE }, u));
        this.totalUsage = addUsage(this.totalUsage, u);
        this.cost += usageCost(u, this.pricing[model]);
        this.pushBudgetPoint(ev.t);
        break;
      }
      case "forecast.question":
        this.question = ev.question as ForecastQuestion;
        break;
      case "forecast.submitted": {
        const t = this.tasks.get(ev.taskId as string);
        if (t) t.forecast = ev.forecast as Forecast;
        break;
      }
      case "forecast.aggregated":
        this.aggregate = ev.aggregate as AggregateForecast;
        if (Array.isArray(ev.panel)) this.forecastPanel = ev.panel as RunState["forecastPanel"];
        if (typeof ev.ledgerId === "string") this.ledgerId = ev.ledgerId;
        break;
      case "run.final":
        this.finalSummary = ev.summary as string;
        this.finalReportPath = ev.reportPath as string | undefined;
        break;
    }
  }

  /**
   * Sample the cumulative spend: a point per meaningful jump (≥0.5% of the
   * budget cap, or 2k tokens unbounded), halving resolution past 600 points.
   */
  private pushBudgetPoint(t: number): void {
    const tokens = this.totalUsage.promptTokens + this.totalUsage.completionTokens;
    const cap = this.meta?.options?.maxTokens ?? 0;
    const minStep = cap > 0 ? Math.max(2000, cap * 0.005) : 2000;
    const last = this.budgetSeries[this.budgetSeries.length - 1];
    if (last && tokens - last.tokens < minStep) {
      last.t = t;
      last.tokens = tokens;
      last.cost = this.cost;
      return;
    }
    this.budgetSeries.push({ t, tokens, cost: this.cost });
    if (this.budgetSeries.length > 600) {
      this.budgetSeries = this.budgetSeries.filter((_, i) => i % 2 === 0 || i === this.budgetSeries.length - 1);
    }
  }

  /** Record a distinct web source URL (canonicalized for dedup). */
  private addSource(raw: unknown): void {
    if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return;
    this.sourceUrls.add(canonicalizeUrl(raw));
  }

  /** Pull source URLs out of a web tool.call (args.url) or tool.result (urls[]). */
  private trackSourceEvent(ev: SwarmEvent): void {
    if (!WEB_SOURCE_TOOLS.has(String(ev.name))) return;
    if (ev.type === "tool.call") {
      const args = ev.args as Record<string, unknown> | undefined;
      if (args && typeof args === "object") this.addSource(args.url);
    } else if (ev.ok && Array.isArray(ev.urls)) {
      for (const u of ev.urls) this.addSource(u);
    }
  }

  private pushNote(ev: SwarmEvent, teamId?: string): void {
    if (typeof ev.url === "string") this.addSource(ev.url);
    this.notes.push({
      t: ev.t,
      taskId: ev.taskId as string | undefined,
      teamId,
      agentId: ev.agentId as string | undefined,
      key: ev.key as string | undefined,
      kind: ev.kind as string | undefined,
      text: ev.text as string,
      url: typeof ev.url === "string" ? ev.url : undefined,
    });
    // Reduced state is held live by the hub and the resume seed — keep only
    // the tail that digests/views actually use. Decisions and conflicts are
    // never dropped: they anchor long-horizon coherence. Forward-pass splice
    // (mirroring the executor's addNote): the array is permanently at the cap
    // once a long run passes it, so this runs on every note event — no
    // filter/sort allocations on the reducer hot path.
    if (this.notes.length > 1000) {
      const keep = (n: BlackboardNote) => n.kind === "decision" || n.kind === "conflict";
      let pinnedCount = 0;
      for (const n of this.notes) if (keep(n)) pinnedCount++;
      let toDrop = this.notes.length - Math.max(pinnedCount, 1000);
      for (let i = 0; i < this.notes.length && toDrop > 0; ) {
        if (!keep(this.notes[i])) {
          this.notes.splice(i, 1);
          toDrop--;
        } else i++;
      }
    }
  }

  taskList(): Task[] {
    return this.taskOrder.map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  activeAgents(): AgentView[] {
    return [...this.agents.values()].filter((a) => a.status === "running");
  }

  pendingOperatorNotes(): string[] {
    return this.operatorNotes.filter((n) => !n.consumed).map((n) => n.text);
  }

  summary(): RunSummary {
    const tasks = this.taskList();
    const count = (s: Task["status"]) => tasks.filter((t) => t.status === s).length;
    return {
      id: this.meta?.id ?? "",
      mission: this.meta?.mission ?? "",
      status: this.status,
      statusReason: this.statusReason || undefined,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      heartbeatAt: this.lastT,
      pid: null,
      model: this.meta?.options.model ?? "",
      tasks: {
        total: tasks.length,
        done: count("done"),
        failed: count("failed"),
        running: count("running") + count("verifying"),
        pending: count("pending"),
        blocked: count("blocked"),
      },
      agentsActive: this.activeAgents().length,
      usage: this.totalUsage,
      cost: this.cost,
      sourceCount: this.sourceUrls.size,
      finalSummary: this.finalSummary,
      ...(this.question
        ? {
            forecast: {
              p: this.aggregate?.probability,
              p50: this.aggregate?.quantiles?.p50,
              unit: this.question.unit,
              n: this.aggregate?.n ?? 0,
              resolutionDate: this.question.resolutionDate,
            },
          }
        : {}),
    };
  }
}

function clipTail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

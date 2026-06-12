// Core shared types for the agentswarm engine.

export type RunStatus =
  | "planning"
  | "running"
  | "synthesizing"
  | "done"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "blocked";

export type Verification = "off" | "normal" | "strict";

/** What kind of run this is. Forecast runs follow the superforecasting pipeline. */
export type RunMode = "research" | "forecast";

/** Binary questions resolve YES/NO; numeric questions resolve to a value. */
export type ForecastKind = "binary" | "numeric";

/** The sharpened, resolvable form of a forecast mission. */
export interface ForecastQuestion {
  /** Unambiguous question text, e.g. "Will the ECB cut its deposit rate before 2026-09-01?" */
  text: string;
  kind: ForecastKind;
  /** Exactly what counts as YES (binary) or how the value is measured (numeric). */
  resolutionCriteria: string;
  /** ISO date by which the question resolves. */
  resolutionDate: string;
  /** Unit for numeric questions ("%", "USD", "people"). */
  unit?: string;
}

/** One panelist's structured forecast (submit_forecast terminal tool). */
export interface Forecast {
  /** Primary method: outside-view | inside-view | trend | market-anchored | inverted-framing | ... */
  method: string;
  /** P(YES) in [0,1] — binary questions. */
  probability?: number;
  /**
   * The probability implied by the panelist's reference classes ALONE, before
   * current evidence — committing to it first makes the news-driven
   * adjustment (prior → final) explicit and attackable.
   */
  prior?: number;
  /** Quantile forecast — numeric questions. */
  quantiles?: { p10: number; p50: number; p90: number };
  rationale: string;
  baseRates?: string[];
  keyDrivers?: string[];
  updateTriggers?: string[];
  submittedAt: number;
}

/** Deterministic combination of the panel (computed in code, never by an LLM). */
export interface AggregateForecast {
  /** Headline P(YES): extremized geometric mean of odds. */
  probability?: number;
  /** Panel median (binary). */
  median?: number;
  /** Un-extremized geometric mean of odds. */
  gmo?: number;
  /** Extremization exponent used. */
  k: number;
  /** Trimmed-mean quantiles (numeric). */
  quantiles?: { p10: number; p50: number; p90: number };
  /** Panel size that actually submitted. */
  n: number;
  /** Disagreement: max−min of panel probabilities (binary) or relative p50 spread (numeric). */
  spread: number;
  /**
   * Mean pairwise Jaccard overlap of the panel's cited sources [0,1].
   * Extremization assumes independent evidence — k is scaled down by this.
   */
  evidenceOverlap?: number;
}

/** Internal effort scale; mapped per provider at request time. */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/** Where sandboxed runs execute (resolved from config at launch). */
export type SandboxRuntimeKind = "host" | "docker" | "e2b" | "modal" | "vercel";

export interface RunOptions {
  model: string;
  conductorModel: string;
  maxWorkers: number;
  maxStepsPerTask: number;
  maxTasks: number;
  /** Run-wide token budget (prompt + completion across every agent). */
  maxTokens: number;
  /** Wall-clock cap per worker attempt (ms); 0 disables. Missing on pre-0.10 runs — readers default it. */
  taskTimeoutMs?: number;
  /** Run mode. Missing on pre-forecast runs — readers default to "research". */
  mode?: RunMode;
  /** Forecast mode: operator-supplied resolution date (ISO) for the question. */
  resolutionDate?: string;
  /** Forecast mode: independent forecaster panel size (3–11). */
  panelSize?: number;
  verification: Verification;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  safeMode: boolean;
  sandboxRuntime: SandboxRuntimeKind;
}

export interface RunMeta {
  id: string;
  mission: string;
  createdAt: number;
  /** Directory worker tools operate in. */
  cwd: string;
  sandbox: boolean;
  options: RunOptions;
}

/** A web source a worker's findings rest on — flows into the final report's bibliography. */
export interface SourceRef {
  url: string;
  title?: string;
  /** Publication date if known (ISO or year). */
  date?: string;
  /** What this source supports. */
  note?: string;
}

/** What the conductor submits via spawn_tasks. */
export interface TaskSpec {
  title: string;
  objective: string;
  role?: string;
  deps?: string[];
  verify?: boolean;
  context?: string;
  /** Model tier: cheap for scouts/bulk, strong for leads and verified deliverables. */
  model?: "cheap" | "default" | "strong";
  /** Run this task as a sub-swarm with its own conductor (one level deep). */
  team?: boolean;
  teamMaxWorkers?: number;
  teamBudgetTokens?: number;
}

export interface Task {
  id: string;
  title: string;
  objective: string;
  role: string;
  deps: string[];
  verify: boolean;
  context?: string;
  status: TaskStatus;
  attempt: number;
  wave: number;
  /** Resolved model tier from the spawn spec. */
  modelTier?: "cheap" | "default" | "strong";
  /** This task runs as a sub-swarm (hierarchical team). */
  team?: boolean;
  teamMaxWorkers?: number;
  teamBudgetTokens?: number;
  report?: string;
  reportStatus?: "done" | "blocked";
  artifacts: string[];
  feedback?: string;
  error?: string;
  /** Last failing tool call of the current attempt — diagnostic context for retries and the conductor. */
  lastToolError?: string;
  /** Latest progress summary journaled by a worker (compaction or checkpoint tool). */
  lastCheckpoint?: string;
  /** Structured handoff fields from the worker's report. */
  keyFacts?: string[];
  openQuestions?: string[];
  filesTouched?: string[];
  /** Web sources the worker's findings rely on (report tool's `sources`). */
  sources?: SourceRef[];
  /** Structured forecast from a forecaster task (submit_forecast terminal). */
  forecast?: Forecast;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  agentIds: string[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface RunSummary {
  id: string;
  mission: string;
  status: RunStatus;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  pid: number | null;
  model: string;
  tasks: {
    total: number;
    done: number;
    failed: number;
    running: number;
    pending: number;
    blocked: number;
  };
  agentsActive: number;
  usage: Usage;
  cost: number;
  /** Distinct web sources touched so far (searches, fetches, cited sources). */
  sourceCount?: number;
  finalSummary?: string;
  /** Forecast runs: the headline aggregate once computed. */
  forecast?: { p?: number; p50?: number; unit?: string; n: number; resolutionDate: string };
}

/**
 * Journal events. Kept intentionally loose — `type` discriminates, payload
 * fields ride alongside. The journal (events.jsonl) is the single source of
 * truth for a run; both the terminal renderer and the web UI reduce it.
 *
 * Event types and payloads:
 *  run.created     { meta: RunMeta }
 *  run.resumed     { resets: string[] }
 *  run.status      { status: RunStatus, reason? }
 *  conductor.update{ text }                       — digest sent to the conductor
 *  conductor.say   { text }                       — conductor's visible commentary
 *  conductor.action{ kind, detail }               — spawn/wait/finish decision
 *  task.created    { task: Task }
 *  task.status     { taskId, status, attempt, reason? }
 *  task.report     { taskId, status, report, artifacts, keyFacts?, openQuestions?, filesTouched?, sources? }
 *  verify.result   { taskId, pass, feedback, issues? }
 *  task.checkpoint { taskId, agentId, attempt, summary } — durable progress marker
 *  agent.spawned   { agentId, taskId, role, model, purpose }
 *  agent.done      { agentId, taskId, steps }
 *  agent.delta     { agentId, taskId, channel: "text"|"think", text }
 *  tool.call       { agentId, taskId, callId, name, args }
 *  tool.result     { agentId, taskId, callId, ok, summary }
 *  note.added      { taskId, agentId, key?, kind?, url?, text }
 *  phase.set       { name, goal, exit_criteria }       — conductor milestone
 *  usage           { agentId, model, usage: Usage, cost }
 *  budget          { spentTokens, capTokens, cost }
 *  operator.note   { text }
 *  run.final       { summary, reportPath }
 *  log             { level: "info"|"warn"|"error", msg }
 *  forecast.question   { question: ForecastQuestion }           — sharpened question (forecast mode)
 *  forecast.submitted  { taskId, agentId, forecast: Forecast }  — one panelist's forecast
 *  forecast.aggregated { aggregate: AggregateForecast, panel: {taskId,method,probability?,p50?}[], ledgerId? }
 */
export interface SwarmEvent {
  seq: number;
  t: number;
  type: string;
  [k: string]: unknown;
}

export interface ModelPrice {
  /** $ per 1M cache-miss input tokens */
  inMiss: number;
  /** $ per 1M cache-hit input tokens */
  inHit: number;
  /** $ per 1M output tokens */
  out: number;
}

export const ZERO_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
  };
}

export function usageCost(u: Usage, price: ModelPrice | undefined): number {
  if (!price) return 0;
  const miss = u.cacheMissTokens || Math.max(0, u.promptTokens - u.cacheHitTokens);
  return (
    (miss * price.inMiss + u.cacheHitTokens * price.inHit + u.completionTokens * price.out) / 1e6
  );
}

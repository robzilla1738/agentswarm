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

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export type RunMode = "research" | "forecast" | "code";
export type ForecastKind = "binary" | "numeric" | "mc" | "date";

export interface Quantiles {
  p5?: number;
  p10: number;
  p25?: number;
  p50: number;
  p75?: number;
  p90: number;
  p95?: number;
}

/** A de-vigged sportsbook line snapshot (the anchor + CLV baseline for a sports facet). */
export interface SportsLineSnapshot {
  pHome?: number;
  pDraw?: number;
  pAway?: number;
  /** Favorite's point spread (positive magnitude). */
  spread?: number;
  /** Over/under total points. */
  total?: number;
  t: number;
}

/** Carried on sub-forecasts the engine decomposed from one real game (winner / total / margin). */
export interface SportsMeta {
  sportTitle: string;
  home: string;
  away: string;
  commence: string;
  facet: "winner" | "total" | "margin";
  favorite: "home" | "away";
  sigma?: number;
  /** The line at forecast time — the anchor and the market-relative scoring baseline. */
  lineAtCreate?: SportsLineSnapshot;
  /** The line near tip-off — captured later for CLV. */
  lineAtClose?: SportsLineSnapshot;
}

export interface ForecastQuestion {
  /** Stable sub-forecast id within a run ("sf1"), set when an open question fans out. */
  id?: string;
  text: string;
  kind: ForecastKind;
  resolutionCriteria: string;
  resolutionDate: string;
  unit?: string;
  options?: string[];
  /** The domain pack that planned this question (finance, macro, sports, …). */
  domain?: string;
  /** Set on sub-forecasts decomposed from one real game — the matched betting line + matchup. */
  sports?: SportsMeta;
}

/** One driver ranked by how much outcome variance it explains (tornado input). */
export interface SensitivityIndex {
  driverId: string;
  driverLabel: string;
  /** First-order correlation ratio η² in [0,1] — share of outcome variance from this driver. */
  varianceContribution: number;
  linearCorrelation: number;
}

/** One scenario cluster from the Monte Carlo: a pattern of which drivers fired, and its conditional outcome. */
export interface ScenarioRow {
  key: string;
  /** Fraction of simulated worlds in this cluster [0,1]. */
  frequency: number;
  outcome: AggregateForecast;
  description: string;
}

/**
 * The grounded scenario simulation for one sub-forecast (forecast.simulated):
 * a bottom-up Monte Carlo cross-check the UI renders as scenarios + a driver
 * tornado + a coherence verdict against the top-down panel.
 */
export interface SimulationView {
  /** Blend weight into the headline (0 = cross-check only, never moved the number). */
  weight: number;
  /** Ids of proposed drivers that were filtered out as ungrounded (provenance). */
  dropped?: string[];
  /** Bottom-up simulated aggregate (before blending onto the panel headline). */
  simulated?: AggregateForecast;
  scenarios: ScenarioRow[];
  sensitivity: SensitivityIndex[];
  coherence: { divergence: number; verdict: "ok" | "moderate" | "high" };
  drivers: { id: string; label: string; provenance?: { kind: string; ref: string; label: string } }[];
}

export interface ForecastOrigin {
  kind: "tournament";
  platform: string;
  externalId: string;
  url: string;
  marketProbAtCreate?: number;
}

export interface Forecast {
  method: string;
  probability?: number;
  /** Base-rate prior committed before current evidence (binary). */
  prior?: number;
  quantiles?: Quantiles;
  optionProbs?: Record<string, number>;
  pNever?: number;
  rationale: string;
  baseRates?: string[];
  keyDrivers?: string[];
  updateTriggers?: string[];
  submittedAt: number;
}

export interface MarketAnchor {
  platform: string;
  url: string;
  title?: string;
  probability: number;
  volume?: number;
  weight: number;
}

/** Every layer of the aggregation chain, recorded so the UI can show the full derivation. */
export interface AggregateComponents {
  panelGmo?: number;
  extremized?: number;
  market?: MarketAnchor;
  blended?: number;
  recalibrated?: number;
  /** After the H2 sequential update on a re-forecast (--supersedes) — the published binary headline. */
  superseded?: number;
  /** Scenario-simulation bottom-up headline (binary), blended in only once it earns weight. */
  simulated?: number;
  /** The simulation blend weight actually applied to the headline (0 until the ledger earns it trust). */
  simBlendWeight?: number;
  /** The sportsbook line a numeric sports facet (total/margin) was anchored to, and how hard. */
  marketLine?: { line: number; sigma: number; lineKind: "total" | "margin"; weight: number };
}

export interface AggregateForecast {
  probability?: number;
  median?: number;
  gmo?: number;
  k: number;
  quantiles?: Quantiles;
  /** Combined quantiles before interval dilation (numeric/date). */
  predilationQuantiles?: Quantiles;
  /** Interval dilation applied to the quantiles and where the factor came from (dLo/dUp = per-tail). */
  dilation?: { d: number; source: "default" | "learned"; n: number; dLo?: number; dUp?: number };
  optionProbs?: Record<string, number>;
  pNever?: number;
  logSpace?: boolean;
  n: number;
  spread: number;
  /** Mean pairwise source overlap of the panel [0,1] — extremization shrinks with it. */
  evidenceOverlap?: number;
  components?: AggregateComponents;
}

export interface ForecastPanelist {
  taskId: string;
  method: string;
  probability?: number;
  prior?: number;
  quantiles?: Quantiles;
  optionProbs?: Record<string, number>;
  pNever?: number;
  weight?: number;
}

/** One sub-forecast of a decomposed question: its question, aggregate, panel, and optional simulation. */
export interface SubForecast {
  questionId: string;
  question: ForecastQuestion;
  aggregate: AggregateForecast | null;
  panel: ForecastPanelist[];
  ledgerId?: string;
  simulation?: SimulationView;
}

/** One ledger entry from /api/forecasts (created record + optional resolution). */
export interface LedgerEntry {
  v: 1;
  id: string;
  runId: string;
  t: number;
  question: ForecastQuestion;
  aggregate: AggregateForecast;
  panel: ForecastPanelist[];
  triggers?: string[];
  evidenceOverlap?: number;
  domain?: string;
  modelId?: string;
  origin?: ForecastOrigin;
  supersedes?: string;
  resolution?: {
    id: string;
    t: number;
    outcome: 0 | 1 | number | string | "void";
    evidence: string;
    sources: string[];
    resolvedBy: "swarm" | "operator";
    brier?: number;
    logScore?: number;
    intervalScore?: number;
    pinball?: number;
  };
}

export interface CalibrationStats {
  n: number;
  brierMean: number;
  bins: { lo: number; hi: number; n: number; meanP: number; hitRate: number }[];
  byMethod: Record<string, { n: number; brierMean: number }>;
  byDomain?: Record<string, { n: number; brierMean: number }>;
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
  report?: string;
  reportStatus?: "done" | "blocked";
  artifacts: string[];
  feedback?: string;
  error?: string;
  lastCheckpoint?: string;
  keyFacts?: string[];
  openQuestions?: string[];
  filesTouched?: string[];
  sources?: { url: string; title?: string; date?: string; note?: string }[];
  /** Structured forecast from a forecaster task (forecast runs). */
  forecast?: Forecast;
  /** Client-derived: distinct source URLs this task has touched so far (live). */
  liveSourceCount?: number;
  modelTier?: "cheap" | "default" | "strong";
  /** Code mode: files this task owns exclusively (from the pinned build plan). */
  ownedFiles?: string[];
  /** Code mode: run as a best-of-N ensemble of N isolated attempts. */
  ensemble?: number;
  team?: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  agentIds: string[];
}

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
  /** finding | decision | conflict | open-question | handoff | claim */
  kind?: string;
  text: string;
  /** Source URL backing the note, when it came from the web. */
  url?: string;
}

export interface ConductorSay {
  t: number;
  text: string;
}

export interface OperatorNote {
  t: number;
  text: string;
  consumed: boolean;
}

export interface RunMeta {
  id: string;
  mission: string;
  createdAt: number;
  cwd: string;
  sandbox: boolean;
  options: {
    model: string;
    conductorModel: string;
    maxWorkers: number;
    maxStepsPerTask: number;
    maxTasks: number;
    maxTokens: number;
    verification: string;
    thinking: boolean;
    reasoningEffort: string;
    safeMode: boolean;
    mode?: RunMode;
    resolutionDate?: string;
    panelSize?: number;
  };
}

export interface RunSummary {
  id: string;
  mission: string;
  status: RunStatus;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
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
  sourceCount?: number;
  pid: number | null;
  finalSummary?: string;
  /** Forecast runs: the headline aggregate once computed. */
  forecast?: { p?: number; p50?: number; unit?: string; kind?: "binary" | "numeric" | "mc" | "date"; n: number; resolutionDate: string };
}

export interface RunSnapshot {
  id: string;
  meta: RunMeta;
  status: RunStatus;
  statusReason: string;
  summary: RunSummary;
  tasks: Task[];
  agents: AgentView[];
  notes: BlackboardNote[];
  conductorLog: ConductorSay[];
  operatorNotes: OperatorNote[];
  usageByModel: Record<string, Usage>;
  cost: number;
  finalSummary?: string;
  finalReportPath?: string;
  question?: ForecastQuestion | null;
  aggregate?: AggregateForecast | null;
  forecastPanel?: ForecastPanelist[];
  ledgerId?: string;
  live: boolean;
  lastSeq: number;
}

export interface SwarmEvent {
  seq: number;
  t: number;
  type: string;
  [k: string]: unknown;
}

export interface ActivityItem {
  id: string;
  t: number;
  agentId: string;
  taskId: string;
  kind: "tool" | "result" | "note" | "report" | "spawn" | "done";
  name?: string;
  ok?: boolean;
  text: string;
}

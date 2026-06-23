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

/** What kind of run this is. Forecast runs follow the superforecasting pipeline;
 *  code runs follow the software-engineering pipeline (recon → build → green-gate). */
export type RunMode = "research" | "forecast" | "code";

/**
 * Binary questions resolve YES/NO; numeric to a value; mc to one of a fixed
 * option list; date to the day an event first occurs (or "never" by the
 * horizon). Date questions ride the numeric quantile machinery in epoch-days.
 */
export type ForecastKind = "binary" | "numeric" | "mc" | "date";

/** Quantile forecast. p10/p50/p90 are the required spine; the rest sharpen the distribution. */
export interface Quantiles {
  p5?: number;
  p10: number;
  p25?: number;
  p50: number;
  p75?: number;
  p90: number;
  p95?: number;
}

/** The sharpened, resolvable form of a forecast mission (or one sub-forecast of an open question). */
export interface ForecastQuestion {
  /**
   * Stable id within a run, e.g. "sf1". Lets panelists, aggregates, and ledger
   * rows be partitioned when one open question fans out into several
   * sub-forecasts. Absent on legacy single-question records (readers default
   * to the primary question).
   */
  id?: string;
  /** Unambiguous question text, e.g. "Will the ECB cut its deposit rate before 2026-09-01?" */
  text: string;
  kind: ForecastKind;
  /** Exactly what counts as YES (binary) or how the value is measured (numeric). */
  resolutionCriteria: string;
  /** ISO date by which the question resolves (the horizon, for date questions). */
  resolutionDate: string;
  /** Unit for numeric questions ("%", "USD", "people"). */
  unit?: string;
  /** The exhaustive option list for mc questions (2–8 distinct options). */
  options?: string[];
  /**
   * Set on sub-forecasts the engine decomposed from a single sporting event
   * (winner / total / margin). Carries the matched sportsbook line so the
   * aggregation anchors to it, and the keys the /scores resolver needs.
   */
  sports?: SportsMeta;
  /**
   * The domain pack that planned this question. Persisted on the question (not
   * just the run) so a resumed run and the resolver still know the domain.
   */
  domain?: DomainId;
  /**
   * Normalized reference-class key the resolved outcome is filed under (e.g.
   * "infra_project_schedule_slip"), so future forecasts can read a COUNTED base
   * rate from accumulated history instead of an LLM guess. Set by the pack.
   */
  refClass?: string;
}

/** A sportsbook line snapshot — the values relevant to a game's three facets, and when it was taken. */
export interface SportsLineSnapshot {
  /** De-vigged home-team win probability. */
  pHome?: number;
  /** De-vigged draw probability — present only for 3-way (soccer-style) books. */
  pDraw?: number;
  /** De-vigged away-team win probability — stored for 3-way books (where independent leg medians need not sum to 1; for 2-way it is exactly 1−pHome). */
  pAway?: number;
  /** Favorite's point spread (positive magnitude). */
  spread?: number;
  /** Over/under total points. */
  total?: number;
  /** Capture time (ms). */
  t: number;
}

/**
 * Provenance for a sub-forecast the engine derived from one sporting event.
 * The matched betting line is the strongest public predictor of the game, so
 * the engine anchors the facet's aggregate to it (lineAtCreate) and resolves
 * the game from the official box score via The Odds API /scores.
 */
export interface SportsMeta {
  /** The Odds API sport key, e.g. "basketball_nba" — needed by /scores. */
  sportKey: string;
  /** The Odds API event id — a re-fetch handle for the closing line (CLV). */
  eventId: string;
  /** League label, e.g. "NBA" — drives the per-sport σ. */
  sportTitle: string;
  home: string;
  away: string;
  /** ISO commence time. */
  commence: string;
  /** Which resolvable facet of the game this sub-forecast is. */
  facet: "winner" | "total" | "margin";
  /** Favorite side — the margin sign convention (favorite − underdog). */
  favorite: "home" | "away";
  /** Per-sport game-to-game SD used to map the total/margin line to quantiles. */
  sigma?: number;
  /** The line at forecast time — the CLV baseline and the market-relative scoring baseline. */
  lineAtCreate?: SportsLineSnapshot;
  /** The line near tip-off — captured later by `swarm sports close` for CLV. */
  lineAtClose?: SportsLineSnapshot;
}

/**
 * Provenance of an externally-imported (tournament) question. The source
 * platform publishes its own resolution — free ground truth — and its price
 * at import time is the benchmark the swarm is scored against.
 */
export interface ForecastOrigin {
  kind: "tournament";
  platform: "manifold" | "polymarket" | "kalshi" | "metaculus";
  externalId: string;
  url: string;
  /** The market's own P(YES) when the question was imported. */
  marketProbAtCreate?: number;
}

/** One panelist's structured forecast (submit_forecast terminal tool). */
export interface Forecast {
  /** Which sub-forecast this panelist answered (ForecastQuestion.id). Absent → the run's primary question. */
  questionId?: string;
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
  /** Quantile forecast — numeric questions (epoch-days for date questions). */
  quantiles?: Quantiles;
  /** Per-option probabilities summing to 1 — mc questions. */
  optionProbs?: Record<string, number>;
  /** P(the event does NOT occur by the horizon) — date questions. */
  pNever?: number;
  rationale: string;
  baseRates?: string[];
  keyDrivers?: string[];
  updateTriggers?: string[];
  submittedAt: number;
}

/** The market price the engine anchored an aggregate to, and how hard. */
export interface MarketAnchor {
  platform: string;
  url: string;
  title?: string;
  /** The market's P(YES) at aggregation time. */
  probability: number;
  volume?: number;
  /** Effective blend weight in log-odds space (config weight × liquidity factor). */
  weight: number;
}

/**
 * Every layer of the aggregation chain, stored so each can be re-fit honestly
 * later (backtests re-blend from these instead of the final number).
 */
export interface AggregateComponents {
  /** Un-extremized geometric mean of odds of the panel. */
  panelGmo?: number;
  /** After overlap-scaled extremization — the panel-only headline. */
  extremized?: number;
  market?: MarketAnchor;
  /** After the market blend (pre-recalibration). */
  blended?: number;
  /** After ledger-fitted recalibration — when present, this is the headline. */
  recalibrated?: number;
  /**
   * After the H2 sequential update on a re-forecast (--supersedes) — when present,
   * this is the published binary headline, so the simulation blend (and the
   * sim-weight refit) read the post-supersede value instead of discarding it.
   */
  superseded?: number;
  /** mc option probabilities BEFORE the learned recalibration — what the next mc-recal fit must read, so it is never circular. */
  preRecalOptionProbs?: Record<string, number>;
  /** Scenario-simulation bottom-up headline (binary/mc) — a cross-check, blended only once it earns weight. */
  simulated?: number;
  /** Scenario-simulation bottom-up quantiles (numeric/date) — the interval cross-check. */
  simulatedQ?: Quantiles;
  /** Scenario-simulation bottom-up per-option probabilities (mc) — the cross-check. */
  simulatedOptionProbs?: Record<string, number>;
  /** Divergence between the simulation and the panel headline (log-odds distance for binary; relative for numeric). */
  simDivergence?: number;
  /** The simulation blend weight actually applied to the headline (0 until the ledger earns it trust). */
  simBlendWeight?: number;
  /** Numeric/date quantiles BEFORE the simulation blend — what a future sim-weight refit must read so it is never circular (mirrors preRecalOptionProbs). */
  preSimQuantiles?: Quantiles;
  /** mc option probabilities BEFORE the simulation blend — the non-circular value a future sim-weight refit reads. */
  preSimOptionProbs?: Record<string, number>;
  /**
   * The sportsbook line a numeric sports facet (total/margin) was anchored to,
   * and how hard. Present only when the facet matched a betting line.
   */
  marketLine?: { line: number; sigma: number; lineKind: "total" | "margin"; weight: number };
  /**
   * Numeric sports facet AFTER interval dilation but BEFORE the line blend —
   * the value a future sports-market-weight refit scores on (never circular).
   */
  blendedQ?: Quantiles;
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
  /** Combined quantiles, dilated for calibration (numeric; epoch-days for date questions). */
  quantiles?: Quantiles;
  /** The combined quantiles BEFORE interval dilation — the value future dilation refits on (never circular). */
  predilationQuantiles?: Quantiles;
  /** The interval dilation actually applied to the quantiles, and where the factor came from. */
  dilation?: { d: number; source: "default" | "learned"; n: number; dLo?: number; dUp?: number };
  /** Per-option probabilities, extremized GMO renormalized to sum 1 (mc). */
  optionProbs?: Record<string, number>;
  /** GMO of the panel's P(never by horizon) — date questions. */
  pNever?: number;
  /** Numeric panels with heavy positive skew aggregate in log space. */
  logSpace?: boolean;
  /** Panel size that actually submitted. */
  n: number;
  /** Disagreement: max−min of panel probabilities (binary) or relative p50 spread (numeric). */
  spread: number;
  /**
   * Mean pairwise Jaccard overlap of the panel's cited sources [0,1].
   * Extremization assumes independent evidence — k is scaled down by this.
   */
  evidenceOverlap?: number;
  /** The aggregation chain layer by layer (binary questions). */
  components?: AggregateComponents;
  /** Scenario-simulation output (scenarios + tornado + coherence), when the simulation stage ran. */
  simulationResult?: SimulationResult;
}

// ---------------------------------------------------------------- scenario simulation

/**
 * Where a simulation driver's marginal distribution comes from — every option
 * is a deterministic-math output, never a number the LLM invented. The engine
 * builds the catalog; the LLM may only reference it.
 */
export type DriverSourceKind = "sub-forecast" | "market" | "base-rate" | "ols-trend";

/** Provenance receipt for one driver's marginal — what grounds it. */
export interface DriverProvenance {
  kind: DriverSourceKind;
  /** sub-forecast → the question id; market → the URL; base-rate → the source text; ols-trend → the series. */
  ref: string;
  /** Human-readable label for display. */
  label: string;
}

/**
 * A driver's marginal distribution and how it is sampled.
 *
 * A `trend` marginal is a location-scale Student-t predictive (the OLS
 * projection). `sePred`/`df` are the honest scale + degrees of freedom; the
 * simulator samples `projected + sePred·t_df`, which has the correct heavy
 * tails for a small-n fit. `lo`/`hi` are kept as the displayed ~80% band. When
 * `sePred`/`df` are absent (legacy/non-OLS producers) the simulator falls back
 * to a Gaussian band derived from (hi−lo).
 */
export type DriverMarginal =
  | { kind: "binary"; probability: number }
  | { kind: "quantiles"; quantiles: Quantiles; logSpace?: boolean }
  | { kind: "trend"; lo: number; projected: number; hi: number; sePred?: number; df?: number; logSpace?: boolean };

/** One grounded simulation driver (a random variable in the Monte Carlo). */
export interface SimDriver {
  /** Stable handle the combiner and dependency edges reference (e.g. "sf_sf1", "mkt_0"). */
  id: string;
  label: string;
  marginal: DriverMarginal;
  provenance: DriverProvenance;
  /** Numeric/trend drivers: the value at which the driver "fires" for scenario clustering. */
  threshold?: number;
  /** Which side of `threshold` counts as "fired" — "above" (default) or "below" (a close-under-strike question). */
  thresholdDir?: "above" | "below";
}

/**
 * The combiner DSL: a closed node set the LLM proposes (shape only) and
 * `evalCombiner` executes (the math). No free code — every leaf is a driver id.
 */
export type CombinerNode =
  | { op: "driver"; id: string }
  | { op: "and"; children: CombinerNode[] }
  | { op: "or"; children: CombinerNode[] }
  | { op: "threshold"; child: CombinerNode; above: number; dir?: "gt" | "lt" }
  | { op: "sum"; children: CombinerNode[] }
  | { op: "weighted_sum"; children: CombinerNode[]; weights: number[] }
  | { op: "max"; children: CombinerNode[] }
  | { op: "min"; children: CombinerNode[] }
  // Random-utility categorical selection (mc): returns the index of the
  // highest-scoring child — one child per option, in option order.
  | { op: "argmax"; children: CombinerNode[] }
  | { op: "conditional_table"; conditionDriver: string; ifTrue: CombinerNode; ifFalse: CombinerNode };

/** Top-level combiner spec: the tree plus how its output reads into the outcome space. */
export interface CombinerSpec {
  kind: ForecastKind;
  root: CombinerNode;
  /** mc only: option labels in order (the root yields an option index per draw). */
  mcOptions?: string[];
}

/** A pairwise correlation between two drivers in standard-normal (Gaussian-copula) space. */
export interface DriverCorrelation {
  id1: string;
  id2: string;
  /** Pearson correlation in Z-space, clamped to [-1, 1]; positive = they tend to fire together. */
  rho: number;
}

/** One scenario cluster — a distinct pattern of which drivers fired, and its conditional outcome. */
export interface ScenarioRow {
  /** Driver-fired pattern key, e.g. "sf_sf1=1,sf_sf2=0". */
  key: string;
  /** Fraction of draws in this cluster [0,1]. */
  frequency: number;
  /** The conditional outcome distribution for draws in this cluster (canonical form). */
  outcome: AggregateForecast;
  /** Human-readable description built from driver labels. */
  description: string;
}

/** First-order sensitivity of the outcome to one driver (tornado input). */
export interface SensitivityIndex {
  driverId: string;
  driverLabel: string;
  /**
   * First-order correlation ratio η² in [0,1]: the share of outcome variance
   * explained by the driver alone, estimated over quantile bins (exact for a
   * binary driver; a proper first-order index — not a full Sobol decomposition,
   * which would also attribute interaction variance).
   */
  varianceContribution: number;
  /** |Pearson(driver value, outcome)| — a linear cross-check on the same sample. */
  linearCorrelation: number;
}

/** The full output of one Monte Carlo scenario simulation. */
export interface SimulationResult {
  /** Bottom-up outcome aggregate in canonical form (binary prob / quantiles / optionProbs). */
  simulatedAggregate: AggregateForecast;
  N: number;
  seed: number;
  /** Top scenarios by frequency (modal first). */
  scenarios: ScenarioRow[];
  /** The most frequent scenario — "the winning one". */
  modalScenario: ScenarioRow;
  /** Drivers ranked by variance contribution (tornado order). */
  sensitivity: SensitivityIndex[];
  /** Divergence between the bottom-up simulation and the top-down panel aggregate. */
  coherence: { divergence: number; verdict: "ok" | "moderate" | "high" };
  /** The grounded drivers used, for display/provenance. */
  drivers: { id: string; label: string; provenance: DriverProvenance }[];
}

/** Internal effort scale; mapped per provider at request time. */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/** Where sandboxed runs execute (resolved from config at launch). */
export type SandboxRuntimeKind = "host" | "docker" | "e2b" | "modal" | "vercel";

/**
 * The forecasting domains a "domain pack" can register under. Each pack owns the
 * intent match, decomposition, data-grounded model, anchoring, and (where exact
 * ground truth exists) auto-resolution for its domain. Absent on a ledger entry
 * means the generic panel+research path produced it. The runtime list and the
 * union type are kept in sync (the const is the single source of truth).
 */
export const DOMAIN_IDS = [
  "sports",
  "finance",
  "construction",
  "macro",
  "elections",
  "business",
] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

/**
 * Which forecast knobs the operator pinned by hand this run. A flag here flips
 * the precedence from "the ledger-learned value wins" to "this exact value
 * wins" — one per knob that HAS a learned chooser. `extremizeKMc` is optional:
 * when unset it inherits the `extremizeK` pin (so pinning binary k still pins
 * the mc exponent, as before), and only an explicit value detaches the two.
 */
export interface ForecastOverrideFlags {
  extremizeK?: boolean;
  /** Pin the multiple-choice exponent independently of the binary one; defaults to the extremizeK pin when unset. */
  extremizeKMc?: boolean;
  marketWeight?: boolean;
  sportsMarketWeight?: boolean;
}

/**
 * A snapshot of the out-of-fold statistical fit the engine learns from the
 * resolved ledger — the genuine "fitted artifact" a saved model can FREEZE and
 * reuse. Computed by snapshotFittedParams (forecast.ts) from the per-domain (or
 * global) record. A frozen snapshot makes a model reproducible and shareable;
 * a "live" model re-fits these from the ledger every run (the default flywheel).
 */
export interface FittedParams {
  domain?: DomainId;
  /** Logistic recalibration (a·logit(p)+b) + the resolution count it was fit on; null when too few binary resolutions. */
  recalibration: { a: number; b: number; n: number } | null;
  /** Shared logistic recalibration for mc option probabilities (B2). Optional for models frozen before it existed. */
  mcRecalibration?: { a: number; b: number; n: number } | null;
  extremizeK: number;
  /** Separate multiple-choice extremization exponent (the mc GMO+renormalize geometry differs from binary). Optional for models frozen before it existed → fall back to extremizeK. */
  extremizeKMc?: number;
  marketWeight: number;
  sportsMarketWeight: number;
  quantileDilation: number;
  /** Asymmetric per-tail dilation (B3). Optional for models frozen before it existed → fall back to the symmetric quantileDilation. */
  quantileDilationLo?: number;
  quantileDilationUp?: number;
  /** Resolutions the dilation factor was fit on (so a frozen run reports an honest n). */
  quantileDilationN: number;
  methodWeights: Record<string, number>;
  /** In-domain resolved forecasts at snapshot time (informational; individual learners back off to the global pool below their own thresholds). */
  fitN: number;
  /** When the snapshot was taken (ms). */
  fitAt: number;
}

/**
 * Code mode: the repo's real build/test commands, detected deterministically by
 * reconRepo (src/codeintel.ts) and injected into the conductor, every worker,
 * and the green-gate. A missing field means "none detected".
 */
export interface CodeCommands {
  install?: string;
  build?: string;
  typecheck?: string;
  test?: string;
  lint?: string;
}

/**
 * Code mode: the deterministic recon of the working directory, produced once
 * before the conductor's first turn and journaled as `code.plan` (restored on
 * resume so recon never re-runs). Greenfield (empty) dirs skip recon and get
 * `{ greenfield: true, commands: {} }`.
 */
export interface RepoProfile {
  greenfield: boolean;
  primaryLanguage: string | null;
  packageManager: string | null;
  framework: string | null;
  commands: CodeCommands;
  monorepo: { tool: string | null; packages: string[] };
  git: { isRepo: boolean; branch: string | null; dirty: boolean };
  conventions: string[];
  manifestFiles: string[];
}

/** Code mode: the result of one green-gate run (build → typecheck → test). */
export interface CodeGateResult {
  green: boolean;
  /** True when NO build/typecheck/test command was detected — the tree was NOT verified (distinct from "all passed"). */
  skipped?: boolean;
  summary: string;
  ran: { check: keyof CodeCommands; pass: boolean; failed: number; total: number }[];
}

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
  /** Code mode: free-text acceptance criteria ("done when …") for the whole build. */
  acceptanceCriteria?: string;
  /** Code mode: skip repo recon and treat the workdir as greenfield (force a from-scratch build). */
  codeGreenfield?: boolean;
  /** Code mode: per-run override of the engine green-gate before synthesis. Undefined → cfg.codeGreenGate. */
  codeGreenGate?: boolean;
  /** Code mode: per-run override of engine commit-on-green. Undefined → cfg.codeAutoCommit. */
  codeAutoCommit?: boolean;
  /** Forecast mode: operator-supplied resolution date (ISO) for the question. */
  resolutionDate?: string;
  /** Forecast mode: independent forecaster panel size (3–11). */
  panelSize?: number;
  /** Forecast mode: pre-sharpened question — tournament imports arrive sharp, so the sharpener is skipped. */
  presetQuestion?: ForecastQuestion;
  /** Forecast mode: provenance of an externally-imported question (recorded in the ledger). */
  forecastOrigin?: ForecastOrigin;
  /** Forecast mode: ledger id this run's forecast supersedes (trigger-driven re-forecast). */
  supersedes?: string;
  /** Forecast mode: force a single forecast (skip open-ended decomposition into sub-forecasts). */
  forecastSingle?: boolean;
  /** Forecast mode: force the scenario-simulation stage on (it also auto-triggers on decomposable questions). */
  forecastSimulate?: boolean;
  /** Forecast: per-run extremization-k override. Undefined → cfg default, still beaten by the learned chooser unless pinned via forecastOverrides. */
  forecastExtremizeK?: number;
  /** Forecast: per-run market-anchor base weight. Undefined → cfg.forecastMarketWeight. */
  forecastMarketWeight?: number;
  /** Forecast: per-run sportsbook-line base weight. Undefined → cfg.forecastSportsMarketWeight. */
  forecastSportsMarketWeight?: number;
  /** Forecast: per-run decompose toggle. Undefined → cfg.forecastDecompose. */
  forecastDecompose?: boolean;
  /** Forecast: per-run sub-forecast cap. Undefined → cfg.forecastMaxSubQuestions. */
  forecastMaxSubQuestions?: number;
  /** Forecast: per-run coherence-probe toggle. Undefined → cfg.forecastCoherenceProbe. */
  forecastCoherenceProbe?: boolean;
  /** Forecast: which of k / market weight / sports weight the operator pinned (learned chooser bypassed for those). */
  forecastOverrides?: ForecastOverrideFlags;
  /** Forecast: domain pack chosen for this run (auto-detected or operator-picked). Recorded for reproducibility. */
  domainPack?: DomainId;
  /** Forecast: the saved-model id this run instantiated, for provenance + track-record linking. */
  forecastModelId?: string;
  verification: Verification;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  safeMode: boolean;
  sandboxRuntime: SandboxRuntimeKind;
}

/**
 * A saved, reusable prediction "model": a named bundle of forecast settings the
 * operator can re-apply to a new question, plus (optionally) a FROZEN fitted-
 * parameter artifact so the run is reproducible/shareable. The track record is
 * derived by joining the ledger on modelId — never stored here.
 */
export interface ForecastModel {
  id: string;
  name: string;
  /** Domain pack this model targets; undefined = auto-detect each run. */
  domain?: DomainId;
  /** The tunable overrides this model pins (each maps onto a RunOptions field). */
  tunables: Partial<{
    panelSize: number;
    extremizeK: number;
    marketWeight: number;
    sportsMarketWeight: number;
    decompose: boolean;
    maxSubQuestions: number;
    coherenceProbe: boolean;
    simulate: boolean;
    overrides: ForecastOverrideFlags;
  }>;
  /** "live" re-fits parameters from the ledger each run; "frozen" uses the snapshot verbatim. */
  fitMode: "live" | "frozen";
  /** The frozen fitted artifact (present when fitMode === "frozen"). */
  fitted?: FittedParams;
  createdAt: number;
  updatedAt: number;
}

/** A saved model's derived track record (calibration over its ledger rows). */
export interface ModelRecord {
  n: number;
  resolved: number;
  brierMean?: number;
  /** Mean (model Brier − market-at-create Brier); negative = the model beat the market. */
  vsMarket?: number;
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
  /** Forecast mode: which sub-forecast a forecaster task answers (parsed from "QUESTION: <id>"). Absent → primary. */
  questionId?: string;
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
  forecast?: { p?: number; p50?: number; unit?: string; kind?: ForecastKind; n: number; resolutionDate: string; count?: number };
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
 *  code.plan       { profile: RepoProfile, commit: boolean, branch: string|null } — recon result (code mode)
 *  code.checkpoint { sha, taskId }                — engine commit-on-green (code mode)
 *  code.gate       { green: boolean, summary }    — pre-synthesis green-gate result (code mode)
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

// Domain packs generalize everything the sports path does — intent match,
// engine-owned decomposition, per-quantity priors, a data-grounded Monte Carlo
// model, market anchoring, and (where exact ground truth exists) auto-resolution
// — into a declarative plugin. The registry detects the domain; the executor
// calls the matched pack's hooks at four pipeline seams. Packs COMPOSE the
// existing deterministic math in forecast.ts/datatools.ts; they never reimplement
// it, and the grounding gate (validateSimStructure) still bounds every domain so
// the LLM never computes a final number.

import type { SwarmConfig } from "../config";
import type { DomainId, ForecastQuestion, SimDriver } from "../types";
import type { LedgerEntry, LedgerOutcome } from "../forecast";

export type { DomainId } from "../types";

/** Outcome of detecting which domain a mission belongs to. */
export interface IntentMatch {
  pack: DomainId;
  /** 0..1. A deterministic match ≥ 0.6 wins outright (no LLM call). */
  confidence: number;
  source: "deterministic" | "llm" | "operator";
  /** Pack-private hint carried forward to plan()/buildDrivers (e.g. a ticker, a FRED series id, the sports facet). */
  hint?: Record<string, unknown>;
}

/** Read-only context handed to every hook — no executor internals leak in. */
export interface DomainCtx {
  cfg: SwarmConfig;
  mission: string;
  /** ISO date the run was created (the "now" for horizon math). */
  today: string;
  /** Operator-supplied --by resolution date, if any. */
  operatorDate?: string;
  /** Resolved per-run flags (already through the executor's precedence helpers). */
  single: boolean;
  decompose: boolean;
  maxSubQuestions: number;
  signal: AbortSignal;
  /** A cheap metered LLM call for matchers/structure that need one. */
  ask: (prompt: string, maxTokens: number) => Promise<string>;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

/** What a pack's auto-resolver returns — the resolveSportsEntry shape. */
export interface DomainResolution {
  outcome: LedgerOutcome;
  evidence: string;
  sources: string[];
}

export interface DomainPack {
  readonly id: DomainId;
  readonly label: string;
  /**
   * One-line description for the LLM domain classifier. Packs WITHOUT this are
   * deterministic-only (e.g. sports, whose classifySportsMission is the sole
   * authority) and never enter the LLM fallback — so a registry of only such
   * packs makes zero extra LLM calls.
   */
  readonly llmHint?: string;
  /** Forecast tunable ids the UI should surface for this domain (progressive disclosure). */
  readonly knobs?: readonly string[];
  /**
   * Degrees of freedom for the scenario simulation's Student-t copula. A finite
   * value (≈6–8) gives the joint TAIL DEPENDENCE a Gaussian copula lacks — when
   * one grounded driver hits an extreme, correlated drivers are more likely to
   * too (the fat-tail co-movement a finance/macro shock actually exhibits).
   * Omitted (or ∞) → the Gaussian copula (current behavior, exactly).
   */
  readonly copulaDf?: number;

  /**
   * DETERMINISTIC, FREE, PURE. A regex/keyword gate (the classifySportsMission
   * analogue). Returns null to abstain. No network, no LLM — the registry runs
   * every pack's matcher, so this must stay cheap and conservative (a wrong
   * domain is worse than the generic path).
   */
  matchIntent(mission: string): IntentMatch | null;

  /**
   * Engine-owned decomposition into typed, resolvable sub-forecasts (the
   * planSportsGame analogue). null → fall through to the generic LLM
   * decomposition. Returns its own human-readable brief.
   */
  plan?(ctx: DomainCtx, match: IntentMatch): Promise<{ questions: ForecastQuestion[]; brief: string } | null>;

  /**
   * THE CORE: build a data-grounded SimDriver catalog for q from real feeds
   * (options-implied → binary, OLS → trend, line → quantiles, counted history →
   * base-rate). Replaces the generic buildDriverCatalog for matched domains.
   * `siblings` is the generic catalog (sibling sub-forecasts + base rates) to
   * extend. The LLM still proposes only STRUCTURE over the returned handles.
   */
  buildDrivers?(
    ctx: DomainCtx,
    q: ForecastQuestion,
    match: IntentMatch,
    siblings: SimDriver[],
  ): Promise<SimDriver[]>;

  /**
   * Auto-resolve from authoritative data (the resolveSportsEntry analogue):
   * a Yahoo close, a FRED print. null → fall back to the web resolution agent.
   */
  resolve?(ctx: DomainCtx, entry: LedgerEntry): Promise<DomainResolution | null>;
}

import * as path from "path";
import * as fs from "fs";
import { home } from "./config";
import { canonicalizeUrl } from "./searchcore";
import { AggregateForecast, Forecast, ForecastKind, ForecastOrigin, ForecastQuestion, Quantiles } from "./types";
import { ensureDir, errMsg } from "./util";

/**
 * Deterministic forecasting math and the persistent forecast ledger.
 *
 * Aggregation is pure code by design: the panel's independence is the whole
 * value of an ensemble, and letting an LLM "combine" the numbers would undo
 * it. Method basis: Halawi et al. 2024 (retrieval + reasoning + ensemble of
 * LLM forecasters approaches human-crowd accuracy) and Satopää et al. 2014
 * (extremized geometric mean of odds beats simple averaging of probabilities).
 *
 * The ledger is an append-only JSONL file (the events.jsonl idiom): a
 * "created" record per forecast and a later "resolved" record keyed by the
 * same id. Single-line appends under PIPE_BUF are atomic on POSIX, so a run
 * finishing and `swarm resolve` writing concurrently cannot corrupt it.
 */

// ---------------------------------------------------------------- math

/** Probabilities are clamped off 0/1: certainty is never earned, and log/odds math degenerates there. */
export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.99, Math.max(0.01, p));
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Mean with floor(n·frac) values trimmed from each end (sorted input not required). */
export function trimmedMean(values: number[], frac = 0.1): number {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * frac);
  const kept = sorted.slice(trim, sorted.length - trim);
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

export const DEFAULT_EXTREMIZE_K = 2.5;

/**
 * Combine a binary panel: median + geometric mean of odds, extremized by k.
 * Extremization compensates for the shared-information shrinkage of
 * averaging — independent forecasters each hold a slice of the evidence, so
 * the honest combined view is more extreme than the average view.
 *
 * Optional weights (from each method's resolved track record) tilt the mean
 * of log-odds toward panelists whose lens has been earning its seat; they are
 * ignored unless they match the panel and are all positive and finite.
 */
export function aggregateBinary(probs: number[], k = DEFAULT_EXTREMIZE_K, weights?: number[]): AggregateForecast {
  const ps = probs.map(clampProb);
  if (!ps.length) throw new Error("aggregateBinary: empty panel");
  const sorted = [...ps].sort((a, b) => a - b);
  const med = median(sorted);
  const ws =
    weights && weights.length === ps.length && weights.every((w) => Number.isFinite(w) && w > 0)
      ? weights
      : ps.map(() => 1);
  const wSum = ws.reduce((s, w) => s + w, 0);
  const logOddsMean = ps.reduce((s, p, i) => s + ws[i] * Math.log(p / (1 - p)), 0) / wSum;
  const gmoOdds = Math.exp(logOddsMean);
  const gmo = gmoOdds / (1 + gmoOdds);
  // Extremization corrects the shrinkage of combining INDEPENDENT views — a
  // panel of one has nothing to correct, so its credence passes through.
  const kEff = ps.length > 1 ? k : 1;
  const extremizedOdds = Math.pow(gmoOdds, kEff);
  const probability = clampProb(extremizedOdds / (1 + extremizedOdds));
  return {
    probability,
    median: med,
    gmo,
    k: kEff,
    n: ps.length,
    spread: sorted[sorted.length - 1] - sorted[0],
  };
}

/** Quantile keys in distribution order, with their cumulative probability levels. */
export const QUANTILE_TAUS: { key: keyof Quantiles; tau: number }[] = [
  { key: "p5", tau: 0.05 },
  { key: "p10", tau: 0.1 },
  { key: "p25", tau: 0.25 },
  { key: "p50", tau: 0.5 },
  { key: "p75", tau: 0.75 },
  { key: "p90", tau: 0.9 },
  { key: "p95", tau: 0.95 },
];

/**
 * Heavily right-skewed positive panels (populations, dollar amounts, counts)
 * aggregate better in log space — a linear trimmed mean lets the largest
 * panelist drag the center. Trigger: every value positive and the median
 * panelist's p90/p10 ratio above 10.
 */
export function shouldUseLogSpace(qs: Quantiles[]): boolean {
  if (!qs.length) return false;
  for (const q of qs) {
    for (const { key } of QUANTILE_TAUS) {
      const v = q[key];
      if (v !== undefined && v <= 0) return false;
    }
  }
  const ratios = qs.map((q) => q.p90 / q.p10).filter((r) => Number.isFinite(r)).sort((a, b) => a - b);
  if (!ratios.length) return false;
  return ratios[Math.floor(ratios.length / 2)] > 10;
}

/**
 * Combine a numeric panel: median per quantile below 10 panelists (a 10% trim
 * removes nothing at those sizes, and the median is the honest outlier guard),
 * 10%-trimmed mean at 10+ (log-space for heavily skewed positive quantities).
 * Values are re-sorted across quantile keys for monotonicity. Optional
 * quantiles aggregate only when every panelist provided them — a percentile
 * averaged over half the panel is a different statistic than its neighbors.
 */
export function aggregateQuantiles(qs: Quantiles[], k = DEFAULT_EXTREMIZE_K): AggregateForecast {
  if (!qs.length) throw new Error("aggregateQuantiles: empty panel");
  const logSpace = shouldUseLogSpace(qs);
  const fwd = (v: number) => (logSpace ? Math.log(v) : v);
  const back = (v: number) => (logSpace ? Math.exp(v) : v);
  const center = (vals: number[]): number =>
    vals.length < 10 ? median([...vals].sort((a, b) => a - b)) : trimmedMean(vals);
  const keys = QUANTILE_TAUS.map((t) => t.key).filter((key) => qs.every((q) => typeof q[key] === "number"));
  const values = keys.map((key) => back(center(qs.map((q) => fwd(q[key] as number))))).sort((a, b) => a - b);
  const quantiles = {} as Quantiles;
  keys.forEach((key, i) => {
    quantiles[key] = values[i];
  });
  const p50s = qs.map((q) => q.p50).sort((a, b) => a - b);
  const scale = Math.max(Math.abs(quantiles.p50), 1e-9);
  return {
    quantiles,
    k,
    n: qs.length,
    spread: (p50s[p50s.length - 1] - p50s[0]) / scale,
    ...(logSpace ? { logSpace } : {}),
  };
}

/**
 * Build a monotone Quantiles object from whatever the panelist provided:
 * the multiset of values is kept, sorted ascending, and assigned back in
 * quantile order (a crossed pair like p10>p50 becomes a swap, not an error).
 * Null unless the p10/p50/p90 spine is present and finite.
 */
export function monotoneQuantiles(partial: Partial<Record<keyof Quantiles, number>>): Quantiles | null {
  const keys = QUANTILE_TAUS.map((t) => t.key).filter((k) => Number.isFinite(partial[k] as number));
  if (!keys.includes("p10") || !keys.includes("p50") || !keys.includes("p90")) return null;
  const values = keys.map((k) => partial[k] as number).sort((a, b) => a - b);
  const out = {} as Quantiles;
  keys.forEach((k, i) => {
    out[k] = values[i];
  });
  return out;
}

/**
 * Mean pinball (quantile) loss over the quantiles a forecast actually stated —
 * the proper score for quantile forecasts (approaches CRPS as quantiles
 * densify). Lower is better; 0 is a perfect point mass on the value.
 */
export function pinballLoss(q: Quantiles, value: number): number {
  let sum = 0;
  let n = 0;
  for (const { key, tau } of QUANTILE_TAUS) {
    const v = q[key];
    if (typeof v !== "number") continue;
    sum += value >= v ? tau * (value - v) : (1 - tau) * (v - value);
    n++;
  }
  return n ? sum / n : 0;
}

// ---------------------------------------------------------------- multiple choice

/**
 * Clamp/normalize a panelist's per-option probabilities onto the question's
 * option list: tolerate percentages, fill missing options with a floor, and
 * renormalize to sum 1. Null when nothing usable was submitted.
 */
export function normalizeOptionProbs(raw: unknown, options: string[]): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || !options.length) return null;
  const lookup = new Map<string, number>();
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    let n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 1) n = n / 100; // tolerate percentages
    lookup.set(key.trim().toLowerCase(), n);
  }
  if (!lookup.size) return null;
  const out: Record<string, number> = {};
  let matched = 0;
  for (const opt of options) {
    const v = lookup.get(opt.trim().toLowerCase());
    if (v !== undefined) matched++;
    out[opt] = Math.max(v ?? 0, 0.005); // unmentioned options keep a floor — certainty is never earned
  }
  if (!matched) return null;
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  for (const opt of options) out[opt] = out[opt] / sum;
  return out;
}

/**
 * Combine an mc panel: per-option weighted GMO of odds, extremized by k, then
 * renormalized to sum 1 (extremization breaks the simplex; renormalization
 * restores it while keeping the sharpening).
 */
export function aggregateMc(
  panels: Record<string, number>[],
  options: string[],
  k = DEFAULT_EXTREMIZE_K,
  weights?: number[]
): AggregateForecast {
  if (!panels.length) throw new Error("aggregateMc: empty panel");
  if (options.length < 2) throw new Error("aggregateMc: need at least 2 options");
  const ws =
    weights && weights.length === panels.length && weights.every((w) => Number.isFinite(w) && w > 0)
      ? weights
      : panels.map(() => 1);
  const wSum = ws.reduce((s, w) => s + w, 0);
  const kEff = panels.length > 1 ? k : 1;
  const result: Record<string, number> = {};
  let spread = 0;
  for (const opt of options) {
    const ps = panels.map((p) => clampProb(p[opt] ?? 0.01));
    const logOddsMean = ps.reduce((s, p, i) => s + ws[i] * Math.log(p / (1 - p)), 0) / wSum;
    const extremized = Math.exp(kEff * logOddsMean);
    result[opt] = clampProb(extremized / (1 + extremized));
    spread = Math.max(spread, Math.max(...ps) - Math.min(...ps));
  }
  const sum = Object.values(result).reduce((s, v) => s + v, 0);
  for (const opt of options) result[opt] = result[opt] / sum;
  return { optionProbs: result, k: kEff, n: panels.length, spread };
}

/** Multiclass Brier: Σ over options of (p − 1{realized})². 0 perfect; 2 is the worst possible. */
export function mcBrierScore(probs: Record<string, number>, realized: string): number {
  let sum = 0;
  for (const [opt, p] of Object.entries(probs)) {
    const y = opt === realized ? 1 : 0;
    sum += Math.pow(p - y, 2);
  }
  return sum;
}

/** Log score of the probability given to what happened. */
export function mcLogScore(probs: Record<string, number>, realized: string): number {
  return Math.log(clampProb(probs[realized] ?? 0.01));
}

// ---------------------------------------------------------------- date questions

const DAY_MS = 86_400_000;

/** ISO date → whole days since the Unix epoch (UTC midnight). NaN-safe: null on garbage. */
export function isoToDays(iso: string): number | null {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

export function daysToIso(days: number): string {
  return new Date(Math.round(days) * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- evidence independence

/**
 * Mean pairwise Jaccard overlap of the panel's cited source sets (canonical
 * URLs). 0 = fully independent evidence, 1 = everyone read the same pages.
 * Pairs where either panelist cited nothing are skipped — silence is not
 * agreement; no valid pairs → 0.
 */
export function evidenceOverlap(sourceSets: string[][]): number {
  const sets = sourceSets.map((urls) => new Set(urls.map((u) => canonicalizeUrl(u))));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (!sets[i].size || !sets[j].size) continue;
      let inter = 0;
      for (const u of sets[i]) if (sets[j].has(u)) inter++;
      const union = sets[i].size + sets[j].size - inter;
      sum += union ? inter / union : 0;
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

/**
 * Extremization corrects the shrinkage of averaging INDEPENDENT views; a
 * panel that read the same headlines holds fewer independent views than it
 * has members, so k shrinks toward 1 (no extremization) as overlap rises.
 */
export function scaleK(k: number, overlap: number): number {
  const o = Math.min(1, Math.max(0, overlap));
  return 1 + (k - 1) * (1 - o);
}

// ---------------------------------------------------------------- market anchoring

/**
 * Blend the panel's aggregate toward a market price in log-odds space.
 * The blend happens AFTER extremization: extremization corrects the panel's
 * shared-information shrinkage, but a market price is already an aggregate of
 * its own crowd — extremizing it like a panelist would double-count.
 * w=0 returns the panel unchanged; w=1 returns the market.
 */
export function blendWithMarket(panelP: number, marketP: number, w: number): number {
  const wc = Math.min(1, Math.max(0, w));
  const lp = Math.log(clampProb(panelP) / (1 - clampProb(panelP)));
  const lm = Math.log(clampProb(marketP) / (1 - clampProb(marketP)));
  const odds = Math.exp((1 - wc) * lp + wc * lm);
  return clampProb(odds / (1 + odds));
}

/**
 * How much a market's liquidity earns it: 0 for a dead market, 1 at ~$100K
 * volume. Thin markets are noisy anchors; their weight scales down.
 */
export function liquidityFactor(volume: number | undefined): number {
  if (!volume || volume <= 0) return 0;
  return Math.min(1, Math.log10(1 + volume) / 5);
}

export const DEFAULT_MARKET_WEIGHT = 0.4;
export const MIN_MARKET_WEIGHT_N = 20;

/**
 * Manifold runs on play money: mana volumes are nominally ~50× a real-money
 * market of comparable conviction. Divide before liquidityFactor so a 10K-mana
 * market doesn't anchor like a $10K Polymarket book.
 */
export const MANIFOLD_VOLUME_DISCOUNT = 50;

/**
 * Fit the market blend weight on the resolved track record: the w that would
 * have minimized mean log loss re-blending each stored panel aggregate with
 * its stored market price. Falls back below MIN_MARKET_WEIGHT_N resolutions.
 */
export function chooseMarketWeight(entries = loadLedger(), fallback = DEFAULT_MARKET_WEIGHT): number {
  const usable = entries.filter(
    (e) =>
      e.question.kind === "binary" &&
      e.resolution &&
      (e.resolution.outcome === 0 || e.resolution.outcome === 1) &&
      typeof e.aggregate.components?.extremized === "number" &&
      typeof e.aggregate.components?.market?.probability === "number"
  );
  if (usable.length < MIN_MARKET_WEIGHT_N) return fallback;
  let bestW = fallback;
  let bestLoss = Infinity;
  for (let i = 0; i <= 10; i++) {
    const w = i / 10;
    let sum = 0;
    for (const e of usable) {
      const c = e.aggregate.components!;
      // Re-apply each market's own liquidity scaling so the fitted w plays
      // the same role it plays live (a base weight, not an absolute one).
      const liq = liquidityFactor(c.market!.volume);
      const p = blendWithMarket(c.extremized!, c.market!.probability, w * liq);
      sum += -logScore(p, e.resolution!.outcome as 0 | 1);
    }
    const mean = sum / usable.length;
    if (mean < bestLoss - 1e-12) {
      bestLoss = mean;
      bestW = w;
    }
  }
  return bestW;
}

// ---------------------------------------------------------------- method weighting

/** A method needs this many resolved forecasts before its weight deviates from 1. */
export const MIN_METHOD_WEIGHT_N = 5;
/** How sharply Brier differences translate into weight differences. */
export const METHOD_WEIGHT_LAMBDA = 4;
/** Shrinkage pseudo-count toward equal weight — small samples can't dominate. */
export const METHOD_WEIGHT_PRIOR_N = 10;

/**
 * Per-method aggregation weights from the resolved track record: a lens whose
 * panelists have scored better than the cross-method mean Brier earns more
 * say in the weighted GMO, shrunk toward 1 by sample size. Methods without
 * enough history (or absent entirely) weigh exactly 1.
 */
export function methodWeights(entries = loadLedger()): Record<string, number> {
  let byMethod: CalibrationStats["byMethod"];
  try {
    byMethod = calibrationStats(entries).byMethod;
  } catch {
    return {};
  }
  let totN = 0;
  let totSum = 0;
  for (const s of Object.values(byMethod)) {
    totN += s.n;
    totSum += s.brierMean * s.n;
  }
  if (!totN) return {};
  const mean = totSum / totN;
  const out: Record<string, number> = {};
  for (const [m, s] of Object.entries(byMethod)) {
    if (s.n < MIN_METHOD_WEIGHT_N) {
      out[m] = 1;
      continue;
    }
    const raw = Math.exp(-METHOD_WEIGHT_LAMBDA * (s.brierMean - mean));
    out[m] = (s.n * raw + METHOD_WEIGHT_PRIOR_N) / (s.n + METHOD_WEIGHT_PRIOR_N);
  }
  return out;
}

// ---------------------------------------------------------------- recalibration

/** Two-parameter logistic recalibration in log-odds space: logit(p′) = a·logit(p) + b. */
export interface Recalibration {
  a: number;
  b: number;
  /** Resolved forecasts the fit rests on. */
  n: number;
}

/** Below this many resolved binary forecasts, recalibration is identity — fitting noise helps nobody. */
export const MIN_RECALIBRATION_N = 40;

/**
 * Fit (a, b) on the resolved record by grid search minimizing mean log loss,
 * regularized toward identity (γ = 2/n) so small samples barely move it.
 * The fit uses each entry's PRE-recalibration value (components.blended or
 * extremized) — fitting on already-recalibrated numbers would be circular.
 * The b intercept is the genuinely new dial vs adaptive-k: it corrects a
 * systematic YES-lean (LLM acquiescence bias) that no symmetric exponent can.
 */
export function fitRecalibration(entries = loadLedger()): Recalibration | null {
  const pts: { p: number; outcome: 0 | 1 }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const c = e.aggregate.components;
    const p = c?.blended ?? c?.extremized ?? e.aggregate.probability;
    if (typeof p !== "number") continue;
    pts.push({ p: clampProb(p), outcome: o });
  }
  if (pts.length < MIN_RECALIBRATION_N) return null;
  const gamma = 2 / pts.length;
  let best: Recalibration = { a: 1, b: 0, n: pts.length };
  let bestLoss = Infinity;
  // a down to 0.1: LLM panels can be SEVERELY overconfident, and a slope
  // floor of 0.5 made that uncorrectable. The identity-regularizer keeps
  // small samples from actually wandering down there without evidence.
  for (let ai = 0; ai <= 38; ai++) {
    const a = 0.1 + ai * 0.05;
    for (let bi = -20; bi <= 20; bi++) {
      const b = bi / 10;
      let sum = 0;
      for (const pt of pts) {
        const lo = Math.log(pt.p / (1 - pt.p));
        const odds = Math.exp(a * lo + b);
        sum += -logScore(clampProb(odds / (1 + odds)), pt.outcome);
      }
      const loss = sum / pts.length + gamma * ((a - 1) * (a - 1) + b * b);
      if (loss < bestLoss - 1e-12) {
        bestLoss = loss;
        best = { a: Number(a.toFixed(2)), b: Number(b.toFixed(2)), n: pts.length };
      }
    }
  }
  return best;
}

export function applyRecalibration(p: number, r: Recalibration | null): number {
  if (!r) return clampProb(p);
  const cp = clampProb(p);
  const odds = Math.exp(r.a * Math.log(cp / (1 - cp)) + r.b);
  return clampProb(odds / (1 + odds));
}

// ---------------------------------------------------------------- analytical gate

/**
 * Mechanical check that a forecast is grounded in analysis, not vibes —
 * returns retry feedback or null. Prompts are advisory; this is the part the
 * panelist cannot skip: an explicit base-rate prior, at least one named
 * reference class, and an actual number somewhere in the reasoning.
 */
export function validateForecastAnalytics(f: Forecast, kind: ForecastKind): string | null {
  const problems: string[] = [];
  if (kind === "binary") {
    if (typeof f.prior !== "number") {
      problems.push(
        "no `prior` — state the probability your reference classes ALONE imply (1-99), before weighing current evidence"
      );
    }
  }
  if (kind === "binary" || kind === "mc") {
    if (!f.baseRates?.length) {
      problems.push(
        "no `base_rates` — name at least one reference class with its historical frequency and where it comes from"
      );
    }
  }
  if (!/\d/.test(f.rationale)) {
    problems.push(
      "the rationale contains no numbers — cite the base rates, data points, or market odds your forecast actually rests on"
    );
  }
  // A decomposition that doesn't show its pieces is an inside view wearing a
  // costume — demand the sub-probabilities and the arithmetic.
  if (kind === "binary" && /decomposition/.test(f.method)) {
    const pcts = new Set((f.rationale.match(/\d+(?:\.\d+)?\s*%/g) ?? []).map((s) => s.replace(/\s+/g, "")));
    if (pcts.size < 2) {
      problems.push(
        'a decomposition forecast must show its pieces — state at least two sub-event probabilities (e.g. "P(bill passes committee) ≈ 40%, P(floor vote passes | committee) ≈ 60%") and the arithmetic that combines them'
      );
    }
  }
  if (!problems.length) return null;
  return (
    "Your forecast was not analytically grounded. Fix exactly this, then call submit_forecast again:\n" +
    problems.map((p) => `- ${p}`).join("\n") +
    "\nA forecast that just absorbs headline sentiment is worthless to the ensemble — anchor on reference classes and real data, then adjust."
  );
}

// ---------------------------------------------------------------- scoring

/** Brier score: (p − outcome)². 0 is perfect, 0.25 is "always say 50%". */
export function brierScore(p: number, outcome: 0 | 1): number {
  return Math.pow(clampProb(p) - outcome, 2);
}

/** Log score: ln of the probability assigned to what happened. 0 is perfect; more negative is worse. */
export function logScore(p: number, outcome: 0 | 1): number {
  const q = clampProb(p);
  return Math.log(outcome === 1 ? q : 1 - q);
}

/**
 * Interval score for the central 80% interval (p10, p90): width plus a
 * 2/α penalty per unit the realized value lands outside. Lower is better.
 */
export function intervalScore(p10: number, p90: number, value: number, alpha = 0.2): number {
  const lo = Math.min(p10, p90);
  const hi = Math.max(p10, p90);
  let s = hi - lo;
  if (value < lo) s += (2 / alpha) * (lo - value);
  if (value > hi) s += (2 / alpha) * (value - hi);
  return s;
}

/**
 * Pull the "METHOD: <label>" assignment out of a forecaster task's objective/
 * context — the handle the engine uses to enforce panel method diversity at
 * spawn time. Null when no parseable label exists (enforcement degrades to
 * advisory, never blocks).
 */
export function extractMethodLabel(text: string): string | null {
  const m = /method(?:\s+label)?\s*[:=]\s*["'`]?([a-z][a-z0-9_-]*)/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Canonicalize a submitted method label: lowercase, and strip revision
 * decorations ("trend (revised)", "trend v2", "trend - updated"). Revisions
 * MUST land on their original label or the latest-per-method dedup keeps both
 * and the lens is double-counted in the ensemble — observed in the wild, so
 * the engine normalizes instead of hoping.
 */
export function canonicalMethodLabel(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/\s*\((?:rev|updat|v\d|retr|new|final|2nd|second)[^)]*\)\s*$/, "")
      .replace(/\s*[-–—:]?\s*(?:revised|revision|updated|rerun|v\d+|final)\s*$/, "")
      .trim() || "unspecified"
  );
}

// ---------------------------------------------------------------- question parsing

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the sharpener's JSON reply into a ForecastQuestion, tolerating code
 * fences and surrounding prose. An operator-supplied resolution date always
 * wins over the model's. Returns null when anything required is unusable —
 * the caller falls back to a mechanically-built question.
 */
export function parseQuestionJson(raw: string, operatorDate?: string): ForecastQuestion | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const text = String(obj.text ?? "").trim();
  const criteria = String(obj.resolutionCriteria ?? "").trim();
  const kind = ["binary", "numeric", "mc", "date"].includes(String(obj.kind))
    ? (String(obj.kind) as ForecastKind)
    : null;
  let date = String(obj.resolutionDate ?? "").trim();
  if (operatorDate && ISO_DATE.test(operatorDate)) date = operatorDate;
  if (!text || !criteria || !kind || !ISO_DATE.test(date)) return null;
  const unit = obj.unit ? String(obj.unit).trim().slice(0, 40) : undefined;
  // mc questions need a usable option list — 2-8 distinct non-empty strings —
  // or the kind degrades to unusable (caller falls back).
  let options: string[] | undefined;
  if (kind === "mc") {
    const raw = Array.isArray(obj.options) ? obj.options.map((o) => String(o).trim().slice(0, 120)).filter(Boolean) : [];
    options = [...new Set(raw)].slice(0, 8);
    if (options.length < 2) return null;
  }
  return {
    text: text.slice(0, 500),
    kind,
    resolutionCriteria: criteria.slice(0, 1000),
    resolutionDate: date,
    ...(kind === "numeric" && unit ? { unit } : {}),
    ...(options ? { options } : {}),
  };
}

// ---------------------------------------------------------------- ledger

export interface LedgerPanelist {
  taskId: string;
  method: string;
  probability?: number;
  /** Base-rate prior committed before current evidence (binary). */
  prior?: number;
  quantiles?: Quantiles;
  optionProbs?: Record<string, number>;
  pNever?: number;
  /** Track-record aggregation weight used (omitted when 1). */
  weight?: number;
}

/**
 * Resolved outcome: 1/0 for binary YES/NO, the realized value for numeric,
 * epoch-days for date, the realized option string for mc, "never" for a date
 * question whose event didn't occur by the horizon, "void" when the question
 * stopped being meaningful.
 */
export type LedgerOutcome = 0 | 1 | number | string | "void";

export interface LedgerCreated {
  v: 1;
  rec: "created";
  id: string;
  runId: string;
  t: number;
  question: ForecastQuestion;
  aggregate: AggregateForecast;
  panel: LedgerPanelist[];
  /** Union of the panel's update triggers — what `swarm forecasts watch` re-checks. */
  triggers?: string[];
  /** Panel evidence overlap at creation — needed to re-tune k honestly later. */
  evidenceOverlap?: number;
  /** Set for tournament-imported questions: source platform, id, and its price at import. */
  origin?: ForecastOrigin;
  /**
   * The ledger id this forecast supersedes (a trigger-driven re-forecast of
   * the same question). Both ends of the chain still resolve and score — that
   * history is exactly what shows whether updating helped — but watching and
   * "live forecast" views follow the newest link.
   */
  supersedes?: string;
}

export interface LedgerResolved {
  v: 1;
  rec: "resolved";
  id: string;
  t: number;
  outcome: LedgerOutcome;
  evidence: string;
  sources: string[];
  resolvedBy: "swarm" | "operator";
  brier?: number;
  logScore?: number;
  intervalScore?: number;
  /** Mean pinball loss over the stated quantiles (numeric/date). */
  pinball?: number;
}

export interface LedgerEntry extends Omit<LedgerCreated, "rec"> {
  resolution?: LedgerResolved;
}

export function forecastsDir(): string {
  return path.join(home(), "forecasts");
}

export function ledgerPath(): string {
  return path.join(forecastsDir(), "ledger.jsonl");
}

export function appendLedger(rec: LedgerCreated | LedgerResolved): void {
  ensureDir(forecastsDir());
  fs.appendFileSync(ledgerPath(), JSON.stringify(rec) + "\n", "utf8");
}

/**
 * Reduce the ledger: created records open entries, resolved records close
 * them (latest resolution per id wins, so an operator override after a swarm
 * resolution sticks). Malformed lines degrade to "forgotten", never crash —
 * the file is on disk where the operator can edit it.
 */
export function loadLedger(): LedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  const entries = new Map<string, LedgerEntry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: LedgerCreated | LedgerResolved;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || typeof rec.id !== "string") continue;
    if (rec.rec === "created" && rec.question && rec.aggregate) {
      const { rec: _omit, ...rest } = rec;
      entries.set(rec.id, { ...rest, panel: Array.isArray(rec.panel) ? rec.panel : [] });
    } else if (rec.rec === "resolved") {
      const entry = entries.get(rec.id);
      if (entry) entry.resolution = rec;
    }
  }
  return [...entries.values()].sort((a, b) => a.t - b.t);
}

/** End of the resolution day, UTC — a forecast is "due" once that moment passes. */
function resolutionDeadline(isoDate: string): number {
  const t = Date.parse(`${isoDate}T23:59:59Z`);
  return Number.isFinite(t) ? t : Date.parse(isoDate);
}

/** Open (unresolved) forecasts whose resolution date has passed. */
export function dueForecasts(now = Date.now()): LedgerEntry[] {
  return loadLedger().filter((e) => !e.resolution && resolutionDeadline(e.question.resolutionDate) <= now);
}

/** Ids that a newer forecast in the ledger supersedes (trigger-driven re-forecasts). */
export function supersededIds(entries: LedgerEntry[]): Set<string> {
  return new Set(entries.map((e) => e.supersedes).filter((s): s is string => Boolean(s)));
}

/** Score and append a resolution record. Returns the record written. */
export function resolveLedgerEntry(
  entry: LedgerEntry,
  outcome: LedgerOutcome,
  opts: { evidence: string; sources: string[]; resolvedBy: "swarm" | "operator" }
): LedgerResolved {
  const rec: LedgerResolved = {
    v: 1,
    rec: "resolved",
    id: entry.id,
    t: Date.now(),
    outcome,
    evidence: opts.evidence,
    sources: opts.sources,
    resolvedBy: opts.resolvedBy,
  };
  const kind = entry.question.kind;
  if (outcome !== "void") {
    if (kind === "binary" && (outcome === 0 || outcome === 1)) {
      const p = entry.aggregate.probability ?? 0.5;
      rec.brier = brierScore(p, outcome);
      rec.logScore = logScore(p, outcome);
    } else if ((kind === "numeric" || kind === "date") && typeof outcome === "number") {
      const q = entry.aggregate.quantiles;
      if (q) {
        rec.intervalScore = intervalScore(q.p10, q.p90, outcome);
        rec.pinball = pinballLoss(q, outcome);
      }
      // A realized date also scores the never-mass: the event happened, so
      // P(never) should have been low.
      if (kind === "date" && typeof entry.aggregate.pNever === "number") {
        rec.logScore = logScore(1 - entry.aggregate.pNever, 1);
      }
    } else if (kind === "date" && outcome === "never") {
      if (typeof entry.aggregate.pNever === "number") {
        rec.logScore = logScore(entry.aggregate.pNever, 1);
      }
    } else if (kind === "mc" && typeof outcome === "string" && entry.aggregate.optionProbs) {
      if (entry.question.options?.includes(outcome)) {
        rec.brier = mcBrierScore(entry.aggregate.optionProbs, outcome);
        rec.logScore = mcLogScore(entry.aggregate.optionProbs, outcome);
      }
    }
  }
  appendLedger(rec);
  return rec;
}

// ---------------------------------------------------------------- calibration

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  hitRate: number;
}

export interface CalibrationStats {
  /** Resolved, scoreable binary forecasts. */
  n: number;
  brierMean: number;
  bins: CalibrationBin[];
  /**
   * Reliability bins for mc option probabilities, kept separate from the
   * binary bins: "option B of 4 at 35%" and "binary YES at 35%" are different
   * calibration properties, and mixing them muddied both diagnoses.
   */
  mcBins: CalibrationBin[];
  /** Per-panel-method mean Brier (panelists scored against the outcome). */
  byMethod: Record<string, { n: number; brierMean: number }>;
}

/** Binary entries resolved to a hard 0/1 (voids and numerics don't calibrate a probability). */
function scoreable(entries: LedgerEntry[]): { p: number; outcome: 0 | 1; panel: LedgerPanelist[] }[] {
  const out: { p: number; outcome: 0 | 1; panel: LedgerPanelist[] }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const p = e.aggregate.probability;
    if (typeof p !== "number") continue;
    out.push({ p, outcome: o, panel: e.panel });
  }
  return out;
}

export function calibrationStats(entries: LedgerEntry[]): CalibrationStats {
  const scored = scoreable(entries);
  const makeBins = (): CalibrationBin[] =>
    Array.from({ length: 10 }, (_, i) => ({
      lo: i / 10,
      hi: (i + 1) / 10,
      n: 0,
      meanP: 0,
      hitRate: 0,
    }));
  const bins = makeBins();
  const mcBins = makeBins();
  let brierSum = 0;
  for (const s of scored) {
    brierSum += brierScore(s.p, s.outcome);
    const bin = bins[Math.min(9, Math.floor(s.p * 10))];
    bin.meanP = (bin.meanP * bin.n + s.p) / (bin.n + 1);
    bin.hitRate = (bin.hitRate * bin.n + s.outcome) / (bin.n + 1);
    bin.n++;
  }
  const byMethod: Record<string, { n: number; brierMean: number }> = {};
  for (const s of scored) {
    for (const m of s.panel) {
      if (typeof m.probability !== "number") continue;
      const key = m.method || "unknown";
      const cur = byMethod[key] ?? { n: 0, brierMean: 0 };
      cur.brierMean = (cur.brierMean * cur.n + brierScore(m.probability, s.outcome)) / (cur.n + 1);
      cur.n++;
      byMethod[key] = cur;
    }
  }
  // mc questions calibrate their own reliability bins — each option is one
  // (stated probability, did-it-happen) pair. They stay out of bins/n/
  // brierMean and byMethod: an option's probability lives on a different
  // base rate than a binary YES, and multiclass Brier's 0–2 scale would
  // corrupt the binary means the method weights are fitted on.
  for (const e of entries) {
    if (e.question.kind !== "mc" || !e.resolution) continue;
    const realized = e.resolution.outcome;
    if (typeof realized !== "string" || realized === "void") continue;
    const probs = e.aggregate.optionProbs;
    if (!probs || !e.question.options?.includes(realized)) continue;
    for (const opt of e.question.options) {
      const p = probs[opt];
      if (typeof p !== "number") continue;
      const bin = mcBins[Math.min(9, Math.floor(p * 10))];
      const hit = opt === realized ? 1 : 0;
      bin.meanP = (bin.meanP * bin.n + p) / (bin.n + 1);
      bin.hitRate = (bin.hitRate * bin.n + hit) / (bin.n + 1);
      bin.n++;
    }
  }
  return {
    n: scored.length,
    brierMean: scored.length ? brierSum / scored.length : 0,
    bins: bins.filter((b) => b.n > 0),
    mcBins: mcBins.filter((b) => b.n > 0),
    byMethod,
  };
}

/** Resolved history below this is noise, not a track record. */
export const MIN_CALIBRATION_N = 10;

const pct = (p: number) => `${Math.round(p * 100)}%`;

/**
 * The flywheel's prompt block: the system's own resolved track record,
 * phrased as actionable bias feedback for the next panel. Empty until enough
 * forecasts have resolved to mean anything.
 */
export function calibrationBlock(entries = loadLedger()): string {
  let stats: CalibrationStats;
  try {
    stats = calibrationStats(entries);
  } catch {
    return "";
  }
  if (stats.n < MIN_CALIBRATION_N) return "";
  const lines = [
    `YOUR TRACK RECORD (${stats.n} resolved forecasts, mean Brier ${stats.brierMean.toFixed(3)} — 0.25 is "always say 50%", lower is better):`,
  ];
  for (const b of stats.bins) {
    if (b.n < 2) continue;
    lines.push(`- In the ${pct(b.lo)}–${pct(b.hi)} band you averaged ${pct(b.meanP)}; ${pct(b.hitRate)} actually resolved YES (n=${b.n}).`);
  }
  for (const b of stats.mcBins) {
    if (b.n < 3) continue;
    lines.push(
      `- (mc options) In the ${pct(b.lo)}–${pct(b.hi)} band you averaged ${pct(b.meanP)}; ${pct(b.hitRate)} of those options realized (n=${b.n}).`
    );
  }
  const high = stats.bins.filter((b) => b.lo >= 0.7 && b.n >= 3);
  const over = high.filter((b) => b.meanP - b.hitRate > 0.1);
  const low = stats.bins.filter((b) => b.hi <= 0.3 && b.n >= 3);
  const under = low.filter((b) => b.hitRate - b.meanP > 0.1);
  if (over.length) lines.push("Diagnosis: you have been OVERCONFIDENT at the high end — shade confident YES forecasts down.");
  if (under.length) lines.push("Diagnosis: you have been OVERCONFIDENT at the low end — shade confident NO forecasts up.");
  if (!over.length && !under.length) lines.push("No systematic bias detected — keep calibrating each question on its own evidence.");
  // Which forecasting lens has actually been earning its seat.
  const methods = Object.entries(stats.byMethod)
    .filter(([, s]) => s.n >= 3)
    .sort((a, b) => a[1].brierMean - b[1].brierMean);
  if (methods.length >= 2) {
    const best = methods[0];
    const worst = methods[methods.length - 1];
    lines.push(
      `Method track record: "${best[0]}" has scored best (Brier ${best[1].brierMean.toFixed(3)}, n=${best[1].n}); "${worst[0]}" worst (${worst[1].brierMean.toFixed(3)}, n=${worst[1].n}).`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- adaptive extremization

/** Search bounds for the extremization exponent. */
const K_MIN = 1;
const K_MAX = 6;

/**
 * Pick the extremization exponent that would have minimized Brier over the
 * resolved history (each entry re-aggregated from its stored panel at each
 * candidate k). A coarse scan brackets the best region, then golden-section
 * refines it to ~1e-3 — exact where a fixed grid could only land within 0.125
 * of the optimum. Falls back to the default below MIN_ADAPTIVE_N resolutions —
 * tuning on a handful of outcomes is just overfitting noise.
 */
export const MIN_ADAPTIVE_N = 30;

export function chooseExtremizeK(entries = loadLedger(), fallback = DEFAULT_EXTREMIZE_K): number {
  const usable = scoreable(entries).filter((s) => s.panel.filter((m) => typeof m.probability === "number").length >= 2);
  if (usable.length < MIN_ADAPTIVE_N) return fallback;
  const meanBrier = (k: number): number => {
    let sum = 0;
    for (const s of usable) {
      const probs = s.panel.map((m) => m.probability).filter((p): p is number => typeof p === "number");
      try {
        sum += brierScore(aggregateBinary(probs, k).probability!, s.outcome);
      } catch (e) {
        // Unreachable with usable's ≥2-prob filter; keep the loop honest anyway.
        void errMsg(e);
      }
    }
    return sum / usable.length;
  };
  // Coarse scan (step 0.5) brackets the global region — Brier vs k is smooth
  // but only locally unimodal, and golden-section alone could chase a local dip.
  let coarseBest = K_MIN;
  let coarseLoss = Infinity;
  for (let k = K_MIN; k <= K_MAX + 1e-9; k += 0.5) {
    const loss = meanBrier(k);
    if (loss < coarseLoss - 1e-12) {
      coarseLoss = loss;
      coarseBest = k;
    }
  }
  // Golden-section refinement within the bracketing cell.
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = Math.max(K_MIN, coarseBest - 0.5);
  let b = Math.min(K_MAX, coarseBest + 0.5);
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = meanBrier(c);
  let fd = meanBrier(d);
  while (b - a > 1e-3) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = meanBrier(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = meanBrier(d);
    }
  }
  return Number(((a + b) / 2).toFixed(3));
}

// ---------------------------------------------------------------- backtest

export interface BacktestRow {
  /** Strategy label. */
  config: string;
  n: number;
  brierMean: number;
  /** Bootstrap 95% CI on the mean Brier (seeded — same ledger, same numbers). */
  brierLo: number;
  brierHi: number;
  logLossMean: number;
}

export interface BacktestReport {
  rows: BacktestRow[];
  /** Swarm vs the source market's price at import, on tournament entries. */
  vsMarket?: { n: number; swarmBrier: number; marketBrier: number };
  skipped: { nonBinary: number; noPanel: number };
}

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapCi(values: number[], b = 1000, seed = 1738): { lo: number; hi: number } {
  if (values.length < 2) return { lo: values[0] ?? 0, hi: values[0] ?? 0 };
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < b; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, c) => a - c);
  // 2.5th/97.5th percentile of b sorted samples: indices round(b·α)−1, 0-based.
  const lo = Math.max(0, Math.round(b * 0.025) - 1);
  const hi = Math.min(means.length - 1, Math.round(b * 0.975) - 1);
  return { lo: means[lo], hi: means[hi] };
}

interface BacktestEntry {
  probs: number[];
  overlap: number;
  outcome: 0 | 1;
  published: number;
  market?: { probability: number; volume?: number };
  entry: LedgerEntry;
}

/**
 * Replay the resolved binary ledger under each aggregation strategy and score
 * them side by side — the regression gate for every mechanism the engine
 * learns. Learned parameters (adaptive k, market weight, recalibration) are
 * fitted OUT-OF-FOLD (10-fold by time order): each entry is scored with
 * parameters fitted on the other folds, so a strategy can't grade its own
 * homework. Pure deterministic replay — no agents, no tokens.
 */
export function backtest(entries = loadLedger()): BacktestReport {
  const skipped = { nonBinary: 0, noPanel: 0 };
  const usable: BacktestEntry[] = [];
  for (const e of entries) {
    if (!e.resolution || e.resolution.outcome === "void") continue;
    if (e.question.kind !== "binary") {
      skipped.nonBinary++;
      continue;
    }
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const probs = e.panel.map((m) => m.probability).filter((p): p is number => typeof p === "number");
    const published = e.aggregate.probability;
    if (!probs.length || typeof published !== "number") {
      skipped.noPanel++;
      continue;
    }
    usable.push({
      probs,
      overlap: e.evidenceOverlap ?? e.aggregate.evidenceOverlap ?? 0,
      outcome: o,
      published,
      market: e.aggregate.components?.market,
      entry: e,
    });
  }
  const report: BacktestReport = { rows: [], skipped };
  if (!usable.length) return report;

  const FOLDS = Math.min(10, usable.length);
  const trainFor = (idx: number): LedgerEntry[] =>
    usable.filter((_, j) => j % FOLDS !== idx % FOLDS).map((u) => u.entry);

  const strategies: { config: string; p: (u: BacktestEntry, i: number) => number }[] = [
    { config: "published headline (as recorded)", p: (u) => u.published },
    { config: "panel GMO, no extremization (k=1)", p: (u) => aggregateBinary(u.probs, 1).probability! },
    {
      config: `panel extremized k=${DEFAULT_EXTREMIZE_K} (overlap-scaled)`,
      p: (u) => aggregateBinary(u.probs, scaleK(DEFAULT_EXTREMIZE_K, u.overlap)).probability!,
    },
    {
      config: "panel adaptive-k (out-of-fold)",
      p: (u, i) => {
        const k = chooseExtremizeK(trainFor(i), DEFAULT_EXTREMIZE_K);
        return aggregateBinary(u.probs, scaleK(k, u.overlap)).probability!;
      },
    },
    {
      config: "+ market anchor (learned w, out-of-fold)",
      p: (u, i) => {
        const k = chooseExtremizeK(trainFor(i), DEFAULT_EXTREMIZE_K);
        const base = aggregateBinary(u.probs, scaleK(k, u.overlap)).probability!;
        if (!u.market) return base;
        const w = chooseMarketWeight(trainFor(i), DEFAULT_MARKET_WEIGHT) * liquidityFactor(u.market.volume);
        return blendWithMarket(base, u.market.probability, w);
      },
    },
    {
      config: "+ recalibration (out-of-fold)",
      p: (u, i) => {
        const train = trainFor(i);
        const k = chooseExtremizeK(train, DEFAULT_EXTREMIZE_K);
        let p = aggregateBinary(u.probs, scaleK(k, u.overlap)).probability!;
        if (u.market) {
          const w = chooseMarketWeight(train, DEFAULT_MARKET_WEIGHT) * liquidityFactor(u.market.volume);
          p = blendWithMarket(p, u.market.probability, w);
        }
        return applyRecalibration(p, fitRecalibration(train));
      },
    },
  ];

  for (const s of strategies) {
    const briers = usable.map((u, i) => brierScore(s.p(u, i), u.outcome));
    const logs = usable.map((u, i) => -logScore(s.p(u, i), u.outcome));
    const ci = bootstrapCi(briers);
    report.rows.push({
      config: s.config,
      n: usable.length,
      brierMean: briers.reduce((a, b) => a + b, 0) / briers.length,
      brierLo: ci.lo,
      brierHi: ci.hi,
      logLossMean: logs.reduce((a, b) => a + b, 0) / logs.length,
    });
  }

  // The external benchmark: on tournament imports, did the published forecast
  // beat the market's own price at import time?
  const tourney = usable.filter((u) => typeof u.entry.origin?.marketProbAtCreate === "number");
  if (tourney.length) {
    report.vsMarket = {
      n: tourney.length,
      swarmBrier: tourney.reduce((s, u) => s + brierScore(u.published, u.outcome), 0) / tourney.length,
      marketBrier:
        tourney.reduce((s, u) => s + brierScore(u.entry.origin!.marketProbAtCreate!, u.outcome), 0) / tourney.length,
    };
  }
  return report;
}

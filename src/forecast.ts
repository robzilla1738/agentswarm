import * as path from "path";
import * as fs from "fs";
import { home } from "./config";
import { normInv } from "./datatools";
import { canonicalizeUrl } from "./searchcore";
import {
  AggregateComponents,
  AggregateForecast,
  CombinerNode,
  CombinerSpec,
  DomainId,
  FittedParams,
  DriverCorrelation,
  Forecast,
  ForecastKind,
  ForecastOrigin,
  ForecastQuestion,
  Quantiles,
  SimDriver,
  SportsLineSnapshot,
  SportsMeta,
} from "./types";
import { clip, ensureDir, errMsg } from "./util";
import { appendRefClass } from "./refstore";

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

/**
 * Looser clamp for OBSERVED market prices feeding the anchor. A real-money
 * market can correctly sit at 98–99.5% on a nearly-decided question; squashing
 * it to the panel's 0.99 ceiling before the log-odds blend throws away exactly
 * the information that makes a confident market worth anchoring to. Still guards
 * the hard 0/1 boundary so the logit stays finite.
 */
export function clampMarketProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.995, Math.max(0.005, p));
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

/** Linear-interpolated quantile q∈[0,1] over an unsorted sample. */
function quantile(values: number[], q: number): number {
  if (values.length <= 1) return values[0] ?? NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
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
 * Robust linear opinion pool (LOP) of a numeric/date panel, computed in the
 * caller's working space (log for heavy skew). Each panelist's stated quantiles
 * define a piecewise-linear quantile function — hence a piecewise-linear CDF;
 * the pool's CDF is the mean of those, inverted back at the canonical taus.
 * Unlike per-quantile averaging (Vincentization), the pool WIDENS when
 * forecasters disagree about LOCATION — disagreement becomes honest uncertainty
 * instead of being averaged away into a falsely tight band.
 *
 * Robustified two ways so one rogue panelist can't hijack a 3–5 member panel:
 *   1. each panelist's quantile vector is winsorized toward the panel's per-key
 *      median (±3·MAD) before pooling, so a 10× outlier is clipped, not pooled;
 *   2. the pooled curve is recentered so its p50 equals the panel's robust
 *      median p50 — location stays exactly as outlier-resistant as the old
 *      median-of-medians (a wild panelist cannot drag the center), while the
 *      WIDTH now reflects genuine between-forecaster disagreement.
 */
function mixtureQuantiles(
  qs: Quantiles[],
  keys: (keyof Quantiles)[],
  fwd: (v: number) => number,
  back: (v: number) => number
): Quantiles {
  const taus = keys.map((key) => QUANTILE_TAUS.find((t) => t.key === key)!.tau);
  const M = keys.length;
  const N = qs.length;
  // Per-panelist quantile values in working (fwd) space: rows[panelist][keyIdx].
  const rows = qs.map((q) => keys.map((key) => fwd(q[key] as number)));
  // Winsorize each key column toward its median by a robust (MAD) scale.
  for (let c = 0; c < M; c++) {
    const col = rows.map((r) => r[c]);
    const med = median([...col].sort((a, b) => a - b));
    const mad = median(col.map((x) => Math.abs(x - med)).sort((a, b) => a - b)) * 1.4826;
    if (mad > 0) {
      const lo = med - 3 * mad;
      const hi = med + 3 * mad;
      for (let r = 0; r < N; r++) rows[r][c] = Math.min(hi, Math.max(lo, rows[r][c]));
    }
  }
  // Re-sort each panelist's clipped values so its quantile function is monotone.
  for (let r = 0; r < N; r++) rows[r].sort((a, b) => a - b);

  const pts = rows.map((r) => r.map((v, j) => ({ tau: taus[j], v })));
  // Piecewise-linear CDF of one panelist, with linearly-extrapolated tails.
  const cdf = (p: { tau: number; v: number }[], x: number): number => {
    const m = p.length;
    if (x <= p[0].v) {
      const dv = p[1].v - p[0].v;
      if (dv <= 0) return x < p[0].v ? 0 : p[0].tau;
      return Math.max(0, p[0].tau + ((x - p[0].v) * (p[1].tau - p[0].tau)) / dv);
    }
    if (x >= p[m - 1].v) {
      const dv = p[m - 1].v - p[m - 2].v;
      if (dv <= 0) return x > p[m - 1].v ? 1 : p[m - 1].tau;
      return Math.min(1, p[m - 1].tau + ((x - p[m - 1].v) * (p[m - 1].tau - p[m - 2].tau)) / dv);
    }
    for (let j = 0; j < m - 1; j++) {
      if (x <= p[j + 1].v) {
        const dv = p[j + 1].v - p[j].v;
        if (dv <= 0) return p[j + 1].tau;
        return p[j].tau + ((x - p[j].v) * (p[j + 1].tau - p[j].tau)) / dv;
      }
    }
    return p[m - 1].tau;
  };
  // Breakpoints: every panelist value plus where each CDF hits 0 and 1, so the
  // pooled CDF is exactly piecewise-linear between sorted breakpoints.
  const bpset = new Set<number>();
  for (const p of pts) {
    for (const { v } of p) bpset.add(v);
    const d0 = p[1].v - p[0].v;
    if (d0 > 0) bpset.add(p[0].v - (p[0].tau * d0) / (p[1].tau - p[0].tau));
    const dN = p[p.length - 1].v - p[p.length - 2].v;
    if (dN > 0)
      bpset.add(p[p.length - 1].v + ((1 - p[p.length - 1].tau) * dN) / (p[p.length - 1].tau - p[p.length - 2].tau));
  }
  const bps = [...bpset].sort((a, b) => a - b);
  // Degenerate (panel of one or all-identical): the pool is a point — no spread.
  if (bps.length < 2) {
    const out = {} as Quantiles;
    keys.forEach((key) => (out[key] = back(rows[0][0])));
    return out;
  }
  const pool = (x: number) => pts.reduce((s, p) => s + cdf(p, x), 0) / N;
  const gvals = bps.map(pool);
  const invert = (t: number): number => {
    if (t <= gvals[0]) return bps[0];
    for (let j = 1; j < bps.length; j++) {
      if (gvals[j] >= t) {
        const dG = gvals[j] - gvals[j - 1];
        if (dG <= 0) return bps[j];
        return bps[j - 1] + ((t - gvals[j - 1]) * (bps[j] - bps[j - 1])) / dG;
      }
    }
    return bps[bps.length - 1];
  };
  // Recenter onto the robust median location so a rogue cannot drag the center.
  const robustMid = median(qs.map((q) => fwd(q.p50)).sort((a, b) => a - b));
  const shift = robustMid - invert(0.5);
  const values = taus.map((t) => back(invert(t) + shift)).sort((a, b) => a - b);
  const out = {} as Quantiles;
  keys.forEach((key, i) => (out[key] = values[i]));
  return out;
}

/**
 * Combine a numeric panel into one predictive distribution. Default is a robust
 * linear opinion pool (`mixtureQuantiles`) — the pool's CDF, which captures
 * between-forecaster disagreement as real width; `combine:"vincent"` keeps the
 * legacy per-quantile median/trimmed-mean (kept as the backtest baseline). Both
 * run in log space for heavily skewed positive quantities, and only over the
 * quantile keys every panelist provided (a percentile averaged across half the
 * panel is a different statistic than its neighbours). Within-forecaster
 * overconfidence is corrected separately, by interval dilation in `aggregateOne`.
 */
export function aggregateQuantiles(
  qs: Quantiles[],
  k = DEFAULT_EXTREMIZE_K,
  opts: { combine?: "lop" | "vincent" } = {}
): AggregateForecast {
  if (!qs.length) throw new Error("aggregateQuantiles: empty panel");
  const logSpace = shouldUseLogSpace(qs);
  const fwd = (v: number) => (logSpace ? Math.log(v) : v);
  const back = (v: number) => (logSpace ? Math.exp(v) : v);
  const keys = QUANTILE_TAUS.map((t) => t.key).filter((key) => qs.every((q) => typeof q[key] === "number"));
  let quantiles: Quantiles;
  if ((opts.combine ?? "lop") === "vincent") {
    const center = (vals: number[]): number =>
      vals.length < 10 ? median([...vals].sort((a, b) => a - b)) : trimmedMean(vals);
    const values = keys.map((key) => back(center(qs.map((q) => fwd(q[key] as number))))).sort((a, b) => a - b);
    quantiles = {} as Quantiles;
    keys.forEach((key, i) => {
      quantiles[key] = values[i];
    });
  } else {
    quantiles = mixtureQuantiles(qs, keys, fwd, back);
  }
  const p50s = qs.map((q) => q.p50).sort((a, b) => a - b);
  const scale = Math.max(Math.abs(quantiles.p50 as number), 1e-9);
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
 * option list, fill missing options with a floor, and renormalize to sum 1.
 * Null when nothing usable was submitted.
 *
 * Scale-invariant by construction: we never rescale individual values, we
 * divide by the sum of the listed options. So {90,9,1} (percentages),
 * {0.9,0.09,0.01} (fractions), and {60,30,10} all map to the same
 * distribution. The previous per-value `if (n > 1) n /= 100` was a bug — an
 * option submitted as exactly `1` (meaning "1%") was not `> 1`, so it slipped
 * through as `1.0` (=100%) and, after renormalizing against its already-scaled
 * neighbours, ballooned to ~50% (e.g. 1/(0.9+0.09+1.0) = 0.5025).
 */
export function normalizeOptionProbs(raw: unknown, options: string[]): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || !options.length) return null;
  const lookup = new Map<string, number>();
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    lookup.set(key.trim().toLowerCase(), n); // raw scale kept — normalized by the listed-option sum below
  }
  if (!lookup.size) return null;
  // Sum over the LISTED options only, so unrelated/typo keys can't distort the scale.
  let rawSum = 0;
  let matched = 0;
  for (const opt of options) {
    const v = lookup.get(opt.trim().toLowerCase());
    if (v !== undefined) {
      matched++;
      rawSum += v;
    }
  }
  if (!matched || rawSum <= 0) return null;
  const out: Record<string, number> = {};
  for (const opt of options) {
    const v = lookup.get(opt.trim().toLowerCase());
    out[opt] = Math.max((v ?? 0) / rawSum, 0.005); // scale-invariant, then floor on the 0–1 scale — certainty is never earned
  }
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
  const ws0 =
    weights && weights.length === panels.length && weights.every((w) => Number.isFinite(w) && w > 0)
      ? weights
      : panels.map(() => 1);

  // Guard 1 — drop non-informative ("I don't know") panels whose option probs
  // are essentially flat: they carry no signal and only drag the aggregate
  // toward uniform (which is what made a bogus "Other" look meaningful). Keep
  // the full set if EVERY panel is degenerate — never aggregate an empty panel.
  const panelSpread = (p: Record<string, number>) => {
    const vs = options.map((o) => clampProb(p[o] ?? 0.01));
    return Math.max(...vs) - Math.min(...vs);
  };
  const tagged = panels.map((p, i) => ({ p, w: ws0[i], flat: panelSpread(p) < 0.02 }));
  const kept = tagged.some((t) => !t.flat) ? tagged.filter((t) => !t.flat) : tagged;
  const panelsK = kept.map((t) => t.p);
  const ws = kept.map((t) => t.w);

  const wSum = ws.reduce((s, w) => s + w, 0);
  const kEff = panelsK.length > 1 ? k : 1;
  const result: Record<string, number> = {};
  let spread = 0;
  for (const opt of options) {
    const raw = panelsK.map((p) => clampProb(p[opt] ?? 0.01));
    spread = Math.max(spread, Math.max(...raw) - Math.min(...raw)); // honest disagreement, pre-winsorize
    // Guard 2 — winsorize per-option outliers once the panel is large enough
    // for quantiles to mean something, so one rogue or mis-scaled vote can't
    // dominate an option, without dropping anyone's ballot.
    let ps = raw;
    if (panelsK.length >= 5) {
      const lo = quantile(raw, 0.1);
      const hi = quantile(raw, 0.9);
      ps = raw.map((p) => Math.min(hi, Math.max(lo, p)));
    }
    const logOddsMean = ps.reduce((s, p, i) => s + ws[i] * Math.log(p / (1 - p)), 0) / wSum;
    const extremized = Math.exp(kEff * logOddsMean);
    result[opt] = clampProb(extremized / (1 + extremized));
  }
  // Each option is aggregated as an independent binary (GMO of odds) then
  // renormalized to restore the simplex. A weighted log-opinion-pool over the
  // simplex would be more principled, but it needs its own k recalibration —
  // deferred to keep the golden-section-tuned k valid.
  const sum = Object.values(result).reduce((s, v) => s + v, 0);
  for (const opt of options) result[opt] = result[opt] / sum;
  return { optionProbs: result, k: kEff, n: panelsK.length, spread };
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

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(canonicalizeUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Mean pairwise overlap of the panel's cited source sets: 0.7 × Jaccard on
 * canonical URLs + 0.3 × Jaccard on domains. Exact-URL matching alone
 * under-detects shared sourcing (two panelists on different pages of the same
 * outlet still share an editorial line), which left k too high. 0 = fully
 * independent evidence, 1 = everyone read the same pages. Pairs where either
 * panelist cited nothing are skipped — silence is not agreement; no valid
 * pairs → 0.
 */
export function evidenceOverlap(sourceSets: string[][]): number {
  const urlSets = sourceSets.map((urls) => new Set(urls.map((u) => canonicalizeUrl(u))));
  const domainSets = sourceSets.map((urls) => new Set(urls.map(hostOf)));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < urlSets.length; i++) {
    for (let j = i + 1; j < urlSets.length; j++) {
      if (!urlSets[i].size || !urlSets[j].size) continue;
      sum += 0.7 * jaccard(urlSets[i], urlSets[j]) + 0.3 * jaccard(domainSets[i], domainSets[j]);
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
  const pp = clampProb(panelP);
  // The market operand keeps its near-boundary information (clampMarketProb),
  // while the panel keeps its conservative clamp. The blended OUTPUT is still
  // capped at 0.99 so the engine never publishes >99% certainty.
  const mp = clampMarketProb(marketP);
  const lp = Math.log(pp / (1 - pp));
  const lm = Math.log(mp / (1 - mp));
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
 * Two-level backoff for the per-domain calibration flywheel: when the in-domain
 * slice has enough resolved history, fit on it; otherwise fall back to ALL
 * entries (the global fit, whose own N-threshold then backs off to the default).
 * A domain thus learns its own parameters exactly where it has earned the data
 * and is identical to global behavior everywhere else — including for old ledger
 * entries written before the domain stamp existed (they carry no domain, so a
 * thin domain transparently uses the global pool that still contains them).
 */
/** Generic per-domain sufficiency threshold for learners without their own named minimum. */
export const MIN_DOMAIN_FIT_N = 20;

function scopeToDomain(entries: LedgerEntry[], domain: DomainId | undefined, minN: number): LedgerEntry[] {
  if (!domain) return entries;
  const inDomain = entries.filter((e) => e.domain === domain);
  const resolved = inDomain.reduce((n, e) => n + (e.resolution ? 1 : 0), 0);
  return resolved >= minN ? inDomain : entries;
}

/** Shrinkage pseudo-count for per-domain partial pooling: at this many in-domain USABLE fits the local term gets half the weight. */
export const POOL_KAPPA = 20;

/**
 * A scalar learner's result: the fitted value, whether it actually LEARNED (vs
 * backed off to the fallback), and the count of entries IT could use. `learned`
 * + `n` are what partial pooling needs — pooling a backed-off fallback would
 * pull the global pool toward the cold prior, and weighting by a kind-agnostic
 * resolution count would credit evidence this estimator never saw.
 */
interface ScalarFit {
  value: number;
  learned: boolean;
  n: number;
}

/**
 * Per-domain partial pooling for a SCALAR learner (James-Stein style): fit the
 * parameter globally and in-domain, then blend the in-domain value toward the
 * global one by the local fit's OWN usable sample — w = nLocal/(nLocal+κ). A hard
 * in-domain↔global switch (the old scopeToDomain) regresses exactly when a domain
 * first crosses its threshold and the thin local fit abruptly takes over; pooling
 * shrinks that local fit toward the global pool until it has earned independence.
 *
 * Two guards keep this from regressing the GLOBAL value toward the static
 * fallback (the bug the QCal learner already avoids): if the local fit did not
 * learn (its own usable slice was below threshold) we return the global fit
 * verbatim — a data-poor domain rests on the global POOL, never the cold prior —
 * and the weight uses the local fit's usable count, not a kind-agnostic
 * resolution tally that would over-credit wrong-kind history.
 */
function pooledScalarFit(
  fit: (entries: LedgerEntry[]) => ScalarFit,
  entries: LedgerEntry[],
  domain: DomainId | undefined,
  kappa = POOL_KAPPA
): number {
  const global = fit(entries);
  if (!domain) return global.value;
  const local = fit(entries.filter((e) => e.domain === domain));
  if (!local.learned) return global.value; // rest on the global pool, not the fallback
  const w = local.n / (local.n + kappa);
  return w * local.value + (1 - w) * global.value;
}

/**
 * Grid-search argmin returning the SMALLEST weight that achieves the minimum
 * loss (strict-improvement-keep-first). This is deliberately conservative on a
 * flat optimum: for a market that the record shows is uninformative or wrong,
 * the low-weight region is flat (the −1/panelN residual clamps wEff to 0), and
 * the smallest such weight is the only one guaranteed to stay harmless when
 * applied LIVE to a future market whose liquidity may differ. (We considered
 * breaking ties toward the prior weight to counter under-anchoring on good
 * markets — the audit's C4 — but that hands a future high-liquidity *wrong*
 * market residual weight, trading a guaranteed safety for a few ten-thousandths
 * of Brier. Conservative wins.)
 */
function gridArgmin(loss: (x: number) => number, lo: number, hi: number, step: number): number {
  let best = lo;
  let bestLoss = Infinity;
  for (let w = lo; w <= hi + 1e-9; w += step) {
    const l = loss(Number(w.toFixed(6)));
    if (l < bestLoss - 1e-12) {
      bestLoss = l;
      best = Number(w.toFixed(6));
    }
  }
  return best;
}

/**
 * Fit the market blend weight on the resolved track record: the w that would
 * have minimized mean log loss re-blending each stored panel aggregate with
 * its stored market price. Falls back below MIN_MARKET_WEIGHT_N resolutions.
 */
function chooseMarketWeightRaw(entries: LedgerEntry[], fallback: number): ScalarFit {
  const usable = entries.filter(
    (e) =>
      e.question.kind === "binary" &&
      e.resolution &&
      (e.resolution.outcome === 0 || e.resolution.outcome === 1) &&
      Number.isFinite(e.aggregate.components?.extremized) &&
      Number.isFinite(e.aggregate.components?.market?.probability)
  );
  if (usable.length < MIN_MARKET_WEIGHT_N) return { value: fallback, learned: false, n: usable.length };
  const lossAt = (w: number): number => {
    let sum = 0;
    for (const e of usable) {
      const c = e.aggregate.components!;
      // Re-apply each market's own liquidity scaling so the fitted w plays the
      // same role it plays live (a base weight, not an absolute one), and
      // subtract the share the panel already carries via its market-anchored
      // lens (see aggregateOne) so double-counting doesn't inflate the fit.
      const liq = liquidityFactor(c.market!.volume);
      const panelN = Math.max(1, e.panel?.length || e.aggregate.n || 1);
      const wEff = Math.max(0, w * liq - 1 / panelN);
      const p = blendWithMarket(c.extremized!, c.market!.probability, wEff);
      sum += -logScore(p, e.resolution!.outcome as 0 | 1);
    }
    return sum / usable.length;
  };
  return { value: gridArgmin(lossAt, 0, 1, 0.1), learned: true, n: usable.length };
}

export function chooseMarketWeight(entries = loadLedger(), fallback = DEFAULT_MARKET_WEIGHT, domain?: DomainId): number {
  return pooledScalarFit((es) => chooseMarketWeightRaw(es, fallback), entries, domain);
}

// ---------------------------------------------------------------- sports line anchoring

/**
 * Game-to-game standard deviation of the realized quantity, per sport × line
 * type — well-established public values (the season-long SD of final totals and
 * margins). These are physical constants of the sport, not tunables, so they
 * live in code. An unknown sport returns null → no line anchor (safe fallback).
 */
export const SPORTS_SIGMA: Record<string, { total: number; margin: number }> = {
  nba: { total: 11, margin: 12 },
  wnba: { total: 11, margin: 12 },
  ncaab: { total: 12, margin: 12 },
  basketball: { total: 11, margin: 12 },
  nfl: { total: 10, margin: 13.5 },
  ncaaf: { total: 14, margin: 16 },
  americanfootball: { total: 11, margin: 14 },
  mlb: { total: 3.2, margin: 4.3 },
  baseball: { total: 3.2, margin: 4.3 },
  nhl: { total: 1.9, margin: 2.4 },
  hockey: { total: 1.9, margin: 2.4 },
  soccer: { total: 1.6, margin: 1.9 },
  epl: { total: 1.6, margin: 1.9 },
};

/**
 * The de-vigged moneyline as an mc market over the winner options. 3-way
 * (soccer-style) books persist all three legs and need normalizing — independent
 * per-leg medians need not sum to 1; 2-way is exact at {home, 1−home}.
 */
export function sportsWinnerMarket(sm: Pick<SportsMeta, "home" | "away" | "lineAtCreate">): Record<string, number> {
  const snap = sm.lineAtCreate;
  const h = snap?.pHome ?? 0.5;
  if (typeof snap?.pDraw === "number" && typeof snap?.pAway === "number") {
    const s = h + snap.pDraw + snap.pAway || 1;
    return { [sm.home]: h / s, Draw: snap.pDraw / s, [sm.away]: snap.pAway / s };
  }
  return { [sm.home]: h, [sm.away]: 1 - h };
}

/**
 * Decide whether a mission is a head-to-head game the engine should decompose
 * into market-anchored facets, and which one. Returns the facet to forecast
 * ("full" = winner + combined total + margin), or null to leave it to the
 * normal planner. Conservative by design: anything that isn't clearly winner /
 * combined total / margin — a single-team total, a player prop, a binary
 * over-under / cover bet, a half/quarter/period line, or a non-game mission —
 * returns null so the forecast target is never silently rewritten.
 */
export function classifySportsMission(mission: string): "winner" | "total" | "margin" | "full" | null {
  const m = (mission || "").toLowerCase();
  // "combine for" / "both teams" imply a two-team game even without a vs/@ token.
  const matchupShape = /\b(vs\.?|@|versus)\b|\b(beat|defeat|upset)s?\b|\bgame \d|\bwin(s|ning)? (against|over)\b|\bcombine[ds]? for\b|\bboth teams?\b/.test(m);
  const leagueWord =
    /\b(nba|wnba|ncaa|nfl|mlb|nhl|epl|premier league|la ?liga|bundesliga|serie a|champions league|ufc|f1|formula 1|test match|odi|ipl|super bowl|world series|stanley cup|playoff|finals?)\b/.test(m);
  if (!matchupShape && !leagueWord) return null;
  const combinedSignal = /\b(combined?|both teams?|each team|total (score|points|runs|goals))\b/.test(m) || /\bcombine[ds]? (for|to)\b/.test(m) || /\bbe scored\b/.test(m);
  const propish =
    /\b(prop|player|rebounds?|assists?|steals?|blocks?|strikeouts?|home runs?|touchdowns?|first half|second half|1st half|2nd half|half[\s-]?time|quarter|q[1-4]\b|period|overtime|\bot\b|first to \d|anytime|hat[\s-]?trick|yards|passing|rushing|receiving)\b/.test(m);
  // A single-team scoring total ("how many points will the Lakers score") is
  // unsupported — but the same phrasing for both teams ("…combine for", "…be scored") is the combined total.
  const singleTeamStat = !combinedSignal && /\bhow many (points|goals|runs|yards|hits|saves) (will|does|can) (the )?[a-z][a-z .'-]*\b/.test(m);
  // A threshold/cover/over-under/win-by-N bet is BINARY — the normal planner
  // owns it ("will A beat B by 5?" is yes/no, not "by how many will A win").
  const binaryThreshold =
    /\bcover(s|ing)? (the )?(spread|line|number|points?)\b/.test(m) ||
    /\b(go|goes|going|stay|stays|land|lands|finish|finishes) (over|under)\b/.test(m) ||
    /\bwin by (more|at least|over|fewer|less|under|exactly) than?\b/.test(m) ||
    (/\bwill\b/.test(m) && /\b(over|under) \d+(\.\d+)?\b/.test(m)) ||
    (/\bwill\b/.test(m) && /\b(beat|beats|defeat|defeats|win|wins|lead|leads) .*\bby \d/.test(m));
  // A season/standings/series comparison is NOT a single game — don't bind it to
  // the next matchup ("win more games than … this season", "win the division").
  const seasonOrSeries =
    /\b(this season|the season|regular season|over the season|this year|all season)\b/.test(m) ||
    /\bmore (games|wins|points|goals|runs) than\b/.test(m) ||
    /\bwin (the )?(division|title|championship|pennant|conference|league|series|cup|trophy|playoffs?)\b/.test(m) ||
    /\b(standings|best.of|series (lead|win|sweep)|win the series|sweep)\b/.test(m) ||
    /\bmake (the )?playoffs?\b/.test(m);
  if (propish || singleTeamStat || binaryThreshold || seasonOrSeries) return null;
  if (
    /\b(combined|total) (score|points|runs|goals)\b/.test(m) ||
    /\b(combined|game|match|the) total\b/.test(m) ||
    /\btotal (be|is|will be)\b/.test(m) ||
    /\bcombine[ds]? (for|to)\b/.test(m) ||
    /\bover[\s/]?under\b/.test(m) ||
    /\bbe scored\b/.test(m)
  )
    return "total";
  if (/\b(by how many|margin of victory|winning margin|what.{0,8}\bmargin)\b/.test(m)) return "margin";
  if (/\b(who (wins|will win|takes it)|which team wins|winner|moneyline)\b/.test(m) || /\bwill (the )?[a-z][a-z .'-]*\b (beat|defeat|upset|win|wins)\b/.test(m)) return "winner";
  return "full";
}

/**
 * Sports whose `spreads` market IS the median expected margin (the line is set
 * so each side is ~50%), so it can anchor the margin distribution. Baseball run
 * lines and hockey puck lines are fixed ±1.5 markets, and soccer handicaps are
 * ±0.5/±1.5 — none is the median margin, so margin anchoring is skipped there
 * (the margin facet still resolves from the box score, just panel-only).
 */
const POINT_SPREAD_SPORTS = new Set(["nba", "wnba", "ncaab", "basketball", "nfl", "ncaaf", "americanfootball"]);

/**
 * Per-sport σ for a total/margin line; null when the sport is unknown (→ skip
 * the anchor). Margin σ is returned only for true point-spread sports — for
 * run-line/puck-line/handicap sports the spread is not the median margin.
 */
export function sportsSigma(sportTitle: string, kind: "total" | "margin"): number | null {
  const key = (sportTitle || "").toLowerCase().replace(/[^a-z]/g, "");
  for (const k of Object.keys(SPORTS_SIGMA)) {
    if (key.includes(k)) {
      if (kind === "margin" && !POINT_SPREAD_SPORTS.has(k)) return null;
      return SPORTS_SIGMA[k][kind];
    }
  }
  return null;
}

/**
 * A sportsbook total/spread line as a Normal(mean=line, sd=σ) mapped onto the
 * 7 canonical taus: q_τ = line + σ·Φ⁻¹(τ). Sharp books post the median≈mean
 * outcome, so the line IS the center; σ is the game-to-game SD. Symmetric and
 * pure additive arithmetic — correct for negative margins, never touches log
 * space, and the tail never reaches 0 at realistic total line/σ.
 */
export function lineToQuantiles(line: number, sigma: number): Quantiles {
  if (!Number.isFinite(line) || !(sigma > 0)) throw new Error("lineToQuantiles: bad line/σ");
  const out: Partial<Record<keyof Quantiles, number>> = {};
  for (const { key, tau } of QUANTILE_TAUS) out[key] = line + sigma * normInv(tau);
  return monotoneQuantiles(out)!;
}

/**
 * Blend a numeric panel aggregate toward a market line distribution PER-TAU
 * (Vincent), not via the linear opinion pool. The LOP widens on disagreement —
 * right for independent panelists, wrong for a sharper estimate of the SAME
 * quantity: it would inflate the band straddling panel and book. Per-tau pulls
 * the CENTER toward the calibrated line while width stays the panel's. w=0 →
 * panel, w=1 → line.
 */
export function blendQuantilesWithMarket(panel: Quantiles, market: Quantiles, w: number): Quantiles {
  return blendQuantiles(panel, market, w);
}

/** Sharp books deserve a high default weight; the panel only nudges the line where it has a real edge. */
export const DEFAULT_SPORTS_MARKET_WEIGHT = 0.75;
/** Resolved sports facets needed before the sports market weight is fit from the record. */
export const MIN_SPORTS_MARKET_WEIGHT_N = 20;

/**
 * Fit the numeric sports market weight on the resolved record: the w that would
 * have minimized mean pinball loss re-blending each facet's stored pre-blend
 * quantiles (components.blendedQ) toward its stored line distribution. Mirrors
 * chooseMarketWeight but in pinball space, re-applying the same −1/panelSize
 * residual the live path uses. Falls back to the high default below 20.
 */
function chooseSportsMarketWeightRaw(entries: LedgerEntry[], fallback: number): ScalarFit {
  const usable = entries.filter(
    (e) =>
      (e.question.kind === "numeric" || e.question.kind === "date") &&
      e.resolution &&
      typeof e.resolution.outcome === "number" &&
      e.aggregate.components?.blendedQ &&
      e.aggregate.components?.marketLine
  );
  if (usable.length < MIN_SPORTS_MARKET_WEIGHT_N) return { value: fallback, learned: false, n: usable.length };
  const lossAt = (w: number): number => {
    let sum = 0;
    for (const e of usable) {
      const c = e.aggregate.components!;
      const mq = lineToQuantiles(c.marketLine!.line, c.marketLine!.sigma);
      const panelN = Math.max(1, e.panel?.length || e.aggregate.n || 1);
      const wEff = Math.max(0, w - 1 / panelN);
      sum += pinballLoss(blendQuantilesWithMarket(c.blendedQ!, mq, wEff), e.resolution!.outcome as number);
    }
    return sum / usable.length;
  };
  return { value: gridArgmin(lossAt, 0, 1, 0.1), learned: true, n: usable.length };
}

export function chooseSportsMarketWeight(entries = loadLedger(), fallback = DEFAULT_SPORTS_MARKET_WEIGHT, domain?: DomainId): number {
  return pooledScalarFit((es) => chooseSportsMarketWeightRaw(es, fallback), entries, domain);
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
export function methodWeights(entries = loadLedger(), domain?: DomainId): Record<string, number> {
  entries = scopeToDomain(entries, domain, MIN_DOMAIN_FIT_N);
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
 * The shared logistic-recalibration grid search: the (a, b) minimizing mean log
 * loss over the (p, outcome) pairs, regularized toward identity (γ = 2/n) so
 * small samples barely move it. Both the binary (fitRecalibration) and mc
 * (fitMcRecalibration) fits are this exact loop over differently-collected pairs;
 * keeping it in one place stops the two from drifting apart. The `n` reported on
 * the result is supplied by the caller (binary: resolved forecasts; mc: resolved
 * questions, since pairs within a question are correlated). a down to 0.1: LLM
 * panels can be SEVERELY overconfident, and a slope floor of 0.5 made that
 * uncorrectable; the identity-regularizer keeps small samples from wandering
 * down there without evidence. Callers gate on their own minimum BEFORE calling.
 */
function fitLogisticRecal(pts: { p: number; outcome: 0 | 1 }[], n: number): Recalibration {
  const gamma = 2 / pts.length;
  let best: Recalibration = { a: 1, b: 0, n };
  let bestLoss = Infinity;
  for (let ai = 0; ai <= 38; ai++) {
    const a = 0.1 + ai * 0.05;
    for (let bi = -20; bi <= 20; bi++) {
      const b = bi / 10;
      let sum = 0;
      for (const pt of pts) {
        const odds = Math.exp(a * Math.log(pt.p / (1 - pt.p)) + b);
        sum += -logScore(clampProb(odds / (1 + odds)), pt.outcome);
      }
      const loss = sum / pts.length + gamma * ((a - 1) * (a - 1) + b * b);
      if (loss < bestLoss - 1e-12) {
        bestLoss = loss;
        best = { a: Number(a.toFixed(2)), b: Number(b.toFixed(2)), n };
      }
    }
  }
  return best;
}

/**
 * Fit (a, b) on the resolved record minimizing mean log loss (shared
 * fitLogisticRecal). The fit uses each entry's PRE-recalibration value
 * (components.blended or extremized) — fitting on already-recalibrated numbers
 * would be circular. The b intercept is the genuinely new dial vs adaptive-k: it
 * corrects a systematic YES-lean (LLM acquiescence bias) no symmetric exponent can.
 */
export function fitRecalibration(entries = loadLedger(), domain?: DomainId): Recalibration | null {
  entries = scopeToDomain(entries, domain, MIN_RECALIBRATION_N);
  const pts: { p: number; outcome: 0 | 1 }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const c = e.aggregate.components;
    const p = c?.blended ?? c?.extremized ?? e.aggregate.probability;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    pts.push({ p: clampProb(p), outcome: o });
  }
  if (pts.length < MIN_RECALIBRATION_N) return null;
  return fitLogisticRecal(pts, pts.length);
}

export function applyRecalibration(p: number, r: Recalibration | null): number {
  if (!r) return clampProb(p);
  const cp = clampProb(p);
  const odds = Math.exp(r.a * Math.log(cp / (1 - cp)) + r.b);
  return clampProb(odds / (1 + odds));
}

// ---------------------------------------------------------------- mc recalibration (B2)

/** Resolved mc QUESTIONS needed before option-probability recalibration leaves identity. */
export const MIN_MC_RECALIBRATION_N = 30;

/**
 * Fit ONE shared logistic (a,b) over every (optionProb, did-it-happen) pair from
 * the resolved mc record — the multiple-choice analogue of fitRecalibration,
 * which mc previously had none of. A single shared map (not per-option) is the
 * right model at these data volumes: it corrects the systematic over/under-
 * confidence of the mc sharpening without K separate fits that would each see a
 * handful of points. Gated on the count of resolved mc QUESTIONS (not pairs,
 * which are correlated within a question). Returns null below the threshold.
 */
export function fitMcRecalibration(entries = loadLedger(), domain?: DomainId): Recalibration | null {
  entries = scopeToDomain(entries, domain, MIN_MC_RECALIBRATION_N);
  const pts: { p: number; outcome: 0 | 1 }[] = [];
  let questions = 0;
  for (const e of entries) {
    if (e.question.kind !== "mc" || !e.resolution) continue;
    const realized = e.resolution.outcome;
    const options = e.question.options;
    // Fit on the PRE-recalibration probs (fall back to the published ones for
    // entries written before the snapshot existed) — fitting on already-
    // recalibrated numbers would be circular, mirroring fitRecalibration.
    const probs = e.aggregate.components?.preRecalOptionProbs ?? e.aggregate.optionProbs;
    if (typeof realized !== "string" || realized === "void" || !options || !probs || !options.includes(realized)) continue;
    questions++;
    for (const opt of options) {
      const p = probs[opt];
      if (typeof p !== "number" || !Number.isFinite(p)) continue;
      pts.push({ p: clampProb(p), outcome: opt === realized ? 1 : 0 });
    }
  }
  if (questions < MIN_MC_RECALIBRATION_N || pts.length < MIN_MC_RECALIBRATION_N) return null;
  // Same logistic grid as the binary fit, but the reported n is the resolved
  // QUESTION count (pairs within a question are correlated, so they'd overstate it).
  return fitLogisticRecal(pts, questions);
}

/** Apply a shared logistic recalibration to each option probability in log-odds, then renormalize to the simplex. */
export function applyMcRecalibration(optionProbs: Record<string, number>, r: Recalibration | null): Record<string, number> {
  if (!r) return optionProbs;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [opt, p] of Object.entries(optionProbs)) {
    const v = applyRecalibration(p, r);
    out[opt] = v;
    sum += v;
  }
  if (sum > 0) for (const opt of Object.keys(out)) out[opt] /= sum;
  return out;
}

// ---------------------------------------------------------------- beta calibration (B1)

/** Three-parameter beta calibration (Kull 2017): p′ = σ(c + a·ln p − b·ln(1−p)). */
export interface BetaCalibration {
  a: number;
  b: number;
  c: number;
  n: number;
}

/**
 * Beta calibration (Kull, Silva Filho & Flach 2017) — a richer alternative to the
 * 2-parameter logistic (Platt) recalibration. Where Platt can only shift and
 * scale the reliability curve affinely in log-odds, beta calibration fits
 * separate slopes on ln p and ln(1−p), so it can bend an S-shaped or
 * boundary-skewed curve. NOT isotonic regression (which overfits below ~1000
 * points and serializes poorly). This is offered as a BACKTEST-GATED alternative:
 * the binary backtest scores it head-to-head with Platt so promotion to the live
 * path is earned, not assumed (Platt remains the live default until the gate
 * shows beta wins, which needs more data than a cold ledger has). Returns null
 * below the recalibration threshold.
 */
export function fitBetaCalibration(entries = loadLedger(), domain?: DomainId): BetaCalibration | null {
  entries = scopeToDomain(entries, domain, MIN_RECALIBRATION_N);
  const pts: { lp: number; l1p: number; outcome: 0 | 1 }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const c = e.aggregate.components;
    const p = c?.blended ?? c?.extremized ?? e.aggregate.probability;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    const cp = clampProb(p);
    pts.push({ lp: Math.log(cp), l1p: Math.log(1 - cp), outcome: o });
  }
  if (pts.length < MIN_RECALIBRATION_N) return null;
  const gamma = 2 / pts.length;
  let best: BetaCalibration = { a: 1, b: 1, c: 0, n: pts.length };
  let bestLoss = Infinity;
  // a,b ≥ 0 (monotone non-decreasing map); grid over a sane range, c the intercept.
  for (let ai = 0; ai <= 30; ai++) {
    const a = ai * 0.1; // 0..3
    for (let bj = 0; bj <= 30; bj++) {
      const b = bj * 0.1; // 0..3
      for (let ck = -20; ck <= 20; ck++) {
        const cc = ck / 10; // -2..2
        let sum = 0;
        for (const pt of pts) {
          const z = cc + a * pt.lp - b * pt.l1p;
          const pp = clampProb(1 / (1 + Math.exp(-z)));
          sum += -logScore(pp, pt.outcome);
        }
        const loss = sum / pts.length + gamma * ((a - 1) * (a - 1) + (b - 1) * (b - 1) + cc * cc);
        if (loss < bestLoss - 1e-12) {
          bestLoss = loss;
          best = { a: Number(a.toFixed(2)), b: Number(b.toFixed(2)), c: Number(cc.toFixed(2)), n: pts.length };
        }
      }
    }
  }
  return best;
}

export function applyBetaCalibration(p: number, cal: BetaCalibration | null): number {
  if (!cal) return clampProb(p);
  const cp = clampProb(p);
  const z = cal.c + cal.a * Math.log(cp) - cal.b * Math.log(1 - cp);
  return clampProb(1 / (1 + Math.exp(-z)));
}

// ---------------------------------------------------------------- interval dilation

/**
 * Interval dilation is to numeric/date forecasts what recalibration is to
 * binary ones: the learned correction for systematic OVER-confidence. LLM
 * predictive intervals are reliably too narrow (an "80%" p10–p90 band covers
 * far less than 80% of outcomes), and the linear-opinion pool only fixes the
 * BETWEEN-forecaster share of that — a panel that agrees and is jointly
 * overconfident still states a tight band. Dilation widens every quantile away
 * from p50 by a factor d (d=1 is identity), in log space for skewed positive
 * quantities so the stretch is proportional rather than additive. pNever is a
 * separate binary-style mass and is never dilated.
 */
export function applyQuantileDilation(q: Quantiles, d: number, logSpace = false): Quantiles {
  // The symmetric case is exactly the asymmetric one with dLo=dUp — keep one
  // stretch kernel (applyAsymmetricDilation) so the log/linear pivot logic can
  // never drift between the two.
  return applyAsymmetricDilation(q, d, d, logSpace);
}

/**
 * Asymmetric interval dilation: widen the LOWER quantiles (below p50) by dLo and
 * the UPPER quantiles (above p50) by dUp. A single symmetric factor can't fix
 * miscoverage that is lopsided — LLM panels are often more overconfident on the
 * downside (a crash) than the upside, or vice-versa per quantity. dLo=dUp
 * recovers the symmetric applyQuantileDilation exactly. p50 is the pivot.
 */
export function applyAsymmetricDilation(q: Quantiles, dLo: number, dUp: number, logSpace = false): Quantiles {
  const out = { ...q };
  const p50 = q.p50;
  for (const { key, tau } of QUANTILE_TAUS) {
    const v = q[key];
    if (typeof v !== "number" || tau === 0.5) continue;
    const d = tau < 0.5 ? dLo : dUp;
    if (!(d > 0) || d === 1) continue;
    out[key] = logSpace && p50 > 0 && v > 0 ? p50 * Math.exp(d * Math.log(v / p50)) : p50 + d * (v - p50);
  }
  return out;
}

/** Out-of-the-box dilation: LLM 80% intervals cover ~50–60%; the LOP adds some width, so 1.15 is deliberately conservative. */
export const DEFAULT_QUANTILE_DILATION = 1.15;
/** Below this many resolved numeric/date forecasts, dilation is the default — fitting d on a handful of intervals is just noise. */
export const MIN_QCAL_N = 25;

export interface QuantileCalibration {
  d: number;
  n: number;
  source: "default" | "learned";
}

/**
 * Fit the interval dilation d on the resolved numeric/date record: the d that
 * minimizes mean pinball loss when each entry's PRE-dilation quantiles are
 * re-dilated by d (fitting on already-dilated numbers would be circular —
 * mirrors `fitRecalibration`'s pre-recalibration choice). Pinball is the proper
 * score and uses every stated quantile, not just the p10/p90 band. Regularized
 * toward d=1 (γ=2/n) so small samples barely move it; falls back to the default
 * below MIN_QCAL_N.
 */
function fitQuantileCalibrationRaw(entries: LedgerEntry[], fallback: number): QuantileCalibration {
  const pts: { q: Quantiles; logSpace: boolean; outcome: number }[] = [];
  for (const e of entries) {
    if ((e.question.kind !== "numeric" && e.question.kind !== "date") || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (typeof o !== "number") continue;
    const q = e.aggregate.predilationQuantiles ?? e.aggregate.quantiles;
    if (!q || typeof q.p50 !== "number") continue;
    pts.push({ q, logSpace: Boolean(e.aggregate.logSpace), outcome: o });
  }
  if (pts.length < MIN_QCAL_N) return { d: fallback, n: pts.length, source: "default" };
  const gamma = 2 / pts.length;
  let bestD = 1;
  let bestLoss = Infinity;
  for (let i = 0; i <= 50; i++) {
    const d = 0.5 + i * 0.05; // 0.5 .. 3.0
    let sum = 0;
    for (const pt of pts) sum += pinballLoss(applyQuantileDilation(pt.q, d, pt.logSpace), pt.outcome);
    const loss = sum / pts.length + gamma * (d - 1) * (d - 1);
    if (loss < bestLoss - 1e-12) {
      bestLoss = loss;
      bestD = d;
    }
  }
  return { d: Number(bestD.toFixed(2)), n: pts.length, source: "learned" };
}

export function fitQuantileCalibration(
  entries = loadLedger(),
  fallback = DEFAULT_QUANTILE_DILATION,
  domain?: DomainId
): QuantileCalibration {
  const global = fitQuantileCalibrationRaw(entries, fallback);
  if (!domain) return global;
  // Partial pooling on the dilation scalar: a thin in-domain fit shrinks toward
  // the global one by its own sample size (and stays global until it learns).
  const local = fitQuantileCalibrationRaw(entries.filter((e) => e.domain === domain), fallback);
  if (local.source === "default") return global;
  const w = local.n / (local.n + POOL_KAPPA);
  const base = global.source === "learned" ? global.d : fallback;
  return { d: Number((w * local.d + (1 - w) * base).toFixed(2)), n: local.n, source: "learned" };
}

export interface IntervalCalibration {
  /** Dilation for quantiles BELOW p50 (the lower tail). */
  dLo: number;
  /** Dilation for quantiles ABOVE p50 (the upper tail). */
  dUp: number;
  n: number;
  source: "default" | "learned";
}

/** Fit one half's dilation by the pinball loss over just that half's taus (p50 pivot fixed). */
function fitHalfDilation(pts: { q: Quantiles; logSpace: boolean; outcome: number }[], side: "lo" | "up", fallback: number): number {
  const keys = QUANTILE_TAUS.filter((t) => (side === "lo" ? t.tau < 0.5 : t.tau > 0.5)).map((t) => t.key);
  const gamma = 2 / pts.length;
  let bestD = 1;
  let bestLoss = Infinity;
  for (let i = 0; i <= 50; i++) {
    const d = 0.5 + i * 0.05; // 0.5 .. 3.0
    let sum = 0;
    for (const pt of pts) {
      const dilated = applyAsymmetricDilation(pt.q, side === "lo" ? d : 1, side === "up" ? d : 1, pt.logSpace);
      // Mean pinball over only this half's stated quantiles — per-KEY so the data
      // term lives on the same scale as the symmetric pinballLoss and the shared
      // γ regularizer shrinks both calibrators equivalently.
      let psum = 0;
      let pn = 0;
      for (const key of keys) {
        const v = dilated[key];
        const tau = QUANTILE_TAUS.find((t) => t.key === key)!.tau;
        if (typeof v !== "number") continue;
        psum += pt.outcome >= v ? tau * (pt.outcome - v) : (1 - tau) * (v - pt.outcome);
        pn++;
      }
      sum += pn ? psum / pn : 0;
    }
    const loss = sum / pts.length + gamma * (d - 1) * (d - 1);
    if (loss < bestLoss - 1e-12) {
      bestLoss = loss;
      bestD = d;
    }
  }
  return Number(bestD.toFixed(2)) || fallback;
}

function fitIntervalCalibrationRaw(entries: LedgerEntry[], fallback: number): IntervalCalibration {
  const pts: { q: Quantiles; logSpace: boolean; outcome: number }[] = [];
  for (const e of entries) {
    if ((e.question.kind !== "numeric" && e.question.kind !== "date") || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (typeof o !== "number") continue;
    const q = e.aggregate.predilationQuantiles ?? e.aggregate.quantiles;
    if (!q || typeof q.p50 !== "number") continue;
    pts.push({ q, logSpace: Boolean(e.aggregate.logSpace), outcome: o });
  }
  if (pts.length < MIN_QCAL_N) return { dLo: fallback, dUp: fallback, n: pts.length, source: "default" };
  return { dLo: fitHalfDilation(pts, "lo", fallback), dUp: fitHalfDilation(pts, "up", fallback), n: pts.length, source: "learned" };
}

/**
 * Interval calibration with ASYMMETRIC (per-tail) dilation — the B3 upgrade over
 * the single symmetric factor. Fits the lower- and upper-tail dilations
 * separately by their own pinball loss, so lopsided miscoverage (an interval too
 * narrow only on the downside) is corrected on the side that needs it. Same
 * partial-pooling discipline as fitQuantileCalibration.
 */
export function fitIntervalCalibration(
  entries = loadLedger(),
  fallback = DEFAULT_QUANTILE_DILATION,
  domain?: DomainId
): IntervalCalibration {
  const global = fitIntervalCalibrationRaw(entries, fallback);
  if (!domain) return global;
  const local = fitIntervalCalibrationRaw(entries.filter((e) => e.domain === domain), fallback);
  if (local.source === "default") return global;
  const w = local.n / (local.n + POOL_KAPPA);
  const baseLo = global.source === "learned" ? global.dLo : fallback;
  const baseUp = global.source === "learned" ? global.dUp : fallback;
  return {
    dLo: Number((w * local.dLo + (1 - w) * baseLo).toFixed(2)),
    dUp: Number((w * local.dUp + (1 - w) * baseUp).toFixed(2)),
    n: local.n,
    source: "learned",
  };
}

/**
 * Snapshot the out-of-fold fit for a domain (or globally) into a reusable,
 * freezable artifact. This is the engine's "fitted model": every parameter the
 * flywheel learns, captured at a moment in time. A saved model can freeze this
 * for reproducibility; the live default re-derives it each run.
 */
export function snapshotFittedParams(domain?: DomainId, entries = loadLedger()): FittedParams {
  const recal = fitRecalibration(entries, domain);
  const mcRecal = fitMcRecalibration(entries, domain);
  const ical = fitIntervalCalibration(entries, DEFAULT_QUANTILE_DILATION, domain);
  const inDomain = domain ? entries.filter((e) => e.domain === domain) : entries;
  const fitN = inDomain.reduce((n, e) => n + (e.resolution ? 1 : 0), 0);
  return {
    domain,
    // Carry each fit's true sample count so a frozen run logs an honest n even
    // when the learner backed off to the global pool.
    recalibration: recal ? { a: recal.a, b: recal.b, n: recal.n } : null,
    mcRecalibration: mcRecal ? { a: mcRecal.a, b: mcRecal.b, n: mcRecal.n } : null,
    extremizeK: chooseExtremizeK(entries, DEFAULT_EXTREMIZE_K, domain),
    extremizeKMc: chooseExtremizeKMc(entries, DEFAULT_EXTREMIZE_K, domain),
    marketWeight: chooseMarketWeight(entries, DEFAULT_MARKET_WEIGHT, domain),
    sportsMarketWeight: chooseSportsMarketWeight(entries, DEFAULT_SPORTS_MARKET_WEIGHT, domain),
    // Symmetric quantileDilation kept (mean of the two tails) for back-compat;
    // the asymmetric per-tail factors are the live path.
    quantileDilation: Number(((ical.dLo + ical.dUp) / 2).toFixed(2)),
    quantileDilationLo: ical.dLo,
    quantileDilationUp: ical.dUp,
    quantileDilationN: ical.n,
    methodWeights: methodWeights(entries, domain),
    fitN,
    fitAt: Date.now(),
  };
}

// ---------------------------------------------------------------- scenario simulation

/**
 * The structure the LLM proposes for a scenario simulation — shape only, never
 * numbers. `drivers` selects from the engine-built grounded catalog by handle;
 * `combiner` is the closed DSL tree; `dependencies` are pairwise correlations.
 */
export interface SimStructure {
  drivers: string[];
  combiner: CombinerNode;
  dependencies: DriverCorrelation[];
  rationale: string;
}

/** Parse the structure model's reply into a SimStructure, tolerating fences/prose (mirrors parseForecastPlan). */
export function parseSimStructure(raw: string): SimStructure | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || !obj.combiner || typeof obj.combiner !== "object") return null;
  const drivers = Array.isArray(obj.drivers) ? obj.drivers.map((d) => String(d)) : [];
  const dependencies = Array.isArray(obj.dependencies)
    ? obj.dependencies
        .map((d) => d as Record<string, unknown>)
        .filter((d) => d && typeof d === "object" && "id1" in d && "id2" in d && Number.isFinite(Number(d.rho)))
        .map((d) => ({ id1: String(d.id1), id2: String(d.id2), rho: Number(d.rho) }))
    : [];
  return { drivers, combiner: obj.combiner as CombinerNode, dependencies, rationale: String(obj.rationale ?? "").slice(0, 600) };
}

const COMBINER_OPS = new Set(["driver", "and", "or", "threshold", "sum", "weighted_sum", "max", "min", "argmax", "conditional_table"]);

/**
 * Recursively validate a raw combiner tree against the grounded driver ids:
 * unknown ops, malformed children, or any leaf referencing a non-grounded
 * driver collapse the whole tree to null (the simulation is then dropped). A
 * pruned tree would silently change the structure's meaning, so reject instead.
 * `binaryIds` is the subset of grounded drivers with a binary marginal — a
 * conditional_table's branch driver must be one of these, so the 0/1 branch is
 * exact (a continuous driver's raw value vs 0.5 would be a silent miscompare).
 */
function sanitizeCombiner(node: unknown, validIds: Set<string>, binaryIds: Set<string>): CombinerNode | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  const op = String(n.op ?? "");
  if (!COMBINER_OPS.has(op)) return null;
  if (op === "driver") return validIds.has(String(n.id)) ? { op, id: String(n.id) } : null;
  if (op === "threshold") {
    const child = sanitizeCombiner(n.child, validIds, binaryIds);
    if (!child || !Number.isFinite(Number(n.above))) return null;
    // dir "lt" (fire below) is opt-in; omit the field for the default "gt" so
    // existing above-threshold combiners serialize byte-identically.
    return n.dir === "lt" ? { op, child, above: Number(n.above), dir: "lt" } : { op, child, above: Number(n.above) };
  }
  if (op === "conditional_table") {
    if (!binaryIds.has(String(n.conditionDriver))) return null; // branch must be a binary driver
    const ifTrue = sanitizeCombiner(n.ifTrue, validIds, binaryIds);
    const ifFalse = sanitizeCombiner(n.ifFalse, validIds, binaryIds);
    return ifTrue && ifFalse ? { op, conditionDriver: String(n.conditionDriver), ifTrue, ifFalse } : null;
  }
  // and / or / sum / max / min / argmax / weighted_sum — children arrays
  if (!Array.isArray(n.children) || !n.children.length) return null;
  const children = n.children.map((c) => sanitizeCombiner(c, validIds, binaryIds));
  if (children.some((c) => c === null)) return null;
  const kids = children as CombinerNode[];
  if (op === "weighted_sum") {
    const weights = Array.isArray(n.weights) ? n.weights.map((w) => Number(w)) : kids.map(() => 1);
    if (weights.length !== kids.length || weights.some((w) => !Number.isFinite(w))) return null;
    return { op, children: kids, weights };
  }
  return { op: op as "and" | "or" | "sum" | "max" | "min" | "argmax", children: kids };
}

export interface SimStructureValidation {
  ok: boolean;
  drivers: SimDriver[];
  spec?: CombinerSpec;
  deps: DriverCorrelation[];
  /** Driver handles the LLM named that aren't in the grounded catalog. */
  dropped: string[];
  reason?: string;
}

/**
 * The grounding gate: keep only drivers that exist in the engine-built catalog,
 * validate the combiner against that grounded set, and drop dependency edges
 * that touch a non-grounded driver. The LLM cannot smuggle in a bare number —
 * every driver's marginal is taken from the catalog, never the proposal.
 * Requires ≥2 grounded drivers and a combiner that resolves entirely within
 * them, or the simulation is rejected (headline untouched).
 */
export function validateSimStructure(
  proposal: SimStructure,
  catalog: SimDriver[],
  kind: ForecastKind,
  mcOptions?: string[]
): SimStructureValidation {
  const byId = new Map(catalog.map((d) => [d.id, d]));
  const groundedIds = new Set(proposal.drivers.filter((id) => byId.has(id)));
  const dropped = proposal.drivers.filter((id) => !byId.has(id));
  const drivers = [...groundedIds].map((id) => byId.get(id)!);
  if (drivers.length < 2) return { ok: false, drivers, deps: [], dropped, reason: "fewer than 2 grounded drivers survived" };
  const binaryIds = new Set(drivers.filter((d) => d.marginal.kind === "binary").map((d) => d.id));
  const root = sanitizeCombiner(proposal.combiner, groundedIds, binaryIds);
  if (!root) return { ok: false, drivers, deps: [], dropped, reason: "combiner referenced ungrounded drivers or was malformed" };
  // mc outcomes are an option INDEX: aggregateSimOutcomes reads each draw's
  // scalar as round(v) into the option list, which is only meaningful when the
  // root is argmax (it returns an exact integer index). Any other op returns an
  // arbitrary scalar that round() would smear across options — reject it.
  if (kind === "mc" && root.op !== "argmax") {
    return { ok: false, drivers, deps: [], dropped, reason: "mc combiner root must be argmax (option-index selection)" };
  }
  const deps = proposal.dependencies.filter(
    (d) => groundedIds.has(d.id1) && groundedIds.has(d.id2) && d.id1 !== d.id2 && Number.isFinite(d.rho)
  );
  return { ok: true, drivers, spec: { kind, root, ...(mcOptions ? { mcOptions } : {}) }, deps, dropped };
}

/** Weighted per-quantile blend of two distributions (Vincent-style), kept monotone. w=0 → a, w=1 → b. */
export function blendQuantiles(a: Quantiles, b: Quantiles, w: number): Quantiles {
  const wc = Math.min(1, Math.max(0, w));
  const out: Partial<Record<keyof Quantiles, number>> = { ...a };
  for (const { key } of QUANTILE_TAUS) {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") out[key] = (1 - wc) * av + wc * bv;
  }
  return monotoneQuantiles(out) ?? a;
}

/** Per-option log-odds blend of two mc distributions, renormalized to the simplex. w=0 → a, w=1 → b. */
export function blendOptionProbs(a: Record<string, number>, b: Record<string, number>, w: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const opt of Object.keys(a)) out[opt] = blendWithMarket(clampProb(a[opt] ?? 0.01), clampProb(b[opt] ?? 0.01), w);
  const sum = Object.values(out).reduce((s, v) => s + v, 0) || 1;
  for (const opt of Object.keys(out)) out[opt] = out[opt] / sum;
  return out;
}

/**
 * The pre-simulation BINARY headline: the published probability the scenario
 * simulation blends on TOP of, and the value the sim-weight fit scores against.
 * Read superseded-first (the H2 sequential update on a re-forecast), then the
 * recalibration chain. Centralized so the live blend (executor) and the fit
 * (chooseSimulationWeight) read the SAME chain — duplicating this expression once
 * silently dropped `superseded` from the serve path while the fit kept it.
 */
export function preSimBinaryHeadline(c: AggregateComponents | undefined, fallback: number): number {
  return c?.superseded ?? c?.recalibrated ?? c?.blended ?? c?.extremized ?? fallback;
}

/** Simulation starts with ZERO headline influence — pure cross-check until the ledger earns it trust. */
export const DEFAULT_SIM_WEIGHT = 0;
/** A newer, less-tested signal than the market anchor (20) — demand more resolved evidence before any blend. */
export const MIN_SIM_WEIGHT_N = 30;
/** The simulation never dominates the panel: its blend weight is capped. */
export const SIM_WEIGHT_CAP = 0.3;

/**
 * Fit the simulation blend weight on the resolved track record, per kind — the
 * w that would have minimized the proper score re-blending each entry's stored
 * pre-sim headline with its stored simulated value. Mirrors chooseMarketWeight.
 * Falls back to 0 (no influence) below MIN_SIM_WEIGHT_N — the simulation earns
 * its seat exactly the way the market anchor and recalibration do.
 */
export function chooseSimulationWeight(entries = loadLedger(), kind: ForecastKind = "binary", fallback = DEFAULT_SIM_WEIGHT, domain?: DomainId): number {
  entries = scopeToDomain(entries, domain, MIN_SIM_WEIGHT_N);
  const grid = (score: (w: number) => number): number => {
    let bestW = fallback;
    let bestLoss = Infinity;
    for (let i = 0; i <= 6; i++) {
      const w = (i / 6) * SIM_WEIGHT_CAP; // 0 .. SIM_WEIGHT_CAP in 7 steps
      const loss = score(w);
      if (loss < bestLoss - 1e-12) {
        bestLoss = loss;
        bestW = Number(w.toFixed(3));
      }
    }
    return bestW;
  };
  if (kind === "binary") {
    // No pre-sim snapshot guard needed here (unlike numeric/mc): the binary
    // pre-sim headline is preserved in the components chain (extremized →
    // blended → recalibrated → superseded), which the simulation blend never
    // mutates — it only overwrites agg.probability. So `pre` below is always the
    // honest pre-sim value even on entries that were later blended; the fit is
    // not circular, and including those entries gives the fit more data. The
    // `superseded` link captures the H2 sequential update so a re-forecast's true
    // published headline (not its pre-supersede value) is what the fit scores.
    const usable = entries.filter(
      (e) =>
        e.question.kind === "binary" &&
        e.resolution &&
        (e.resolution.outcome === 0 || e.resolution.outcome === 1) &&
        typeof e.aggregate.components?.simulated === "number"
    );
    if (usable.length < MIN_SIM_WEIGHT_N) return fallback;
    return grid((w) =>
      usable.reduce((s, e) => {
        const c = e.aggregate.components!;
        const pre = preSimBinaryHeadline(c, e.aggregate.probability ?? 0.5);
        return s - logScore(blendWithMarket(pre, c.simulated!, w), e.resolution!.outcome as 0 | 1);
      }, 0) / usable.length
    );
  }
  if (kind === "numeric" || kind === "date") {
    // Include entries that WERE sim-blended as long as their pre-sim headline was
    // snapshotted (components.preSimQuantiles) — re-blending the stored (post-sim)
    // headline would be circular, but the snapshot is the honest pre-sim value, so
    // the fit can learn from exactly the questions where the simulation was used
    // (matching the binary path). Older entries that were blended before the
    // snapshot existed are still excluded.
    const usable = entries.filter(
      (e) =>
        (e.question.kind === "numeric" || e.question.kind === "date") &&
        e.resolution &&
        typeof e.resolution.outcome === "number" &&
        e.aggregate.components?.simulatedQ &&
        (e.aggregate.components?.preSimQuantiles || e.aggregate.quantiles) &&
        (e.aggregate.components?.preSimQuantiles || !e.aggregate.components?.simBlendWeight)
    );
    if (usable.length < MIN_SIM_WEIGHT_N) return fallback;
    return grid((w) =>
      usable.reduce((s, e) => {
        const c = e.aggregate.components!;
        return s + pinballLoss(blendQuantiles(c.preSimQuantiles ?? e.aggregate.quantiles!, c.simulatedQ!, w), e.resolution!.outcome as number);
      }, 0) / usable.length
    );
  }
  // mc — same pre-sim snapshot logic as numeric/date.
  const usable = entries.filter(
    (e) =>
      e.question.kind === "mc" &&
      e.resolution &&
      typeof e.resolution.outcome === "string" &&
      e.resolution.outcome !== "void" &&
      e.aggregate.components?.simulatedOptionProbs &&
      (e.aggregate.components?.preSimOptionProbs || e.aggregate.optionProbs) &&
      (e.aggregate.components?.preSimOptionProbs || !e.aggregate.components?.simBlendWeight)
  );
  if (usable.length < MIN_SIM_WEIGHT_N) return fallback;
  return grid((w) =>
    usable.reduce((s, e) => {
      const c = e.aggregate.components!;
      return s - mcLogScore(blendOptionProbs(c.preSimOptionProbs ?? e.aggregate.optionProbs!, c.simulatedOptionProbs!, w), e.resolution!.outcome as string);
    }, 0) / usable.length
  );
}

/** Sim-on vs sim-off split of the resolved ledger for the backtest readout (descriptive — questions vary in difficulty). */
export interface SimulationLedgerSummary {
  onN: number;
  offN: number;
  /** Mean Brier of the published binary headline, by group (null when a group is empty). */
  onBrier: number | null;
  offBrier: number | null;
}

export function simulationLedgerSummary(entries = loadLedger()): SimulationLedgerSummary {
  const on: number[] = [];
  const off: number[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const p = e.aggregate.probability;
    if (typeof p !== "number") continue;
    (e.simulationRan ? on : off).push(brierScore(p, o));
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  return { onN: on.length, offN: off.length, onBrier: mean(on), offBrier: mean(off) };
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
 * Pull the "QUESTION: <id>" assignment out of a forecaster task's objective —
 * which sub-forecast it answers when an open question decomposed. Null when
 * absent (single-question runs need no tag; readers default to the primary).
 */
export function extractQuestionRef(text: string): string | null {
  const m = /question(?:\s+id)?\s*[:=]\s*["'`]?(sf\d+)/i.exec(text);
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

/** Kinds that forecast a timing/quantity ("when") rather than a category or yes/no. */
export const TIMING_KINDS: ReadonlySet<ForecastKind> = new Set<ForecastKind>(["date", "numeric"]);

/**
 * A "when will X happen" mission asks for TIMING — it must be forecast as a
 * date (or a duration), never silently reframed into a "which/who" (mc) or
 * "will-it" (binary) question. The sharpener/planner sometimes does exactly
 * that on a small model, so the engine guards against it.
 *
 * High precision by design: matches "by when", a "when <auxiliary verb>"
 * interrogative ("when will|does|is|did|can|could…"), or "how long|soon
 * until|before|till" — NOT a "when" used as a subordinating conjunction
 * ("what happens when the Fed cuts?"), which never precedes one of those verbs.
 */
export function isTimingMission(mission: string): boolean {
  return /\bby\s+when\b|\bwhen\s+(will|would|does|do|is|are|was|were|did|can|could|might|must|should|shall|has|have)\b|\bhow\s+(long|soon)\s+(until|till|before|'?til)\b/i.test(
    mission
  );
}

/**
 * Resolve a sub-forecast's horizon when decomposing (best-effort, never
 * rejects): operator date wins; an absent/unparseable/past model date falls
 * back to today + `fallbackDays`; a valid future date is clamped to ~5 years
 * out so a model can't park a question a century away.
 */
export function clampHorizon(rawDate: string, operatorDate: string | undefined, today: string, fallbackDays = 90): string {
  if (operatorDate && ISO_DATE.test(operatorDate)) return operatorDate;
  const t0 = isoToDays(today);
  if (t0 === null) return ISO_DATE.test(rawDate) ? rawDate : "";
  const fallback = daysToIso(t0 + fallbackDays);
  if (!ISO_DATE.test(rawDate)) return fallback;
  const d = isoToDays(rawDate);
  if (d === null || d < t0 + 1) return fallback; // past/today with no operator date → push out
  if (d > t0 + 1825) return daysToIso(t0 + 1825); // cap ~5 years
  return rawDate;
}

/**
 * Build a ForecastQuestion from an already-parsed object. In strict mode
 * (no `fallbackDate`), an invalid date returns null — the historical
 * single-question behavior. In plan mode (`fallbackDate` set), the date is
 * resolved/clamped instead of rejected so a sub-forecast always survives.
 */
function questionFromObj(
  obj: Record<string, unknown>,
  operatorDate?: string,
  fallbackDate?: string
): ForecastQuestion | null {
  if (!obj || typeof obj !== "object") return null;
  const text = String(obj.text ?? "").trim();
  const criteria = String(obj.resolutionCriteria ?? "").trim();
  const kind = ["binary", "numeric", "mc", "date"].includes(String(obj.kind))
    ? (String(obj.kind) as ForecastKind)
    : null;
  let date = String(obj.resolutionDate ?? "").trim();
  if (operatorDate && ISO_DATE.test(operatorDate)) date = operatorDate;
  if (fallbackDate && !ISO_DATE.test(date)) date = fallbackDate; // plan mode: never reject on date
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
  return questionFromObj(obj, operatorDate);
}

/** An open-ended question decomposed into 1+ resolvable sub-forecasts plus the framing they answer. */
export interface ForecastPlan {
  brief: string;
  questions: ForecastQuestion[];
}

/**
 * Parse the decomposition model's reply into a ForecastPlan, tolerating prose,
 * fences, a `{brief, questions:[...]}` shape, a bare `questions` array, or a
 * single question object. Each sub-question runs through the same validation
 * as `parseQuestionJson` (best-effort dates so none is dropped on a horizon),
 * gets a stable id (sf1..sfN), and the set is capped at `maxN`. Returns null
 * only when nothing parses — the caller then falls back to single-question
 * sharpening, then to the mechanical binary question.
 */
export function parseForecastPlan(
  raw: string,
  operatorDate: string | undefined,
  today: string,
  maxN = 6
): ForecastPlan | null {
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
  const items: unknown[] = Array.isArray(obj.questions)
    ? obj.questions
    : obj.text // a single question object with no wrapper
      ? [obj]
      : [];
  const questions: ForecastQuestion[] = [];
  for (const item of items) {
    if (questions.length >= Math.max(1, maxN)) break;
    if (!item || typeof item !== "object") continue;
    const rawDate = String((item as Record<string, unknown>).resolutionDate ?? "").trim();
    const fallbackDate = clampHorizon(rawDate, operatorDate, today);
    const q = questionFromObj(item as Record<string, unknown>, operatorDate, fallbackDate);
    if (q) questions.push({ ...q, id: `sf${questions.length + 1}` });
  }
  if (!questions.length) return null;
  const brief = String(obj.brief ?? "").trim().slice(0, 600);
  return { brief, questions };
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
  /** The domain pack that planned/modeled this forecast — the per-domain calibration key. Absent = generic path. */
  domain?: DomainId;
  /** The saved model this forecast was produced with, for per-model track records. */
  modelId?: string;
  /** Set for tournament-imported questions: source platform, id, and its price at import. */
  origin?: ForecastOrigin;
  /**
   * Sub-forecasts of one open-ended question share a set id (the run id) and a
   * brief — the overall framing the sub-forecasts together answer. Absent on a
   * lone single-question forecast.
   */
  setId?: string;
  brief?: string;
  /** The scenario-simulation stage ran for this forecast — lets backtests stratify sim-on vs sim-off. */
  simulationRan?: boolean;
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

/**
 * A patch to an already-created entry, keyed by the same id. Lets the engine
 * write the base forecast record durably (inline, at aggregation) and then,
 * after the best-effort scenario-simulation stage, append the sim-augmented
 * aggregate without a second "created" record (which would double-count) and
 * without widening the crash window — a crash before this patch simply leaves
 * the clean, sim-less base record intact.
 */
export interface LedgerUpdated {
  v: 1;
  rec: "updated";
  id: string;
  t: number;
  /** Optional: the sim-augmented aggregate (absent when the patch only carries a closing line). */
  aggregate?: AggregateForecast;
  simulationRan?: boolean;
  /** The sportsbook line near tip-off, merged into the entry's sports facet for CLV. */
  sportsLineAtClose?: SportsLineSnapshot;
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

export function appendLedger(rec: LedgerCreated | LedgerResolved | LedgerUpdated): void {
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
    let rec: LedgerCreated | LedgerResolved | LedgerUpdated;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || typeof rec.id !== "string") continue;
    if (rec.rec === "created" && rec.question && rec.aggregate) {
      const { rec: _omit, ...rest } = rec;
      entries.set(rec.id, { ...rest, panel: Array.isArray(rec.panel) ? rec.panel : [] });
    } else if (rec.rec === "updated") {
      // Patch the base entry with the sim-augmented aggregate and/or the
      // closing sportsbook line (best-effort — a missing field is just skipped).
      const entry = entries.get(rec.id);
      if (entry) {
        if (rec.aggregate) entry.aggregate = rec.aggregate;
        if (rec.simulationRan) entry.simulationRan = true;
        if (rec.sportsLineAtClose && entry.question.sports) entry.question.sports.lineAtClose = rec.sportsLineAtClose;
      }
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
  const kind = entry.question.kind;
  // Canonicalize an mc outcome to the exact option-list spelling (case/space-
  // insensitive). Callers already validate, but a primitive whose STORED
  // outcome and scoring guard could disagree on case is latent corruption: the
  // record would close "resolved" yet score nothing, silently dropping out of
  // mc calibration.
  const settled: LedgerOutcome =
    kind === "mc" && typeof outcome === "string" && outcome !== "void"
      ? (entry.question.options?.find((o) => o.trim().toLowerCase() === outcome.trim().toLowerCase()) ?? outcome)
      : outcome;
  const rec: LedgerResolved = {
    v: 1,
    rec: "resolved",
    id: entry.id,
    t: Date.now(),
    outcome: settled,
    evidence: opts.evidence,
    sources: opts.sources,
    resolvedBy: opts.resolvedBy,
  };
  if (settled !== "void") {
    if (kind === "binary" && (settled === 0 || settled === 1)) {
      // A non-finite or missing headline is a corrupt record — score nothing
      // rather than laundering it into a 0.5 coin-flip (clampProb maps NaN→0.5)
      // that would poison every parameter the flywheel fits on this row.
      const p = entry.aggregate.probability;
      if (typeof p === "number" && Number.isFinite(p)) {
        rec.brier = brierScore(p, settled);
        rec.logScore = logScore(p, settled);
      }
    } else if ((kind === "numeric" || kind === "date") && typeof settled === "number") {
      const q = entry.aggregate.quantiles;
      if (q) {
        rec.intervalScore = intervalScore(q.p10, q.p90, settled);
        rec.pinball = pinballLoss(q, settled);
      }
      // A realized date also scores the never-mass: the event happened, so
      // P(never) should have been low.
      if (kind === "date" && typeof entry.aggregate.pNever === "number") {
        rec.logScore = logScore(1 - entry.aggregate.pNever, 1);
      }
    } else if (kind === "date" && settled === "never") {
      if (typeof entry.aggregate.pNever === "number") {
        rec.logScore = logScore(entry.aggregate.pNever, 1);
      }
    } else if (kind === "mc" && typeof settled === "string" && entry.aggregate.optionProbs) {
      if (entry.question.options?.includes(settled)) {
        rec.brier = mcBrierScore(entry.aggregate.optionProbs, settled);
        rec.logScore = mcLogScore(entry.aggregate.optionProbs, settled);
      }
    }
  }
  appendLedger(rec);
  // Mirror the resolved outcome into the reference-class store so a domain pack
  // can later read a COUNTED base rate (queryRefClass) instead of parsing one
  // from prose. Best-effort, dormant until a pack stamps question.refClass.
  const refClass = entry.question.refClass;
  const dom = entry.domain ?? entry.question.domain;
  if (refClass && dom && settled !== "void") {
    try {
      appendRefClass({
        v: 1,
        kind: "refclass",
        t: Date.now(),
        domain: dom,
        refClass,
        question: clip(entry.question.text, 200),
        qkind: kind,
        outcome: settled,
        ledgerId: entry.id,
        // Carry the open-question group + supersession link so queryRefClass can
        // de-dup: a re-forecast of the same event must count ONCE (G3).
        ...(entry.setId ? { setId: entry.setId } : {}),
        ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
      });
    } catch {
      /* reference-class accumulation is best-effort */
    }
  }
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
  /** Per-domain headline mean Brier over resolved binary forecasts (the per-domain track record). */
  byDomain: Record<string, { n: number; brierMean: number }>;
}

/** Binary entries resolved to a hard 0/1 (voids and numerics don't calibrate a probability). */
function scoreable(entries: LedgerEntry[]): { p: number; outcome: 0 | 1; panel: LedgerPanelist[]; overlap: number }[] {
  const out: { p: number; outcome: 0 | 1; panel: LedgerPanelist[]; overlap: number }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const p = e.aggregate.probability;
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    // Carry the evidence overlap so a learner can replay the SERVED estimator
    // (scaleK(k, overlap)) instead of the raw one — train/serve must match.
    out.push({ p, outcome: o, panel: e.panel, overlap: e.evidenceOverlap ?? e.aggregate.evidenceOverlap ?? 0 });
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
      if (typeof m.probability !== "number" || !Number.isFinite(m.probability)) continue;
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
  // Per-domain headline Brier over resolved binary forecasts — the slice that
  // shows whether a domain's model is actually calibrated. Binary-only so the
  // scale matches brierMean (mc Brier is 0–2).
  const byDomain: Record<string, { n: number; brierMean: number }> = {};
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    const p = e.aggregate.probability;
    if ((o !== 0 && o !== 1) || typeof p !== "number" || !Number.isFinite(p)) continue;
    const dom = e.domain ?? e.question.domain ?? "generic";
    const cur = byDomain[dom] ?? { n: 0, brierMean: 0 };
    cur.brierMean = (cur.brierMean * cur.n + brierScore(p, o)) / (cur.n + 1);
    cur.n++;
    byDomain[dom] = cur;
  }
  return {
    n: scored.length,
    brierMean: scored.length ? brierSum / scored.length : 0,
    bins: bins.filter((b) => b.n > 0),
    mcBins: mcBins.filter((b) => b.n > 0),
    byMethod,
    byDomain,
  };
}

/**
 * Outside-view discipline diagnostic (G2): each panelist commits a base-rate
 * `prior` BEFORE weighing the news. This scores whether the panel's deviations
 * from that committed prior actually PAY OFF — splitting resolved binary
 * forecasts into small- vs large-move halves (by |final − aggregated prior|) and
 * comparing the published Brier to the prior's own Brier on the large-move half.
 * If big moves score WORSE than just holding the prior, the panel is talking
 * itself off the base rate. This is the SCORING stage only — the engine does not
 * blindly blend self-reported priors (they're unverified and gameable); a learned
 * shrinkage is gated on this signal turning negative over real history.
 */
export interface PriorDeltaStats {
  n: number;
  meanAbsDelta: number;
  smallMoveBrier: number;
  largeMoveBrier: number;
  /** On the large-move half: the Brier of just holding the aggregated prior. */
  largeMovePriorBrier: number;
  /** True when large moves beat simply holding the prior (deviations earn their keep). */
  bigMovesPayOff: boolean;
}

export function priorDeltaStats(entries = loadLedger()): PriorDeltaStats {
  const pts: { delta: number; brier: number; priorBrier: number }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "binary" || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o !== 0 && o !== 1) continue;
    const final = e.aggregate.probability;
    if (typeof final !== "number" || !Number.isFinite(final)) continue;
    const priors = e.panel.map((p) => p.prior).filter((p): p is number => typeof p === "number" && Number.isFinite(p));
    if (!priors.length) continue;
    // Aggregate the priors in log-odds (the panel's geometric-mean-of-odds core,
    // without the served extremization/weights — this is a diagnostic reference
    // point, not the published number, so the un-sharpened mean is the right baseline).
    const lo = priors.reduce((s, p) => s + Math.log(clampProb(p) / (1 - clampProb(p))), 0) / priors.length;
    const priorAgg = clampProb(Math.exp(lo) / (1 + Math.exp(lo)));
    pts.push({ delta: Math.abs(final - priorAgg), brier: brierScore(final, o), priorBrier: brierScore(priorAgg, o) });
  }
  if (!pts.length) return { n: 0, meanAbsDelta: 0, smallMoveBrier: 0, largeMoveBrier: 0, largeMovePriorBrier: 0, bigMovesPayOff: true };
  const deltas = pts.map((p) => p.delta).sort((a, b) => a - b);
  const med = median(deltas);
  const small = pts.filter((p) => p.delta <= med);
  const large = pts.filter((p) => p.delta > med);
  const lgBrier = large.length ? large.reduce((s, p) => s + p.brier, 0) / large.length : 0;
  const lgPriorBrier = large.length ? large.reduce((s, p) => s + p.priorBrier, 0) / large.length : 0;
  return {
    n: pts.length,
    meanAbsDelta: pts.reduce((s, p) => s + p.delta, 0) / pts.length,
    smallMoveBrier: small.length ? small.reduce((s, p) => s + p.brier, 0) / small.length : 0,
    largeMoveBrier: lgBrier,
    largeMovePriorBrier: lgPriorBrier,
    bigMovesPayOff: large.length === 0 || lgBrier <= lgPriorBrier,
  };
}

/** "Did we match/beat the market" — the success metric for sports forecasts. */
export interface SportsCalibration {
  /** Winner facets: our Brier vs the de-vigged moneyline's Brier on the realized team. */
  winner: { n: number; brier: number; marketBrier: number };
  /** Total-points facets: our mean pinball vs a degenerate "just predict the line" baseline. */
  total: { n: number; pinball: number; linePinball: number };
  /** Margin facets: same comparison against the spread. */
  margin: { n: number; pinball: number; linePinball: number };
  /** Closing Line Value: among facets with a captured closing line, the share where our median led the line's move. */
  clv: { n: number; pctProfitable: number };
}

/** A degenerate distribution with all mass at v — the "forecast = the line" baseline for pinball comparison. */
function pointQuantiles(v: number): Quantiles {
  const out: Partial<Record<keyof Quantiles, number>> = {};
  for (const { key } of QUANTILE_TAUS) out[key] = v;
  return out as Quantiles;
}

/**
 * Score the sports record against the market — the literal "match/beat the
 * line" deliverable. Winner Brier vs the moneyline's Brier; total/margin pinball
 * vs predicting the line itself; and CLV (did our median lead the line's move)
 * for facets whose closing line was captured. Empty sections report n=0.
 */
export function sportsCalibrationStats(entries = loadLedger()): SportsCalibration {
  const out: SportsCalibration = {
    winner: { n: 0, brier: 0, marketBrier: 0 },
    total: { n: 0, pinball: 0, linePinball: 0 },
    margin: { n: 0, pinball: 0, linePinball: 0 },
    clv: { n: 0, pctProfitable: 0 },
  };
  let winB = 0, winM = 0, totP = 0, totL = 0, marP = 0, marL = 0, clvProfit = 0;
  for (const e of entries) {
    const sm = e.question.sports;
    if (!sm || !e.resolution) continue;
    const o = e.resolution.outcome;
    if (o === "void") continue;
    if (sm.facet === "winner" && typeof o === "string" && e.aggregate.optionProbs && typeof sm.lineAtCreate?.pHome === "number") {
      // The market baseline prices every leg (incl. Draw for 3-way books).
      out.winner.n++;
      winB += mcBrierScore(e.aggregate.optionProbs, o);
      winM += mcBrierScore(sportsWinnerMarket(sm), o);
    } else if ((sm.facet === "total" || sm.facet === "margin") && typeof o === "number" && e.aggregate.quantiles) {
      // The margin baseline is the spread only when it's a true point-spread
      // anchor (sm.sigma set) — a run/puck/handicap line is not the median margin.
      const lineVal = sm.facet === "total" ? sm.lineAtCreate?.total : typeof sm.sigma === "number" ? sm.lineAtCreate?.spread : undefined;
      // This is a "vs the line" comparison — skip facets that never had a line,
      // or the missing baseline term would deflate the line's averaged pinball.
      if (typeof lineVal !== "number") continue;
      const ourPin = pinballLoss(e.aggregate.quantiles, o);
      const linePin = pinballLoss(pointQuantiles(lineVal), o);
      if (sm.facet === "total") {
        out.total.n++;
        totP += ourPin;
        totL += linePin;
      } else {
        out.margin.n++;
        marP += ourPin;
        marL += linePin;
      }
    }
    // CLV: our median led the line's open→close move (we beat the closing line).
    const createV = sm.facet === "total" ? sm.lineAtCreate?.total : sm.facet === "margin" ? sm.lineAtCreate?.spread : sm.lineAtCreate?.pHome;
    const closeV = sm.facet === "total" ? sm.lineAtClose?.total : sm.facet === "margin" ? sm.lineAtClose?.spread : sm.lineAtClose?.pHome;
    const ourMedian = sm.facet === "winner" ? e.aggregate.optionProbs?.[sm.home] : e.aggregate.quantiles?.p50;
    if (typeof createV === "number" && typeof closeV === "number" && typeof ourMedian === "number" && closeV !== createV) {
      out.clv.n++;
      if (Math.sign(ourMedian - createV) === Math.sign(closeV - createV)) clvProfit++;
    }
  }
  if (out.winner.n) { out.winner.brier = winB / out.winner.n; out.winner.marketBrier = winM / out.winner.n; }
  if (out.total.n) { out.total.pinball = totP / out.total.n; out.total.linePinball = totL / out.total.n; }
  if (out.margin.n) { out.margin.pinball = marP / out.margin.n; out.margin.linePinball = marL / out.margin.n; }
  if (out.clv.n) out.clv.pctProfitable = clvProfit / out.clv.n;
  return out;
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

/**
 * Minimize a locally-unimodal 1-D loss on [lo,hi]: a coarse scan (step) brackets
 * the global region — the loss is smooth but only locally unimodal, so golden
 * section alone could chase a local dip — then golden-section refines, and the
 * refined point is compared against the bracket endpoints so a boundary optimum
 * stays reachable. Shared by the binary and mc extremization fits.
 */
function minimize1D(f: (x: number) => number, lo: number, hi: number, step = 0.5): number {
  let coarseBest = lo;
  let coarseLoss = Infinity;
  for (let x = lo; x <= hi + 1e-9; x += step) {
    const loss = f(x);
    if (loss < coarseLoss - 1e-12) {
      coarseLoss = loss;
      coarseBest = x;
    }
  }
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = Math.max(lo, coarseBest - step);
  let b = Math.min(hi, coarseBest + step);
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > 1e-3) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  let best = coarseBest;
  let bestLoss = Infinity;
  for (const x of [coarseBest, (a + b) / 2, a, b]) {
    const loss = f(x);
    if (loss < bestLoss - 1e-12) {
      bestLoss = loss;
      best = x;
    }
  }
  return Number(best.toFixed(3));
}

/**
 * Pick the binary extremization exponent that would have minimized Brier over
 * the resolved history. CRUCIAL: the objective replays the SERVED estimator —
 * `aggregateBinary(probs, scaleK(k, overlap), methodWeights)` — not the raw one.
 * Fitting raw k while serving scaleK(k,overlap)·weighted is a train/serve skew
 * that mis-orders the per-entry exponents. Per-domain partial pooling shrinks a
 * thin in-domain fit toward the global one. Falls back below MIN_ADAPTIVE_N.
 */
export function chooseExtremizeK(entries = loadLedger(), fallback = DEFAULT_EXTREMIZE_K, domain?: DomainId): number {
  return pooledScalarFit((es) => chooseExtremizeKRaw(es, fallback), entries, domain);
}

function chooseExtremizeKRaw(entries: LedgerEntry[], fallback: number): ScalarFit {
  // Method weights are computed over the same entries the objective scores. This
  // is mild in-sample optimism (an entry's own outcome nudges its panelist's
  // weight up), which biases the fitted k slightly LOW — the conservative
  // (less-overconfident) direction. The honest gate is the forward-chaining
  // backtest (the served base uses methodWeights(train) on strictly-earlier entries);
  // the live path applies methodWeights(ledger) where the new question isn't yet
  // in the ledger, so the serve side has no leakage.
  const mw = methodWeights(entries);
  const prepared = scoreable(entries)
    .map((s) => {
      const kept = s.panel.filter((m) => typeof m.probability === "number" && Number.isFinite(m.probability));
      return { probs: kept.map((m) => m.probability as number), weights: kept.map((m) => mw[m.method] ?? 1), overlap: s.overlap, outcome: s.outcome };
    })
    .filter((s) => s.probs.length >= 2);
  if (prepared.length < MIN_ADAPTIVE_N) return { value: fallback, learned: false, n: prepared.length };
  const meanBrier = (k: number): number => {
    let sum = 0;
    for (const s of prepared) sum += brierScore(aggregateBinary(s.probs, scaleK(k, s.overlap), s.weights).probability!, s.outcome);
    return sum / prepared.length;
  };
  return { value: minimize1D(meanBrier, K_MIN, K_MAX), learned: true, n: prepared.length };
}

/** mc resolved entries with a hard option outcome and ≥2 panel ballots — the mc analogue of scoreable. */
function scoreableMc(
  entries: LedgerEntry[]
): { panels: Record<string, number>[]; options: string[]; realized: string; overlap: number; methods: string[] }[] {
  const out: { panels: Record<string, number>[]; options: string[]; realized: string; overlap: number; methods: string[] }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "mc" || !e.resolution) continue;
    const realized = e.resolution.outcome;
    const options = e.question.options;
    // ≥2 options required — aggregateMc throws below that, and a 1-option mc is degenerate.
    if (typeof realized !== "string" || realized === "void" || !options || options.length < 2 || !options.includes(realized)) continue;
    const kept = e.panel.filter((m) => m.optionProbs && typeof m.optionProbs === "object");
    if (kept.length < 2) continue;
    out.push({
      panels: kept.map((m) => m.optionProbs!),
      options,
      realized,
      overlap: e.evidenceOverlap ?? e.aggregate.evidenceOverlap ?? 0,
      methods: kept.map((m) => m.method),
    });
  }
  return out;
}

/**
 * The mc extremization exponent — fit on multiclass log-loss, replaying the
 * served `aggregateMc(panels, options, scaleK(k, overlap), weights)`. The
 * per-option-GMO-then-renormalize geometry has a different optimal exponent than
 * the binary path, so reusing the binary k (the old behavior) mis-sharpens every
 * multiple-choice question. Same shared minimizer + partial pooling.
 */
export function chooseExtremizeKMc(entries = loadLedger(), fallback = DEFAULT_EXTREMIZE_K, domain?: DomainId): number {
  return pooledScalarFit((es) => chooseExtremizeKMcRaw(es, fallback), entries, domain);
}

function chooseExtremizeKMcRaw(entries: LedgerEntry[], fallback: number): ScalarFit {
  const mw = methodWeights(entries);
  const usable = scoreableMc(entries).map((s) => ({ ...s, weights: s.methods.map((m) => mw[m] ?? 1) }));
  if (usable.length < MIN_ADAPTIVE_N) return { value: fallback, learned: false, n: usable.length };
  const meanLoss = (k: number): number => {
    let sum = 0;
    for (const s of usable) {
      const agg = aggregateMc(s.panels, s.options, scaleK(k, s.overlap), s.weights);
      sum += -mcLogScore(agg.optionProbs!, s.realized);
    }
    return sum / usable.length;
  };
  return { value: minimize1D(meanLoss, K_MIN, K_MAX), learned: true, n: usable.length };
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

/** Deterministic PRNG (mulberry32) so bootstrap CIs — and the scenario simulation — are reproducible. */
export function mulberry32(seed: number): () => number {
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
  /** Panel methods aligned to probs, so a replayed strategy can apply the learned method weights. */
  methods: string[];
  overlap: number;
  outcome: 0 | 1;
  published: number;
  market?: { probability: number; volume?: number };
  /** Forecast creation/serve instant — the moment the parameters would have been read live. */
  createT: number;
  /** Resolution instant — when this entry's outcome became known. */
  resolveT: number;
  entry: LedgerEntry;
}

/**
 * Replay the resolved binary ledger under each aggregation strategy and score
 * them side by side — the regression gate for every mechanism the engine learns.
 * Learned parameters (adaptive k, market weight, recalibration) are fitted
 * OUT-OF-FOLD by a TIME-RESPECTING expanding window: each entry is scored with
 * parameters fitted ONLY on strictly-earlier entries. An index-interleaved
 * (j%FOLDS) split leaks future outcomes into the training fold and flatters
 * exactly the learners (recalibration most of all) whose job is to generalize
 * forward — so it would green-light a strategy that won't hold live. Pure
 * deterministic replay — no agents, no tokens.
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
    const kept = e.panel.filter((m) => typeof m.probability === "number" && Number.isFinite(m.probability));
    const probs = kept.map((m) => m.probability as number);
    const published = e.aggregate.probability;
    if (!probs.length || typeof published !== "number") {
      skipped.noPanel++;
      continue;
    }
    usable.push({
      probs,
      methods: kept.map((m) => m.method),
      overlap: e.evidenceOverlap ?? e.aggregate.evidenceOverlap ?? 0,
      outcome: o,
      published,
      market: e.aggregate.components?.market,
      createT: e.t,
      resolveT: e.resolution.t,
      entry: e,
    });
  }
  const report: BacktestReport = { rows: [], skipped };
  if (!usable.length) return report;

  // Time-respecting (forward-chaining) OOF keyed on RESOLUTION time, not creation
  // order: when entry i was served (createT), only outcomes RESOLVED before then
  // were knowable. Training on "earlier-created" leaks future outcomes — a
  // long-horizon question created first can resolve last. So train on entries
  // whose resolution preceded i's serve instant; the recalibration intercept
  // (which learns a systematic YES-lean) is the most leakage-flattered otherwise.
  const trainFor = (idx: number): LedgerEntry[] => usable.filter((u) => u.resolveT < usable[idx].createT).map((u) => u.entry);
  // Hoist every out-of-fold fit ONCE per entry. Each is a pure function of the
  // strictly-earlier training slice, so a strategy can index the precomputed fit
  // instead of refitting from scratch on every call — the binary backtest used to
  // re-run chooseExtremizeK/chooseMarketWeight/fitRecalibration/fitBetaCalibration
  // inside each strategy's per-entry closure (and twice over, once for Brier and
  // once for log loss), turning an O(n) replay into O(n²·gridsize). Each fit is
  // threaded with the entry's OWN domain so the gate measures the per-domain
  // partial-pooled estimator aggregateOne actually ships (not the global pool).
  const trains = usable.map((_, i) => trainFor(i));
  const doms = usable.map((u) => u.entry.domain);
  const ks = trains.map((t, i) => chooseExtremizeK(t, DEFAULT_EXTREMIZE_K, doms[i]));
  const mws = trains.map((t, i) => methodWeights(t, doms[i]));
  const mwts = trains.map((t, i) => chooseMarketWeight(t, DEFAULT_MARKET_WEIGHT, doms[i]));
  const recals = trains.map((t, i) => fitRecalibration(t, doms[i]));
  const betas = trains.map((t, i) => fitBetaCalibration(t, doms[i]));

  // The SERVED binary estimate: extremized-by-scaleK, weighted by the learned
  // method weights — exactly what aggregateOne ships, so the gate measures reality.
  const servedBaseAt = (u: BacktestEntry, i: number): number => {
    const weights = u.methods.map((m) => mws[i][m] ?? 1);
    return aggregateBinary(u.probs, scaleK(ks[i], u.overlap), weights).probability!;
  };
  const marketedAt = (u: BacktestEntry, i: number): number => {
    const base = servedBaseAt(u, i);
    if (!u.market) return base;
    const w = mwts[i] * liquidityFactor(u.market.volume);
    return blendWithMarket(base, u.market.probability, w);
  };

  const strategies: { config: string; p: (u: BacktestEntry, i: number) => number }[] = [
    { config: "published headline (as recorded)", p: (u) => u.published },
    { config: "panel GMO, no extremization (k=1)", p: (u) => aggregateBinary(u.probs, 1).probability! },
    {
      config: `panel extremized k=${DEFAULT_EXTREMIZE_K} (overlap-scaled)`,
      p: (u) => aggregateBinary(u.probs, scaleK(DEFAULT_EXTREMIZE_K, u.overlap)).probability!,
    },
    {
      config: "panel adaptive-k + method weights (out-of-fold)",
      p: (u, i) => servedBaseAt(u, i),
    },
    {
      config: "+ market anchor (learned w, out-of-fold)",
      p: (u, i) => marketedAt(u, i),
    },
    {
      config: "+ recalibration (out-of-fold)",
      p: (u, i) => applyRecalibration(marketedAt(u, i), recals[i]),
    },
    {
      // B1: beta calibration as a BACKTEST-GATED alternative to Platt. Same chain,
      // beta recalibration instead of logistic — promote to live only if this row
      // beats "+ recalibration" once the ledger is deep enough to tell.
      config: "+ beta calibration (out-of-fold, alt)",
      p: (u, i) => applyBetaCalibration(marketedAt(u, i), betas[i]),
    },
  ];

  for (const s of strategies) {
    // One prediction pass per strategy — Brier and log loss are pure functions of
    // the same prediction, so evaluating s.p once (not twice) is exact and halves
    // the work the published headline / static rows already share.
    const preds = usable.map((u, i) => s.p(u, i));
    const briers = preds.map((p, i) => brierScore(p, usable[i].outcome));
    const logs = preds.map((p, i) => -logScore(p, usable[i].outcome));
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

// ---------------------------------------------------------------- mc backtest

export interface BacktestMcRow {
  config: string;
  n: number;
  /** Mean multiclass Brier (0 perfect … 2 worst). */
  brierMean: number;
  /** Mean multiclass log loss (lower is better). */
  logLossMean: number;
}

export interface BacktestMcReport {
  rows: BacktestMcRow[];
  skipped: number;
}

/**
 * Replay the resolved multiple-choice ledger to check the mc extremization
 * exponent earns its seat — scored on multiclass Brier + log loss, time-
 * respecting OOF. Distinct from the binary backtest because mc has its own k
 * (the per-option-GMO-then-renormalize geometry differs).
 */
export function backtestMc(entries = loadLedger()): BacktestMcReport {
  const usable: { panels: Record<string, number>[]; methods: string[]; options: string[]; realized: string; overlap: number; published?: Record<string, number>; createT: number; resolveT: number; entry: LedgerEntry }[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (e.question.kind !== "mc" || !e.resolution) {
      if (e.question.kind === "mc") skipped++;
      continue;
    }
    const realized = e.resolution.outcome;
    const options = e.question.options;
    if (typeof realized !== "string" || realized === "void" || !options || options.length < 2 || !options.includes(realized)) {
      skipped++;
      continue;
    }
    const kept = e.panel.filter((m) => m.optionProbs && typeof m.optionProbs === "object");
    if (kept.length < 2) {
      skipped++;
      continue;
    }
    usable.push({
      panels: kept.map((m) => m.optionProbs!),
      methods: kept.map((m) => m.method),
      options,
      realized,
      overlap: e.evidenceOverlap ?? e.aggregate.evidenceOverlap ?? 0,
      published: e.aggregate.optionProbs,
      createT: e.t,
      resolveT: e.resolution.t,
      entry: e,
    });
  }
  const report: BacktestMcReport = { rows: [], skipped };
  if (!usable.length) return report;
  // Time-respecting OOF by resolution time (see backtest()). Hoist every fit once
  // per entry (threaded with the entry's own domain) instead of refitting the
  // exponent and recalibration — and recomputing trainFor — inside each strategy's
  // per-entry closure, which re-ran chooseExtremizeKMc twice over for the recal row.
  const trainFor = (idx: number): LedgerEntry[] => usable.filter((u) => u.resolveT < usable[idx].createT).map((u) => u.entry);
  const trains = usable.map((_, i) => trainFor(i));
  const doms = usable.map((u) => u.entry.domain);
  const kmcs = trains.map((t, i) => chooseExtremizeKMc(t, DEFAULT_EXTREMIZE_K, doms[i]));
  const mws = trains.map((t, i) => methodWeights(t, doms[i]));
  const mcRecals = trains.map((t, i) => fitMcRecalibration(t, doms[i]));
  const servedWith = (u: (typeof usable)[number], k: number, mw: Record<string, number>): Record<string, number> => {
    const weights = u.methods.map((m) => mw[m] ?? 1);
    return aggregateMc(u.panels, u.options, scaleK(k, u.overlap), weights).optionProbs!;
  };
  const strategies: { config: string; probs: (u: (typeof usable)[number], i: number) => Record<string, number> }[] = [
    { config: "published headline (as recorded)", probs: (u) => u.published ?? servedWith(u, DEFAULT_EXTREMIZE_K, {}) },
    { config: `static k=${DEFAULT_EXTREMIZE_K} (overlap-scaled)`, probs: (u) => servedWith(u, DEFAULT_EXTREMIZE_K, {}) },
    { config: "adaptive kMc + method weights (out-of-fold)", probs: (u, i) => servedWith(u, kmcs[i], mws[i]) },
    {
      // Gate mc recalibration the same way binary recalibration is gated: does it
      // beat the un-recalibrated served headline out-of-fold?
      config: "+ mc recalibration (out-of-fold)",
      probs: (u, i) => applyMcRecalibration(servedWith(u, kmcs[i], mws[i]), mcRecals[i]),
    },
  ];
  for (const s of strategies) {
    let brier = 0;
    let log = 0;
    for (let i = 0; i < usable.length; i++) {
      const p = s.probs(usable[i], i);
      brier += mcBrierScore(p, usable[i].realized);
      log += -mcLogScore(p, usable[i].realized);
    }
    report.rows.push({ config: s.config, n: usable.length, brierMean: brier / usable.length, logLossMean: log / usable.length });
  }
  return report;
}

// ---------------------------------------------------------------- numeric backtest

export interface BacktestNumericRow {
  config: string;
  n: number;
  /** Mean pinball loss over stated quantiles (proper score; lower is better). */
  pinballMean: number;
  /** Bootstrap 95% CI on the mean pinball (seeded). */
  pinballLo: number;
  pinballHi: number;
  /** Mean 80% interval score (width + out-of-interval penalty). */
  intervalMean: number;
  /** Fraction of outcomes inside the p10–p90 band — well-calibrated ≈ 0.80. */
  coverage: number;
  /** True when the learned dilation never had enough data to leave the default. */
  learnedEqualsDefault?: boolean;
}

export interface BacktestNumericReport {
  rows: BacktestNumericRow[];
  skipped: { nonNumeric: number; noPanel: number; unresolved: number };
}

/**
 * Replay the resolved numeric/date ledger under each quantile-aggregation
 * strategy and score them side by side — the regression gate for the LOP
 * combiner and the interval-dilation calibrator. Learned dilation is fitted
 * OUT-OF-FOLD by a TIME-RESPECTING expanding window (each entry's dilation is fit
 * only on entries RESOLVED before it was served) — an index-interleaved split
 * would leak future outcomes and flatter the calibrator. Pure deterministic
 * replay; no agents. Standalone from `backtest()` so the binary path is untouched.
 */
export function backtestNumeric(entries = loadLedger()): BacktestNumericReport {
  const skipped = { nonNumeric: 0, noPanel: 0, unresolved: 0 };
  const usable: { panel: Quantiles[]; outcome: number; createT: number; resolveT: number; entry: LedgerEntry }[] = [];
  for (const e of entries) {
    if (e.question.kind !== "numeric" && e.question.kind !== "date") {
      skipped.nonNumeric++;
      continue;
    }
    if (!e.resolution || typeof e.resolution.outcome !== "number") {
      skipped.unresolved++;
      continue;
    }
    const panel = e.panel
      .map((p) => p.quantiles)
      .filter((q): q is Quantiles => Boolean(q && typeof q.p50 === "number" && typeof q.p10 === "number"));
    if (!panel.length) {
      skipped.noPanel++;
      continue;
    }
    usable.push({ panel, outcome: e.resolution.outcome, createT: e.t, resolveT: e.resolution.t, entry: e });
  }
  const report: BacktestNumericReport = { rows: [], skipped };
  if (!usable.length) return report;

  // Time-respecting OOF (see backtest()): each entry's dilation is fit only on
  // entries resolved before it was served.
  const trainFor = (idx: number): LedgerEntry[] => usable.filter((u) => u.resolveT < usable[idx].createT).map((u) => u.entry);
  const entryCal = usable.map((_, i) => fitQuantileCalibration(trainFor(i), DEFAULT_QUANTILE_DILATION));
  const entryICal = usable.map((_, i) => fitIntervalCalibration(trainFor(i), DEFAULT_QUANTILE_DILATION));
  const learnedEqualsDefault = entryCal.every((c) => c.source === "default");

  const def = DEFAULT_QUANTILE_DILATION;
  const strategies: { config: string; q: (u: (typeof usable)[number], i: number) => Quantiles; learned?: boolean }[] = [
    { config: "vincent, no dilation (legacy)", q: (u) => aggregateQuantiles(u.panel, DEFAULT_EXTREMIZE_K, { combine: "vincent" }).quantiles! },
    { config: "LOP, no dilation", q: (u) => aggregateQuantiles(u.panel, DEFAULT_EXTREMIZE_K, { combine: "lop" }).quantiles! },
    {
      config: `LOP + default dilation (×${def})`,
      q: (u) => {
        const a = aggregateQuantiles(u.panel, DEFAULT_EXTREMIZE_K, { combine: "lop" });
        return applyQuantileDilation(a.quantiles!, def, Boolean(a.logSpace));
      },
    },
    {
      config: "LOP + learned dilation (out-of-fold)",
      learned: true,
      q: (u, i) => {
        const a = aggregateQuantiles(u.panel, DEFAULT_EXTREMIZE_K, { combine: "lop" });
        return applyQuantileDilation(a.quantiles!, entryCal[i].d, Boolean(a.logSpace));
      },
    },
    {
      config: "LOP + asymmetric dilation (out-of-fold)",
      learned: true,
      q: (u, i) => {
        const a = aggregateQuantiles(u.panel, DEFAULT_EXTREMIZE_K, { combine: "lop" });
        return applyAsymmetricDilation(a.quantiles!, entryICal[i].dLo, entryICal[i].dUp, Boolean(a.logSpace));
      },
    },
  ];

  for (const s of strategies) {
    const pinballs: number[] = [];
    const intervals: number[] = [];
    let covered = 0;
    usable.forEach((u, i) => {
      const q = s.q(u, i);
      pinballs.push(pinballLoss(q, u.outcome));
      intervals.push(intervalScore(q.p10, q.p90, u.outcome));
      const lo = Math.min(q.p10, q.p90);
      const hi = Math.max(q.p10, q.p90);
      if (u.outcome >= lo && u.outcome <= hi) covered++;
    });
    const ci = bootstrapCi(pinballs);
    report.rows.push({
      config: s.config,
      n: usable.length,
      pinballMean: pinballs.reduce((a, b) => a + b, 0) / pinballs.length,
      pinballLo: ci.lo,
      pinballHi: ci.hi,
      intervalMean: intervals.reduce((a, b) => a + b, 0) / intervals.length,
      coverage: covered / usable.length,
      ...(s.learned ? { learnedEqualsDefault } : {}),
    });
  }
  return report;
}

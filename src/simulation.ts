import {
  AggregateForecast,
  CombinerNode,
  CombinerSpec,
  DriverCorrelation,
  DriverMarginal,
  ForecastKind,
  Quantiles,
  ScenarioRow,
  SensitivityIndex,
  SimDriver,
  SimulationResult,
} from "./types";
import { QUANTILE_TAUS, clampProb, mulberry32 } from "./forecast";
import { normCdf } from "./datatools";

/**
 * Grounded scenario simulation: a pure, deterministic, seeded Monte Carlo over
 * the forecast's grounded drivers.
 *
 * The discipline mirrors the aggregation engine in forecast.ts — the LLM never
 * supplies a number here. The driver MARGINALS are the existing aggregated
 * distributions (a sub-forecast's headline, a market price, an OLS trend); the
 * LLM proposes only the STRUCTURE (a closed combiner DSL + pairwise
 * dependencies), and this module does the math: draw correlated worlds through
 * a Gaussian copula, push each through the combiner, and roll the simulated
 * outcomes back into the same binary / Quantiles / optionProbs representation
 * the rest of the pipeline speaks. Scenario clustering and a first-order
 * sensitivity (tornado) fall out of the same sample for free.
 *
 * Reuses forecast.ts primitives (mulberry32, QUANTILE_TAUS, clampProb) and
 * datatools.ts normCdf (Φ); the only genuinely new numerics are the normal
 * quantile (normInv), single-quantile CDF inversion, and the copula.
 */

// ---------------------------------------------------------------- normal quantile

/**
 * Standard-normal quantile Φ⁻¹ via Acklam's rational approximation, refined by
 * one Newton step against normCdf. The refinement is bounded by normCdf's own
 * precision (Abramowitz-Stegun, ~1.5e-7), so the practical error is ~5e-7, not
 * machine epsilon. normCdf already lives in datatools.ts; this is its missing
 * inverse. Not on the hot sampling path (the copula draws normals directly) but
 * exported as the natural companion primitive.
 */
export function normInv(p: number): number {
  const pc = Math.max(1e-10, Math.min(1 - 1e-10, p));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let z: number;
  if (pc < pLow) {
    const q = Math.sqrt(-2 * Math.log(pc));
    z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (pc <= pHigh) {
    const q = pc - 0.5;
    const r = q * q;
    z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - pc));
    z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // One Halley/Newton refinement step.
  const e = normCdf(z) - pc;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((z * z) / 2);
  return z - u;
}

// ---------------------------------------------------------------- marginal sampling

/**
 * Invert a single Quantiles object's piecewise-linear CDF at uniform u∈[0,1].
 * Replicates the CDF geometry of mixtureQuantiles (forecast.ts) for one
 * panelist: the QUANTILE_TAUS knots define a quantile function, linearly
 * interpolated inside and linearly extrapolated in the tails. `logSpace`
 * operates in log(value) space (right-skewed positives) so the inverse stays
 * monotone on the log scale and the draw is always positive. `dTau<=0` guards
 * make a point mass (p10=p50=p90) degenerate cleanly to its value.
 */
export function sampleFromQuantiles(q: Quantiles, u: number, logSpace = false): number {
  const knots = QUANTILE_TAUS.filter(({ key }) => typeof q[key] === "number").map(({ key, tau }) => ({
    tau,
    v: logSpace ? Math.log(q[key] as number) : (q[key] as number),
  }));
  if (!knots.length) throw new Error("sampleFromQuantiles: empty Quantiles");
  const out = (v: number) => (logSpace ? Math.exp(v) : v);
  if (knots.length === 1) return out(knots[0].v);
  const uc = Math.max(0, Math.min(1, u));
  // Left tail: extrapolate from the first two knots.
  if (uc <= knots[0].tau) {
    const dTau = knots[1].tau - knots[0].tau;
    if (dTau <= 0) return out(knots[0].v);
    return out(knots[0].v + ((uc - knots[0].tau) * (knots[1].v - knots[0].v)) / dTau);
  }
  const last = knots[knots.length - 1];
  const prev = knots[knots.length - 2];
  if (uc >= last.tau) {
    const dTau = last.tau - prev.tau;
    if (dTau <= 0) return out(last.v);
    return out(last.v + ((uc - last.tau) * (last.v - prev.v)) / dTau);
  }
  for (let i = 0; i < knots.length - 1; i++) {
    if (uc <= knots[i + 1].tau) {
      const dTau = knots[i + 1].tau - knots[i].tau;
      if (dTau <= 0) return out(knots[i + 1].v);
      return out(knots[i].v + ((uc - knots[i].tau) * (knots[i + 1].v - knots[i].v)) / dTau);
    }
  }
  return out(last.v);
}

/** Draw the marginal value for one driver given a correlated standard normal z. */
function drawMarginal(m: DriverMarginal, z: number): number {
  // Every kind maps HIGH latent z → HIGH driver value, so the copula's sign is
  // consistent across kinds. A numeric/trend driver's value increases with z;
  // a binary driver must therefore FIRE on high z (not low), or a positive
  // specified correlation between a binary and a numeric driver would realize as
  // a negative one. The marginal P(fire)=p is preserved: P(Φ(z) ≥ 1−p) = p.
  if (m.kind === "binary") return normCdf(z) >= 1 - clampProb(m.probability) ? 1 : 0;
  if (m.kind === "quantiles") {
    const v = sampleFromQuantiles(m.quantiles, normCdf(z), Boolean(m.logSpace));
    // A logSpace marginal whose quantiles disagree (a non-positive knot slipping
    // past the upstream shouldUseLogSpace guard) would log()→NaN and poison the
    // whole simulated distribution. Fall back to the median rather than propagate.
    return Number.isFinite(v) ? v : m.quantiles.p50;
  }
  // trend: a Gaussian marginal whose (lo,hi) is treated as an 80% band, so
  // σ = (hi−lo)/(2·z₀.₉) with z₀.₉=1.282. NOTE: when sourcing this from
  // olsProject (a Student-t band at df=n−2), the constructor must convert the
  // t-band to a Gaussian-equivalent 80% band first, or σ is overstated for
  // small n. Producers of trend marginals are responsible for that conversion.
  const sigma = Math.max(0, (m.hi - m.lo) / (2 * 1.282));
  return m.projected + z * sigma;
}

// ---------------------------------------------------------------- Gaussian copula

/**
 * Cholesky L (lower) with L·Lᵀ = M for symmetric PD M (flat row-major D×D).
 * Returns null when M is not PD (a non-positive pivot appears).
 */
function cholesky(M: number[], D: number): number[] | null {
  const L = new Array(D * D).fill(0);
  for (let i = 0; i < D; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * D + k] * L[j * D + k];
      if (i === j) {
        const diag = M[i * D + i] - sum;
        if (diag < 1e-12) return null;
        L[i * D + j] = Math.sqrt(diag);
      } else {
        L[i * D + j] = (M[i * D + j] - sum) / L[j * D + j];
      }
    }
  }
  return L;
}

/**
 * Repair a correlation matrix to a PD one by diagonal loading (Tikhonov
 * shrinkage), NOT Higham's Frobenius-nearest PD: R' = (1−α)R + αI keeps the
 * unit diagonal and shrinks off-diagonals until Cholesky succeeds (LLM-proposed
 * correlations need not be jointly consistent). At α=1 the matrix is the
 * identity, which is always PD, so the loop always returns; the trailing
 * identity is an unreachable safety net.
 */
function shrinkToPD(M: number[], D: number): number[] {
  for (let a = 0; a <= 1.0001; a += 0.02) {
    const R = M.map((v, idx) => (Math.floor(idx / D) === idx % D ? (1 - a) * v + a : (1 - a) * v));
    if (cholesky(R, D)) return R;
  }
  return Array.from({ length: D * D }, (_, idx) => (Math.floor(idx / D) === idx % D ? 1 : 0));
}

/**
 * Build a sampler that yields D correlated standard normals per call. The
 * correlation matrix is assembled from the LLM's pairwise edges (clamped,
 * repaired to PD), Cholesky-factored once, and applied to independent
 * Box-Muller normals: Z = L·W with W ~ N(0,I).
 */
export function buildCopulaSampler(drivers: SimDriver[], deps: DriverCorrelation[], rand: () => number): () => number[] {
  const D = drivers.length;
  const idxOf = new Map(drivers.map((d, i) => [d.id, i]));
  const R: number[] = Array.from({ length: D * D }, (_, k) => (Math.floor(k / D) === k % D ? 1 : 0));
  for (const { id1, id2, rho } of deps) {
    const i = idxOf.get(id1);
    const j = idxOf.get(id2);
    if (i === undefined || j === undefined || i === j) continue;
    const r = Math.max(-0.999, Math.min(0.999, rho));
    R[i * D + j] = r;
    R[j * D + i] = r;
  }
  let L = cholesky(R, D);
  if (!L) L = cholesky(shrinkToPD(R, D), D) ?? R.map((_, idx) => (Math.floor(idx / D) === idx % D ? 1 : 0));
  const Lf = L;

  // Box-Muller normal generator over the mulberry32 stream (spare-value cached).
  let spare: number | null = null;
  const nextNormal = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = Math.max(1e-10, rand());
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.cos(2 * Math.PI * u2);
    return r * Math.sin(2 * Math.PI * u2);
  };

  return (): number[] => {
    const W = Array.from({ length: D }, nextNormal);
    const Z = new Array(D).fill(0);
    for (let i = 0; i < D; i++) for (let j = 0; j <= i; j++) Z[i] += Lf[i * D + j] * W[j];
    return Z;
  };
}

// ---------------------------------------------------------------- combiner DSL

/** Recursively evaluate one combiner node to a scalar, given the per-draw driver values. */
export function evalCombiner(node: CombinerNode, idx: Map<string, number>, dvals: number[]): number {
  switch (node.op) {
    case "driver": {
      const i = idx.get(node.id);
      if (i === undefined) throw new Error(`evalCombiner: unknown driver "${node.id}"`);
      return dvals[i];
    }
    case "and":
      return node.children.every((c) => evalCombiner(c, idx, dvals) > 0.5) ? 1 : 0;
    case "or":
      return node.children.some((c) => evalCombiner(c, idx, dvals) > 0.5) ? 1 : 0;
    case "threshold":
      return evalCombiner(node.child, idx, dvals) > node.above ? 1 : 0;
    case "sum":
      return node.children.reduce((s, c) => s + evalCombiner(c, idx, dvals), 0);
    case "weighted_sum": {
      // A convex combination (all weights ≥ 0) normalizes to a weighted average;
      // a mixed-sign form (a difference / net change) is a genuine linear
      // combination and must NOT be normalized — dividing by Σ|w| compresses it
      // toward 0 and biases every zero-centered outcome's interval narrow.
      const allNonNeg = node.weights.every((w) => w >= 0);
      const sumW = node.weights.reduce((s, w) => s + w, 0);
      const denom = allNonNeg && sumW > 0 ? sumW : 1;
      return node.children.reduce((s, c, i) => s + ((node.weights[i] ?? 0) / denom) * evalCombiner(c, idx, dvals), 0);
    }
    case "max":
      return Math.max(...node.children.map((c) => evalCombiner(c, idx, dvals)));
    case "min":
      return Math.min(...node.children.map((c) => evalCombiner(c, idx, dvals)));
    case "argmax": {
      // Random-utility categorical selection: the index of the top-scoring child.
      let best = 0;
      let bestV = -Infinity;
      for (let i = 0; i < node.children.length; i++) {
        const v = evalCombiner(node.children[i], idx, dvals);
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      return best;
    }
    case "conditional_table": {
      const i = idx.get(node.conditionDriver);
      if (i === undefined) throw new Error(`evalCombiner: unknown condition driver "${node.conditionDriver}"`);
      return dvals[i] > 0.5 ? evalCombiner(node.ifTrue, idx, dvals) : evalCombiner(node.ifFalse, idx, dvals);
    }
    default:
      throw new Error(`evalCombiner: unrecognized op "${(node as { op: string }).op}"`);
  }
}

/** Linear-interpolated empirical quantile over an already-sorted ascending sample. */
function empiricalQuantile(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * Math.min(1, Math.max(0, tau));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Roll a set of simulated outcome scalars into the canonical aggregate for the question kind. */
export function aggregateSimOutcomes(rawOutcomes: number[], combiner: CombinerSpec): AggregateForecast {
  const N = rawOutcomes.length;
  if (!N) throw new Error("aggregateSimOutcomes: no draws");
  if (combiner.kind === "binary") {
    const p = rawOutcomes.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0) / N;
    return { probability: clampProb(p), k: 1, n: N, spread: 0 };
  }
  if (combiner.kind === "numeric" || combiner.kind === "date") {
    const sorted = [...rawOutcomes].sort((a, b) => a - b);
    const quantiles = {} as Quantiles;
    for (const { key, tau } of QUANTILE_TAUS) quantiles[key] = empiricalQuantile(sorted, tau);
    return { quantiles, k: 1, n: N, spread: 0 };
  }
  // mc: each draw's scalar is an option index. validateSimStructure guarantees
  // the root is argmax (which returns an exact integer index), so round() is
  // just defensive; the clamp keeps any stray value in range so no draw is
  // silently dropped (which would deflate every option's fraction).
  const opts = combiner.mcOptions ?? [];
  const counts: Record<string, number> = {};
  for (const o of opts) counts[o] = 0;
  for (const v of rawOutcomes) {
    const i = Math.max(0, Math.min(opts.length - 1, Math.round(v)));
    counts[opts[i]]++;
  }
  // Add-one (Laplace) smoothing — the principled multinomial cell estimator. It
  // shrinks toward uniform as a function of N (unlike a flat 0.005 floor that
  // inflates never-selected options by a fixed amount regardless of draws) and
  // already sums to 1 (Σ(countᵢ+1) = N+K), so no renormalization is needed.
  const K = opts.length || 1;
  const optionProbs: Record<string, number> = {};
  for (const o of opts) optionProbs[o] = ((counts[o] ?? 0) + 1) / (N + K);
  return { optionProbs, k: 1, n: N, spread: 0 };
}

// ---------------------------------------------------------------- driver firing / scenarios

/** Effective fire threshold for a driver (binary: 0.5; numeric/trend: stated threshold or distribution center). */
function fireThreshold(d: SimDriver): number {
  if (d.marginal.kind === "binary") return 0.5;
  if (typeof d.threshold === "number") return d.threshold;
  return d.marginal.kind === "quantiles" ? d.marginal.quantiles.p50 : d.marginal.projected;
}

function fired(d: SimDriver, thr: number, val: number): number {
  if (d.marginal.kind === "binary") return val > 0.5 ? 1 : 0;
  return val > thr ? 1 : 0;
}

/**
 * Cluster the drawn worlds by their driver-fired pattern (≤2^D cells, no
 * k-means), rank by frequency, and attach each cluster's conditional outcome.
 * The modal cluster is "the winning scenario". Capped at the top 8 or ≥90%
 * cumulative coverage, whichever comes first.
 */
function clusterScenarios(driverFired: number[][], drivers: SimDriver[], rawOutcomes: number[], combiner: CombinerSpec): ScenarioRow[] {
  const N = rawOutcomes.length;
  const buckets = new Map<string, { outcomes: number[]; pattern: number[] }>();
  for (let s = 0; s < N; s++) {
    const pattern = drivers.map((_, i) => driverFired[i][s]);
    const key = pattern.map((f, i) => `${drivers[i].id}=${f}`).join(",");
    let b = buckets.get(key);
    if (!b) {
      b = { outcomes: [], pattern };
      buckets.set(key, b);
    }
    b.outcomes.push(rawOutcomes[s]);
  }
  const rows: ScenarioRow[] = [];
  for (const [key, { outcomes, pattern }] of buckets) {
    rows.push({
      key,
      frequency: outcomes.length / N,
      outcome: aggregateSimOutcomes(outcomes, combiner),
      description: pattern.map((f, i) => `${drivers[i].label}: ${f ? "yes" : "no"}`).join(", "),
    });
  }
  rows.sort((a, b) => b.frequency - a.frequency);
  const top: ScenarioRow[] = [];
  let cum = 0;
  for (const r of rows) {
    top.push(r);
    cum += r.frequency;
    if (top.length >= 8 || cum >= 0.9) break;
  }
  return top;
}

// ---------------------------------------------------------------- sensitivity (tornado)

/**
 * Correlation ratio η² = Var(E[Y|X]) / Var(Y), estimated by binning X into up
 * to `bins` quantile groups. Equal X values are never split across bins, so a
 * binary driver yields exactly two groups (η² is then exact) while a continuous
 * driver gets up to `bins` groups that capture nonlinear first-order effects —
 * strictly better than a single fired/not-fired split. O(N log N) per driver.
 */
function correlationRatio(xs: number[], ys: number[], meanY: number, varY: number, bins = 10): number {
  const N = xs.length;
  if (varY < 1e-12) return 0;
  const order = Array.from({ length: N }, (_, k) => k).sort((a, b) => xs[a] - xs[b]);
  let between = 0;
  const groupMean = (start: number, end: number): void => {
    let sum = 0;
    for (let k = start; k < end; k++) sum += ys[order[k]];
    between += ((end - start) / N) * (sum / (end - start) - meanY) ** 2;
  };
  // Count distinct X values. A driver with few distinct values (binary → 2, a
  // small-count integer) is grouped BY VALUE so a rare class (a p=0.95 binary's
  // 5% of zeros) still forms its own group. Quantile bins would let the majority
  // value-block swallow the boundary and report η²=0 for a driver that clearly
  // matters — the rare-flip drivers whose importance the tornado most needs.
  let distinct = 1;
  for (let k = 1; k < N; k++) if (xs[order[k]] !== xs[order[k - 1]]) distinct++;
  if (distinct <= bins) {
    let start = 0;
    for (let k = 1; k <= N; k++) {
      if (k === N || xs[order[k]] !== xs[order[k - 1]]) {
        groupMean(start, k);
        start = k;
      }
    }
  } else {
    let start = 0;
    for (let b = 0; b < bins && start < N; b++) {
      let end = Math.min(N, Math.floor(((b + 1) * N) / bins));
      while (end < N && end > 0 && xs[order[end]] === xs[order[end - 1]]) end++; // keep equal values together
      if (end <= start) continue;
      groupMean(start, end);
      start = end;
    }
  }
  return Math.max(0, Math.min(1, between / varY));
}

/**
 * First-order sensitivity per driver from the existing sample (no extra model
 * runs): the correlation ratio η² over quantile bins of the driver, plus
 * |Pearson| as a linear cross-check. O(N·D·log N).
 */
function computeSensitivity(driverDraws: number[][], rawOutcomes: number[], drivers: SimDriver[]): SensitivityIndex[] {
  const N = rawOutcomes.length;
  const meanY = rawOutcomes.reduce((s, v) => s + v, 0) / N;
  const varY = rawOutcomes.reduce((s, v) => s + (v - meanY) ** 2, 0) / N;
  return drivers
    .map((driver, i) => {
      if (varY < 1e-12) return { driverId: driver.id, driverLabel: driver.label, varianceContribution: 0, linearCorrelation: 0 };
      const xi = driverDraws[i];
      const meanX = xi.reduce((s, v) => s + v, 0) / N;
      const varX = xi.reduce((s, v) => s + (v - meanX) ** 2, 0) / N;
      let cov = 0;
      for (let s = 0; s < N; s++) cov += (xi[s] - meanX) * (rawOutcomes[s] - meanY);
      cov /= N;
      const linearCorrelation = varX > 1e-12 ? Math.min(1, Math.abs(cov / Math.sqrt(varX * varY))) : 0;
      return {
        driverId: driver.id,
        driverLabel: driver.label,
        varianceContribution: correlationRatio(xi, rawOutcomes, meanY, varY),
        linearCorrelation,
      };
    })
    .sort((a, b) => b.varianceContribution - a.varianceContribution);
}

// ---------------------------------------------------------------- coherence

/** Quantify how far the bottom-up simulation lands from the top-down panel aggregate. */
export function checkCoherence(simAgg: AggregateForecast, topDown: AggregateForecast | undefined, kind: ForecastKind): SimulationResult["coherence"] {
  if (!topDown) return { divergence: 0, verdict: "ok" };
  let divergence = 0;
  if (kind === "binary") {
    divergence = Math.abs((simAgg.probability ?? 0.5) - (topDown.probability ?? 0.5));
  } else if (kind === "numeric" || kind === "date") {
    const sq = simAgg.quantiles;
    const tq = topDown.quantiles;
    if (sq && tq) {
      // Scale by the panel's own spread (IQR-ish), not |p50|: a zero-centered
      // quantity (anomalies, net change, margins) has p50≈0, and dividing by it
      // would make any nonzero gap look infinite. The p10–p90 width is the
      // natural, always-positive scale for the distribution.
      const scale = Math.max(Math.abs(tq.p90 - tq.p10), Math.abs(tq.p50), 1e-9);
      const spine: (keyof Quantiles)[] = ["p10", "p50", "p90"];
      divergence = spine.reduce((s, k) => s + Math.abs(((sq[k] as number) ?? 0) - ((tq[k] as number) ?? 0)) / scale, 0) / spine.length;
    }
  } else {
    const sp = simAgg.optionProbs ?? {};
    const tp = topDown.optionProbs ?? {};
    const opts = Object.keys({ ...sp, ...tp });
    if (opts.length) divergence = opts.reduce((s, o) => s + Math.abs((sp[o] ?? 0) - (tp[o] ?? 0)), 0) / opts.length;
  }
  const verdict = divergence < 0.05 ? "ok" : divergence < 0.15 ? "moderate" : "high";
  return { divergence, verdict };
}

// ---------------------------------------------------------------- orchestrator

/**
 * Run the scenario simulation: N seeded correlated draws, each propagated
 * through the combiner, then aggregated back into canonical form alongside the
 * scenario table, sensitivity ranking, and the coherence check against the
 * panel. Pure and deterministic — same inputs, same seed → identical result.
 */
export function runSimulation(
  drivers: SimDriver[],
  combiner: CombinerSpec,
  deps: DriverCorrelation[],
  N = 10_000,
  seed = 1738,
  topDown?: AggregateForecast
): SimulationResult {
  if (drivers.length < 1) throw new Error("runSimulation: need at least one driver");
  const rand = mulberry32(seed);
  const drawNormals = buildCopulaSampler(drivers, deps, rand);
  const idx = new Map(drivers.map((d, i) => [d.id, i]));
  const thresholds = drivers.map(fireThreshold);

  const rawOutcomes = new Array<number>(N);
  const driverDraws = drivers.map(() => new Array<number>(N));
  const driverFired = drivers.map(() => new Array<number>(N));

  for (let s = 0; s < N; s++) {
    const Z = drawNormals();
    const dvals = drivers.map((d, i) => drawMarginal(d.marginal, Z[i]));
    rawOutcomes[s] = evalCombiner(combiner.root, idx, dvals);
    for (let i = 0; i < drivers.length; i++) {
      driverDraws[i][s] = dvals[i];
      driverFired[i][s] = fired(drivers[i], thresholds[i], dvals[i]);
    }
  }

  const simulatedAggregate = aggregateSimOutcomes(rawOutcomes, combiner);
  const scenarios = clusterScenarios(driverFired, drivers, rawOutcomes, combiner);
  const sensitivity = computeSensitivity(driverDraws, rawOutcomes, drivers);
  const coherence = checkCoherence(simulatedAggregate, topDown, combiner.kind);

  return {
    simulatedAggregate,
    N,
    seed,
    scenarios,
    modalScenario: scenarios[0],
    sensitivity,
    coherence,
    drivers: drivers.map((d) => ({ id: d.id, label: d.label, provenance: d.provenance })),
  };
}

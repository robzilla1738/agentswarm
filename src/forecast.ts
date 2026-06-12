import * as path from "path";
import * as fs from "fs";
import { home } from "./config";
import { canonicalizeUrl } from "./searchcore";
import { AggregateForecast, Forecast, ForecastKind, ForecastQuestion } from "./types";
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
 */
export function aggregateBinary(probs: number[], k = DEFAULT_EXTREMIZE_K): AggregateForecast {
  const ps = probs.map(clampProb);
  if (!ps.length) throw new Error("aggregateBinary: empty panel");
  const sorted = [...ps].sort((a, b) => a - b);
  const med = median(sorted);
  const logOddsMean = ps.reduce((s, p) => s + Math.log(p / (1 - p)), 0) / ps.length;
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

/** Combine a numeric panel: 10%-trimmed mean per quantile, re-sorted for monotonicity. */
export function aggregateQuantiles(
  qs: { p10: number; p50: number; p90: number }[],
  k = DEFAULT_EXTREMIZE_K
): AggregateForecast {
  if (!qs.length) throw new Error("aggregateQuantiles: empty panel");
  const agg = [trimmedMean(qs.map((q) => q.p10)), trimmedMean(qs.map((q) => q.p50)), trimmedMean(qs.map((q) => q.p90))].sort(
    (a, b) => a - b
  );
  const p50s = qs.map((q) => q.p50).sort((a, b) => a - b);
  const scale = Math.max(Math.abs(agg[1]), 1e-9);
  return {
    quantiles: { p10: agg[0], p50: agg[1], p90: agg[2] },
    k,
    n: qs.length,
    spread: (p50s[p50s.length - 1] - p50s[0]) / scale,
  };
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
  const kind = obj.kind === "numeric" ? ("numeric" as const) : obj.kind === "binary" ? ("binary" as const) : null;
  let date = String(obj.resolutionDate ?? "").trim();
  if (operatorDate && ISO_DATE.test(operatorDate)) date = operatorDate;
  if (!text || !criteria || !kind || !ISO_DATE.test(date)) return null;
  const unit = obj.unit ? String(obj.unit).trim().slice(0, 40) : undefined;
  return {
    text: text.slice(0, 500),
    kind,
    resolutionCriteria: criteria.slice(0, 1000),
    resolutionDate: date,
    ...(kind === "numeric" && unit ? { unit } : {}),
  };
}

// ---------------------------------------------------------------- ledger

export interface LedgerPanelist {
  taskId: string;
  method: string;
  probability?: number;
  /** Base-rate prior committed before current evidence (binary). */
  prior?: number;
  quantiles?: { p10: number; p50: number; p90: number };
}

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
}

export interface LedgerResolved {
  v: 1;
  rec: "resolved";
  id: string;
  t: number;
  /** 0/1 for binary, the realized value for numeric, "void" when the question stopped being meaningful. */
  outcome: 0 | 1 | number | "void";
  evidence: string;
  sources: string[];
  resolvedBy: "swarm" | "operator";
  brier?: number;
  logScore?: number;
  intervalScore?: number;
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

/** Score and append a resolution record. Returns the record written. */
export function resolveLedgerEntry(
  entry: LedgerEntry,
  outcome: 0 | 1 | number | "void",
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
  if (outcome !== "void") {
    if (entry.question.kind === "binary" && (outcome === 0 || outcome === 1)) {
      const p = entry.aggregate.probability ?? 0.5;
      rec.brier = brierScore(p, outcome);
      rec.logScore = logScore(p, outcome);
    } else if (entry.question.kind === "numeric" && typeof outcome === "number") {
      const q = entry.aggregate.quantiles;
      if (q) rec.intervalScore = intervalScore(q.p10, q.p90, outcome);
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
  const bins: CalibrationBin[] = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    hi: (i + 1) / 10,
    n: 0,
    meanP: 0,
    hitRate: 0,
  }));
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
  return {
    n: scored.length,
    brierMean: scored.length ? brierSum / scored.length : 0,
    bins: bins.filter((b) => b.n > 0),
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

const K_GRID = Array.from({ length: 13 }, (_, i) => 1 + i * 0.25); // 1.00 … 4.00

/**
 * Pick the extremization exponent that would have minimized Brier over the
 * resolved history (each entry re-aggregated from its stored panel at each
 * candidate k). Falls back to the default below MIN_ADAPTIVE_N resolutions —
 * tuning on a handful of outcomes is just overfitting noise.
 */
export const MIN_ADAPTIVE_N = 30;

export function chooseExtremizeK(entries = loadLedger(), fallback = DEFAULT_EXTREMIZE_K): number {
  const usable = scoreable(entries).filter((s) => s.panel.filter((m) => typeof m.probability === "number").length >= 2);
  if (usable.length < MIN_ADAPTIVE_N) return fallback;
  let bestK = fallback;
  let bestBrier = Infinity;
  for (const k of K_GRID) {
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
    const mean = sum / usable.length;
    if (mean < bestBrier - 1e-12) {
      bestBrier = mean;
      bestK = k;
    }
  }
  return bestK;
}

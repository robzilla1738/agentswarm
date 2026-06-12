const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The ledger reads AGENTSWARM_HOME at call time via config.home() — isolate
// every test in a temp home BEFORE loading the module (belt and braces; the
// path is resolved lazily anyway).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-forecast-test-"));
process.env.AGENTSWARM_HOME = TMP_HOME;

const {
  clampProb,
  trimmedMean,
  aggregateBinary,
  aggregateQuantiles,
  brierScore,
  logScore,
  intervalScore,
  parseQuestionJson,
  validateForecastAnalytics,
  evidenceOverlap,
  scaleK,
  appendLedger,
  loadLedger,
  ledgerPath,
  dueForecasts,
  resolveLedgerEntry,
  calibrationStats,
  calibrationBlock,
  chooseExtremizeK,
  blendWithMarket,
  liquidityFactor,
  chooseMarketWeight,
  methodWeights,
  fitRecalibration,
  applyRecalibration,
  extractMethodLabel,
  pinballLoss,
  monotoneQuantiles,
  shouldUseLogSpace,
  aggregateMc,
  mcBrierScore,
  mcLogScore,
  normalizeOptionProbs,
  isoToDays,
  daysToIso,
  MIN_CALIBRATION_N,
  MIN_ADAPTIVE_N,
  MIN_MARKET_WEIGHT_N,
  MIN_METHOD_WEIGHT_N,
  MIN_RECALIBRATION_N,
  DEFAULT_EXTREMIZE_K,
  DEFAULT_MARKET_WEIGHT,
} = require("../../dist/forecast.js");
const { coerceConfigValue } = require("../../dist/config.js");

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

function clearLedger() {
  try {
    fs.rmSync(ledgerPath());
  } catch {
    /* not created yet */
  }
}

// ---------------------------------------------------------------- math

test("clampProb keeps probabilities off 0/1 and defaults NaN to 0.5", () => {
  assert.equal(clampProb(0), 0.01);
  assert.equal(clampProb(1), 0.99);
  assert.equal(clampProb(0.5), 0.5);
  assert.equal(clampProb(NaN), 0.5);
  assert.equal(clampProb(Infinity), 0.5);
});

test("aggregateBinary: hand-computed median, GMO, and extremized headline", () => {
  // probs [0.6, 0.7, 0.8]: mean log-odds = (ln1.5 + ln(7/3) + ln4)/3 = 0.87969
  // → GMO odds e^0.87969 = 2.4101 → gmo = 0.7068
  // → extremized (k=2.5) odds 2.4101^2.5 = 9.0185 → p = 0.9002
  const a = aggregateBinary([0.6, 0.7, 0.8], 2.5);
  assert.equal(a.n, 3);
  assert.equal(a.k, 2.5);
  near(a.median, 0.7, 1e-9);
  near(a.gmo, 0.7068, 1e-3);
  near(a.probability, 0.9002, 1e-3);
  near(a.spread, 0.2, 1e-9);
});

test("aggregateBinary: a unanimous panel extremizes away from the shared value", () => {
  const a = aggregateBinary([0.7, 0.7, 0.7], 2.5);
  near(a.gmo, 0.7, 1e-9);
  assert.ok(a.probability > 0.8, "extremization pushes a confident consensus outward");
});

test("aggregateBinary: a single panelist passes through un-extremized", () => {
  const a = aggregateBinary([0.6], 2.5);
  near(a.probability, 0.6, 1e-9);
  assert.equal(a.k, 1);
  assert.equal(a.n, 1);
  assert.equal(a.spread, 0);
});

test("aggregateBinary clamps 0/1 inputs instead of blowing up the odds math", () => {
  const a = aggregateBinary([0, 1, 0.5], 2.5);
  assert.ok(Number.isFinite(a.probability));
  assert.ok(a.probability >= 0.01 && a.probability <= 0.99);
});

test("aggregateBinary rejects an empty panel", () => {
  assert.throws(() => aggregateBinary([], 2.5));
});

test("trimmedMean trims floor(n·frac) from each end", () => {
  assert.equal(trimmedMean([1, 2, 3, 4, 100], 0.2), 3); // trims 1 and 100
  assert.equal(trimmedMean([1, 2, 3], 0.1), 2); // floor(0.3)=0 → plain mean
});

test("aggregateQuantiles: small panels take the median per quantile, stay monotonic, spread is relative", () => {
  const a = aggregateQuantiles([
    { p10: 10, p50: 20, p90: 30 },
    { p10: 12, p50: 24, p90: 40 },
    { p10: 8, p50: 16, p90: 28 },
  ]);
  assert.equal(a.n, 3);
  near(a.quantiles.p10, 10, 1e-9);
  near(a.quantiles.p50, 20, 1e-9);
  near(a.quantiles.p90, 30, 1e-9); // median of 30/40/28 — a mean would let 40 drag it
  assert.ok(a.quantiles.p10 <= a.quantiles.p50 && a.quantiles.p50 <= a.quantiles.p90);
  near(a.spread, (24 - 16) / 20, 1e-9);
});

test("aggregateQuantiles: one wild panelist cannot drag a small panel", () => {
  const a = aggregateQuantiles([
    { p10: 10, p50: 20, p90: 30 },
    { p10: 11, p50: 21, p90: 31 },
    { p10: 100, p50: 200, p90: 300 },
  ]);
  near(a.quantiles.p50, 21, 1e-9, "median holds the center; a mean would say ~80");
});

test("scoring: brier, log, interval fixtures", () => {
  near(brierScore(0.9, 1), 0.01, 1e-9);
  near(brierScore(0.9, 0), 0.81, 1e-9);
  near(brierScore(0.5, 1), 0.25, 1e-9);
  near(logScore(0.9, 1), Math.log(0.9), 1e-9);
  near(logScore(0.9, 0), Math.log(0.1), 1e-9);
  // inside the interval: just the width
  near(intervalScore(10, 30, 20), 20, 1e-9);
  // 5 below the interval: width + (2/0.2)·5 = 20 + 50
  near(intervalScore(10, 30, 5), 70, 1e-9);
  // 10 above: 20 + 100
  near(intervalScore(10, 30, 40), 120, 1e-9);
});

// ---------------------------------------------------------------- analytical gate

const groundedForecast = {
  method: "outside-view",
  probability: 0.6,
  prior: 0.55,
  rationale: "6 of 10 comparable cases resolved YES; current evidence nudges up.",
  baseRates: ["6/10 comparable cases"],
  submittedAt: 1,
};

test("validateForecastAnalytics passes a grounded binary forecast", () => {
  assert.equal(validateForecastAnalytics(groundedForecast, "binary"), null);
});

test("validateForecastAnalytics demands prior, base rates, and numbers", () => {
  const noPrior = validateForecastAnalytics({ ...groundedForecast, prior: undefined }, "binary");
  assert.ok(/prior/.test(noPrior));
  const noRates = validateForecastAnalytics({ ...groundedForecast, baseRates: [] }, "binary");
  assert.ok(/base_rates/.test(noRates));
  const noDigits = validateForecastAnalytics({ ...groundedForecast, rationale: "it feels likely from the headlines" }, "binary");
  assert.ok(/no numbers/.test(noDigits));
  // all three problems reported at once
  const allBad = validateForecastAnalytics(
    { method: "m", probability: 0.5, rationale: "vibes", submittedAt: 1 },
    "binary"
  );
  assert.ok(/prior/.test(allBad) && /base_rates/.test(allBad) && /no numbers/.test(allBad));
});

test("validateForecastAnalytics for numeric only requires numbers in the rationale", () => {
  const f = { method: "trend", quantiles: { p10: 1, p50: 2, p90: 3 }, rationale: "OLS slope 0.4/day projects 2.1", submittedAt: 1 };
  assert.equal(validateForecastAnalytics(f, "numeric"), null);
  assert.ok(/no numbers/.test(validateForecastAnalytics({ ...f, rationale: "the trend looks strong" }, "numeric")));
});

// ---------------------------------------------------------------- evidence overlap

test("evidenceOverlap: identical sets → 1, disjoint → 0, empty pairs skipped", () => {
  const a = ["https://x.com/one", "https://x.com/two"];
  assert.equal(evidenceOverlap([a, [...a]]), 1);
  assert.equal(evidenceOverlap([["https://x.com/one"], ["https://y.com/other"]]), 0);
  // canonicalization: tracking params and trailing slashes don't break identity
  near(evidenceOverlap([["https://x.com/one?utm_source=tracker"], ["https://x.com/one/"]]), 1, 1e-9);
  // a silent panelist is skipped, not counted as disagreement
  assert.equal(evidenceOverlap([a, [], [...a]]), 1);
  // no valid pairs at all → 0
  assert.equal(evidenceOverlap([[], []]), 0);
  assert.equal(evidenceOverlap([a]), 0);
  // half overlap: {1,2} vs {2,3} → 1/3
  near(evidenceOverlap([["https://x.com/1", "https://x.com/2"], ["https://x.com/2", "https://x.com/3"]]), 1 / 3, 1e-9);
});

test("scaleK: full independence keeps k, full overlap kills extremization", () => {
  assert.equal(scaleK(2.5, 0), 2.5);
  assert.equal(scaleK(2.5, 1), 1);
  near(scaleK(2.5, 0.5), 1.75, 1e-9);
  assert.equal(scaleK(2.5, -1), 2.5); // clamped
  assert.equal(scaleK(2.5, 2), 1); // clamped
});

// ---------------------------------------------------------------- question parsing

test("parseQuestionJson reads fenced/prose-wrapped JSON and enforces fields", () => {
  const q = parseQuestionJson(
    'Sure! Here it is:\n```json\n{"text":"Will X happen before 2026-09-01?","kind":"binary","resolutionCriteria":"YES if X occurs per official source","resolutionDate":"2026-09-01"}\n```'
  );
  assert.ok(q);
  assert.equal(q.kind, "binary");
  assert.equal(q.resolutionDate, "2026-09-01");

  assert.equal(parseQuestionJson("no json here"), null);
  assert.equal(parseQuestionJson('{"text":"x","kind":"binary","resolutionCriteria":"c"}'), null, "missing date");
  assert.equal(parseQuestionJson('{"text":"x","kind":"maybe","resolutionCriteria":"c","resolutionDate":"2026-01-01"}'), null, "bad kind");
});

test("parseQuestionJson: the operator's resolution date always wins", () => {
  const q = parseQuestionJson(
    '{"text":"Will X?","kind":"binary","resolutionCriteria":"c","resolutionDate":"2030-01-01"}',
    "2026-12-31"
  );
  assert.equal(q.resolutionDate, "2026-12-31");
});

test("parseQuestionJson: numeric questions keep their unit; binary drop it", () => {
  const num = parseQuestionJson('{"text":"What will X be?","kind":"numeric","resolutionCriteria":"c","resolutionDate":"2026-01-01","unit":"USD"}');
  assert.equal(num.unit, "USD");
  const bin = parseQuestionJson('{"text":"Will X?","kind":"binary","resolutionCriteria":"c","resolutionDate":"2026-01-01","unit":"USD"}');
  assert.equal(bin.unit, undefined);
});

// ---------------------------------------------------------------- ledger

const QUESTION = {
  text: "Will the test event happen by 2026-01-31?",
  kind: "binary",
  resolutionCriteria: "YES if the event occurs per the test harness",
  resolutionDate: "2026-01-31",
};

function createdRec(id, overrides = {}) {
  return {
    v: 1,
    rec: "created",
    id,
    runId: "run_test",
    t: Date.now(),
    question: { ...QUESTION },
    aggregate: aggregateBinary([0.6, 0.7, 0.8], 2.5),
    panel: [
      { taskId: "T2", method: "outside-view", probability: 0.6 },
      { taskId: "T3", method: "inside-view", probability: 0.7 },
      { taskId: "T4", method: "trend", probability: 0.8 },
    ],
    ...overrides,
  };
}

test("ledger: created→resolved reduction, latest resolution wins, malformed lines skipped", () => {
  clearLedger();
  appendLedger(createdRec("f_a"));
  appendLedger(createdRec("f_b"));
  // hand-corrupt one line — must degrade to forgotten, never throw
  fs.appendFileSync(ledgerPath(), "{not json}\n");
  appendLedger({ v: 1, rec: "resolved", id: "f_a", t: Date.now(), outcome: 0, evidence: "swarm said no", sources: [], resolvedBy: "swarm", brier: 0.81 });
  // operator override AFTER the swarm — must win
  appendLedger({ v: 1, rec: "resolved", id: "f_a", t: Date.now() + 1, outcome: 1, evidence: "operator corrected", sources: [], resolvedBy: "operator", brier: 0.01 });
  // resolution for an unknown id — ignored
  appendLedger({ v: 1, rec: "resolved", id: "f_ghost", t: Date.now(), outcome: 1, evidence: "", sources: [], resolvedBy: "swarm" });

  const entries = loadLedger();
  assert.equal(entries.length, 2);
  const a = entries.find((e) => e.id === "f_a");
  assert.equal(a.resolution.outcome, 1);
  assert.equal(a.resolution.resolvedBy, "operator");
  const b = entries.find((e) => e.id === "f_b");
  assert.equal(b.resolution, undefined);
});

test("dueForecasts: open entries past their resolution day (end of day UTC)", () => {
  clearLedger();
  appendLedger(createdRec("f_due", { question: { ...QUESTION, resolutionDate: "2020-01-01" } }));
  appendLedger(createdRec("f_open", { question: { ...QUESTION, resolutionDate: "2999-01-01" } }));
  appendLedger(createdRec("f_resolved", { question: { ...QUESTION, resolutionDate: "2020-01-01" } }));
  appendLedger({ v: 1, rec: "resolved", id: "f_resolved", t: Date.now(), outcome: 1, evidence: "", sources: [], resolvedBy: "operator" });

  const due = dueForecasts();
  assert.deepEqual(due.map((e) => e.id), ["f_due"]);
  // not yet due one second before its deadline passes
  const justBefore = Date.parse("2999-01-01T23:59:58Z");
  assert.ok(dueForecasts(justBefore).some((e) => e.id === "f_open") === false);
});

test("resolveLedgerEntry scores binary (brier/log) and numeric (interval) outcomes", () => {
  clearLedger();
  appendLedger(createdRec("f_bin"));
  appendLedger(
    createdRec("f_num", {
      question: { ...QUESTION, kind: "numeric", unit: "pts" },
      aggregate: aggregateQuantiles([{ p10: 10, p50: 20, p90: 30 }]),
      panel: [{ taskId: "T2", method: "trend", quantiles: { p10: 10, p50: 20, p90: 30 } }],
    })
  );
  const entries = loadLedger();
  const p = entries.find((e) => e.id === "f_bin").aggregate.probability;

  const recBin = resolveLedgerEntry(entries.find((e) => e.id === "f_bin"), 1, { evidence: "happened", sources: [], resolvedBy: "swarm" });
  near(recBin.brier, Math.pow(p - 1, 2), 1e-12);
  near(recBin.logScore, Math.log(p), 1e-12);

  const recNum = resolveLedgerEntry(entries.find((e) => e.id === "f_num"), 35, { evidence: "measured", sources: [], resolvedBy: "swarm" });
  near(recNum.intervalScore, intervalScore(10, 30, 35), 1e-12);

  const reloaded = loadLedger();
  assert.equal(reloaded.find((e) => e.id === "f_bin").resolution.outcome, 1);
  assert.equal(reloaded.find((e) => e.id === "f_num").resolution.outcome, 35);
});

// ---------------------------------------------------------------- calibration

function resolvedEntry(id, p, outcome, method = "outside-view") {
  return {
    id,
    runId: "r",
    t: 1,
    question: { ...QUESTION },
    aggregate: { probability: p, k: 2.5, n: 1, spread: 0 },
    panel: [{ taskId: "T2", method, probability: p }],
    resolution: { v: 1, rec: "resolved", id, t: 2, outcome, evidence: "", sources: [], resolvedBy: "swarm" },
  };
}

test("calibrationStats bins by forecast probability and tracks per-method Brier", () => {
  const entries = [
    resolvedEntry("a", 0.85, 1),
    resolvedEntry("b", 0.85, 0),
    resolvedEntry("c", 0.15, 0, "trend"),
    // voids and unresolved entries are not scoreable
    { ...resolvedEntry("d", 0.5, 1), resolution: { ...resolvedEntry("d", 0.5, 1).resolution, outcome: "void" } },
    { ...resolvedEntry("e", 0.5, 1), resolution: undefined },
  ];
  const stats = calibrationStats(entries);
  assert.equal(stats.n, 3);
  const hi = stats.bins.find((b) => b.lo === 0.8);
  assert.equal(hi.n, 2);
  near(hi.meanP, 0.85, 1e-9);
  near(hi.hitRate, 0.5, 1e-9);
  near(stats.byMethod["outside-view"].brierMean, (Math.pow(0.85 - 1, 2) + Math.pow(0.85, 2)) / 2, 1e-9);
  assert.equal(stats.byMethod["trend"].n, 1);
});

test("calibrationBlock stays silent below the minimum track record, then reports", () => {
  const few = Array.from({ length: MIN_CALIBRATION_N - 1 }, (_, i) => resolvedEntry(`s${i}`, 0.9, 1));
  assert.equal(calibrationBlock(few), "");
  const enough = Array.from({ length: MIN_CALIBRATION_N + 2 }, (_, i) => resolvedEntry(`m${i}`, 0.9, i % 2));
  const block = calibrationBlock(enough);
  assert.ok(/TRACK RECORD/.test(block));
  assert.ok(/OVERCONFIDENT at the high end/.test(block), "said 90% but only half resolved YES");
});

// ---------------------------------------------------------------- adaptive k

test("chooseExtremizeK falls back below the minimum history and tunes above it", () => {
  const few = Array.from({ length: MIN_ADAPTIVE_N - 1 }, (_, i) => ({
    ...resolvedEntry(`f${i}`, 0.6, 1),
    panel: [
      { taskId: "T2", method: "a", probability: 0.6 },
      { taskId: "T3", method: "b", probability: 0.6 },
    ],
  }));
  assert.equal(chooseExtremizeK(few, DEFAULT_EXTREMIZE_K), DEFAULT_EXTREMIZE_K);

  // Every panel says 60% and the answer is always YES — the more
  // extremization, the better the Brier, so the search rides the upper bound.
  const many = Array.from({ length: MIN_ADAPTIVE_N + 5 }, (_, i) => ({
    ...resolvedEntry(`m${i}`, 0.6, 1),
    panel: [
      { taskId: "T2", method: "a", probability: 0.6 },
      { taskId: "T3", method: "b", probability: 0.6 },
    ],
  }));
  assert.ok(chooseExtremizeK(many, DEFAULT_EXTREMIZE_K) >= 5.99, "monotone improvement rides to K_MAX=6");

  // A 70% panel that only hits 50/50: any extremization hurts, so the
  // search converges to the lower bound k=1.
  const calibrated = Array.from({ length: MIN_ADAPTIVE_N + 5 }, (_, i) => ({
    ...resolvedEntry(`c${i}`, 0.7, i % 2),
    panel: [
      { taskId: "T2", method: "a", probability: 0.7 },
      { taskId: "T3", method: "b", probability: 0.7 },
    ],
  }));
  assert.ok(chooseExtremizeK(calibrated, DEFAULT_EXTREMIZE_K) <= 1.01, "harmful extremization converges to k=1");
});

test("chooseExtremizeK finds an interior optimum the old 0.25 grid could not", () => {
  // Panels at 60%, exactly 75% resolve YES. Brier-optimal extremized
  // probability is 0.75, i.e. odds 1.5^k = 3 → k* = ln3/ln1.5 ≈ 2.7095.
  const entries = Array.from({ length: 40 }, (_, i) => ({
    ...resolvedEntry(`i${i}`, 0.6, i % 4 === 0 ? 0 : 1),
    panel: [
      { taskId: "T2", method: "a", probability: 0.6 },
      { taskId: "T3", method: "b", probability: 0.6 },
    ],
  }));
  const k = chooseExtremizeK(entries, DEFAULT_EXTREMIZE_K);
  const kStar = Math.log(3) / Math.log(1.5);
  assert.ok(Math.abs(k - kStar) < 0.01, `expected ~${kStar.toFixed(4)}, got ${k}`);
  assert.equal(chooseExtremizeK(entries, DEFAULT_EXTREMIZE_K), k, "deterministic");
});

// ---------------------------------------------------------------- config plumbing

test("config: forecastPanelSize rounds and clamps; forecastExtremizeK keeps its fraction", () => {
  assert.equal(coerceConfigValue("forecastPanelSize", "7.6"), 8);
  assert.equal(coerceConfigValue("forecastPanelSize", "99"), 11);
  assert.equal(coerceConfigValue("forecastPanelSize", "1"), 3);
  assert.equal(coerceConfigValue("forecastExtremizeK", "2.5"), 2.5);
  assert.equal(coerceConfigValue("forecastExtremizeK", "9"), 4);
  assert.equal(coerceConfigValue("forecastExtremizeK", "0.1"), 1);
  assert.throws(() => coerceConfigValue("forecastExtremizeK", "abc"));
});

// ---------------------------------------------------------------- OLS trend projection

const { olsProject } = require("../../dist/datatools.js");

test("olsProject fits an exact line with a zero residual band", () => {
  // y = 2x + 1 with x in days from 2026-01-01
  const points = [
    { date: "2026-01-01", value: 1 },
    { date: "2026-01-02", value: 3 },
    { date: "2026-01-03", value: 5 },
    { date: "2026-01-04", value: 7 },
  ];
  const p = olsProject(points, "2026-01-11");
  assert.ok(p);
  near(p.slopePerDay, 2, 1e-9);
  near(p.projected, 21, 1e-9); // x=10 days → 2·10+1
  near(p.hi - p.lo, 0, 1e-9); // exact fit → no residual band
  assert.equal(p.daysAhead, 7);
});

test("olsProject refuses to fit what isn't a line", () => {
  assert.equal(olsProject([{ date: "2026-01-01", value: 1 }], "2026-02-01"), null);
  assert.equal(
    olsProject(
      [
        { date: "2026-01-01", value: 1 },
        { date: "2026-01-01", value: 5 },
      ],
      "2026-02-01"
    ),
    null,
    "zero time variance"
  );
  assert.equal(olsProject([{ date: "2026-01-01", value: 1 }, { date: "2026-01-02", value: 2 }], "not-a-date"), null);
});

test("olsProject interpolates noisy data with a real band", () => {
  const points = [
    { date: "2026-01-01", value: 10 },
    { date: "2026-01-02", value: 13 },
    { date: "2026-01-03", value: 13 },
    { date: "2026-01-04", value: 16 },
  ];
  const p = olsProject(points, "2026-01-08");
  assert.ok(p && p.slopePerDay > 0);
  assert.ok(p.hi > p.projected && p.lo < p.projected, "noisy fit carries a band");
});

// ---------------------------------------------------------------- market anchoring

test("blendWithMarket: w=0 keeps the panel, w=1 takes the market, blend is monotone", () => {
  near(blendWithMarket(0.6, 0.3, 0), 0.6, 1e-9);
  near(blendWithMarket(0.6, 0.3, 1), 0.3, 1e-9);
  near(blendWithMarket(0.7, 0.7, 0.5), 0.7, 1e-9); // agreement is a fixed point
  // 50/50 blend of even odds with 4:1 odds is 2:1 odds = 2/3
  near(blendWithMarket(0.5, 0.8, 0.5), 2 / 3, 1e-9);
  // monotone: more weight pulls strictly closer to the market
  let prev = blendWithMarket(0.8, 0.2, 0);
  for (let w = 0.1; w <= 1.001; w += 0.1) {
    const b = blendWithMarket(0.8, 0.2, w);
    assert.ok(b < prev, `w=${w} should pull toward the market`);
    prev = b;
  }
});

test("liquidityFactor: dead markets earn nothing, $100K earns full weight", () => {
  assert.equal(liquidityFactor(undefined), 0);
  assert.equal(liquidityFactor(0), 0);
  near(liquidityFactor(1000), Math.log10(1001) / 5, 1e-9);
  assert.equal(liquidityFactor(100_000), 1);
  assert.equal(liquidityFactor(50_000_000), 1); // capped
});

const anchoredEntry = (extremized, marketP, outcome, volume = 100_000) => ({
  v: 1,
  id: "x",
  runId: "r",
  t: 0,
  question: { ...QUESTION },
  aggregate: {
    probability: extremized,
    k: 2.5,
    n: 3,
    spread: 0.1,
    components: {
      extremized,
      market: { platform: "polymarket", url: "u", probability: marketP, volume, weight: 0.4 },
    },
  },
  panel: [],
  resolution: { v: 1, rec: "resolved", id: "x", t: 1, outcome, evidence: "", sources: [], resolvedBy: "operator" },
});

test("chooseMarketWeight falls back below the minimum sample", () => {
  const few = Array.from({ length: MIN_MARKET_WEIGHT_N - 1 }, () => anchoredEntry(0.5, 0.9, 1));
  assert.equal(chooseMarketWeight(few, DEFAULT_MARKET_WEIGHT), DEFAULT_MARKET_WEIGHT);
  assert.equal(chooseMarketWeight([], 0.3), 0.3);
});

test("chooseMarketWeight learns to trust a market that keeps being right", () => {
  // Panel stuck at 50%, market confidently right every time → full deference (w=1.0).
  const entries = Array.from({ length: 30 }, (_, i) => anchoredEntry(0.5, i % 2 ? 0.9 : 0.1, i % 2 ? 1 : 0));
  assert.equal(chooseMarketWeight(entries, DEFAULT_MARKET_WEIGHT), 1.0);
});

test("chooseMarketWeight learns to ignore a market that keeps being wrong", () => {
  // Panel confidently right, market confidently wrong → weight 0.
  const entries = Array.from({ length: 30 }, (_, i) =>
    anchoredEntry(i % 2 ? 0.85 : 0.15, i % 2 ? 0.1 : 0.9, i % 2 ? 1 : 0)
  );
  assert.equal(chooseMarketWeight(entries, DEFAULT_MARKET_WEIGHT), 0);
});

test("chooseMarketWeight ignores entries without anchor components", () => {
  const noComponents = Array.from({ length: 40 }, () => {
    const e = anchoredEntry(0.5, 0.9, 1);
    delete e.aggregate.components;
    return e;
  });
  assert.equal(chooseMarketWeight(noComponents, 0.4), 0.4);
});

// ---------------------------------------------------------------- weighted GMO + method weights

test("aggregateBinary: weights tilt the mean of log-odds; equal weights match unweighted", () => {
  const unweighted = aggregateBinary([0.6, 0.8], 1);
  const equal = aggregateBinary([0.6, 0.8], 1, [2, 2]);
  near(equal.probability, unweighted.probability, 1e-12);
  // weights [3,1] over log-odds [ln1.5, ln4] → (3·0.405465+1.386294)/4 = 0.650672 → p = 0.65715
  const tilted = aggregateBinary([0.6, 0.8], 1, [3, 1]);
  near(tilted.probability, 0.65715, 1e-4);
  // invalid weights are ignored, not an error
  near(aggregateBinary([0.6, 0.8], 1, [1]).probability, unweighted.probability, 1e-12);
  near(aggregateBinary([0.6, 0.8], 1, [1, 0]).probability, unweighted.probability, 1e-12);
  near(aggregateBinary([0.6, 0.8], 1, [1, NaN]).probability, unweighted.probability, 1e-12);
});

test("methodWeights: good methods earn weight, small samples stay at 1", () => {
  // outside-view nails it (brier ~0.04), trend coin-flips wrong (brier ~0.49)
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push({
      ...resolvedEntry(`g${i}`, 0.8, 1),
      panel: [
        { taskId: "T2", method: "outside-view", probability: 0.8 },
        { taskId: "T3", method: "trend", probability: 0.3 },
        { taskId: "T4", method: "fresh", probability: 0.5 }, // only seen here... n=12 ≥ MIN; use a sparse one below
      ],
    });
  }
  const w = methodWeights(entries);
  assert.ok(w["outside-view"] > 1, `good method should weigh >1, got ${w["outside-view"]}`);
  assert.ok(w["trend"] < 1, `bad method should weigh <1, got ${w["trend"]}`);
  assert.ok(w["outside-view"] < 3, "shrinkage keeps weights bounded");
  // a method below the per-method floor stays at exactly 1
  const sparse = entries.slice(0, MIN_METHOD_WEIGHT_N - 1);
  const w2 = methodWeights(sparse);
  assert.equal(w2["outside-view"], 1);
  assert.equal(w2["trend"], 1);
  assert.deepEqual(methodWeights([]), {});
});

// ---------------------------------------------------------------- recalibration

test("fitRecalibration is identity (null) below the minimum record", () => {
  const few = Array.from({ length: MIN_RECALIBRATION_N - 1 }, (_, i) => resolvedEntry(`r${i}`, 0.7, i % 2));
  assert.equal(fitRecalibration(few), null);
  assert.equal(applyRecalibration(0.7, null), 0.7);
});

test("fitRecalibration learns to deflate systematic overconfidence", () => {
  // The system keeps saying 75% YES but only half resolve YES.
  const entries = Array.from({ length: 60 }, (_, i) => resolvedEntry(`o${i}`, 0.75, i % 2));
  const r = fitRecalibration(entries);
  assert.ok(r, "enough history to fit");
  const recal = applyRecalibration(0.75, r);
  assert.ok(recal > 0.4 && recal < 0.6, `75% should map near 50%, got ${recal}`);
  // and the fit must actually beat identity on its own training data
  const lossAt = (p) => entries.reduce((s, e, i) => s + -logScore(p, i % 2), 0) / entries.length;
  assert.ok(lossAt(recal) < lossAt(0.75), "fitted mapping reduces mean log loss");
});

test("fitRecalibration can represent SEVERE overconfidence (a well below 0.5)", () => {
  // 90% forecasts resolving 50/50: the loss-optimal map sends every 90% to
  // ~50%, which on identical inputs needs a·logit(0.9)+b ≈ 0 — the
  // regularizer then prefers small |b|, pushing a far below the old 0.5 floor.
  const entries = Array.from({ length: 80 }, (_, i) => resolvedEntry(`sv${i}`, 0.9, i % 2));
  const r = fitRecalibration(entries);
  assert.ok(r, "enough history to fit");
  assert.ok(r.a < 0.5, `severe overconfidence needs a<0.5, got a=${r.a}`);
  const recal = applyRecalibration(0.9, r);
  assert.ok(recal > 0.4 && recal < 0.6, `90% should map near 50%, got ${recal}`);
});

test("fitRecalibration stays near identity when the record is already calibrated", () => {
  // 80% forecasts resolving YES 80% of the time: nothing to fix.
  const entries = Array.from({ length: 50 }, (_, i) => resolvedEntry(`c${i}`, 0.8, i % 5 === 0 ? 0 : 1));
  const r = fitRecalibration(entries);
  assert.ok(r);
  const recal = applyRecalibration(0.8, r);
  assert.ok(Math.abs(recal - 0.8) < 0.07, `calibrated record should barely move 80%, got ${recal}`);
});

test("fitRecalibration fits on PRE-recalibration components, not the final number", () => {
  // components.blended (0.9) is the honest input; probability (0.5) is what a
  // previous recalibration published. The fit must read 0.9.
  const entries = Array.from({ length: 50 }, (_, i) => ({
    ...resolvedEntry(`p${i}`, 0.5, 1),
    aggregate: {
      probability: 0.5,
      k: 2.5,
      n: 3,
      spread: 0,
      components: { extremized: 0.88, blended: 0.9, recalibrated: 0.5 },
    },
  }));
  const r = fitRecalibration(entries);
  assert.ok(r);
  // every outcome is YES and the pre-recal input was 0.9 → the fit should
  // push UP (a>1 or b>0), not correct an imaginary 0.5.
  assert.ok(applyRecalibration(0.9, r) >= 0.9, "fit read the pre-recalibration value");
});

// ---------------------------------------------------------------- decomposition gate + method labels

test("validateForecastAnalytics demands visible arithmetic from decomposition forecasts", () => {
  const decomp = {
    method: "decomposition",
    probability: 0.3,
    prior: 0.35,
    rationale: "P(committee) ≈ 60%, P(floor|committee) ≈ 50% → 30% overall (base rate 3 of 10).",
    baseRates: ["3/10 similar bills"],
    submittedAt: 1,
  };
  assert.equal(validateForecastAnalytics(decomp, "binary"), null);
  const opaque = validateForecastAnalytics(
    { ...decomp, rationale: "The chain of events makes 30% feel right overall." },
    "binary"
  );
  assert.ok(/sub-event probabilities/.test(opaque));
});

test("extractMethodLabel parses the spawn-time method assignment", () => {
  assert.equal(extractMethodLabel("Forecast the question. METHOD: outside-view"), "outside-view");
  assert.equal(extractMethodLabel("method: Decomposition\nmore text"), "decomposition");
  assert.equal(extractMethodLabel('Use METHOD = "skeptic" here'), "skeptic");
  assert.equal(extractMethodLabel("no label anywhere"), null);
});

test("canonicalMethodLabel strips revision decorations so revisions replace their originals", () => {
  const { canonicalMethodLabel } = require("../../dist/forecast.js");
  assert.equal(canonicalMethodLabel("trend (revised)"), "trend");
  assert.equal(canonicalMethodLabel("Trend (Rev 2)"), "trend");
  assert.equal(canonicalMethodLabel("outside-view (updated after red-team)"), "outside-view");
  assert.equal(canonicalMethodLabel("inside-view v2"), "inside-view");
  assert.equal(canonicalMethodLabel("market-anchored - revised"), "market-anchored");
  assert.equal(canonicalMethodLabel("decomposition: final"), "decomposition");
  // untouched labels pass through
  assert.equal(canonicalMethodLabel("inverted-framing"), "inverted-framing");
  assert.equal(canonicalMethodLabel("skeptic"), "skeptic");
  assert.equal(canonicalMethodLabel(""), "unspecified");
});

// ---------------------------------------------------------------- extended quantiles + pinball

test("monotoneQuantiles requires the p10/p50/p90 spine and repairs crossings", () => {
  assert.equal(monotoneQuantiles({ p10: 1, p50: 2 }), null);
  const fixed = monotoneQuantiles({ p10: 5, p50: 2, p90: 9 }); // crossed pair
  assert.deepEqual(fixed, { p10: 2, p50: 5, p90: 9 });
  const seven = monotoneQuantiles({ p5: 1, p10: 2, p25: 3, p50: 4, p75: 5, p90: 6, p95: 7 });
  assert.deepEqual(seven, { p5: 1, p10: 2, p25: 3, p50: 4, p75: 5, p90: 6, p95: 7 });
});

test("aggregateQuantiles aggregates optional quantiles only when every panelist gave them", () => {
  const a = aggregateQuantiles([
    { p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 },
    { p10: 12, p25: 16, p50: 24, p75: 30, p90: 40 },
  ]);
  assert.ok(a.quantiles.p25 !== undefined && a.quantiles.p75 !== undefined);
  const b = aggregateQuantiles([
    { p10: 10, p25: 15, p50: 20, p90: 30 },
    { p10: 12, p50: 24, p90: 40 }, // no p25 here
  ]);
  assert.equal(b.quantiles.p25, undefined, "a quantile half the panel skipped is not aggregated");
  assert.ok(b.quantiles.p10 !== undefined);
});

test("aggregateQuantiles switches to log space for heavily skewed positive panels", () => {
  const skewed = [
    { p10: 1, p50: 100, p90: 10000 },
    { p10: 2, p50: 50, p90: 8000 },
    { p10: 1, p50: 200, p90: 20000 },
  ];
  assert.ok(shouldUseLogSpace(skewed));
  const a = aggregateQuantiles(skewed);
  assert.equal(a.logSpace, true);
  // log-space mean of p50s = exp(mean(ln 100, ln 50, ln 200)) = 100
  near(a.quantiles.p50, 100, 1);
  // tight or negative panels stay linear
  assert.ok(!shouldUseLogSpace([{ p10: 90, p50: 100, p90: 110 }]));
  assert.ok(!shouldUseLogSpace([{ p10: -5, p50: 100, p90: 10000 }]));
  assert.equal(aggregateQuantiles([{ p10: 90, p50: 100, p90: 110 }]).logSpace, undefined);
});

test("pinballLoss: hand-computed values, zero at a point mass", () => {
  // value 20 against {p10:10, p50:20, p90:30}:
  // p10: 20≥10 → 0.1·10 = 1; p50: 0; p90: 20<30 → 0.1·10 = 1 → mean 2/3
  near(pinballLoss({ p10: 10, p50: 20, p90: 30 }, 20), 2 / 3, 1e-9);
  near(pinballLoss({ p10: 20, p50: 20, p90: 20 }, 20), 0, 1e-12);
  // a sharper correct interval scores better than a vague one
  const sharp = pinballLoss({ p10: 18, p50: 20, p90: 22 }, 20);
  const vague = pinballLoss({ p10: 0, p50: 20, p90: 40 }, 20);
  assert.ok(sharp < vague);
});

// ---------------------------------------------------------------- mc questions

test("normalizeOptionProbs tolerates percentages, fills gaps, renormalizes", () => {
  const opts = ["Alice", "Bob", "Other"];
  const p = normalizeOptionProbs({ alice: 60, Bob: 30, Other: 10 }, opts);
  near(p["Alice"], 0.6, 1e-2);
  near(p["Alice"] + p["Bob"] + p["Other"], 1, 1e-9);
  // a missing option gets a floor, never zero
  const partial = normalizeOptionProbs({ Alice: 0.9 }, opts);
  assert.ok(partial["Bob"] > 0 && partial["Other"] > 0);
  near(partial["Alice"] + partial["Bob"] + partial["Other"], 1, 1e-9);
  assert.equal(normalizeOptionProbs({ Zed: 1 }, opts), null, "nothing matched the option list");
  assert.equal(normalizeOptionProbs(null, opts), null);
});

test("aggregateMc: per-option GMO, extremized, renormalized to sum 1", () => {
  const opts = ["A", "B", "C"];
  const a = aggregateMc(
    [
      { A: 0.6, B: 0.3, C: 0.1 },
      { A: 0.7, B: 0.2, C: 0.1 },
      { A: 0.5, B: 0.4, C: 0.1 },
    ],
    opts,
    2.5
  );
  const sum = opts.reduce((s, o) => s + a.optionProbs[o], 0);
  near(sum, 1, 1e-9);
  assert.ok(a.optionProbs["A"] > 0.6, "extremization sharpens the consensus mode");
  assert.ok(a.optionProbs["A"] > a.optionProbs["B"] && a.optionProbs["B"] > a.optionProbs["C"]);
  // permutation symmetry
  const b = aggregateMc(
    [
      { C: 0.1, A: 0.6, B: 0.3 },
      { B: 0.2, C: 0.1, A: 0.7 },
      { A: 0.5, C: 0.1, B: 0.4 },
    ],
    opts,
    2.5
  );
  near(a.optionProbs["A"], b.optionProbs["A"], 1e-12);
  // single panelist passes through un-extremized (k=1) and renormalized
  const single = aggregateMc([{ A: 0.6, B: 0.3, C: 0.1 }], opts, 2.5);
  assert.equal(single.k, 1);
  near(single.optionProbs["A"], 0.6, 1e-2);
});

test("mc scoring: multiclass Brier and log score", () => {
  const probs = { A: 0.6, B: 0.3, C: 0.1 };
  // realized A: (0.6−1)² + 0.3² + 0.1² = 0.16+0.09+0.01 = 0.26
  near(mcBrierScore(probs, "A"), 0.26, 1e-9);
  near(mcLogScore(probs, "A"), Math.log(0.6), 1e-9);
  near(mcLogScore(probs, "C"), Math.log(0.1), 1e-9);
});

test("parseQuestionJson accepts mc with a usable option list and date kinds", () => {
  const mc = parseQuestionJson(
    '{"text":"Who wins?","kind":"mc","resolutionCriteria":"per official result","resolutionDate":"2026-11-03","options":["Alice","Bob","Other"]}'
  );
  assert.equal(mc.kind, "mc");
  assert.deepEqual(mc.options, ["Alice", "Bob", "Other"]);
  // an mc question without 2+ options is unusable
  assert.equal(
    parseQuestionJson('{"text":"Who?","kind":"mc","resolutionCriteria":"c","resolutionDate":"2026-01-01","options":["Only"]}'),
    null
  );
  const date = parseQuestionJson(
    '{"text":"When will X launch?","kind":"date","resolutionCriteria":"first official launch","resolutionDate":"2027-12-31"}'
  );
  assert.equal(date.kind, "date");
});

// ---------------------------------------------------------------- date helpers + scoring

test("isoToDays/daysToIso round-trip and reject garbage", () => {
  assert.equal(daysToIso(isoToDays("2026-06-15")), "2026-06-15");
  assert.equal(isoToDays("not a date"), null);
  assert.ok(isoToDays("2026-06-16") - isoToDays("2026-06-15") === 1);
});

test("resolveLedgerEntry scores mc, date, and pinball outcomes", () => {
  clearLedger();
  appendLedger(
    createdRec("f_mc", {
      question: { ...QUESTION, kind: "mc", options: ["A", "B"] },
      aggregate: { optionProbs: { A: 0.7, B: 0.3 }, k: 2.5, n: 3, spread: 0.1 },
      panel: [{ taskId: "T2", method: "outside-view", optionProbs: { A: 0.7, B: 0.3 } }],
    })
  );
  const d10 = isoToDays("2026-01-10");
  appendLedger(
    createdRec("f_date", {
      question: { ...QUESTION, kind: "date" },
      aggregate: { quantiles: { p10: d10, p50: d10 + 10, p90: d10 + 30 }, pNever: 0.2, k: 2.5, n: 3, spread: 0.1 },
      panel: [{ taskId: "T2", method: "trend", quantiles: { p10: d10, p50: d10 + 10, p90: d10 + 30 } }],
    })
  );
  appendLedger(
    createdRec("f_num5", {
      question: { ...QUESTION, kind: "numeric" },
      aggregate: aggregateQuantiles([{ p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 }]),
      panel: [{ taskId: "T2", method: "trend", quantiles: { p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 } }],
    })
  );
  const entries = loadLedger();

  const recMc = resolveLedgerEntry(entries.find((e) => e.id === "f_mc"), "A", { evidence: "", sources: [], resolvedBy: "operator" });
  near(recMc.brier, mcBrierScore({ A: 0.7, B: 0.3 }, "A"), 1e-12);
  near(recMc.logScore, Math.log(0.7), 1e-9);

  const realized = d10 + 12;
  const recDate = resolveLedgerEntry(entries.find((e) => e.id === "f_date"), realized, { evidence: "", sources: [], resolvedBy: "operator" });
  near(recDate.pinball, pinballLoss({ p10: d10, p50: d10 + 10, p90: d10 + 30 }, realized), 1e-12);
  near(recDate.logScore, Math.log(0.8), 1e-9, "the never-mass is scored when the event happened");

  const recNum = resolveLedgerEntry(entries.find((e) => e.id === "f_num5"), 22, { evidence: "", sources: [], resolvedBy: "operator" });
  assert.ok(recNum.pinball !== undefined && recNum.intervalScore !== undefined);

  // a date question that never happened scores the never-mass directly
  clearLedger();
  appendLedger(
    createdRec("f_never", {
      question: { ...QUESTION, kind: "date" },
      aggregate: { quantiles: { p10: d10, p50: d10 + 10, p90: d10 + 30 }, pNever: 0.2, k: 2.5, n: 3, spread: 0.1 },
      panel: [],
    })
  );
  const recNever = resolveLedgerEntry(loadLedger()[0], "never", { evidence: "", sources: [], resolvedBy: "operator" });
  near(recNever.logScore, Math.log(0.2), 1e-9);
});

test("calibrationStats keeps mc options in their own reliability bins", () => {
  const mcEntry = {
    id: "mc1",
    runId: "r",
    t: 1,
    question: { ...QUESTION, kind: "mc", options: ["A", "B"] },
    aggregate: { optionProbs: { A: 0.75, B: 0.25 }, k: 2.5, n: 3, spread: 0.1 },
    panel: [],
    resolution: { v: 1, rec: "resolved", id: "mc1", t: 2, outcome: "A", evidence: "", sources: [], resolvedBy: "swarm" },
  };
  const stats = calibrationStats([mcEntry]);
  assert.equal(stats.n, 0, "mc entries don't inflate the binary count");
  assert.equal(stats.bins.length, 0, "mc options stay out of the BINARY bins — different base rate");
  const hi = stats.mcBins.find((b) => b.lo === 0.7);
  assert.ok(hi && hi.n === 1 && hi.hitRate === 1, "the realized option lands in its mc bin as a hit");
  const lo = stats.mcBins.find((b) => b.lo === 0.2);
  assert.ok(lo && lo.n === 1 && lo.hitRate === 0, "the losing option lands as a miss");
});

// ---------------------------------------------------------------- backtest

test("backtest is deterministic and ranks strategies sanely", () => {
  const { backtest } = require("../../dist/forecast.js");
  // 60 resolved binaries: the panel says 60% when YES, 40% when NO — mildly
  // informative, so extremization should help (the panel underclaims).
  const entries = Array.from({ length: 60 }, (_, i) => {
    const yes = i % 2 === 1;
    const p = yes ? 0.6 : 0.4;
    return {
      ...resolvedEntry(`b${i}`, p, yes ? 1 : 0),
      evidenceOverlap: 0,
      panel: [
        { taskId: "T2", method: "a", probability: p },
        { taskId: "T3", method: "b", probability: p + (yes ? 0.05 : -0.05) },
      ],
    };
  });
  const r1 = backtest(entries);
  const r2 = backtest(entries);
  assert.deepEqual(r1, r2, "same ledger must produce identical numbers (seeded bootstrap)");
  assert.ok(r1.rows.length >= 5);
  for (const row of r1.rows) {
    assert.equal(row.n, 60);
    assert.ok(row.brierLo <= row.brierMean && row.brierMean <= row.brierHi, "CI brackets the mean");
  }
  const byName = Object.fromEntries(r1.rows.map((r) => [r.config, r]));
  const k1 = byName["panel GMO, no extremization (k=1)"];
  const adaptive = r1.rows.find((r) => /adaptive-k/.test(r.config));
  assert.ok(adaptive.brierMean <= k1.brierMean + 1e-9, "an informative panel benefits from (out-of-fold) extremization");
});

test("backtest reports the vs-market line on tournament entries", () => {
  const { backtest } = require("../../dist/forecast.js");
  const entries = Array.from({ length: 20 }, (_, i) => {
    const yes = i % 2 === 1;
    return {
      ...resolvedEntry(`t${i}`, yes ? 0.8 : 0.2, yes ? 1 : 0),
      panel: [{ taskId: "T2", method: "a", probability: yes ? 0.8 : 0.2 }],
      origin: {
        kind: "tournament",
        platform: "manifold",
        externalId: `m${i}`,
        url: "u",
        marketProbAtCreate: yes ? 0.6 : 0.4, // market less sharp than the swarm here
      },
    };
  });
  const r = backtest(entries);
  assert.ok(r.vsMarket && r.vsMarket.n === 20);
  assert.ok(r.vsMarket.swarmBrier < r.vsMarket.marketBrier, "the sharper-and-right swarm beats the market");
});

test("backtest degrades to empty on a ledger with nothing replayable", () => {
  const { backtest } = require("../../dist/forecast.js");
  assert.deepEqual(backtest([]).rows, []);
  const numericOnly = [
    {
      ...resolvedEntry("n1", 0.5, 1),
      question: { ...QUESTION, kind: "numeric" },
    },
  ];
  const r = backtest(numericOnly);
  assert.equal(r.rows.length, 0);
  assert.equal(r.skipped.nonBinary, 1);
});

// ---------------------------------------------------------------- supersede chains

test("supersede chains: ids carry through the ledger and mark the stale link", () => {
  const { supersededIds } = require("../../dist/forecast.js");
  clearLedger();
  appendLedger(createdRec("f_old"));
  appendLedger(createdRec("f_new", { supersedes: "f_old" }));
  const entries = loadLedger();
  assert.equal(entries.find((e) => e.id === "f_new").supersedes, "f_old");
  const superseded = supersededIds(entries);
  assert.ok(superseded.has("f_old") && !superseded.has("f_new"));
});

// ---------------------------------------------------------------- bootstrap CI

test("bootstrapCi uses the exact percentile indices of the sorted bootstrap means", () => {
  const { bootstrapCi } = require("../../dist/forecast.js");
  const values = Array.from({ length: 50 }, (_, i) => i / 49); // mean 0.5, real spread
  const ci = bootstrapCi(values);
  const ci2 = bootstrapCi(values);
  assert.deepEqual(ci, ci2, "seeded → deterministic");
  assert.ok(ci.lo < 0.5 && 0.5 < ci.hi, "CI brackets the true mean");
  // The 95% CI of a mean over 50 uniform values is tight — both ends well inside the data range.
  assert.ok(ci.lo > 0.3 && ci.hi < 0.7);
  // Degenerate input degrades, never throws.
  assert.deepEqual(bootstrapCi([0.4]), { lo: 0.4, hi: 0.4 });
  assert.deepEqual(bootstrapCi([]), { lo: 0, hi: 0 });
});

test.after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

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
  clampMarketProb,
  trimmedMean,
  aggregateBinary,
  aggregateQuantiles,
  brierScore,
  logScore,
  intervalScore,
  parseQuestionJson,
  parseForecastPlan,
  clampHorizon,
  isTimingMission,
  extractQuestionRef,
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
  chooseExtremizeKMc,
  chooseSimulationWeight,
  preSimBinaryHeadline,
  MIN_SIM_WEIGHT_N,
  backtest,
  backtestMc,
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
  applyQuantileDilation,
  applyAsymmetricDilation,
  fitQuantileCalibration,
  fitIntervalCalibration,
  backtestNumeric,
  MIN_CALIBRATION_N,
  MIN_ADAPTIVE_N,
  MIN_MARKET_WEIGHT_N,
  MIN_METHOD_WEIGHT_N,
  MIN_RECALIBRATION_N,
  MIN_QCAL_N,
  DEFAULT_EXTREMIZE_K,
  DEFAULT_MARKET_WEIGHT,
  DEFAULT_QUANTILE_DILATION,
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

test("aggregateQuantiles (LOP): median location is the robust center, width is monotone, spread is relative", () => {
  const a = aggregateQuantiles([
    { p10: 10, p50: 20, p90: 30 },
    { p10: 12, p50: 24, p90: 40 },
    { p10: 8, p50: 16, p90: 28 },
  ]);
  assert.equal(a.n, 3);
  // The pool is recentered on the robust median of p50s (median of 20/24/16 = 20).
  near(a.quantiles.p50, 20, 1e-9);
  assert.ok(a.quantiles.p10 <= a.quantiles.p50 && a.quantiles.p50 <= a.quantiles.p90);
  // The pool captures between-forecaster disagreement: the band is at least as
  // wide as the Vincentized one (which would be exactly 10..30).
  const v = aggregateQuantiles(
    [
      { p10: 10, p50: 20, p90: 30 },
      { p10: 12, p50: 24, p90: 40 },
      { p10: 8, p50: 16, p90: 28 },
    ],
    DEFAULT_EXTREMIZE_K,
    { combine: "vincent" }
  );
  assert.ok(a.quantiles.p90 - a.quantiles.p10 >= v.quantiles.p90 - v.quantiles.p10 - 1e-9);
  near(a.spread, (24 - 16) / 20, 1e-9); // spread is still the raw relative p50 disagreement
});

test("aggregateQuantiles: one wild panelist cannot drag the center (winsorize + recenter)", () => {
  const a = aggregateQuantiles([
    { p10: 10, p50: 20, p90: 30 },
    { p10: 11, p50: 21, p90: 31 },
    { p10: 100, p50: 200, p90: 300 },
  ]);
  // Recentering pins p50 to the robust median of p50s (median of 20/21/200 = 21);
  // a CDF mixture without robustification would be dragged far above.
  near(a.quantiles.p50, 21, 1e-9, "robust median holds the center; raw pooling would say ~80+");
  assert.ok(a.quantiles.p90 < 100, "winsorization keeps the rogue's 300 from blowing out the upper tail");
});

test("aggregateQuantiles (LOP): an agreeing panel barely widens vs Vincent; disagreement widens more", () => {
  const tight = [
    { p10: 18, p50: 20, p90: 22 },
    { p10: 18, p50: 20, p90: 22 },
    { p10: 19, p50: 20, p90: 21 },
  ];
  const loose = [
    { p10: 5, p50: 20, p90: 35 },
    { p10: 18, p50: 20, p90: 22 },
    { p10: 30, p50: 40, p90: 50 },
  ];
  const wTight = (() => {
    const a = aggregateQuantiles(tight);
    return a.quantiles.p90 - a.quantiles.p10;
  })();
  const wLoose = (() => {
    const a = aggregateQuantiles(loose);
    return a.quantiles.p90 - a.quantiles.p10;
  })();
  assert.ok(wLoose > wTight, "a disagreeing panel produces a genuinely wider band");
});

test("aggregateQuantiles (LOP): a panel of one passes through unchanged", () => {
  const a = aggregateQuantiles([{ p10: 10, p50: 20, p90: 30 }]);
  near(a.quantiles.p10, 10, 1e-9);
  near(a.quantiles.p50, 20, 1e-9);
  near(a.quantiles.p90, 30, 1e-9);
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
  // same-domain partial overlap: 0.7·urlJaccard(1/3) + 0.3·domainJaccard(1) —
  // two panelists reading the same outlet share sourcing beyond exact URLs
  near(
    evidenceOverlap([["https://x.com/1", "https://x.com/2"], ["https://x.com/2", "https://x.com/3"]]),
    0.7 * (1 / 3) + 0.3,
    1e-9
  );
  // cross-domain partial overlap stays lower than same-domain at equal URL overlap
  const cross = evidenceOverlap([["https://x.com/1", "https://a.com/2"], ["https://a.com/2", "https://y.com/3"]]);
  near(cross, 0.7 * (1 / 3) + 0.3 * (1 / 3), 1e-9);
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

test("ledger: an 'updated' patch merges the sim-augmented aggregate onto the base entry", () => {
  clearLedger();
  const base = createdRec("f_sim");
  appendLedger(base); // durable base record, pre-simulation (no sim fields)
  // The simulation stage appends an 'updated' patch keyed to the same id.
  const patched = {
    ...base.aggregate,
    components: { ...(base.aggregate.components ?? {}), simulated: 0.42, simBlendWeight: 0 },
  };
  appendLedger({ v: 1, rec: "updated", id: "f_sim", t: Date.now() + 1, aggregate: patched, simulationRan: true });

  const entries = loadLedger();
  // Still exactly ONE entry (no double-count from a second 'created').
  assert.equal(entries.filter((e) => e.id === "f_sim").length, 1);
  const e = entries.find((x) => x.id === "f_sim");
  assert.equal(e.simulationRan, true);
  assert.equal(e.aggregate.components.simulated, 0.42);
  // An 'updated' for an unknown id is ignored, never crashes.
  appendLedger({ v: 1, rec: "updated", id: "f_ghost", t: Date.now(), aggregate: patched, simulationRan: true });
  assert.equal(loadLedger().some((x) => x.id === "f_ghost"), false);
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

test("calibrationStats drops non-finite probabilities instead of laundering them to a 0.5 coin-flip", () => {
  // A corrupt headline (NaN/Infinity from a partial write, crash, or hand edit)
  // must NOT be scored — clampProb maps it to 0.5, which would silently bias the
  // Brier mean and every parameter fit on the record. Same family as the
  // binary-NO poisoning guard.
  const entries = [
    resolvedEntry("a", 0.7, 1),
    resolvedEntry("b", NaN, 0),
    resolvedEntry("c", Infinity, 1),
  ];
  const stats = calibrationStats(entries);
  assert.equal(stats.n, 1, "only the finite forecast is scoreable");
  assert.equal(stats.byMethod["outside-view"].n, 1, "the non-finite panelists are dropped too");
  // chooseExtremizeK and fitRecalibration read the same path — neither should
  // see the corrupt rows.
  assert.equal(fitRecalibration(entries), null, "well below MIN, but proves the path doesn't throw on NaN");
});

test("resolveLedgerEntry writes no score for a non-finite headline (no 0.5 laundering)", () => {
  clearLedger();
  const entry = {
    id: "f_nan", runId: "r", t: 1,
    question: { ...QUESTION },
    aggregate: { probability: NaN, k: 2.5, n: 1, spread: 0 },
    panel: [],
  };
  const rec = resolveLedgerEntry(entry, 1, { evidence: "", sources: [], resolvedBy: "operator" });
  assert.equal(rec.brier, undefined, "a corrupt headline scores nothing");
  assert.equal(rec.logScore, undefined);
  assert.equal(rec.outcome, 1, "but the resolution itself is still recorded");
});

test("resolveLedgerEntry canonicalizes a case/space-variant mc outcome and scores it", () => {
  clearLedger();
  const entry = {
    id: "f_mc", runId: "r", t: 1,
    question: { ...QUESTION, kind: "mc", options: ["Labour", "Conservative", "Reform"] },
    aggregate: { optionProbs: { Labour: 0.5, Conservative: 0.3, Reform: 0.2 }, n: 1, spread: 0 },
    panel: [],
  };
  const rec = resolveLedgerEntry(entry, "  conservative ", { evidence: "", sources: [], resolvedBy: "operator" });
  assert.equal(rec.outcome, "Conservative", "stored as the exact option spelling, not the operator's casing");
  assert.ok(typeof rec.brier === "number", "scored, not silently dropped as a non-match");
  assert.ok(typeof rec.logScore === "number");
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

test("olsProject returns null for 2 points — no zero-width band paraded as 80%", () => {
  // Two points fit a line exactly; residual variance is undefined (df=0), so the
  // old code emitted a zero-width "80% band" — false certainty. Null is honest.
  assert.equal(
    olsProject([{ date: "2026-01-01", value: 10 }, { date: "2026-01-08", value: 20 }], "2026-02-01"),
    null
  );
});

test("olsProject inflates the band for autocorrelated residuals beyond the i.i.d. fit", () => {
  const points = [
    { date: "2026-01-01", value: 0 },
    { date: "2026-01-02", value: 1 },
    { date: "2026-01-03", value: 8 },
    { date: "2026-01-04", value: 9 },
    { date: "2026-01-05", value: 4 },
    { date: "2026-01-06", value: 5 },
  ];
  const p = olsProject(points, "2026-01-12");
  // Faithfully recompute the i.i.d. band the old code produced and prove the
  // AR(1) inflation made the actual band materially wider.
  const x = [0, 1, 2, 3, 4, 5];
  const y = points.map((q) => q.value);
  const n = 6;
  const mx = 2.5;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const resid = y.map((v, i) => v - (intercept + slope * x[i]));
  const ssr = resid.reduce((s, r) => s + r * r, 0);
  const sigmaIid = Math.sqrt(ssr / (n - 2));
  let r1 = 0;
  for (let i = 1; i < n; i++) r1 += resid[i] * resid[i - 1];
  const rho = Math.max(0, Math.min(0.9, r1 / ssr));
  assert.ok(rho > 0, "the test series is positively autocorrelated");
  const xT = (Date.parse("2026-01-12") - Date.parse("2026-01-01")) / 86_400_000;
  const tMul = 1.533; // tQuantile90(df=4)
  const iidHalf = tMul * sigmaIid * Math.sqrt(1 + 1 / n + ((xT - mx) ** 2) / sxx);
  const actualHalf = (p.hi - p.lo) / 2;
  assert.ok(actualHalf > iidHalf * 1.05, `AR(1) inflation widens the band: ${actualHalf} vs i.i.d. ${iidHalf}`);
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

test("clampMarketProb keeps near-boundary market information the panel clamp discards", () => {
  near(clampMarketProb(0.995), 0.995, 1e-12);
  near(clampMarketProb(0.999), 0.995, 1e-12); // still bounded off 1 for a finite logit
  near(clampMarketProb(0.001), 0.005, 1e-12);
  assert.equal(clampMarketProb(NaN), 0.5);
  // The panel clamp would crush a 99.5% real-money market to 0.99; this does not.
  assert.ok(clampMarketProb(0.995) > clampProb(0.995));
});

test("blendWithMarket preserves a confident market's information at partial weight", () => {
  // At w=0.75 the result stays under the 0.99 output cap, so the looser market
  // clamp is visible: the blend lands strictly above what the old 0.99-clamped
  // market price would have produced.
  const b = blendWithMarket(0.9, 0.995, 0.75);
  assert.ok(b > 0.985 && b < 0.99, `confident market pulls the blend up, got ${b}`);
  const logit = (p) => Math.log(p / (1 - p));
  const oldClamped = Math.min(0.99, Math.max(0.01, 0.995)); // the old clampProb path → 0.99
  const odds = Math.exp(0.25 * logit(0.9) + 0.75 * logit(oldClamped));
  const oldBlend = odds / (1 + odds);
  assert.ok(b > oldBlend, `new blend ${b} should exceed the old 0.99-clamped blend ${oldBlend}`);
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

test("extractQuestionRef parses the sub-forecast id assignment", () => {
  assert.equal(extractQuestionRef("QUESTION: sf2\nMETHOD: trend"), "sf2");
  assert.equal(extractQuestionRef('question = "SF10" here'), "sf10");
  assert.equal(extractQuestionRef("METHOD: trend (no question tag)"), null);
});

test("clampHorizon: operator date wins; missing/past → fallback; far future capped", () => {
  const today = "2026-06-13";
  // operator date always wins, even if the model offered something else
  assert.equal(clampHorizon("2027-01-01", "2026-09-01", today), "2026-09-01");
  // missing/garbage → today + 90d
  assert.equal(clampHorizon("", undefined, today), "2026-09-11");
  assert.equal(clampHorizon("not-a-date", undefined, today), "2026-09-11");
  // a past date with no operator date is pushed out to the fallback
  assert.equal(clampHorizon("2020-01-01", undefined, today), "2026-09-11");
  // a sane future date is kept
  assert.equal(clampHorizon("2026-12-31", undefined, today), "2026-12-31");
  // absurdly far future is capped to ~5 years
  assert.equal(clampHorizon("2099-01-01", undefined, today), "2031-06-12");
});

test("isTimingMission: a 'when will X' mission is timing; a 'which/will' one is not", () => {
  // The reported failure: a "when will it be restored" mission must read as timing
  // so the engine forces a date forecast instead of a "which party" mc swap.
  assert.equal(isTimingMission("the US government just shut down Fable 5 access. When will it be restored to the public?"), true);
  assert.equal(isTimingMission("When will the Fed cut rates?"), true);
  assert.equal(isTimingMission("By when will SpaceX land humans on Mars?"), true);
  assert.equal(isTimingMission("How long until GPT-6 ships?"), true);
  assert.equal(isTimingMission("How soon before the strike ends?"), true);
  assert.equal(isTimingMission("when is the next recession"), true);
  // Not timing — these ask a different quantity and must keep their own kind.
  assert.equal(isTimingMission("Which party will win the 2028 election?"), false);
  assert.equal(isTimingMission("Will the Fed cut rates by September 2026?"), false);
  assert.equal(isTimingMission("How much will Bitcoin be worth at year end?"), false);
  // "when" as a subordinating conjunction (not an interrogative) must not trip it
  assert.equal(isTimingMission("What happens to stocks when the Fed cuts rates?"), false);
});

test("parseForecastPlan: multi-question decomposition with stable ids", () => {
  const raw = JSON.stringify({
    brief: "Outlook for US housing in 2026.",
    questions: [
      { text: "Will 30y mortgage rate fall below 6% in 2026?", kind: "binary", resolutionCriteria: "Freddie Mac PMMS weekly avg < 6.0% any week in 2026.", resolutionDate: "2026-12-31" },
      { text: "US median existing-home price YoY % change at year-end 2026?", kind: "numeric", unit: "%", resolutionCriteria: "NAR December 2026 YoY.", resolutionDate: "2027-01-20" },
    ],
  });
  const plan = parseForecastPlan(raw, undefined, "2026-06-13", 6);
  assert.ok(plan);
  assert.equal(plan.brief, "Outlook for US housing in 2026.");
  assert.equal(plan.questions.length, 2);
  assert.deepEqual(plan.questions.map((q) => q.id), ["sf1", "sf2"]);
  assert.equal(plan.questions[0].kind, "binary");
  assert.equal(plan.questions[1].unit, "%");
});

test("parseForecastPlan: a clean single question yields a one-element plan", () => {
  const raw = JSON.stringify({
    brief: "",
    questions: [{ text: "Will the Fed cut by 2026-09-01?", kind: "binary", resolutionCriteria: "FOMC statement.", resolutionDate: "2026-09-01" }],
  });
  const plan = parseForecastPlan(raw, undefined, "2026-06-13");
  assert.equal(plan.questions.length, 1);
  assert.equal(plan.questions[0].id, "sf1");
});

test("parseForecastPlan: operator date overrides every sub-question; bad dates are clamped, not dropped", () => {
  const raw = JSON.stringify({
    questions: [
      { text: "A?", kind: "binary", resolutionCriteria: "x", resolutionDate: "2099-01-01" },
      { text: "B?", kind: "binary", resolutionCriteria: "y", resolutionDate: "garbage" },
    ],
  });
  const plan = parseForecastPlan(raw, "2026-10-01", "2026-06-13");
  assert.equal(plan.questions.length, 2, "neither sub-question is dropped on a bad date");
  assert.ok(plan.questions.every((q) => q.resolutionDate === "2026-10-01"), "operator date wins everywhere");
});

test("parseForecastPlan: caps at maxN and tolerates a bare single-object reply", () => {
  const many = JSON.stringify({ questions: Array.from({ length: 9 }, (_, i) => ({ text: `Q${i}?`, kind: "binary", resolutionCriteria: "c", resolutionDate: "2026-12-31" })) });
  assert.equal(parseForecastPlan(many, undefined, "2026-06-13", 6).questions.length, 6);
  const bare = JSON.stringify({ text: "Will X?", kind: "binary", resolutionCriteria: "c", resolutionDate: "2026-12-31" });
  const plan = parseForecastPlan(bare, undefined, "2026-06-13");
  assert.equal(plan.questions.length, 1);
  // nothing parseable → null (caller falls back to single-question sharpening)
  assert.equal(parseForecastPlan("not json", undefined, "2026-06-13"), null);
  assert.equal(parseForecastPlan(JSON.stringify({ questions: [{ text: "" }] }), undefined, "2026-06-13"), null);
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

test("applyQuantileDilation widens around p50, is identity at d=1, stays monotone, log-space proportional", () => {
  const q = { p10: 10, p50: 20, p90: 30 };
  const wide = applyQuantileDilation(q, 2, false);
  near(wide.p50, 20, 1e-9); // center fixed
  near(wide.p10, 0, 1e-9); // 20 + 2·(10−20)
  near(wide.p90, 40, 1e-9); // 20 + 2·(30−20)
  assert.deepEqual(applyQuantileDilation(q, 1, false), { p10: 10, p50: 20, p90: 30 });
  // monotonicity preserved across the full spine for any d>0
  const w = applyQuantileDilation({ p5: 5, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30, p95: 35 }, 1.5, false);
  assert.ok(w.p5 <= w.p10 && w.p10 <= w.p25 && w.p25 <= w.p50 && w.p50 <= w.p90 && w.p90 <= w.p95);
  // log space: the stretch is multiplicative around p50, so ratios square at d=2
  const lg = applyQuantileDilation({ p10: 50, p50: 100, p90: 200 }, 2, true);
  near(lg.p50, 100, 1e-9);
  near(lg.p90, 400, 1e-6); // (200/100)² · 100
  near(lg.p10, 25, 1e-6); // (50/100)² · 100
});

test("applyQuantileDilation is EXACTLY the symmetric case of applyAsymmetricDilation (one shared kernel)", () => {
  // The symmetric function now delegates to the asymmetric one; this locks the
  // equivalence so the log/linear stretch kernel can never drift between them.
  const shapes = [
    { p10: 10, p50: 20, p90: 30 },
    { p5: 5, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30, p95: 35 },
    { p10: 50, p50: 100, p90: 200 },
  ];
  for (const q of shapes) {
    for (const d of [0.6, 1, 1.5, 2.4]) {
      for (const ls of [false, true]) {
        assert.deepEqual(applyQuantileDilation(q, d, ls), applyAsymmetricDilation(q, d, d, ls), `d=${d} logSpace=${ls}`);
      }
    }
  }
});

test("preSimBinaryHeadline reads superseded-first, then the recalibration chain (one source for fit + serve)", () => {
  // H2 supersede value wins over everything below it.
  near(preSimBinaryHeadline({ extremized: 0.5, recalibrated: 0.6, superseded: 0.9 }, 0.5), 0.9, 1e-12);
  near(preSimBinaryHeadline({ extremized: 0.5, blended: 0.55, recalibrated: 0.6 }, 0.5), 0.6, 1e-12);
  near(preSimBinaryHeadline({ extremized: 0.5, blended: 0.55 }, 0.5), 0.55, 1e-12);
  near(preSimBinaryHeadline({ extremized: 0.5 }, 0.3), 0.5, 1e-12);
  // empty / undefined components → fallback
  near(preSimBinaryHeadline(undefined, 0.42), 0.42, 1e-12);
  near(preSimBinaryHeadline({}, 0.42), 0.42, 1e-12);
});

test("chooseSimulationWeight(binary) reads the post-supersede headline as the pre-sim value (H2)", () => {
  // 30 resolved YES binaries. The simulation (0.7) is BETTER than the panel
  // (extremized 0.5) but WORSE than the post-supersede headline (0.9). So:
  //  · superseded present → pre=0.9, blending toward 0.7 only hurts → w stays 0.
  //  · superseded absent  → pre=0.5, blending toward 0.7 helps      → w > 0.
  // A fit that ignored `superseded` (read extremized) would pick w>0 in BOTH.
  const mk = (withSuperseded) =>
    Array.from({ length: MIN_SIM_WEIGHT_N }, (_, i) => ({
      v: 1,
      id: `s${i}`,
      runId: "r",
      t: i,
      question: { ...QUESTION, kind: "binary" },
      aggregate: {
        probability: 0.7,
        k: 2.5,
        n: 3,
        spread: 0.1,
        components: { extremized: 0.5, simulated: 0.7, ...(withSuperseded ? { superseded: 0.9 } : {}) },
      },
      panel: [],
      resolution: { v: 1, rec: "resolved", id: `s${i}`, t: i + 1, outcome: 1, evidence: "", sources: [], resolvedBy: "operator" },
    }));
  const wWith = chooseSimulationWeight(mk(true), "binary", 0);
  const wWithout = chooseSimulationWeight(mk(false), "binary", 0);
  assert.equal(wWith, 0, "a strong post-supersede headline shouldn't be dragged toward a weaker sim");
  assert.ok(wWithout > 0, "without the supersede update, the weaker panel benefits from the sim");
});

test("chooseSimulationWeight(numeric) learns from previously-blended entries via the pre-sim snapshot (non-circular)", () => {
  // Entries that were already sim-blended (simBlendWeight set) used to be dropped
  // wholesale; now they feed the fit through components.preSimQuantiles (the
  // honest pre-blend value), exactly like the binary path. Outcome ≈ 100; the
  // pre-sim band sits far below it and the sim is centered on it, so the fit
  // should learn w>0 — but ONLY because the snapshot lets it read a pre-sim value.
  const mk = (withSnapshot) =>
    Array.from({ length: MIN_SIM_WEIGHT_N }, (_, i) => ({
      v: 1,
      id: `n${i}`,
      runId: "r",
      t: i,
      question: { ...QUESTION, kind: "numeric" },
      aggregate: {
        quantiles: { p10: 95, p50: 100, p90: 105 }, // post-blend headline (already moved toward sim)
        k: 2.5,
        n: 3,
        spread: 0.1,
        components: {
          simulatedQ: { p10: 95, p50: 100, p90: 105 },
          simBlendWeight: 0.2, // marks the entry as ALREADY blended
          ...(withSnapshot ? { preSimQuantiles: { p10: 5, p50: 10, p90: 15 } } : {}),
        },
      },
      panel: [],
      resolution: { v: 1, rec: "resolved", id: `n${i}`, t: i + 1, outcome: 100 + (i % 5), evidence: "", sources: [], resolvedBy: "operator" },
    }));
  const wSnapshot = chooseSimulationWeight(mk(true), "numeric", 0);
  const wNone = chooseSimulationWeight(mk(false), "numeric", 0);
  assert.ok(wSnapshot > 0, "with the pre-sim snapshot the blended entries are usable and the sim earns weight");
  assert.equal(wNone, 0, "without a snapshot, already-blended entries stay excluded (avoids the circular fit)");
});

test("fitQuantileCalibration widens systematically over-narrow intervals, falls back below MIN, doesn't widen well-covered ones", () => {
  const mk = (outcome) => ({
    v: 1,
    id: "q",
    runId: "r",
    t: 0,
    question: { ...QUESTION, kind: "numeric" },
    aggregate: { k: 2.5, n: 3, spread: 0.1, predilationQuantiles: { p10: 18, p50: 20, p90: 22 } },
    panel: [],
    resolution: { v: 1, rec: "resolved", id: "q", t: 1, outcome, evidence: "", sources: [], resolvedBy: "operator" },
  });
  // Below MIN_QCAL_N → the default, untouched.
  const few = [5, 12, 20, 28, 35].map(mk);
  const cal0 = fitQuantileCalibration(few, DEFAULT_QUANTILE_DILATION);
  assert.equal(cal0.source, "default");
  near(cal0.d, DEFAULT_QUANTILE_DILATION, 1e-9);
  // Outcomes scattered far wider than the stated ±2 band → learn to widen.
  const wideOutcomes = Array.from({ length: 30 }, (_, i) => mk(5 + (i % 11) * 3));
  const cal = fitQuantileCalibration(wideOutcomes, DEFAULT_QUANTILE_DILATION);
  assert.equal(cal.source, "learned");
  assert.equal(cal.n, 30);
  assert.ok(cal.d > 1, `over-narrow intervals should learn a widening factor, got ${cal.d}`);
  // Outcomes that sit inside the band → no need to widen (d not pushed up).
  const tightOutcomes = Array.from({ length: 30 }, (_, i) => mk(19 + (i % 3)));
  const calTight = fitQuantileCalibration(tightOutcomes, DEFAULT_QUANTILE_DILATION);
  assert.ok(calTight.d <= 1.2, `well-covered intervals shouldn't be widened, got ${calTight.d}`);
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

test("normalizeOptionProbs: an option submitted as integer 1 (=1%) is not inflated to ~50% (regression)", () => {
  const opts = ["New York Knicks", "San Antonio Spurs", "Other"];
  // The bug: `if (n > 1) n /= 100` left a bare `1` as 1.0 (=100%), so after
  // renormalizing it became 1/(0.9+0.09+1.0) ≈ 0.50. It must read as ~1%.
  const p = normalizeOptionProbs({ "New York Knicks": 90, "San Antonio Spurs": 9, Other: 1 }, opts);
  assert.ok(p["Other"] < 0.03, `Other should be ~1%, got ${p["Other"]}`);
  assert.ok(p["New York Knicks"] > 0.8, "the leading option keeps its mass");
  near(p["New York Knicks"] + p["San Antonio Spurs"] + p["Other"], 1, 1e-9);
});

test("normalizeOptionProbs is scale-invariant: percentages and fractions agree", () => {
  const opts = ["A", "B", "C"];
  const pct = normalizeOptionProbs({ A: 90, B: 9, C: 1 }, opts);
  const frac = normalizeOptionProbs({ A: 0.9, B: 0.09, C: 0.01 }, opts);
  for (const o of opts) near(pct[o], frac[o], 1e-9);
});

test("aggregateMc: a lone rogue/mis-scaled panel can't dominate an option (winsorize, n≥5)", () => {
  const opts = ["A", "B"];
  // Five panelists are confident in A; one rogue insists on B at the floor.
  const consensus = { A: 0.9, B: 0.1 };
  const rogue = { A: 0.02, B: 0.98 };
  const panels = [consensus, consensus, consensus, consensus, consensus, rogue];
  const agg = aggregateMc(panels, opts, 2.5);
  assert.ok(agg.optionProbs["A"] > 0.85, `winsorized aggregate should still favor A strongly, got ${agg.optionProbs["A"]}`);
  near(agg.optionProbs["A"] + agg.optionProbs["B"], 1, 1e-9);
});

test("aggregateMc: a near-uniform 'I don't know' panel is excluded as non-informative", () => {
  const opts = ["A", "B", "C"];
  const informative = { A: 0.7, B: 0.2, C: 0.1 };
  const flat = { A: 0.34, B: 0.33, C: 0.33 };
  const withFlat = aggregateMc([informative, informative, flat], opts, 2.5);
  const without = aggregateMc([informative, informative], opts, 2.5);
  assert.equal(withFlat.n, 2, "the flat panel is dropped from the count");
  near(withFlat.optionProbs["A"], without.optionProbs["A"], 1e-9);
  // …but if EVERY panel is flat we keep them rather than aggregate nothing.
  const allFlat = aggregateMc([flat, flat], opts, 2.5);
  assert.equal(allFlat.n, 2);
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

test("backtestNumeric replays interval forecasts, scores coverage, and credits dilation when intervals run narrow", () => {
  const mkNum = (panelQ, outcome, kind = "numeric") => ({
    v: 1,
    id: "n",
    runId: "r",
    t: 0,
    question: { ...QUESTION, kind },
    aggregate: { k: 2.5, n: panelQ.length, spread: 0.1 },
    panel: panelQ.map((q, j) => ({ taskId: `T${j}`, method: "trend", quantiles: q })),
    resolution: { v: 1, rec: "resolved", id: "n", t: 1, outcome, evidence: "", sources: [], resolvedBy: "operator" },
  });
  // Agreeing, narrow panels with the outcome just outside the band: the LOP
  // can't widen (no disagreement), but the default dilation can — so coverage
  // and pinball both improve from "LOP, no dilation" to "+ default dilation".
  const entries = Array.from({ length: 12 }, (_, i) => {
    const center = 100 + i * 5;
    const q = { p10: center - 5, p50: center, p90: center + 5 };
    return mkNum([q, { ...q }], center + 5.5);
  });
  const r = backtestNumeric(entries);
  assert.equal(r.rows.length, 5); // +asymmetric dilation row (B3)
  for (const row of r.rows) {
    assert.equal(row.n, 12);
    assert.ok(row.coverage >= 0 && row.coverage <= 1);
    assert.ok(row.pinballLo <= row.pinballMean && row.pinballMean <= row.pinballHi, "CI brackets the mean");
  }
  const lopNo = r.rows.find((x) => x.config === "LOP, no dilation");
  const lopDef = r.rows.find((x) => /default dilation/.test(x.config));
  assert.equal(lopNo.coverage, 0, "the ±5 band misses the +5.5 outcome");
  assert.equal(lopDef.coverage, 1, "the ×1.15 default band reaches it");
  assert.ok(lopDef.pinballMean < lopNo.pinballMean, "widening a too-narrow interval lowers pinball");
  // Only 12 resolved (< MIN_QCAL_N) → the learned row is flagged as default-equal.
  const learned = r.rows.find((x) => /learned/.test(x.config));
  assert.equal(learned.learnedEqualsDefault, true);
  // Nothing replayable → empty, with a reason.
  assert.equal(backtestNumeric([]).rows.length, 0);
  assert.equal(backtestNumeric([]).skipped.unresolved, 0);
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

// ============================================================ Phase 2: flywheel train/serve consistency

const olEntry = (id, probs, overlap, outcome) => ({
  v: 1,
  id,
  runId: "r",
  t: 1,
  question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
  aggregate: { probability: 0.65, k: 2.5, n: probs.length, spread: 0, evidenceOverlap: overlap },
  evidenceOverlap: overlap,
  panel: probs.map((p, i) => ({ taskId: `T${i}`, method: "outside-view", probability: p })),
  resolution: { v: 1, rec: "resolved", id, t: 2, outcome, evidence: "", sources: [], resolvedBy: "swarm" },
});

// 40 entries: panel says 0.65 but YES resolves 80% of the time → underconfident,
// so extremization (k>1) lowers Brier; optimal effective exponent ≈ 2.24.
const overlapLedger = (overlap) =>
  Array.from({ length: 40 }, (_, i) => olEntry(`o${overlap}_${i}`, [0.65, 0.65, 0.65], overlap, i < 32 ? 1 : 0));

test("A1: chooseExtremizeK replays the SERVED estimator (scaleK+weights) — overlap raises the fitted raw k", () => {
  const kLow = chooseExtremizeK(overlapLedger(0), DEFAULT_EXTREMIZE_K);
  const kHigh = chooseExtremizeK(overlapLedger(0.6), DEFAULT_EXTREMIZE_K);
  // The live path applies scaleK(k, overlap) < k, so to reach the same Brier-optimal
  // sharpening the learner must pick a LARGER raw k when overlap is high. Fitting raw
  // k (the old skew) would return the same value regardless of overlap.
  assert.ok(kHigh > kLow + 0.3, `kHigh ${kHigh} should exceed kLow ${kLow} by overlap compensation`);
  // Sanity: the fitted k actually beats no-extremization on the served path.
  const probs = [0.65, 0.65, 0.65];
  const servedBrier = (k) => {
    let s = 0;
    for (let i = 0; i < 40; i++) s += Math.pow(aggregateBinary(probs, scaleK(k, 0)).probability - (i < 32 ? 1 : 0), 2);
    return s / 40;
  };
  assert.ok(servedBrier(kLow) < servedBrier(1), "fitted k beats k=1 on the served estimator");
});

const mcEntry2 = (id, realized, overlap = 0) => ({
  v: 1,
  id,
  runId: "r",
  t: 1,
  question: { kind: "mc", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01", options: ["A", "B", "C"] },
  aggregate: { optionProbs: { A: 0.5, B: 0.3, C: 0.2 }, n: 3, spread: 0, evidenceOverlap: overlap },
  evidenceOverlap: overlap,
  panel: [0, 1, 2].map((i) => ({ taskId: `T${i}`, method: "outside-view", optionProbs: { A: 0.5, B: 0.3, C: 0.2 } })),
  resolution: { v: 1, rec: "resolved", id, t: 2, outcome: realized, evidence: "", sources: [], resolvedBy: "swarm" },
});

// A wins 70%, panel only gives it 0.5 → an underconfident-but-correct mc panel wants sharpening.
const mcLedger = Array.from({ length: 40 }, (_, i) => mcEntry2(`m${i}`, i < 28 ? "A" : i < 34 ? "B" : "C"));

test("A2: chooseExtremizeKMc fits a SEPARATE mc exponent and sharpens an underconfident correct panel", () => {
  const k = chooseExtremizeKMc(mcLedger, DEFAULT_EXTREMIZE_K);
  assert.ok(k >= 1 && k <= 6, `kMc in [1,6], got ${k}`);
  assert.ok(k > 1.1, `underconfident-but-correct mc panel should sharpen (k>1), got ${k}`);
});

test("A2: backtestMc replays mc entries with an adaptive-kMc row scored on multiclass Brier/log-loss", () => {
  const rep = backtestMc(mcLedger);
  assert.ok(rep.rows.length >= 3, "has published/static/adaptive rows");
  assert.ok(rep.rows.some((r) => /kMc/.test(r.config)), "has an adaptive-kMc row");
  assert.ok(rep.rows.every((r) => r.n === 40 && Number.isFinite(r.brierMean) && Number.isFinite(r.logLossMean)));
});

const domAnchored = (id, domain, marketP, outcome) => ({
  v: 1,
  id,
  runId: "r",
  t: 1,
  domain,
  question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
  aggregate: {
    probability: 0.5,
    k: 2.5,
    n: 3,
    spread: 0,
    components: { extremized: 0.5, market: { platform: "polymarket", url: "u", probability: marketP, volume: 100_000, weight: 0.4 } },
  },
  panel: [{ taskId: "T0", method: "outside-view", probability: 0.5 }, { taskId: "T1", method: "outside-view", probability: 0.5 }, { taskId: "T2", method: "outside-view", probability: 0.5 }],
  resolution: { v: 1, rec: "resolved", id, t: 2, outcome, evidence: "", sources: [], resolvedBy: "swarm" },
});

test("A5: per-domain partial pooling — a market reliable in one domain earns more weight there than in a domain where it's wrong", () => {
  // macro: market always WRONG (anti-correlated) → wants weight 0.
  // finance: market always RIGHT → wants high weight. Mixed global is intermediate.
  const macro = Array.from({ length: 25 }, (_, i) => domAnchored(`ma${i}`, "macro", i % 2 ? 0.1 : 0.9, i % 2 ? 1 : 0));
  const finance = Array.from({ length: 25 }, (_, i) => domAnchored(`fi${i}`, "finance", i % 2 ? 0.9 : 0.1, i % 2 ? 1 : 0));
  const all = [...macro, ...finance];
  const wFinance = chooseMarketWeight(all, DEFAULT_MARKET_WEIGHT, "finance");
  const wMacro = chooseMarketWeight(all, DEFAULT_MARKET_WEIGHT, "macro");
  assert.ok(wFinance > wMacro + 0.3, `finance weight ${wFinance} should exceed macro weight ${wMacro} (pooling toward the in-domain fit)`);
});

// ---- Phase-2 review fixes: pooling guard + multi-method exercise ----

const mcDomEntry = (id, domain, realized) => ({
  v: 1, id, runId: "r", t: 1, domain,
  question: { kind: "mc", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01", options: ["A", "B", "C"] },
  aggregate: { optionProbs: { A: 0.5, B: 0.3, C: 0.2 }, n: 3, spread: 0, evidenceOverlap: 0 },
  evidenceOverlap: 0,
  panel: [0, 1, 2].map((i) => ({ taskId: `T${i}`, method: "outside-view", optionProbs: { A: 0.5, B: 0.3, C: 0.2 } })),
  resolution: { v: 1, rec: "resolved", id, t: 2, outcome: realized, evidence: "", sources: [], resolvedBy: "swarm" },
});
const binDomEntry = (id, domain, p, outcome) => ({
  v: 1, id, runId: "r", t: 1, domain,
  question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
  aggregate: { probability: p, k: 2.5, n: 3, spread: 0, evidenceOverlap: 0 },
  evidenceOverlap: 0,
  panel: [0, 1, 2].map((i) => ({ taskId: `T${i}`, method: "outside-view", probability: p })),
  resolution: { v: 1, rec: "resolved", id, t: 2, outcome, evidence: "", sources: [], resolvedBy: "swarm" },
});

test("A5 pooling guard: a thin in-domain mc slice rests on the GLOBAL mc k, never the cold default", () => {
  // 35 mc entries (domain macro) where A wins 90% → a learnable, high global mc k.
  const macroMc = Array.from({ length: 35 }, (_, i) => mcDomEntry(`gm${i}`, "macro", i < 31 ? "A" : i < 33 ? "B" : "C"));
  // finance: 40 binary resolutions (irrelevant to the mc fit) + only 3 mc (< MIN_ADAPTIVE_N).
  const finBin = Array.from({ length: 40 }, (_, i) => binDomEntry(`fb${i}`, "finance", 0.6, i < 32 ? 1 : 0));
  const finMc = Array.from({ length: 3 }, (_, i) => mcDomEntry(`fm${i}`, "finance", "A"));
  const all = [...macroMc, ...finBin, ...finMc];
  const globalK = chooseExtremizeKMc(all, DEFAULT_EXTREMIZE_K);
  const financeK = chooseExtremizeKMc(all, DEFAULT_EXTREMIZE_K, "finance");
  // The finance local mc fit can't learn (3 < 30), so pooling must return the
  // global mc k verbatim — NOT blend it toward the default driven by 40 binary rows.
  near(financeK, globalK, 1e-9, "thin in-domain mc rests on the global pool");
  assert.ok(Math.abs(financeK - DEFAULT_EXTREMIZE_K) > 0.1, `should not regress to the default ${DEFAULT_EXTREMIZE_K}, got ${financeK}`);
});

test("A5 pooling guard: a domain with no usable market history keeps the GLOBAL market weight, not the fallback", () => {
  // Global: 30 binary anchored entries where the market is always right → high global weight.
  const global = Array.from({ length: 30 }, (_, i) => ({ ...anchoredEntry(0.5, i % 2 ? 0.9 : 0.1, i % 2 ? 1 : 0), id: `g${i}`, domain: "macro" }));
  // finance: binary resolutions with NO market component (not usable for the market-weight fit).
  const finance = Array.from({ length: 25 }, (_, i) => binDomEntry(`f${i}`, "finance", 0.6, i % 2));
  const all = [...global, ...finance];
  const globalW = chooseMarketWeight(all, DEFAULT_MARKET_WEIGHT);
  const financeW = chooseMarketWeight(all, DEFAULT_MARKET_WEIGHT, "finance");
  near(financeW, globalW, 1e-9, "no usable in-domain market history ⇒ global weight, not fallback");
});

test("chooseExtremizeK handles a multi-method panel without error (weighted served replay)", () => {
  // Two methods of differing accuracy → non-uniform weights exercise the weighted path.
  const entries = Array.from({ length: 35 }, (_, i) => ({
    v: 1, id: `mm${i}`, runId: "r", t: 1,
    question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
    aggregate: { probability: 0.6, k: 2.5, n: 2, spread: 0, evidenceOverlap: 0.2 },
    evidenceOverlap: 0.2,
    panel: [
      { taskId: "T0", method: "outside-view", probability: i < 30 ? 0.7 : 0.3 },
      { taskId: "T1", method: "trend", probability: 0.5 },
    ],
    resolution: { v: 1, rec: "resolved", id: `mm${i}`, t: 2, outcome: i < 28 ? 1 : 0, evidence: "", sources: [], resolvedBy: "swarm" },
  }));
  const k = chooseExtremizeK(entries, DEFAULT_EXTREMIZE_K);
  assert.ok(k >= 1 && k <= 6 && Number.isFinite(k), `multi-method fit returns a valid k, got ${k}`);
});

// ---- B3: asymmetric (per-tail) interval calibration ----

test("applyAsymmetricDilation widens each tail by its own factor; dLo=dUp ≡ symmetric", () => {
  const q = { p10: 90, p25: 95, p50: 100, p75: 105, p90: 110 };
  // Upper-only dilation (dLo=1, dUp=2): p50 fixed, lower untouched, upper widened.
  const up = applyAsymmetricDilation(q, 1, 2, false);
  assert.equal(up.p50, 100);
  assert.equal(up.p10, 90, "lower tail unchanged at dLo=1");
  assert.equal(up.p90, 100 + 2 * 10, "upper tail widened by dUp");
  assert.equal(up.p75, 100 + 2 * 5);
  // dLo=dUp matches the symmetric path exactly.
  const asym = applyAsymmetricDilation(q, 1.3, 1.3, false);
  const sym = applyQuantileDilation(q, 1.3, false);
  for (const k of ["p10", "p25", "p50", "p75", "p90"]) near(asym[k], sym[k], 1e-9, k);
});

test("fitIntervalCalibration learns a wider dilation on the tail that is systematically too narrow", () => {
  // Panels symmetric & narrow, but outcomes land BELOW the band (lower tail too
  // tight) — the lower dilation should learn larger than the upper.
  const mk = (id, center, outcome) => ({
    v: 1, id, runId: "r", t: 1,
    question: { kind: "numeric", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
    aggregate: { quantiles: { p10: center - 5, p50: center, p90: center + 5 }, predilationQuantiles: { p10: center - 5, p50: center, p90: center + 5 }, k: 2.5, n: 2, spread: 0 },
    panel: [{ taskId: "T0", method: "trend", quantiles: { p10: center - 5, p50: center, p90: center + 5 } }],
    resolution: { v: 1, rec: "resolved", id, t: 2, outcome, evidence: "", sources: [], resolvedBy: "swarm" },
  });
  // Outcome consistently ~9 below center → far past the lower p10 (−5), inside upper.
  const entries = Array.from({ length: 30 }, (_, i) => mk(`d${i}`, 100 + i, 100 + i - 9));
  const cal = fitIntervalCalibration(entries, DEFAULT_QUANTILE_DILATION);
  assert.equal(cal.source, "learned");
  assert.ok(cal.dLo > cal.dUp, `lower tail should widen more (dLo ${cal.dLo} > dUp ${cal.dUp})`);
});

// ---- B2: mc recalibration / B1: beta calibration ----

const { fitMcRecalibration, applyMcRecalibration, fitBetaCalibration, applyBetaCalibration } = require("../../dist/forecast.js");

test("applyMcRecalibration applies a shared logistic per option and renormalizes to the simplex", () => {
  const r = { a: 1.5, b: 0, n: 40 }; // sharpen (a>1)
  const out = applyMcRecalibration({ A: 0.5, B: 0.3, C: 0.2 }, r);
  near(out.A + out.B + out.C, 1, 1e-9, "renormalized");
  assert.ok(out.A > 0.5, "a>1 sharpens the leader");
  // null recalibration is identity.
  const id = applyMcRecalibration({ A: 0.6, B: 0.4 }, null);
  near(id.A, 0.6, 1e-9);
});

test("fitMcRecalibration learns a correction from a systematically over/under-confident mc record", () => {
  // Panels give the winner 0.5 but it wins 75% of the time → underconfident →
  // recalibration should push the leader up (a>1 or b favoring it).
  const entries = Array.from({ length: 40 }, (_, i) => ({
    v: 1, id: `mr${i}`, runId: "r", t: 1,
    question: { kind: "mc", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01", options: ["A", "B", "C"] },
    aggregate: { optionProbs: { A: 0.5, B: 0.3, C: 0.2 }, n: 3, spread: 0 },
    panel: [{ taskId: "T0", method: "outside-view", optionProbs: { A: 0.5, B: 0.3, C: 0.2 } }],
    resolution: { v: 1, rec: "resolved", id: `mr${i}`, t: 2, outcome: i < 30 ? "A" : i < 35 ? "B" : "C", evidence: "", sources: [], resolvedBy: "swarm" },
  }));
  const recal = fitMcRecalibration(entries);
  assert.ok(recal, "learns above the threshold");
  const before = 0.5;
  const after = applyMcRecalibration({ A: 0.5, B: 0.3, C: 0.2 }, recal).A;
  assert.ok(after > before, `underconfident leader should be pushed up (${before} → ${after})`);
  // Below threshold → null.
  assert.equal(fitMcRecalibration(entries.slice(0, 10)), null);
});

test("beta calibration fits and reduces to identity sensibly; applyBetaCalibration is monotone", () => {
  // A well-calibrated record → near-identity map (a≈b≈1, c≈0), so it barely moves p.
  const entries = Array.from({ length: 50 }, (_, i) => resolvedEntry(`bc${i}`, (i % 10) / 10 + 0.05, ((i % 10) / 10 + 0.05) > Math.random() ? 1 : 0));
  const cal = fitBetaCalibration(entries);
  assert.ok(cal, "fits above the threshold");
  // Monotone: higher p maps to higher p'.
  assert.ok(applyBetaCalibration(0.8, cal) > applyBetaCalibration(0.3, cal));
  // Identity when null.
  near(applyBetaCalibration(0.42, null), 0.42, 1e-9);
});

// ---- G2: outside-view prior→final delta scoring ----

const { priorDeltaStats } = require("../../dist/forecast.js");

test("priorDeltaStats flags when big deviations from the committed prior LOSE to holding it (G2)", () => {
  // Panels commit prior 0.5, then swing hard to 0.9 — but the outcome is NO.
  // Big moves are wrong → bigMovesPayOff should be false and large-move Brier > prior Brier.
  const bigWrong = (id) => ({
    v: 1, id, runId: "r", t: 1,
    question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
    aggregate: { probability: 0.9, k: 2.5, n: 2, spread: 0 },
    panel: [{ taskId: "T0", method: "outside-view", prior: 0.5, probability: 0.9 }],
    resolution: { v: 1, rec: "resolved", id, t: 2, outcome: 0, evidence: "", sources: [], resolvedBy: "swarm" },
  });
  // Small-move, well-calibrated entries (prior≈final, correct).
  const smallOk = (id, p, o) => ({
    v: 1, id, runId: "r", t: 1,
    question: { kind: "binary", text: "q", resolutionCriteria: "", resolutionDate: "2030-01-01" },
    aggregate: { probability: p, k: 2.5, n: 2, spread: 0 },
    panel: [{ taskId: "T0", method: "outside-view", prior: p, probability: p }],
    resolution: { v: 1, rec: "resolved", id, t: 2, outcome: o, evidence: "", sources: [], resolvedBy: "swarm" },
  });
  const entries = [
    ...Array.from({ length: 8 }, (_, i) => bigWrong(`bw${i}`)),
    ...Array.from({ length: 8 }, (_, i) => smallOk(`so${i}`, i % 2 ? 0.8 : 0.2, i % 2 ? 1 : 0)),
  ];
  const pd = priorDeltaStats(entries);
  assert.equal(pd.n, 16);
  assert.ok(pd.meanAbsDelta > 0);
  assert.equal(pd.bigMovesPayOff, false, "big wrong moves should NOT pay off");
  assert.ok(pd.largeMoveBrier > pd.largeMovePriorBrier, "holding the prior would have beaten the big moves");
  // No priors → empty/neutral.
  const noPriors = priorDeltaStats([resolvedEntry("x", 0.7, 1)]);
  assert.equal(noPriors.n, 0);
  assert.equal(noPriors.bigMovesPayOff, true);
});

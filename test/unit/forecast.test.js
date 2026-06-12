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
  MIN_CALIBRATION_N,
  MIN_ADAPTIVE_N,
  DEFAULT_EXTREMIZE_K,
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

test("aggregateQuantiles: trimmed means stay monotonic and spread is relative", () => {
  const a = aggregateQuantiles([
    { p10: 10, p50: 20, p90: 30 },
    { p10: 12, p50: 24, p90: 40 },
    { p10: 8, p50: 16, p90: 28 },
  ]);
  assert.equal(a.n, 3);
  near(a.quantiles.p10, 10, 1e-9);
  near(a.quantiles.p50, 20, 1e-9);
  near(a.quantiles.p90, 32.6667, 1e-3);
  assert.ok(a.quantiles.p10 <= a.quantiles.p50 && a.quantiles.p50 <= a.quantiles.p90);
  near(a.spread, (24 - 16) / 20, 1e-9);
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
  // extremization, the better the Brier, so the grid maxes out.
  const many = Array.from({ length: MIN_ADAPTIVE_N + 5 }, (_, i) => ({
    ...resolvedEntry(`m${i}`, 0.6, 1),
    panel: [
      { taskId: "T2", method: "a", probability: 0.6 },
      { taskId: "T3", method: "b", probability: 0.6 },
    ],
  }));
  assert.equal(chooseExtremizeK(many, DEFAULT_EXTREMIZE_K), 4);

  // Perfectly calibrated already (p=0.5 splits 50/50) — k=1 (no extremization) wins.
  const calibrated = Array.from({ length: MIN_ADAPTIVE_N + 5 }, (_, i) => ({
    ...resolvedEntry(`c${i}`, 0.7, i % 2),
    panel: [
      { taskId: "T2", method: "a", probability: 0.7 },
      { taskId: "T3", method: "b", probability: 0.7 },
    ],
  }));
  assert.equal(chooseExtremizeK(calibrated, DEFAULT_EXTREMIZE_K), 1);
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

test.after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

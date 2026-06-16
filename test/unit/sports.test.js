const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the ledger in a temp home (sportsCalibrationStats/chooseSportsMarketWeight default to loadLedger()).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-sports-test-"));
process.env.AGENTSWARM_HOME = TMP_HOME;

const { normInv, sportsDayNumber, sportsDayIso, distinctiveTokens } = require("../../dist/datatools.js");
const {
  lineToQuantiles,
  blendQuantilesWithMarket,
  sportsSigma,
  SPORTS_SIGMA,
  chooseSportsMarketWeight,
  DEFAULT_SPORTS_MARKET_WEIGHT,
  sportsCalibrationStats,
  pinballLoss,
  mcBrierScore,
  monotoneQuantiles,
  clampProb,
  sportsWinnerMarket,
  classifySportsMission,
} = require("../../dist/forecast.js");

const TAUS = ["p5", "p10", "p25", "p50", "p75", "p90", "p95"];
const width = (q) => q.p90 - q.p10;

test("distinctiveTokens drops shared city/structural words, keeping the mascot", () => {
  // Mascots survive; city words ("new", "york", "los", "angeles") are dropped.
  assert.deepStrictEqual(distinctiveTokens("New York Giants"), ["giants"]);
  assert.deepStrictEqual(distinctiveTokens("New York Jets"), ["jets"]);
  assert.deepStrictEqual(distinctiveTokens("Los Angeles Lakers"), ["lakers"]);
  // So "New York Giants" shares NO distinctive token with a Jets team — no false same-city match.
  const q = new Set(distinctiveTokens("New York Giants vs Dallas Cowboys"));
  assert.ok(!distinctiveTokens("New York Jets").some((t) => q.has(t)));
  assert.ok(distinctiveTokens("New York Giants").some((t) => q.has(t)));
});

test("sportsDayNumber maps US night games to their local date but leaves non-US games on their UTC date", () => {
  const target = sportsDayNumber(Date.parse("2026-06-20T12:00:00Z")); // plain "June 20" (no league key)
  const nba = "basketball_nba";
  // US: June-20 ET night game commences ~June 21 00:30Z — still the June 20 game.
  assert.strictEqual(sportsDayNumber(Date.parse("2026-06-21T00:30:00Z"), nba), target);
  assert.strictEqual(sportsDayNumber(Date.parse("2026-06-20T19:00:00Z"), nba), target); // afternoon
  // US: the PREVIOUS night's game (June-19 ET, ~June 20 00:30Z) must NOT match June 20.
  assert.strictEqual(sportsDayNumber(Date.parse("2026-06-20T00:30:00Z"), nba), target - 1);
  // Non-US (EPL/AFL): an evening game already sits on its local UTC date — no shift.
  assert.strictEqual(sportsDayNumber(Date.parse("2026-06-20T09:00:00Z"), "aussierules_afl"), target); // 19:00 AEST
  assert.strictEqual(sportsDayNumber(Date.parse("2026-06-20T19:00:00Z"), "soccer_epl"), target); // 20:00 BST
  // The ISO label reflects the local date for US late games.
  assert.strictEqual(sportsDayIso(Date.parse("2026-06-21T00:30:00Z"), nba), "2026-06-20");
});

test("normInv inverts the standard normal at known points", () => {
  assert.ok(Math.abs(normInv(0.5)) < 1e-9);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(normInv(0.025) + 1.959964) < 1e-4);
  assert.ok(Math.abs(normInv(0.9) - 1.281552) < 1e-4);
  // Symmetric.
  assert.ok(Math.abs(normInv(0.3) + normInv(0.7)) < 1e-6);
});

test("lineToQuantiles centers on the line, is symmetric, monotone, and handles negatives", () => {
  const q = lineToQuantiles(224.5, 11);
  assert.strictEqual(q.p50, 224.5);
  // Symmetric about the line.
  assert.ok(Math.abs(q.p5 + q.p95 - 2 * 224.5) < 1e-9);
  assert.ok(Math.abs(q.p10 + q.p90 - 2 * 224.5) < 1e-9);
  // Monotone increasing.
  for (let i = 1; i < TAUS.length; i++) assert.ok(q[TAUS[i]] > q[TAUS[i - 1]]);
  // A 224.5 total with σ=11 never has a tail near zero.
  assert.ok(q.p5 > 200);
  // Negative margin line: p50 negative, p95 positive (favorite can lose).
  const m = lineToQuantiles(-6.5, 12);
  assert.strictEqual(m.p50, -6.5);
  assert.ok(m.p5 < -6.5 && m.p95 > 0);
});

test("sportsSigma resolves known sports and rejects unknown ones", () => {
  assert.strictEqual(sportsSigma("NBA", "total"), SPORTS_SIGMA.nba.total);
  assert.strictEqual(sportsSigma("NBA", "margin"), SPORTS_SIGMA.nba.margin);
  assert.strictEqual(sportsSigma("NFL", "total"), SPORTS_SIGMA.nfl.total);
  assert.strictEqual(sportsSigma("Tiddlywinks", "total"), null);
  // Margin σ only for true point-spread sports — MLB run lines / NHL puck lines
  // aren't the median margin, so margin anchoring is skipped (total still works).
  assert.strictEqual(sportsSigma("MLB", "margin"), null);
  assert.strictEqual(sportsSigma("MLB", "total"), SPORTS_SIGMA.mlb.total);
  assert.strictEqual(sportsSigma("NHL", "margin"), null);
  assert.strictEqual(sportsSigma("EPL", "margin"), null);
});

test("blendQuantilesWithMarket pulls the center toward the line without inflating width", () => {
  const panel = lineToQuantiles(230, 15); // wider, off-center
  const market = lineToQuantiles(224.5, 11); // sharp line
  const blended = blendQuantilesWithMarket(panel, market, 0.6);
  // Center pulled 60% toward the line.
  assert.ok(Math.abs(blended.p50 - (0.4 * 230 + 0.6 * 224.5)) < 1e-9);
  // Width stays a convex combination — never wider than the panel, never tighter than the line.
  assert.ok(width(blended) <= width(panel) + 1e-9);
  assert.ok(width(blended) >= width(market) - 1e-9);
  // Endpoints.
  assert.deepStrictEqual(blendQuantilesWithMarket(panel, market, 0), monotoneQuantiles(panel));
  assert.deepStrictEqual(blendQuantilesWithMarket(panel, market, 1), monotoneQuantiles(market));
});

test("chooseSportsMarketWeight falls back to the high default below the threshold", () => {
  assert.strictEqual(chooseSportsMarketWeight([]), DEFAULT_SPORTS_MARKET_WEIGHT);
  // A handful of resolved facets is still below MIN — fallback holds.
  const few = [
    {
      question: { kind: "numeric", sports: { facet: "total" } },
      panel: [{}, {}, {}, {}, {}],
      aggregate: { n: 5, components: { blendedQ: lineToQuantiles(220, 11), marketLine: { line: 222, sigma: 11, lineKind: "total", weight: 0.55 } } },
      resolution: { outcome: 225 },
    },
  ];
  assert.strictEqual(chooseSportsMarketWeight(few), DEFAULT_SPORTS_MARKET_WEIGHT);
});

test("sportsCalibrationStats scores winner/total/margin against the market", () => {
  const entries = [
    {
      question: { kind: "mc", options: ["Home", "Away"], sports: { facet: "winner", home: "Home", away: "Away", lineAtCreate: { pHome: 0.6 } } },
      aggregate: { optionProbs: { Home: 0.65, Away: 0.35 } },
      resolution: { outcome: "Home" },
    },
    {
      question: { kind: "numeric", sports: { facet: "total", lineAtCreate: { total: 220 } } },
      aggregate: { quantiles: lineToQuantiles(222, 11) },
      resolution: { outcome: 225 },
    },
    {
      question: { kind: "numeric", sports: { facet: "margin", favorite: "home", sigma: 12, lineAtCreate: { spread: 6 } } },
      aggregate: { quantiles: lineToQuantiles(5, 12) },
      resolution: { outcome: 8 },
    },
  ];
  const s = sportsCalibrationStats(entries);
  assert.strictEqual(s.winner.n, 1);
  assert.ok(Math.abs(s.winner.brier - mcBrierScore({ Home: 0.65, Away: 0.35 }, "Home")) < 1e-9);
  assert.ok(Math.abs(s.winner.marketBrier - mcBrierScore({ Home: 0.6, Away: 0.4 }, "Home")) < 1e-9);
  assert.strictEqual(s.total.n, 1);
  assert.ok(s.total.pinball > 0 && s.total.linePinball > 0);
  // Our total distribution (centered 222, closer to the realized 225) should beat the line-only baseline (220).
  assert.ok(s.total.pinball < s.total.linePinball);
  assert.strictEqual(s.margin.n, 1);
  assert.ok(s.margin.pinball > 0 && s.margin.linePinball > 0);
});

test("classifySportsMission routes only clean winner/total/margin/score game questions", () => {
  // Full decomposition: generic score / preview.
  assert.strictEqual(classifySportsMission("predict the score of Lakers vs Celtics"), "full");
  assert.strictEqual(classifySportsMission("Lakers vs Celtics on 2026-06-20"), "full");
  // Explicit single facets.
  assert.strictEqual(classifySportsMission("Will the Lakers beat the Celtics?"), "winner");
  assert.strictEqual(classifySportsMission("who wins Lakers vs Celtics?"), "winner");
  assert.strictEqual(classifySportsMission("Will the Lakers win vs the Celtics?"), "winner");
  assert.strictEqual(classifySportsMission("How many points will the Lakers and Celtics combine for?"), "total");
  assert.strictEqual(classifySportsMission("what will the combined total be in Lakers vs Celtics?"), "total");
  assert.strictEqual(classifySportsMission("how many points will be scored in Lakers vs Celtics?"), "total");
  assert.strictEqual(classifySportsMission("by how many will the Lakers beat the Celtics?"), "margin");
  assert.strictEqual(classifySportsMission("what will the margin of victory be in Lakers vs Celtics?"), "margin");
  // "beat ... by N" is a binary spread bet, not a numeric margin — leave it to the normal planner.
  assert.strictEqual(classifySportsMission("Will the Lakers beat the Celtics by 5 points?"), null);

  // null — leave to the normal planner (never silently rewrite the target):
  assert.strictEqual(classifySportsMission("Will the ECB cut rates by September?"), null); // not a game
  assert.strictEqual(classifySportsMission("How many points will the Lakers score vs the Celtics?"), null); // single-team total
  assert.strictEqual(classifySportsMission("Will the Lakers cover the spread vs the Celtics?"), null); // binary cover
  assert.strictEqual(classifySportsMission("Will Lakers vs Celtics go over 220.5?"), null); // binary over/under
  assert.strictEqual(classifySportsMission("Will LeBron get 10+ rebounds vs the Celtics?"), null); // player prop
  assert.strictEqual(classifySportsMission("Who leads at halftime, Lakers vs Celtics?"), null); // half line
  assert.strictEqual(classifySportsMission("Will the Dodgers win more games than the Padres this season?"), null); // season comparison
  assert.strictEqual(classifySportsMission("Will the Celtics win the championship?"), null); // standings/title
  assert.strictEqual(classifySportsMission("Will the Lakers win the series vs the Nuggets?"), null); // multi-game series
});

test("sportsWinnerMarket: 2-way is exact, 3-way normalizes all three stored legs", () => {
  // 2-way: away is exactly 1 − home.
  assert.deepStrictEqual(sportsWinnerMarket({ home: "H", away: "A", lineAtCreate: { pHome: 0.6 } }), { H: 0.6, A: 0.4 });
  // 3-way: independent per-leg medians need not sum to 1 — normalize, don't reconstruct away.
  const m = sportsWinnerMarket({ home: "H", away: "A", lineAtCreate: { pHome: 0.5, pDraw: 0.3, pAway: 0.4 } });
  const sum = m.H + m.Draw + m.A;
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(m.H - 0.5 / 1.2) < 1e-9 && Math.abs(m.A - 0.4 / 1.2) < 1e-9);
});

test("sportsCalibrationStats prices the Draw for 3-way winner markets", () => {
  const entries = [
    {
      question: { kind: "mc", options: ["Home", "Draw", "Away"], sports: { facet: "winner", home: "Home", away: "Away", lineAtCreate: { pHome: 0.5, pDraw: 0.3, pAway: 0.2 } } },
      aggregate: { optionProbs: { Home: 0.45, Draw: 0.3, Away: 0.25 } },
      resolution: { outcome: "Draw" },
    },
  ];
  const s = sportsCalibrationStats(entries);
  assert.strictEqual(s.winner.n, 1);
  // Market baseline must price the real (normalized) Draw leg, not a 2-way {Home,Away}.
  const expected = mcBrierScore({ Home: 0.5, Draw: 0.3, Away: 0.2 }, "Draw");
  assert.ok(Math.abs(s.winner.marketBrier - expected) < 1e-9);
});

test("sportsCalibrationStats skips total/margin facets that never had a line", () => {
  const entries = [
    // total facet with NO total line — must not count, or the line baseline deflates.
    { question: { kind: "numeric", sports: { facet: "total", lineAtCreate: { t: 0 } } }, aggregate: { quantiles: lineToQuantiles(220, 11) }, resolution: { outcome: 225 } },
    // a real total facet WITH a line still counts.
    { question: { kind: "numeric", sports: { facet: "total", lineAtCreate: { total: 220 } } }, aggregate: { quantiles: lineToQuantiles(221, 11) }, resolution: { outcome: 223 } },
    // a margin facet WITHOUT sigma (MLB run line) is NOT a true point spread — excluded from vs-line scoring.
    { question: { kind: "numeric", sports: { facet: "margin", favorite: "home", lineAtCreate: { spread: 1.5 } } }, aggregate: { quantiles: lineToQuantiles(1, 4.3) }, resolution: { outcome: 2 } },
  ];
  const s = sportsCalibrationStats(entries);
  assert.strictEqual(s.total.n, 1);
  assert.ok(s.total.linePinball > 0); // not a spurious zero baseline
  assert.strictEqual(s.margin.n, 0); // run-line margin excluded
});

test("sportsCalibrationStats ignores voids and non-sports entries", () => {
  const entries = [
    { question: { kind: "binary" }, aggregate: { probability: 0.7 }, resolution: { outcome: 1 } },
    { question: { kind: "mc", options: ["A", "B"], sports: { facet: "winner", home: "A", away: "B", lineAtCreate: { pHome: 0.5 } } }, aggregate: { optionProbs: { A: 0.5, B: 0.5 } }, resolution: { outcome: "void" } },
  ];
  const s = sportsCalibrationStats(entries);
  assert.strictEqual(s.winner.n, 0);
  assert.strictEqual(s.total.n, 0);
  assert.strictEqual(s.margin.n, 0);
});

const test = require("node:test");
const assert = require("node:assert");

const {
  devigProbs,
  shinDevig,
  normCdf,
  impliedProbAbove,
  interpIvToHorizon,
  selectConsistentDuration,
  canonicalSeriesKey,
  olsProject,
  rwDriftProject,
  dampedTrendProject,
  projectSeries,
  backtestProjectors,
  extractHtmlTables,
  formatTables,
  kalshiPrice,
} = require("../../dist/datatools.js");

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ---------------------------------------------------------------- de-vig

test("devigProbs strips the bookmaker margin and sums to 1", () => {
  // Fair coin priced at 1.91/1.91 (typical -110/-110): de-vigged to 50/50.
  const p = devigProbs([1.91, 1.91]);
  near(p[0], 0.5, 1e-9);
  near(p[0] + p[1], 1, 1e-12);
  // A favorite at 1.25 vs underdog at 4.0: raw implied 0.8/0.25 → normalized.
  const q = devigProbs([1.25, 4.0]);
  near(q[0], 0.8 / 1.05, 1e-9);
  near(q[0] + q[1], 1, 1e-12);
  // 3-way (with draw) still normalizes
  const r = devigProbs([2.5, 3.4, 3.1]);
  near(r[0] + r[1] + r[2], 1, 1e-12);
});

test("devigProbs never fabricates certainty from a single priced outcome", () => {
  // A lone outcome (suspended line, one side pulled) can't be de-vigged —
  // normalizing it to sum 1 would invent a 100% probability. Return the raw
  // implied prob instead so it reads as incomplete, not certain.
  const p = devigProbs([1.5]);
  assert.equal(p.length, 1);
  assert.ok(p[0] < 1, `single outcome must not normalize to 1, got ${p[0]}`);
  near(p[0], 1 / 1.5, 1e-9);
  // Two valid outcomes still de-vig to sum 1 as before.
  const q = devigProbs([2, 2]);
  near(q[0] + q[1], 1, 1e-12);
});

// ---------------------------------------------------------------- Shin de-vig (C1)

test("shinDevig sums to 1 and matches proportional on a balanced book", () => {
  const fair = shinDevig([1.91, 1.91]);
  near(fair[0], 0.5, 1e-9);
  near(fair[0] + fair[1], 1, 1e-12);
  // 3-way balanced book also sums to 1.
  const three = shinDevig([3.3, 3.3, 3.3]);
  near(three[0] + three[1] + three[2], 1, 1e-9);
  near(three[0], 1 / 3, 1e-6);
});

test("shinDevig shifts mass TOWARD the favorite vs proportional (favorite-longshot fix)", () => {
  // Favorite 1.25 (implied 0.80), longshot 4.0 (implied 0.25); overround ~5%.
  const odds = [1.25, 4.0];
  const prop = devigProbs(odds);
  const shin = shinDevig(odds);
  near(shin[0] + shin[1], 1, 1e-9);
  // Shin pushes the favorite UP and the longshot DOWN relative to proportional.
  assert.ok(shin[0] > prop[0], `Shin favorite ${shin[0]} should exceed proportional ${prop[0]}`);
  assert.ok(shin[1] < prop[1], `Shin longshot ${shin[1]} should be below proportional ${prop[1]}`);
  // Bounded between the proportional estimate and the raw inverse-odds implied (0.8).
  assert.ok(shin[0] > prop[0] && shin[0] < 0.8);
});

test("shinDevig refuses to fabricate certainty from a single priced outcome", () => {
  const p = shinDevig([1.5]);
  assert.equal(p.length, 1);
  near(p[0], 1 / 1.5, 1e-9);
});

// ---------------------------------------------------------------- options math

test("normCdf matches known values", () => {
  near(normCdf(0), 0.5, 1e-7);
  near(normCdf(1.96), 0.975, 1e-3);
  near(normCdf(-1.96), 0.025, 1e-3);
  near(normCdf(1), 0.8413, 1e-3);
});

test("impliedProbAbove: at-the-money is near 50%, deep ITM/OTM behave", () => {
  // ATM, short-dated, modest vol: d2 slightly negative → just under 50%.
  const atm = impliedProbAbove(100, 100, 0.3, 0.25, 0.04);
  assert.ok(atm > 0.4 && atm < 0.55, `ATM should be near 50%, got ${atm}`);
  // Spot far above strike → near certain.
  assert.ok(impliedProbAbove(200, 100, 0.3, 0.25) > 0.95);
  // Spot far below strike → near zero.
  assert.ok(impliedProbAbove(50, 100, 0.3, 0.25) < 0.05);
  // Higher vol pulls the lognormal median down → P(above) falls for ATM.
  assert.ok(impliedProbAbove(100, 100, 0.8, 1) < impliedProbAbove(100, 100, 0.2, 1));
  // Garbage in → null, not NaN.
  assert.equal(impliedProbAbove(0, 100, 0.3, 0.25), null);
  assert.equal(impliedProbAbove(100, 100, 0, 0.25), null);
});

test("impliedProbAbove real-world drift (r+ERP) raises P(>K) for an OTM call vs risk-neutral (E2)", () => {
  // Same IV/horizon; the only change is the drift. A higher (real-world) drift
  // shifts the lognormal up → higher P above an out-of-the-money strike.
  const riskNeutral = impliedProbAbove(100, 120, 0.3, 2); // default drift = r
  const realWorld = impliedProbAbove(100, 120, 0.3, 2, 0.04, 0.09); // r + 5% ERP
  assert.ok(realWorld > riskNeutral, `real-world ${realWorld} should exceed risk-neutral ${riskNeutral}`);
  // At a near-zero horizon the measures converge (drift·T → 0).
  near(impliedProbAbove(100, 105, 0.3, 0.01), impliedProbAbove(100, 105, 0.3, 0.01, 0.04, 0.09), 5e-3);
});

test("interpIvToHorizon interpolates IV in total-variance space across bracketing expiries", () => {
  // Flat term structure (both expiries 20% IV) → 20% at any horizon between them.
  const flat = interpIvToHorizon([{ T: 0.1, iv: 0.2 }, { T: 0.5, iv: 0.2 }], 0.3);
  near(flat.iv, 0.2, 1e-9);
  assert.equal(flat.interpolated, true);
  // Upward-sloping term structure: σ at the midpoint horizon sits between the two,
  // and total variance is exactly linear in T. Knots: (0.25y,20%) and (0.75y,30%).
  const a = { T: 0.25, iv: 0.2 };
  const b = { T: 0.75, iv: 0.3 };
  const wA = a.iv * a.iv * a.T; // 0.01
  const wB = b.iv * b.iv * b.T; // 0.0675
  const Tt = 0.5;
  const wT = wA + (wB - wA) * ((Tt - a.T) / (b.T - a.T)); // halfway
  const expected = Math.sqrt(wT / Tt);
  const mid = interpIvToHorizon([a, b], Tt);
  near(mid.iv, expected, 1e-9);
  assert.ok(mid.iv > 0.2 && mid.iv < 0.3, `interpolated σ ${mid.iv} between knots`);
  // One knot only (horizon outside the listed range): σ held flat, not interpolated.
  const one = interpIvToHorizon([{ T: 0.2, iv: 0.25 }], 1.0);
  near(one.iv, 0.25, 1e-12);
  assert.equal(one.interpolated, false);
});

test("interpIvToHorizon holds IV flat (not total variance) when the horizon is outside both knots", () => {
  // Two same-side knots, horizon beyond both. Holding TOTAL VARIANCE flat would
  // back out σ·√(T_knot/tYears) — a silent vol mis-statement; hold σ flat instead.
  const beyond = interpIvToHorizon([{ T: 0.25, iv: 0.3 }, { T: 0.5, iv: 0.3 }], 2.0);
  near(beyond.iv, 0.3, 1e-9);
  assert.equal(beyond.interpolated, false);
  // Horizon before both knots → flat at the earlier knot's σ (not re-scaled).
  const before = interpIvToHorizon([{ T: 0.5, iv: 0.2 }, { T: 1.0, iv: 0.4 }], 0.1);
  near(before.iv, 0.2, 1e-9);
  assert.equal(before.interpolated, false);
  // Sanity: strictly inside still interpolates in total-variance space.
  const inside = interpIvToHorizon([{ T: 0.25, iv: 0.2 }, { T: 0.75, iv: 0.3 }], 0.5);
  assert.equal(inside.interpolated, true);
  assert.ok(inside.iv > 0.2 && inside.iv < 0.3);
});

// ---------------------------------------------------------------- projectors (H1/E3)

const linSeries = (n, start, slopePerDay, step = 7) => {
  const pts = [];
  const t0 = Date.parse("2025-01-01");
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * step * 86400000).toISOString().slice(0, 10);
    // Deterministic wiggle so the series has nonzero innovation variance (a real
    // series is never a perfect line — a noiseless line has a legitimately zero band).
    const noise = 3 * Math.sin(i * 1.7) + 2 * Math.cos(i * 0.9);
    pts.push({ date: d, value: start + slopePerDay * i * step + noise });
  }
  return pts;
};

test("rwDriftProject extrapolates the drift with a √-horizon-growing band", () => {
  const pts = linSeries(30, 100, 0.5); // +0.5/day clean trend
  const near30 = rwDriftProject(pts, "2025-08-01");
  const far = rwDriftProject(pts, "2026-06-01");
  assert.ok(near30 && far);
  assert.equal(near30.method, "rwdrift");
  // Drift ≈ 0.5/day, projection rises over time.
  assert.ok(near30.slopePerDay > 0.4 && near30.slopePerDay < 0.6, `drift ${near30.slopePerDay}`);
  assert.ok(far.projected > near30.projected, "further horizon projects higher on a positive drift");
  // Prediction band widens with horizon (random-walk variance grows).
  assert.ok(far.hi - far.lo > near30.hi - near30.lo, "band widens with horizon");
  assert.ok(far.df >= 1 && Number.isFinite(far.sePred));
});

test("rwDriftProject in log space gives a lognormal (positive, asymmetric) band", () => {
  // A multiplicatively growing price series.
  const pts = [];
  const t0 = Date.parse("2025-01-01");
  for (let i = 0; i < 40; i++) pts.push({ date: new Date(t0 + i * 7 * 86400000).toISOString().slice(0, 10), value: 100 * Math.pow(1.01, i) });
  const proj = rwDriftProject(pts, "2026-01-01", { logSpace: true });
  assert.ok(proj && proj.logSpace === true);
  assert.ok(proj.lo > 0, "lognormal lower band stays positive");
  // Asymmetric around the median: upside is wider than downside in linear space.
  assert.ok(proj.hi - proj.projected > proj.projected - proj.lo, "lognormal band skews up");
});

test("dampedTrendProject flattens a steep trend vs OLS at long horizon", () => {
  const pts = linSeries(20, 100, 1.0); // steep +1/day
  const ols = olsProject(pts, "2027-01-01");
  const damped = dampedTrendProject(pts, "2027-01-01");
  assert.ok(ols && damped);
  assert.equal(damped.method, "damped");
  // The damped projection sits well below the unbounded linear extrapolation.
  assert.ok(damped.projected < ols.projected, `damped ${damped.projected} < ols ${ols.projected}`);
});

test("projectSeries defaults to random-walk-with-drift", () => {
  const pts = linSeries(15, 50, 0.2);
  assert.equal(projectSeries(pts, "2025-09-01").method, "rwdrift");
  assert.equal(projectSeries(pts, "2025-09-01", "ols").method, "ols");
  assert.equal(projectSeries(pts, "2025-09-01", "damped").method, "damped");
});

test("selectConsistentDuration de-sawtooths SEC flow facts (keeps annual, not annual+quarterly)", () => {
  // A typical XBRL flow tag: per-year 10-K (~365d) PLUS quarterly/YTD 10-Q spans.
  const raw = [
    { end: "2022-12-31", val: 400, span: 365 }, // FY annual
    { end: "2022-03-31", val: 90, span: 90 }, // Q1
    { end: "2022-06-30", val: 95, span: 91 }, // Q2
    { end: "2022-09-30", val: 100, span: 92 }, // Q3
    { end: "2023-12-31", val: 440, span: 365 }, // FY annual
    { end: "2023-03-31", val: 105, span: 90 }, // Q1
  ];
  const { kept, durNote } = selectConsistentDuration(raw);
  assert.equal(durNote, "annual (10-K FY)");
  assert.deepEqual(kept.map((r) => r.end).sort(), ["2022-12-31", "2023-12-31"]);
  // Annual values are monotone-ish and ~4× the quarters — no sawtooth left.
  assert.ok(kept.every((r) => r.val >= 300));
});

test("selectConsistentDuration leaves instant (stock) facts untouched", () => {
  const raw = [
    { end: "2022-12-31", val: 1000, span: 0 },
    { end: "2023-12-31", val: 1100, span: 0 },
  ];
  const { kept, durNote } = selectConsistentDuration(raw);
  assert.equal(durNote, "point-in-time");
  assert.equal(kept.length, 2);
});

test("selectConsistentDuration falls back to the modal period when no clean annual history", () => {
  const raw = [
    { end: "2022-03-31", val: 90, span: 90 },
    { end: "2022-06-30", val: 95, span: 91 },
    { end: "2022-09-30", val: 100, span: 92 },
  ];
  const { kept } = selectConsistentDuration(raw);
  assert.equal(kept.length, 3); // all ~90-day quarters share one bucket
});

test("canonicalSeriesKey keeps the inflation RATE distinct from the CPI index level (F2)", () => {
  // "inflation" → CPIAUCSL with a YoY transform; "cpi" → the raw index. They must
  // NOT collide in the series cache or one would silently serve the other.
  const infl = canonicalSeriesKey("fred", "inflation");
  const cpi = canonicalSeriesKey("fred", "cpi");
  assert.notEqual(infl, cpi, `inflation key ${infl} must differ from cpi key ${cpi}`);
  assert.ok(infl.includes("~pc1"), `inflation key should mark the YoY transform: ${infl}`);
  assert.equal(cpi, "CPIAUCSL");
  // Plain aliases still resolve to their series id.
  assert.equal(canonicalSeriesKey("fred", "unemployment"), "UNRATE");
});

test("options horizon uses the TARGET date, not the expiry — N(d2) honors the shorter window", () => {
  // The fix: P(>K) must be computed to the forecast horizon. A nearer horizon on
  // the same IV gives a probability closer to 50% for an OTM strike (less time to
  // travel). Using a longer expiry T would overstate the move — the E1 bug.
  const spot = 100, strike = 110, iv = 0.3;
  const pShortHorizon = impliedProbAbove(spot, strike, iv, 0.1); // ~5 weeks
  const pLongExpiry = impliedProbAbove(spot, strike, iv, 0.5); // ~6 months (the wrong T)
  assert.ok(pShortHorizon < pLongExpiry, `nearer horizon ${pShortHorizon} should be < longer-expiry ${pLongExpiry} for an OTM call`);
});

// ---------------------------------------------------------------- kalshi price drift

test("kalshiPrice reads cents, dollar strings, and book midpoints", () => {
  near(kalshiPrice({ last_price: 35 }), 0.35, 1e-9);
  near(kalshiPrice({ last_price_dollars: "0.4100" }), 0.41, 1e-9);
  near(kalshiPrice({ yes_bid_dollars: "0.30", yes_ask_dollars: "0.40" }), 0.35, 1e-9);
  assert.equal(kalshiPrice({}), undefined);
  assert.equal(kalshiPrice({ last_price: 0 }), undefined);
});

// ---------------------------------------------------------------- wikipedia tables

const HTML = `
<html><body>
<table class="wikitable">
<caption>Opinion polling</caption>
<tr><th>Pollster</th><th>Date</th><th>Alice</th><th>Bob</th></tr>
<tr><td>Acme<sup>[1]</sup></td><td>2026-05-01</td><td>48%</td><td>44%</td></tr>
<tr><td>Birch &amp; Co</td><td>2026-05-08</td><td>47%</td><td>45%</td></tr>
</table>
<table><tr><td>one row only — skipped</td></tr></table>
<table>
<tr><th>Year</th><th>Winner</th></tr>
<tr><td>2020</td><td>X</td></tr>
<tr><td>2024</td><td>Y</td></tr>
<tr><td>2028</td><td>?</td></tr>
</table>
</body></html>`;

test("extractHtmlTables parses captions, headers, refs, and entities", () => {
  const tables = extractHtmlTables(HTML);
  assert.equal(tables.length, 2, "single-row tables are skipped");
  assert.equal(tables[0].caption, "Opinion polling");
  assert.deepEqual(tables[0].rows[0], ["Pollster", "Date", "Alice", "Bob"]);
  assert.equal(tables[0].rows[1][0], "Acme", "sup refs are stripped");
  assert.equal(tables[0].rows[2][0], "Birch & Co", "entities decode");
});

test("formatTables lists tables and prints the requested one as TSV", () => {
  const tables = extractHtmlTables(HTML);
  const listing = formatTables(tables);
  assert.ok(/2 table\(s\) found/.test(listing));
  assert.ok(/Opinion polling/.test(listing));
  const second = formatTables(tables, 1);
  assert.ok(second.startsWith("Year\tWinner"));
  assert.ok(/2024\tY/.test(second));
  assert.equal(formatTables([]), "no data tables found on the page");
});

test("olsProject band is a real prediction interval — wider with longer extrapolation", () => {
  const { olsProject } = require("../../dist/datatools.js");
  // Noisy-but-linear series: y = x + alternating ±2 noise, 30 daily points.
  const points = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: i + (i % 2 ? 2 : -2),
  }));
  const near = olsProject(points, "2026-02-15"); // ~2 weeks past the data
  const far = olsProject(points, "2026-06-01"); // ~4 months past the data
  assert.ok(near && far);
  const width = (p) => p.hi - p.lo;
  assert.ok(width(far) > width(near), "extrapolation term must widen the band quadratically with distance");
  assert.ok(near.lo < near.projected && near.projected < near.hi);
  // Perfectly linear data → ~zero residuals → ~zero band, any horizon.
  const clean = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: 5 * i,
  }));
  const proj = olsProject(clean, "2026-03-01");
  assert.ok(proj && width(proj) < 1e-9);
  assert.ok(Math.abs(proj.projected - 5 * 59) < 1e-6, "projection follows the line");
});

// ---- projector backtest (proving the RW-drift default) ----

const { mulberry32 } = require("../../dist/forecast.js");

test("backtestProjectors walk-forwards each method and RW-drift beats OLS on a true random walk", () => {
  // A genuine random walk (iid increments, seeded): the best one-step predictor
  // is the last value, so OLS — which fits a global line and extrapolates a
  // spurious slope from accumulated noise — has a larger one-step-ahead MAE than
  // RW-drift (last + mean step). This is the empirical case for the RW-drift default.
  const rand = mulberry32(20240);
  const t0 = Date.parse("2025-01-01");
  const series = [];
  let v = 100;
  for (let i = 0; i < 120; i++) {
    v += (rand() - 0.5) * 6; // zero-drift iid steps
    series.push({ date: new Date(t0 + i * 86400000).toISOString().slice(0, 10), value: v });
  }
  const rows = backtestProjectors([series]);
  const by = Object.fromEntries(rows.map((r) => [r.method, r]));
  assert.ok(by.rwdrift.n > 0 && by.ols.n > 0, "both methods scored");
  assert.ok(by.rwdrift.mase < by.ols.mase, `RW-drift MASE ${by.rwdrift.mase} should beat OLS ${by.ols.mase} on a random walk`);
  assert.ok(by.rwdrift.coverage >= 0 && by.rwdrift.coverage <= 1);
  // Too-short series produce no scored steps.
  assert.equal(backtestProjectors([series.slice(0, 5)]).every((r) => r.n === 0), true);
});

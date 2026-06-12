const test = require("node:test");
const assert = require("node:assert");

const {
  devigProbs,
  normCdf,
  impliedProbAbove,
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

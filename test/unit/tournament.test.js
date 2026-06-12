const test = require("node:test");
const assert = require("node:assert");

const {
  tournamentFromManifold,
  tournamentFromKalshi,
  tournamentFromPolymarket,
  tournamentFromMetaculus,
  platformOutcome,
} = require("../../dist/datatools.js");

// Fixed clock: 2026-06-01T00:00:00Z. Window tests are deterministic.
const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (daysFromNow) => new Date(NOW + daysFromNow * DAY).toISOString();

// ---------------------------------------------------------------- manifold

test("tournamentFromManifold keeps live binary markets in the window and drops junk", () => {
  const data = [
    // good: binary, live, active, closes in 5 days
    {
      id: "m1",
      question: "Will X happen?",
      url: "https://manifold.markets/u/x",
      outcomeType: "BINARY",
      probability: 0.62,
      volume: 1200,
      uniqueBettorCount: 40,
      closeTime: NOW + 5 * DAY,
    },
    // resolved → out
    { id: "m2", question: "Resolved?", outcomeType: "BINARY", probability: 0.5, isResolved: true, closeTime: NOW + 5 * DAY, uniqueBettorCount: 50 },
    // multiple-choice → out
    { id: "m3", question: "Which one?", outcomeType: "MULTIPLE_CHOICE", probability: 0.5, closeTime: NOW + 5 * DAY, uniqueBettorCount: 50 },
    // low activity → out
    { id: "m4", question: "Dead market?", outcomeType: "BINARY", probability: 0.5, volume: 10, uniqueBettorCount: 2, closeTime: NOW + 5 * DAY },
    // closes beyond window → out
    { id: "m5", question: "Far future?", outcomeType: "BINARY", probability: 0.5, volume: 9999, uniqueBettorCount: 99, closeTime: NOW + 60 * DAY },
    // already closed → out
    { id: "m6", question: "Past?", outcomeType: "BINARY", probability: 0.5, volume: 9999, uniqueBettorCount: 99, closeTime: NOW - DAY },
  ];
  const out = tournamentFromManifold(data, 14, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].platform, "manifold");
  assert.equal(out[0].externalId, "m1");
  assert.equal(out[0].probability, 0.62);
  assert.match(out[0].closes, /^\d{4}-\d{2}-\d{2}$/);
});

test("tournamentFromManifold tolerates garbage input", () => {
  assert.deepEqual(tournamentFromManifold(null, 14, NOW), []);
  assert.deepEqual(tournamentFromManifold({ nope: true }, 14, NOW), []);
  assert.deepEqual(tournamentFromManifold([{}, { id: "x" }], 14, NOW), []);
});

// ---------------------------------------------------------------- kalshi

test("tournamentFromKalshi converts cents and applies floors", () => {
  const data = {
    markets: [
      { ticker: "K1", title: "Will Y settle yes?", event_ticker: "EV1", last_price: 35, volume: 5000, close_time: iso(3) },
      // settled price pinned at 0 → out
      { ticker: "K2", title: "Pinned", last_price: 0, volume: 5000, close_time: iso(3) },
      // no volume → out
      { ticker: "K3", title: "Quiet", last_price: 40, volume: 5, close_time: iso(3) },
      // out of window
      { ticker: "K4", title: "Late", last_price: 40, volume: 5000, close_time: iso(40) },
    ],
  };
  const out = tournamentFromKalshi(data, 14, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].externalId, "K1");
  assert.equal(out[0].probability, 0.35);
  assert.ok(out[0].url.includes("EV1"));
});

test("tournamentFromKalshi handles the dollars-string API shape and skips parlays", () => {
  const data = {
    markets: [
      // current API: prices as dollar strings, volume as *_fp strings
      { ticker: "K10", title: "Will the Fed cut?", event_ticker: "EV2", last_price_dollars: "0.4100", volume_fp: "12000", close_time: iso(4) },
      // auto-generated multivariate parlay → out
      { ticker: "K11", title: "Combo", last_price_dollars: "0.20", volume_fp: "9000", close_time: iso(4), mve_collection_ticker: "KXMVE-R" },
      // provisional market → out
      { ticker: "K12", title: "Provisional", last_price_dollars: "0.20", volume_fp: "9000", close_time: iso(4), is_provisional: true },
      // no trade yet, but a live book → midpoint
      { ticker: "K13", title: "Fresh book", event_ticker: "EV3", yes_bid_dollars: "0.30", yes_ask_dollars: "0.40", open_interest_fp: "800", close_time: iso(4) },
    ],
  };
  const out = tournamentFromKalshi(data, 14, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].probability, 0.41);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(out[1].probability, 0.35), `book midpoint should be 0.35, got ${out[1].probability}`);
});

// ---------------------------------------------------------------- polymarket

test("tournamentFromPolymarket parses outcomePrices strings and drops settled extremes", () => {
  const data = [
    {
      id: 101,
      question: "Will Z occur?",
      slug: "will-z-occur",
      closed: false,
      endDate: iso(7),
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.41","0.59"]',
      volume: "150000",
    },
    // pinned at extreme → effectively settled, out
    { id: 102, question: "Done deal", closed: false, endDate: iso(7), outcomes: '["Yes","No"]', outcomePrices: '["0.999","0.001"]', volume: "9000" },
    // non-binary outcomes → out
    { id: 103, question: "Which?", closed: false, endDate: iso(7), outcomes: '["A","B","C"]', outcomePrices: '["0.3","0.3","0.4"]', volume: "9000" },
    // closed → out
    { id: 104, question: "Closed", closed: true, endDate: iso(7), outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume: "9000" },
  ];
  const out = tournamentFromPolymarket(data, 14, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].externalId, "101");
  assert.equal(out[0].probability, 0.41);
  assert.ok(out[0].url.includes("will-z-occur"));
});

// ---------------------------------------------------------------- metaculus

test("tournamentFromMetaculus reads the recency-weighted center and prefers resolve time", () => {
  const data = {
    results: [
      {
        id: 555,
        title: "Will W resolve yes?",
        page_url: "/questions/555/",
        nr_forecasters: 120,
        scheduled_close_time: iso(2),
        scheduled_resolve_time: iso(6),
        question: { aggregations: { recency_weighted: { latest: { centers: [0.27] } } } },
      },
      // too few forecasters → out
      { id: 556, title: "Thin crowd", nr_forecasters: 3, scheduled_resolve_time: iso(6), question: { aggregations: { recency_weighted: { latest: { centers: [0.5] } } } } },
      // resolves beyond window → out
      { id: 557, title: "Distant", nr_forecasters: 120, scheduled_resolve_time: iso(90), question: { aggregations: { recency_weighted: { latest: { centers: [0.5] } } } } },
    ],
  };
  const out = tournamentFromMetaculus(data, 14, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].externalId, "555");
  assert.equal(out[0].probability, 0.27);
  // closes must reflect the RESOLVE time (day 6), not the close time (day 2)
  assert.equal(out[0].closes, iso(6).slice(0, 10));
});

// ---------------------------------------------------------------- platform resolution

test("platformOutcome maps Manifold resolutions", () => {
  assert.deepEqual(platformOutcome("manifold", { isResolved: true, resolution: "YES" }).outcome, 1);
  assert.deepEqual(platformOutcome("manifold", { isResolved: true, resolution: "NO" }).outcome, 0);
  assert.deepEqual(platformOutcome("manifold", { isResolved: true, resolution: "CANCEL" }).outcome, "void");
  // resolve-to-probability is not a hard outcome
  assert.equal(platformOutcome("manifold", { isResolved: true, resolution: "MKT" }), null);
  assert.equal(platformOutcome("manifold", { isResolved: false }), null);
});

test("platformOutcome maps Kalshi settlements", () => {
  assert.equal(platformOutcome("kalshi", { market: { result: "yes" } }).outcome, 1);
  assert.equal(platformOutcome("kalshi", { market: { result: "no" } }).outcome, 0);
  assert.equal(platformOutcome("kalshi", { market: { result: "" } }), null);
  assert.equal(platformOutcome("kalshi", {}), null);
});

test("platformOutcome maps Polymarket settled prices", () => {
  const settledYes = { closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' };
  const settledNo = { closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' };
  const open = { closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]' };
  const ambiguous = { closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' };
  assert.equal(platformOutcome("polymarket", settledYes).outcome, 1);
  assert.equal(platformOutcome("polymarket", settledNo).outcome, 0);
  assert.equal(platformOutcome("polymarket", open), null);
  assert.equal(platformOutcome("polymarket", ambiguous), null);
});

test("platformOutcome maps Metaculus resolutions including annulment", () => {
  assert.equal(platformOutcome("metaculus", { question: { resolution: 1 } }).outcome, 1);
  assert.equal(platformOutcome("metaculus", { question: { resolution: 0 } }).outcome, 0);
  assert.equal(platformOutcome("metaculus", { question: { resolution: -1 } }).outcome, "void");
  assert.equal(platformOutcome("metaculus", { question: { resolution: "annulled" } }).outcome, "void");
  assert.equal(platformOutcome("metaculus", { question: { resolution: null } }), null);
});

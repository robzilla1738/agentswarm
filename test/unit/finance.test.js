const test = require("node:test");
const assert = require("node:assert");
const { parseFinance } = require("../../dist/domains/finance.js");

test("parseFinance extracts a strike for every directional phrasing (above + below synonyms)", () => {
  const cases = [
    ["Will $AAPL close above $150 by 2026-12-31?", 150],
    ["Will $AAPL close below $150 by 2026-12-31?", 150],
    ["Will $AAPL close beneath $150 by 2026-12-31?", 150],
    ["Will $AAPL be less than $150 by 2026-12-31?", 150],
    ["Will $AAPL be greater than $200 by 2026-12-31?", 200],
    ["Will $AAPL be more than $200 by 2026-12-31?", 200],
    ["Will $AAPL be at least $200 by 2026-12-31?", 200],
    ["Will $AAPL be at most $150 by 2026-12-31?", 150],
    ["Will $AAPL reach $1,234.56 by 2026-12-31?", 1234.56],
  ];
  for (const [q, strike] of cases) {
    const f = parseFinance(q);
    assert.ok(f, `should parse: ${q}`);
    assert.equal(f.strike, strike, `strike for "${q}"`);
    assert.equal(f.strong, true, `a parsed strike makes it a strong domain match: ${q}`);
  }
});

test("parseFinance: 'beneath'/'less than' no longer lose the strike (regression)", () => {
  // These words lived in the resolver's direction detector but NOT the strike
  // regex, so a well-formed "below" question lost its options grounding AND its
  // deterministic resolution. Both lists now derive from one shared source.
  assert.equal(parseFinance("Will $AAPL close beneath $150?").strike, 150);
  assert.equal(parseFinance("Will the S&P 500 be less than 5000 by 2026-12-31?").strike, 5000);
});

test("parseFinance returns the direction from the SAME match as the strike (below flag)", () => {
  assert.equal(parseFinance("Will $AAPL close below $150?").below, true);
  assert.equal(parseFinance("Will $AAPL be at most $150?").below, true);
  assert.equal(parseFinance("Will $AAPL close above $150?").below, false);
  assert.equal(parseFinance("Will $AAPL reach $150?").below, false);
});

test("parseFinance: word boundaries stop a direction keyword matching inside another word", () => {
  // "over" inside "discover", "top" inside "laptop" must NOT yield a bogus strike.
  assert.equal(parseFinance("Will $AAPL recover and discover 200 new uses?").strike, undefined);
  assert.equal(parseFinance("Will the $AAPL laptop ship 100 units?").strike, undefined);
});

test("parseFinance: strike and direction come from the SAME clause (no cross-clause drift)", () => {
  // First directional+number match wins for BOTH strike and direction — they
  // cannot be drawn from different clauses (the old code took the strike from the
  // first match but re-scanned the whole text for any below-word).
  const f = parseFinance("Will $NVDA stay above 40 but later drop below 50?");
  assert.equal(f.strike, 40);
  assert.equal(f.below, false, "direction must match the clause the strike came from (above 40)");
});

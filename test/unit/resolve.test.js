const test = require("node:test");
const assert = require("node:assert");

const { resolveOutcome, verdictsAgree } = require("../../dist/resolve.js");
const { isoToDays } = require("../../dist/forecast.js");

// Minimal LedgerEntry shape: resolveOutcome only reads id + question.{kind,options}.
const entry = (kind, options) => ({ id: "f_test", question: { kind, options } });

test("verdictsAgree: small-magnitude numeric readings agree via a band-relative floor, not pure-relative", () => {
  // A margin/net-change near zero: pure-relative 1% tolerance collapses to ~0
  // and would bounce two genuinely-agreeing resolvers to manual settlement,
  // starving numeric calibration. The floor scales to the 80% band (here 20).
  const e = { question: { kind: "numeric" }, aggregate: { quantiles: { p10: -10, p50: 0, p90: 10 } } };
  const v = (value) => ({ outcome: "value", value, evidence: "", confidence: "high", sources: [] });
  assert.equal(verdictsAgree(e, v(0), v(0.3)), true, "0 vs 0.3 agree (floor 0.4 = 2% of band 20)");
  assert.equal(verdictsAgree(e, v(0), v(5)), false, "a real disagreement still fails");
  // Large magnitudes: the relative term dominates and the floor is negligible.
  const big = { question: { kind: "numeric" }, aggregate: {} };
  assert.equal(verdictsAgree(big, v(1_000_000), v(1_005_000)), true, "within 1%");
  assert.equal(verdictsAgree(big, v(1_000_000), v(1_100_000)), false, "10% apart");
});

test("binary: yes/no map to 1/0", () => {
  assert.deepEqual(resolveOutcome(entry("binary"), { outcome: "yes" }), { outcome: 1 });
  assert.deepEqual(resolveOutcome(entry("binary"), { outcome: "no" }), { outcome: 0 });
});

test("binary: a kind-mismatched verdict is fail-closed, not scored as NO", () => {
  // The bug this guards: a "never"/"value"/"option"/"date" verdict on a binary
  // question previously fell through to the binary branch and scored as 0 (NO),
  // silently poisoning the calibration ledger.
  for (const outcome of ["never", "value", "option", "date"]) {
    const r = resolveOutcome(entry("binary"), { outcome });
    assert.ok("skip" in r, `binary + "${outcome}" must skip, got ${JSON.stringify(r)}`);
    assert.match(r.skip, /settle manually/);
  }
});

test("void resolves regardless of kind", () => {
  assert.deepEqual(resolveOutcome(entry("binary"), { outcome: "void" }), { outcome: "void" });
  assert.deepEqual(resolveOutcome(entry("numeric"), { outcome: "void" }), { outcome: "void" });
  assert.deepEqual(resolveOutcome(entry("date"), { outcome: "void" }), { outcome: "void" });
});

test("numeric: value flows through; missing value or wrong kind skips", () => {
  assert.deepEqual(resolveOutcome(entry("numeric"), { outcome: "value", value: 42 }), { outcome: 42 });
  assert.deepEqual(resolveOutcome(entry("numeric"), { outcome: "value", value: 0 }), { outcome: 0 });
  assert.ok("skip" in resolveOutcome(entry("numeric"), { outcome: "value" }));
  assert.ok("skip" in resolveOutcome(entry("numeric"), { outcome: "yes" })); // kind mismatch
});

test("mc: realized option must match the list (case-insensitive), else skip", () => {
  const e = entry("mc", ["Labour", "Conservative", "Reform"]);
  assert.deepEqual(resolveOutcome(e, { outcome: "option", option: "conservative" }), { outcome: "Conservative" });
  const r = resolveOutcome(e, { outcome: "option", option: "Green" });
  assert.ok("skip" in r);
  assert.match(r.skip, /not in the question's option list/);
  assert.ok("skip" in resolveOutcome(e, { outcome: "yes" })); // kind mismatch
});

test("date: never, a parseable date, and the mismatch/empty cases", () => {
  assert.deepEqual(resolveOutcome(entry("date"), { outcome: "never" }), { outcome: "never" });
  assert.deepEqual(resolveOutcome(entry("date"), { outcome: "date", date: "2026-01-15" }), {
    outcome: isoToDays("2026-01-15"),
  });
  assert.ok("skip" in resolveOutcome(entry("date"), { outcome: "date" })); // no date
  assert.ok("skip" in resolveOutcome(entry("date"), { outcome: "date", date: "not-a-date" }));
  assert.ok("skip" in resolveOutcome(entry("date"), { outcome: "yes" })); // kind mismatch
});

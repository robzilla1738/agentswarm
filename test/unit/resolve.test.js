const test = require("node:test");
const assert = require("node:assert");

const { resolveOutcome } = require("../../dist/resolve.js");
const { isoToDays } = require("../../dist/forecast.js");

// Minimal LedgerEntry shape: resolveOutcome only reads id + question.{kind,options}.
const entry = (kind, options) => ({ id: "f_test", question: { kind, options } });

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

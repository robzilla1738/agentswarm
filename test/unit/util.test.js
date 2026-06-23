const test = require("node:test");
const assert = require("node:assert");

const { withTimeout, normalizeWorkdirRel, parseJsonLoose } = require("../../dist/util.js");
const { synthReserve } = require("../../dist/executor.js");

test("normalizeWorkdirRel: same file → same key (lock can't be dodged by spelling)", () => {
  const wd = "/work/repo";
  const k = normalizeWorkdirRel(wd, "src/a.ts");
  assert.equal(k, "src/a.ts");
  // INVARIANT (hard write-lock): absolute, ./, and ..-rejoined spellings of the
  // SAME file must normalize to ONE key, else two live tasks could each write it.
  assert.equal(normalizeWorkdirRel(wd, "./src/a.ts"), k);
  assert.equal(normalizeWorkdirRel(wd, "/work/repo/src/a.ts"), k, "absolute path normalizes to the same key");
  assert.equal(normalizeWorkdirRel(wd, "src/../src/a.ts"), k, "..-rejoin normalizes to the same key");
  // A path escaping the workdir is not lockable (null), never silently mis-keyed.
  assert.equal(normalizeWorkdirRel(wd, "../outside.ts"), null);
  assert.equal(normalizeWorkdirRel(wd, "/etc/passwd"), null);
});

test("parseJsonLoose: tolerates fences/prose, picks the first array or object", () => {
  assert.deepEqual(parseJsonLoose('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseJsonLoose('here you go:\n```json\n["x"]\n```'), ["x"]);
  assert.deepEqual(parseJsonLoose('prose {"k":1} trailing'), { k: 1 });
  assert.equal(parseJsonLoose("not json at all"), undefined);
});

test("withTimeout aborts after the deadline and reports timedOut", async () => {
  const parent = new AbortController();
  const d = withTimeout(parent.signal, 20);
  assert.equal(d.signal.aborted, false);
  assert.equal(d.timedOut(), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(d.signal.aborted, true);
  assert.equal(d.timedOut(), true, "deadline abort is distinguishable");
  d.dispose();
});

test("withTimeout follows a parent abort without marking timedOut", async () => {
  const parent = new AbortController();
  const d = withTimeout(parent.signal, 60_000);
  parent.abort();
  assert.equal(d.signal.aborted, true, "parent abort propagates");
  assert.equal(d.timedOut(), false, "run cancellation is not a timeout");
  d.dispose();
});

test("withTimeout with an already-aborted parent starts aborted", () => {
  const parent = new AbortController();
  parent.abort();
  const d = withTimeout(parent.signal, 60_000);
  assert.equal(d.signal.aborted, true);
  assert.equal(d.timedOut(), false);
  d.dispose();
});

test("withTimeout dispose cancels the deadline", async () => {
  const parent = new AbortController();
  const d = withTimeout(parent.signal, 20);
  d.dispose();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(d.signal.aborted, false, "disposed deadline never fires");
  assert.equal(d.timedOut(), false);
});

test("withTimeout ms=0 disables the deadline", async () => {
  const parent = new AbortController();
  const d = withTimeout(parent.signal, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(d.signal.aborted, false);
  d.dispose();
});

test("synthReserve scales with the cap inside [30K, 120K], never above a quarter of it", () => {
  assert.equal(synthReserve(0, "root"), 0, "no cap, no reserve");
  assert.equal(synthReserve(2_000, "root"), 500, "tiny budgets reserve at most a quarter");
  assert.equal(synthReserve(100_000, "root"), 25_000, "quarter-cap beats the 30K floor on small budgets");
  assert.equal(synthReserve(2_000_000, "root"), 60_000, "3% of the cap in range");
  assert.equal(synthReserve(100_000_000, "root"), 120_000, "huge caps reserve the 120K ceiling");
  assert.equal(synthReserve(12_000_000, "team"), 8_000, "teams reserve a flat 8K for the consolidation call");
  assert.equal(synthReserve(2_000, "team"), 500, "team reserve also bounded by a quarter of the cap");
});

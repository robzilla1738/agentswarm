const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the refstore at a throwaway dir BEFORE requiring the module (home() reads
// AGENTSWARM_HOME at call time, so setting it here is enough).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-refstore-"));
process.env.AGENTSWARM_HOME = tmp;

const { appendRefClass, queryRefClass, seedRefClasses } = require("../../dist/refstore.js");
const { seedCorpus } = require("../../dist/domains/seeds.js");
const { REF_CLASS: CONSTRUCTION_KEY } = require("../../dist/domains/construction.js");

const near = (a, b, eps = 1e-3, msg = "") => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);

test("queryRefClass smooths the base rate (Jeffreys) — 5/5 is ~0.92, never 1.0", () => {
  for (let i = 0; i < 5; i++) {
    appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "all_yes", qkind: "binary", outcome: 1, ledgerId: `e${i}`, t: i });
  }
  const rc = queryRefClass("test", "all_yes");
  assert.equal(rc.binaryN, 5);
  near(rc.rawBaseRate, 1.0, 1e-9, "raw is 1.0");
  near(rc.baseRate, 5.5 / 6, 1e-9, "smoothed (yes+½)/(n+1) = 0.9167");
  assert.ok(rc.baseRate < 1, "smoothed base rate is strictly below 1");
  // Credible interval brackets the estimate and stays inside (0,1).
  assert.ok(rc.ci[0] > 0 && rc.ci[1] < 1 && rc.ci[0] < rc.baseRate && rc.baseRate < rc.ci[1], `ci ${JSON.stringify(rc.ci)}`);
});

test("queryRefClass excludes via filter and counts a mixed class", () => {
  for (const [id, o] of [["a", 1], ["b", 0], ["c", 1], ["d", 0]]) {
    appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "mixed", qkind: "binary", outcome: o, ledgerId: id, t: 1 });
  }
  const all = queryRefClass("test", "mixed");
  assert.equal(all.binaryN, 4);
  near(all.rawBaseRate, 0.5, 1e-9);
  near(all.baseRate, 2.5 / 5, 1e-9, "(2+½)/(4+1) = 0.5");
  // Non-circularity: exclude one of the YES rows by ledgerId.
  const excl = queryRefClass("test", "mixed", (r) => r.ledgerId !== "a");
  assert.equal(excl.binaryN, 3);
  near(excl.rawBaseRate, 1 / 3, 1e-9);
});

test("queryRefClass returns no base rate for an empty class", () => {
  const rc = queryRefClass("test", "does_not_exist");
  assert.equal(rc.binaryN, 0);
  assert.equal(rc.baseRate, undefined);
});

test("seedRefClasses imports a counted corpus, is idempotent, and keeps real resolutions (G-cold-start)", () => {
  // A real (non-seeded) resolution the seeding must preserve — keyed on the SAME
  // key the construction pack actually queries (the seed must feed the real path).
  appendRefClass({ v: 1, kind: "refclass", domain: "construction", refClass: CONSTRUCTION_KEY, qkind: "binary", outcome: 0, ledgerId: "real1", t: 1 });
  const first = seedRefClasses(seedCorpus(0));
  assert.ok(first.added > 0, "imported rows");
  assert.ok(first.kept >= 1, "kept the real (non-seeded) resolutions");
  // CRITICAL: query the key the PACK uses, not the seed key, so a mismatch can't ship green.
  const after1 = queryRefClass("construction", CONSTRUCTION_KEY);
  assert.ok((after1.binaryN ?? 0) >= 5, "the construction pack's own query key resolves the seed (driver gate would fire)");
  // Re-seed: must NOT double-count (idempotent) and must still keep the real rows.
  const second = seedRefClasses(seedCorpus(0));
  assert.equal(second.added, first.added, "same corpus size");
  assert.equal(second.kept, first.kept, "real resolutions survive re-seed unchanged");
  const after2 = queryRefClass("construction", CONSTRUCTION_KEY);
  assert.equal(after1.binaryN, after2.binaryN, "re-seed did not duplicate rows");
  // The seeded construction slip rate is high and Jeffreys-smoothed below 1.
  assert.ok(after2.baseRate > 0.7 && after2.baseRate < 1, `smoothed slip rate ${after2.baseRate}`);
});

test("queryRefClass collapses supersession chains — a re-forecast of the same event counts once (G3)", () => {
  // e1 superseded by e2 superseded by e3, all the SAME event resolving YES.
  appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "chain", qkind: "binary", outcome: 1, ledgerId: "e1", t: 1 });
  appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "chain", qkind: "binary", outcome: 1, ledgerId: "e2", supersedes: "e1", t: 2 });
  appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "chain", qkind: "binary", outcome: 1, ledgerId: "e3", supersedes: "e2", t: 3 });
  // Plus one independent event.
  appendRefClass({ v: 1, kind: "refclass", domain: "test", refClass: "chain", qkind: "binary", outcome: 0, ledgerId: "other", t: 4 });
  const rc = queryRefClass("test", "chain");
  assert.equal(rc.binaryN, 2, "the 3-link chain counts once + the independent event = 2, not 4");
});

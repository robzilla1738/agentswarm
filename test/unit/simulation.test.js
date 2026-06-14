const test = require("node:test");
const assert = require("node:assert");

const {
  normInv,
  sampleFromQuantiles,
  buildCopulaSampler,
  evalCombiner,
  aggregateSimOutcomes,
  checkCoherence,
  runSimulation,
} = require("../../dist/simulation.js");
const {
  mulberry32,
  validateSimStructure,
  parseSimStructure,
  chooseSimulationWeight,
  blendQuantiles,
  blendOptionProbs,
} = require("../../dist/forecast.js");
const { normCdf } = require("../../dist/datatools.js");

const near = (a, b, eps = 0.02, msg = "") => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);

const binDriver = (id, p) => ({ id, label: id, marginal: { kind: "binary", probability: p }, provenance: { kind: "sub-forecast", ref: id, label: id } });
const qDriver = (id, q, logSpace = false) => ({
  id,
  label: id,
  marginal: { kind: "quantiles", quantiles: q, logSpace },
  threshold: q.p50,
  provenance: { kind: "sub-forecast", ref: id, label: id },
});

// ---------------------------------------------------------------- normInv

test("normInv inverts normCdf", () => {
  for (const z of [-2.5, -1, -0.3, 0, 0.3, 1, 2.5]) {
    near(normInv(normCdf(z)), z, 1e-5, `normInv(normCdf(${z}))`);
  }
  // Known quantiles.
  near(normInv(0.5), 0, 1e-6);
  near(normInv(0.975), 1.959964, 1e-3);
});

// ---------------------------------------------------------------- sampleFromQuantiles

test("sampleFromQuantiles reproduces the input quantiles", () => {
  const q = { p10: 10, p25: 15, p50: 20, p75: 30, p90: 40 };
  const rand = mulberry32(42);
  const N = 60000;
  const draws = new Array(N);
  for (let i = 0; i < N; i++) draws[i] = sampleFromQuantiles(q, rand());
  draws.sort((a, b) => a - b);
  const emp = (t) => draws[Math.floor((N - 1) * t)];
  near(emp(0.1), 10, 0.6, "p10");
  near(emp(0.5), 20, 0.6, "p50");
  near(emp(0.9), 40, 0.8, "p90");
});

test("sampleFromQuantiles handles a point mass without crashing", () => {
  const q = { p10: 5, p50: 5, p90: 5 };
  for (const u of [0, 0.3, 0.5, 0.99, 1]) assert.strictEqual(sampleFromQuantiles(q, u), 5);
});

test("sampleFromQuantiles log-space stays positive and monotone", () => {
  const q = { p10: 100, p50: 1000, p90: 100000 };
  const lo = sampleFromQuantiles(q, 0.1, true);
  const mid = sampleFromQuantiles(q, 0.5, true);
  const hi = sampleFromQuantiles(q, 0.9, true);
  assert.ok(lo > 0 && mid > lo && hi > mid, "monotone & positive in log space");
  near(mid, 1000, 50, "log-space p50");
});

// ---------------------------------------------------------------- copula

test("buildCopulaSampler reproduces target correlation", () => {
  const drivers = [binDriver("A", 0.5), binDriver("B", 0.5)];
  const rand = mulberry32(7);
  const draw = buildCopulaSampler(drivers, [{ id1: "A", id2: "B", rho: 0.7 }], rand);
  const N = 40000;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = draw();
    sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
  }
  const cov = sxy / N - (sx / N) * (sy / N);
  const sd = Math.sqrt((sxx / N - (sx / N) ** 2) * (syy / N - (sy / N) ** 2));
  near(cov / sd, 0.7, 0.03, "sample correlation");
});

test("buildCopulaSampler repairs a non-PD correlation matrix (no throw)", () => {
  const drivers = [binDriver("A", 0.5), binDriver("B", 0.5), binDriver("C", 0.5)];
  // Impossible to be jointly PD: A~B +0.9, A~C +0.9, B~C −0.9.
  const deps = [
    { id1: "A", id2: "B", rho: 0.9 },
    { id1: "A", id2: "C", rho: 0.9 },
    { id1: "B", id2: "C", rho: -0.9 },
  ];
  const rand = mulberry32(3);
  const draw = buildCopulaSampler(drivers, deps, rand);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 1000; i++) {
      const z = draw();
      assert.strictEqual(z.length, 3);
      assert.ok(z.every((v) => Number.isFinite(v)));
    }
  });
});

// ---------------------------------------------------------------- combiner

test("evalCombiner: and / or / weighted_sum", () => {
  const idx = new Map([["A", 0], ["B", 1]]);
  const andNode = { op: "and", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] };
  const orNode = { op: "or", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] };
  assert.strictEqual(evalCombiner(andNode, idx, [1, 1]), 1);
  assert.strictEqual(evalCombiner(andNode, idx, [1, 0]), 0);
  assert.strictEqual(evalCombiner(orNode, idx, [0, 1]), 1);
  assert.strictEqual(evalCombiner(orNode, idx, [0, 0]), 0);
  const ws = { op: "weighted_sum", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }], weights: [1, 3] };
  near(evalCombiner(ws, idx, [4, 8]), (1 * 4 + 3 * 8) / 4, 1e-9, "weighted_sum");
});

// ---------------------------------------------------------------- runSimulation: binary

test("AND of two independent binaries ≈ p1·p2", () => {
  const drivers = [binDriver("A", 0.6), binDriver("B", 0.5)];
  const spec = { kind: "binary", root: { op: "and", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const r = runSimulation(drivers, spec, [], 40000, 99);
  near(r.simulatedAggregate.probability, 0.3, 0.02, "P(A∧B) independent");
});

test("OR of two independent binaries ≈ 1−(1−p1)(1−p2)", () => {
  const drivers = [binDriver("A", 0.6), binDriver("B", 0.5)];
  const spec = { kind: "binary", root: { op: "or", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const r = runSimulation(drivers, spec, [], 40000, 99);
  near(r.simulatedAggregate.probability, 1 - 0.4 * 0.5, 0.02, "P(A∨B) independent");
});

test("positive correlation raises P(A∧B) toward min(p1,p2)", () => {
  const drivers = () => [binDriver("A", 0.6), binDriver("B", 0.5)];
  const spec = { kind: "binary", root: { op: "and", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const indep = runSimulation(drivers(), spec, [], 40000, 5).simulatedAggregate.probability;
  const corr = runSimulation(drivers(), spec, [{ id1: "A", id2: "B", rho: 0.8 }], 40000, 5).simulatedAggregate.probability;
  assert.ok(corr > indep + 0.03, `correlated ${corr} should exceed independent ${indep}`);
  assert.ok(corr <= 0.5 + 1e-9, "cannot exceed min(0.6,0.5)");
});

test("positive correlation has a consistent sign across mixed driver kinds (binary ↔ numeric)", () => {
  // A binary driver and a numeric driver, positively correlated. The binary
  // must fire on HIGH latent z (like the numeric value rises with z), so
  // "A fires" and "B is above its median" co-occur. P(A ∧ B>median) must rise
  // ABOVE the independent 0.25 — if binary fired on low z, a positive specified
  // rho would push it BELOW 0.25 (the bug this guards).
  const mk = () => [binDriver("A", 0.5), qDriver("B", { p10: 80, p50: 100, p90: 120 })];
  const spec = {
    kind: "binary",
    root: { op: "and", children: [{ op: "driver", id: "A" }, { op: "threshold", child: { op: "driver", id: "B" }, above: 100 }] },
  };
  const indep = runSimulation(mk(), spec, [], 40000, 7).simulatedAggregate.probability;
  const corr = runSimulation(mk(), spec, [{ id1: "A", id2: "B", rho: 0.85 }], 40000, 7).simulatedAggregate.probability;
  near(indep, 0.25, 0.02, "independent P(A ∧ B>median)");
  assert.ok(corr > indep + 0.05, `positively correlated ${corr} should exceed independent ${indep} (sign must be consistent)`);
});

test("runSimulation is deterministic for a fixed seed", () => {
  const mk = () => [binDriver("A", 0.6), binDriver("B", 0.4)];
  const spec = { kind: "binary", root: { op: "and", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const a = runSimulation(mk(), spec, [], 5000, 1738);
  const b = runSimulation(mk(), spec, [], 5000, 1738);
  assert.strictEqual(a.simulatedAggregate.probability, b.simulatedAggregate.probability);
  assert.deepStrictEqual(a.scenarios[0].key, b.scenarios[0].key);
});

test("scenarios rank by frequency and a tornado is produced", () => {
  const drivers = [binDriver("A", 0.7), binDriver("B", 0.3)];
  const spec = { kind: "binary", root: { op: "and", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const r = runSimulation(drivers, spec, [], 20000, 11);
  assert.ok(r.scenarios.length >= 1);
  for (let i = 1; i < r.scenarios.length; i++) assert.ok(r.scenarios[i - 1].frequency >= r.scenarios[i].frequency, "scenarios sorted desc");
  assert.strictEqual(r.modalScenario.key, r.scenarios[0].key);
  assert.strictEqual(r.sensitivity.length, 2);
  assert.ok(r.sensitivity.every((s) => s.varianceContribution >= 0 && s.varianceContribution <= 1));
});

// ---------------------------------------------------------------- runSimulation: numeric & mc

test("numeric sum combiner ≈ sum of medians", () => {
  const A = qDriver("A", { p10: 0, p50: 10, p90: 20 });
  const B = qDriver("B", { p10: 0, p50: 10, p90: 20 });
  const spec = { kind: "numeric", root: { op: "sum", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const r = runSimulation([A, B], spec, [], 20000, 4);
  near(r.simulatedAggregate.quantiles.p50, 20, 1.5, "sum p50");
  assert.ok(r.simulatedAggregate.quantiles.p10 < r.simulatedAggregate.quantiles.p90, "monotone");
});

test("argmax combiner selects the highest-scoring option (random-utility mc)", () => {
  const idx = new Map([["A", 0], ["B", 1], ["C", 2]]);
  const node = { op: "argmax", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }, { op: "driver", id: "C" }] };
  assert.strictEqual(evalCombiner(node, idx, [0.2, 0.9, 0.5]), 1);
  assert.strictEqual(evalCombiner(node, idx, [0.9, 0.2, 0.5]), 0);
  assert.strictEqual(evalCombiner(node, idx, [0.1, 0.2, 0.99]), 2);
});

test("mc argmax over per-option score subtrees produces a valid simplex over ALL options", () => {
  const A = qDriver("A", { p10: 0, p50: 1, p90: 2 });
  const B = qDriver("B", { p10: 0, p50: 1, p90: 2 });
  const C = qDriver("C", { p10: 0, p50: 1, p90: 2 });
  const spec = {
    kind: "mc",
    mcOptions: ["x", "y", "z"],
    root: { op: "argmax", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }, { op: "driver", id: "C" }] },
  };
  const r = runSimulation([A, B, C], spec, [], 20000, 3);
  const p = r.simulatedAggregate.optionProbs;
  near(Object.values(p).reduce((s, v) => s + v, 0), 1, 1e-9, "sums to 1");
  // Symmetric iid drivers → roughly uniform over 3 options, and every option is reachable.
  for (const o of ["x", "y", "z"]) assert.ok(p[o] > 0.2 && p[o] < 0.47, `option ${o} reachable (${p[o]})`);
});

test("mc out-of-range combiner values are clamped, not dropped (fractions still sum to 1)", () => {
  // A 'sum' over two binaries yields {0,1,2}; with only 2 options, value 2 is
  // out of range and must clamp to the last option, never be discarded.
  const A = binDriver("A", 0.7);
  const B = binDriver("B", 0.7);
  const spec = { kind: "mc", mcOptions: ["lo", "hi"], root: { op: "sum", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  const r = runSimulation([A, B], spec, [], 20000, 6);
  const p = r.simulatedAggregate.optionProbs;
  near(Object.values(p).reduce((s, v) => s + v, 0), 1, 1e-9, "no draws dropped");
});

test("mc combiner buckets into option fractions that sum to 1", () => {
  const A = binDriver("A", 0.7);
  const B = binDriver("B", 0.5);
  // option 0 if A fires else (option 1 if B else option 2)
  const spec = {
    kind: "mc",
    mcOptions: ["x", "y", "z"],
    root: {
      op: "conditional_table",
      conditionDriver: "A",
      ifTrue: { op: "driver", id: "A" }, // value 1 -> rounds to option index 1? handle below
      ifFalse: { op: "threshold", child: { op: "driver", id: "B" }, above: 0.5 },
    },
  };
  const r = runSimulation([A, B], spec, [], 20000, 8);
  const probs = r.simulatedAggregate.optionProbs;
  const sum = Object.values(probs).reduce((s, v) => s + v, 0);
  near(sum, 1, 1e-9, "option probs sum to 1");
  assert.deepStrictEqual(Object.keys(probs).sort(), ["x", "y", "z"]);
});

test("degenerate point-mass drivers don't crash the simulation", () => {
  const A = qDriver("A", { p10: 5, p50: 5, p90: 5 });
  const B = binDriver("B", 0.5);
  const spec = { kind: "numeric", root: { op: "sum", children: [{ op: "driver", id: "A" }, { op: "driver", id: "B" }] } };
  assert.doesNotThrow(() => runSimulation([A, B], spec, [], 5000, 1));
});

// ---------------------------------------------------------------- aggregateSimOutcomes / coherence

test("aggregateSimOutcomes binary fraction", () => {
  const outcomes = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]; // 30% ones
  const agg = aggregateSimOutcomes(outcomes, { kind: "binary", root: { op: "driver", id: "A" } });
  near(agg.probability, 0.3, 1e-9);
});

test("checkCoherence verdicts scale with divergence", () => {
  const sim = { probability: 0.5 };
  assert.strictEqual(checkCoherence(sim, { probability: 0.52 }, "binary").verdict, "ok");
  assert.strictEqual(checkCoherence(sim, { probability: 0.62 }, "binary").verdict, "moderate");
  assert.strictEqual(checkCoherence(sim, { probability: 0.8 }, "binary").verdict, "high");
  assert.strictEqual(checkCoherence(sim, undefined, "binary").verdict, "ok");
});

test("checkCoherence handles a zero-centered numeric question (no scale blow-up)", () => {
  // p50 ≈ 0 (a net-change / anomaly question). Scaling by |p50| would make any
  // gap look infinite; scaling by the p10–p90 width keeps it sane.
  const sim = { quantiles: { p10: -9, p50: 0.2, p90: 11 } };
  const panel = { quantiles: { p10: -10, p50: 0, p90: 10 } };
  const r = checkCoherence(sim, panel, "numeric");
  assert.ok(Number.isFinite(r.divergence) && r.divergence < 0.1, `near-identical zero-centered dists should be 'ok', got ${r.divergence}`);
  assert.strictEqual(r.verdict, "ok");
});

test("binned sensitivity: a continuous driver that determines the outcome scores high η²", () => {
  // Outcome = A (a continuous quantile driver); B is irrelevant. η²(A) should be
  // ~1 and η²(B) ~0 — the 2-group split alone could not separate them this cleanly.
  const A = qDriver("A", { p10: 0, p50: 50, p90: 100 });
  const B = qDriver("B", { p10: 0, p50: 50, p90: 100 });
  const spec = { kind: "numeric", root: { op: "driver", id: "A" } };
  const r = runSimulation([A, B], spec, [], 20000, 9);
  const byId = Object.fromEntries(r.sensitivity.map((s) => [s.driverId, s.varianceContribution]));
  assert.ok(byId.A > 0.85, `A should dominate variance, got ${byId.A}`);
  assert.ok(byId.B < 0.1, `B should be near-zero, got ${byId.B}`);
  assert.strictEqual(r.sensitivity[0].driverId, "A", "tornado ranks A first");
});

// ---------------------------------------------------------------- grounding gate

test("validateSimStructure drops ungrounded drivers and keeps grounded ones", () => {
  const catalog = [binDriver("sf_sf1", 0.5), binDriver("sf_sf2", 0.4)];
  const proposal = {
    drivers: ["sf_sf1", "sf_sf2", "ghost"],
    combiner: { op: "and", children: [{ op: "driver", id: "sf_sf1" }, { op: "driver", id: "sf_sf2" }] },
    dependencies: [{ id1: "sf_sf1", id2: "ghost", rho: 0.5 }],
    rationale: "x",
  };
  const v = validateSimStructure(proposal, catalog, "binary");
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.dropped, ["ghost"]);
  assert.strictEqual(v.drivers.length, 2);
  assert.strictEqual(v.deps.length, 0, "edge touching ghost is dropped");
});

test("validateSimStructure rejects a combiner referencing an ungrounded driver", () => {
  const catalog = [binDriver("sf_sf1", 0.5), binDriver("sf_sf2", 0.4)];
  const proposal = {
    drivers: ["sf_sf1", "sf_sf2"],
    combiner: { op: "and", children: [{ op: "driver", id: "sf_sf1" }, { op: "driver", id: "ghost" }] },
    dependencies: [],
    rationale: "x",
  };
  assert.strictEqual(validateSimStructure(proposal, catalog, "binary").ok, false);
});

test("validateSimStructure rejects a conditional_table whose branch driver is not binary", () => {
  // A continuous (quantiles) conditionDriver compared to 0.5 would be a silent
  // miscompare — the gate must reject it.
  const catalog = [qDriver("num", { p10: 0, p50: 50, p90: 100 }), binDriver("bin", 0.5)];
  const bad = {
    drivers: ["num", "bin"],
    combiner: { op: "conditional_table", conditionDriver: "num", ifTrue: { op: "driver", id: "bin" }, ifFalse: { op: "driver", id: "bin" } },
    dependencies: [],
    rationale: "x",
  };
  assert.strictEqual(validateSimStructure(bad, catalog, "numeric").ok, false);
  // The same structure with a BINARY condition driver is accepted.
  const good = { ...bad, combiner: { ...bad.combiner, conditionDriver: "bin", ifTrue: { op: "driver", id: "num" }, ifFalse: { op: "driver", id: "num" } } };
  assert.strictEqual(validateSimStructure(good, catalog, "numeric").ok, true);
});

test("validateSimStructure rejects fewer than 2 grounded drivers", () => {
  const catalog = [binDriver("sf_sf1", 0.5)];
  const proposal = { drivers: ["sf_sf1"], combiner: { op: "driver", id: "sf_sf1" }, dependencies: [], rationale: "x" };
  assert.strictEqual(validateSimStructure(proposal, catalog, "binary").ok, false);
});

test("parseSimStructure tolerates surrounding prose", () => {
  const raw = 'Here is the structure:\n{"drivers":["a","b"],"combiner":{"op":"and","children":[{"op":"driver","id":"a"}]},"dependencies":[],"rationale":"r"}\nDone.';
  const p = parseSimStructure(raw);
  assert.ok(p);
  assert.deepStrictEqual(p.drivers, ["a", "b"]);
  assert.strictEqual(p.combiner.op, "and");
});

// ---------------------------------------------------------------- blend helpers & weight

test("chooseSimulationWeight returns 0 below the minimum sample", () => {
  assert.strictEqual(chooseSimulationWeight([], "binary"), 0);
  assert.strictEqual(chooseSimulationWeight([], "numeric"), 0);
  assert.strictEqual(chooseSimulationWeight([], "mc"), 0);
});

test("blendQuantiles and blendOptionProbs are identity at w=0", () => {
  const a = { p10: 1, p50: 2, p90: 3 };
  const b = { p10: 10, p50: 20, p90: 30 };
  assert.deepStrictEqual(blendQuantiles(a, b, 0), a);
  near(blendQuantiles(a, b, 1).p50, 20, 1e-9, "w=1 → b");
  const oa = { x: 0.6, y: 0.4 };
  const ob = { x: 0.2, y: 0.8 };
  const blended0 = blendOptionProbs(oa, ob, 0);
  near(blended0.x, 0.6, 1e-6, "option blend identity at w=0");
});

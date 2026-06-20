const test = require("node:test");
const assert = require("node:assert");

const { lgamma, regIncBeta, betaQuantile } = require("../../dist/numerics.js");

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);

test("lgamma matches known values", () => {
  near(lgamma(1), 0, 1e-9, "Γ(1)=1");
  near(lgamma(2), 0, 1e-9, "Γ(2)=1");
  near(Math.exp(lgamma(5)), 24, 1e-6, "Γ(5)=4!=24");
  near(Math.exp(lgamma(0.5)), Math.sqrt(Math.PI), 1e-9, "Γ(½)=√π");
});

test("regIncBeta matches known regularized incomplete beta values", () => {
  // I_x(1,1) = x (uniform CDF).
  near(regIncBeta(0.3, 1, 1), 0.3, 1e-9);
  // Symmetric Beta(2,2): I_0.5 = 0.5.
  near(regIncBeta(0.5, 2, 2), 0.5, 1e-9);
  // Boundaries.
  assert.equal(regIncBeta(0, 2, 3), 0);
  assert.equal(regIncBeta(1, 2, 3), 1);
  // I_x(a,b) = 1 − I_{1−x}(b,a) (reflection).
  near(regIncBeta(0.7, 2, 5), 1 - regIncBeta(0.3, 5, 2), 1e-9);
});

test("betaQuantile inverts regIncBeta and hits known quantiles", () => {
  for (const [a, b] of [[0.5, 0.5], [2, 2], [2, 5], [5, 1]]) {
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const x = betaQuantile(p, a, b);
      near(regIncBeta(x, a, b), p, 1e-6, `betaQuantile(${p},${a},${b})`);
    }
  }
  // Median of the symmetric Jeffreys prior Beta(½,½) is 0.5.
  near(betaQuantile(0.5, 0.5, 0.5), 0.5, 1e-6);
});

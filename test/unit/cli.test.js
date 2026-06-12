const test = require("node:test");
const assert = require("node:assert");

const { optionOverrides } = require("../../dist/cli.js");
const { loadConfig } = require("../../dist/config.js");

const cfg = loadConfig();

test("numeric run flags reject non-numeric input", () => {
  assert.throws(() => optionOverrides({ workers: "abc" }, cfg), /--workers must be a number/);
  assert.throws(() => optionOverrides({ steps: "lots" }, cfg), /--steps must be a number/);
  assert.throws(() => optionOverrides({ tasks: "many" }, cfg), /--tasks must be a number/);
  assert.throws(() => optionOverrides({ budget: "1m" }, cfg), /--budget must be a number/);
});

test("numeric run flags clamp to config ranges", () => {
  assert.equal(optionOverrides({ workers: "999" }, cfg).maxWorkers, 256);
  assert.equal(optionOverrides({ workers: "0" }, cfg).maxWorkers, 1);
  assert.equal(optionOverrides({ workers: "256" }, cfg).maxWorkers, 256);
  assert.equal(optionOverrides({ steps: "30" }, cfg).maxStepsPerTask, 30);
  assert.equal(optionOverrides({ tasks: "5000" }, cfg).maxTasks, 1000);
  assert.equal(optionOverrides({ budget: "1000000" }, cfg).maxTokens, 1_000_000);
  assert.equal(optionOverrides({ budget: "2000" }, cfg).maxTokens, 2_000, "per-run budgets may dip below the config floor");
  assert.equal(optionOverrides({ budget: "10" }, cfg).maxTokens, 1_000, "but not below 1K");
});

test("unset flags leave options untouched", () => {
  const o = optionOverrides({}, cfg);
  assert.equal(o.maxWorkers, undefined);
  assert.equal(o.maxTokens, undefined);
});

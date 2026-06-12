const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { taskTable } = require("../../dist/prompts.js");
const { CallGate } = require("../../dist/deepseek.js");
const { RunState } = require("../../dist/state.js");

function mkTask(i, wave, status) {
  return {
    id: `T${i}`, title: `task ${i}`, objective: "o", role: "worker", deps: [],
    verify: false, status, attempt: 1, wave, artifacts: [], createdAt: 0, agentIds: [],
  };
}

test("taskTable collapses settled waves but keeps failures itemized", () => {
  const tasks = [];
  let n = 0;
  for (let w = 1; w <= 10; w++) {
    for (let i = 0; i < 50; i++) tasks.push(mkTask(++n, w, "done"));
  }
  tasks.push(mkTask(++n, 3, "failed"));
  tasks[tasks.length - 1].error = "exploded badly";
  tasks.push(mkTask(++n, 10, "running"));
  const table = taskTable(tasks);
  assert.ok(table.length < 8000, `500-task table should be compact, got ${table.length} chars`);
  assert.ok(/wave 3: 50 done/.test(table), "old waves collapse to one line");
  assert.ok(table.includes("exploded badly"), "failures stay itemized with their error");
  assert.ok(new RegExp(`T${n} \\[running\\]`).test(table), "active tasks stay full-line");
});

test("taskTable stays itemized for small runs", () => {
  const tasks = [mkTask(1, 1, "done"), mkTask(2, 1, "running")];
  const table = taskTable(tasks);
  assert.ok(table.includes("T1 [done]") && table.includes("T2 [running]"));
});

test("CallGate enforces ceiling and AIMD on 429", async () => {
  const gate = new CallGate(2);
  await gate.acquire("normal");
  await gate.acquire("normal");
  let third = false;
  const p = gate.acquire("normal").then(() => (third = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, "third call queues behind the ceiling");
  gate.release();
  await p;
  assert.equal(third, true);

  gate.reportRateLimit(0);
  assert.equal(gate.state().ceiling, 1, "429 halves toward the floor of 1");
  for (let i = 0; i < 10; i++) gate.reportSuccess();
  assert.equal(gate.state().ceiling, 2, "gate recovers from a ceiling of 1");
  const big = new CallGate(16);
  big.reportRateLimit(0);
  assert.equal(big.state().ceiling, 8);
  for (let i = 0; i < 10; i++) big.reportSuccess();
  assert.equal(big.state().ceiling, 9, "sustained successes recover additively");
});

test("CallGate high priority jumps the queue", async () => {
  const gate = new CallGate(1);
  await gate.acquire("normal");
  const order = [];
  const a = gate.acquire("normal").then(() => order.push("normal"));
  const b = gate.acquire("high").then(() => order.push("high"));
  gate.release();
  await Promise.race([b, a]);
  gate.release();
  await Promise.all([a, b]);
  assert.deepEqual(order[0], "high");
});

test("reducer partitions teamId events into team sub-state", () => {
  let seq = 0;
  const ev = (type, payload = {}) => ({ seq: ++seq, t: 1000 + seq, type, ...payload });
  const s = new RunState({ m: { inMiss: 1, inHit: 0, out: 1 } });
  s.apply(ev("task.created", { task: mkTask(1, 1, "running") }));
  s.apply(ev("task.created", { teamId: "T1", task: mkTask(1, 1, "pending") }));
  s.apply(ev("task.created", { teamId: "T1", task: mkTask(2, 1, "pending") }));
  s.apply(ev("usage", { teamId: "T1", model: "m", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0, cacheMissTokens: 100 } }));
  assert.equal(s.taskList().length, 1, "root sees only the team task");
  assert.equal(s.teams.get("T1").taskList().length, 2, "team sub-state holds the child tasks");
  assert.equal(s.totalUsage.promptTokens, 100, "team usage rolls up to the root totals");
});

test("cross-run memory round-trips and renders a prompt block", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mem-test-"));
  process.env.AGENTSWARM_HOME = home;
  delete require.cache[require.resolve("../../dist/memory.js")];
  delete require.cache[require.resolve("../../dist/config.js")];
  const { appendMemory, loadMemory, memoryBlock } = require("../../dist/memory.js");
  const cwd = "/tmp/some-project";
  assert.equal(memoryBlock(cwd), "");
  appendMemory(cwd, { mission: "build the API", finishedAt: 1750000000000, status: "done", summary: "API built and tested", keyDecisions: ["use sqlite"] });
  assert.equal(loadMemory(cwd).length, 1);
  const block = memoryBlock(cwd);
  assert.ok(block.includes("PRIOR RUNS") && block.includes("build the API") && block.includes("use sqlite"));
  for (let i = 0; i < 25; i++) appendMemory(cwd, { mission: `m${i}`, finishedAt: 1, status: "done", summary: "s", keyDecisions: [] });
  assert.ok(loadMemory(cwd).length <= 20, "memory is capped");
  fs.rmSync(home, { recursive: true, force: true });
});

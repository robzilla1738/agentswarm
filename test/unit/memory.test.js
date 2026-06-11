// Unit tests for cross-run memory: atomic writes, runId-keyed replacement.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTSWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mem-"));
const { appendMemory, loadMemory, memoryBlock } = require("../../dist/memory.js");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mem-ws-"));

test("entries accumulate and runId-keyed entries replace in place", () => {
  appendMemory(cwd, { runId: "run_a", mission: "m1", finishedAt: 1, status: "in-progress", summary: "halfway", keyDecisions: [] });
  appendMemory(cwd, { runId: "run_b", mission: "m2", finishedAt: 2, status: "done", summary: "done two", keyDecisions: ["use X"] });
  assert.equal(loadMemory(cwd).length, 2);

  // The final write for run_a replaces its interim snapshot.
  appendMemory(cwd, { runId: "run_a", mission: "m1", finishedAt: 3, status: "done", summary: "completed", keyDecisions: [] });
  const entries = loadMemory(cwd);
  assert.equal(entries.length, 2);
  const a = entries.find((e) => e.runId === "run_a");
  assert.equal(a.status, "done");
  assert.equal(a.summary, "completed");
});

test("memoryBlock renders prior runs", () => {
  const block = memoryBlock(cwd);
  assert.match(block, /PRIOR RUNS IN THIS WORKSPACE/);
  assert.match(block, /use X/);
});

test("entries without runId still append (legacy)", () => {
  const before = loadMemory(cwd).length;
  appendMemory(cwd, { mission: "legacy", finishedAt: 4, status: "done", summary: "s", keyDecisions: [] });
  appendMemory(cwd, { mission: "legacy2", finishedAt: 5, status: "done", summary: "s", keyDecisions: [] });
  assert.equal(loadMemory(cwd).length, before + 2);
});

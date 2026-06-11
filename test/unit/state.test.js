const test = require("node:test");
const assert = require("node:assert");
const { RunState } = require("../../dist/state.js");

let seq = 0;
const ev = (type, payload = {}) => ({ seq: ++seq, t: 1000 + seq, type, ...payload });
const task = (id, extra = {}) => ({
  id,
  objective: `do ${id}`,
  role: "worker",
  status: "pending",
  deps: [],
  attempt: 0,
  ...extra,
});

test("task lifecycle reduces to done with report", () => {
  const s = new RunState();
  s.apply(ev("task.created", { task: task("T1") }));
  s.apply(ev("task.status", { taskId: "T1", status: "running" }));
  s.apply(ev("task.report", { taskId: "T1", status: "done", report: "did it", artifacts: ["a.md"] }));
  s.apply(ev("task.status", { taskId: "T1", status: "done" }));
  const t = s.tasks.get("T1");
  assert.equal(t.status, "done");
  assert.equal(t.report, "did it");
  assert.deepEqual(t.artifacts, ["a.md"]);
  assert.ok(t.startedAt && t.endedAt);
});

test("run.resumed resets in-flight tasks and closes running agents", () => {
  const s = new RunState();
  s.apply(ev("task.created", { task: task("T1") }));
  s.apply(ev("task.created", { task: task("T2") }));
  s.apply(ev("task.status", { taskId: "T1", status: "done" }));
  s.apply(ev("task.status", { taskId: "T2", status: "running" }));
  s.apply(ev("agent.spawned", { agentId: "a1", taskId: "T2" }));
  s.apply(ev("run.resumed", { resets: ["T2"] }));
  assert.equal(s.tasks.get("T1").status, "done");
  assert.equal(s.tasks.get("T2").status, "pending");
  assert.equal(s.tasks.get("T2").startedAt, undefined);
  assert.equal(s.agents.get("a1").status, "done");
});

test("usage accumulates per model and totals", () => {
  const s = new RunState({ m1: { inputPerM: 1, outputPerM: 2 } });
  const usage = { promptTokens: 100, completionTokens: 50, cacheHitTokens: 0, cacheMissTokens: 100 };
  s.apply(ev("usage", { model: "m1", usage }));
  s.apply(ev("usage", { model: "m1", usage }));
  assert.equal(s.totalUsage.promptTokens, 200);
  assert.equal(s.usageByModel.get("m1").completionTokens, 100);
});

test("summary counts verifying as running", () => {
  const s = new RunState();
  s.apply(ev("run.created", { meta: { id: "r1", mission: "m", createdAt: 1, options: { model: "x" } } }));
  s.apply(ev("task.created", { task: task("T1") }));
  s.apply(ev("task.status", { taskId: "T1", status: "verifying" }));
  assert.equal(s.summary().tasks.running, 1);
});

test("task.checkpoint survives a resume reset", () => {
  const s = new RunState();
  s.apply(ev("task.created", { task: task("T1") }));
  s.apply(ev("task.status", { taskId: "T1", status: "running" }));
  s.apply(ev("task.checkpoint", { taskId: "T1", agentId: "w1", attempt: 1, summary: "half done" }));
  s.apply(ev("run.resumed", { resets: ["T1"] }));
  const t = s.tasks.get("T1");
  assert.equal(t.status, "pending");
  assert.equal(t.lastCheckpoint, "half done");
});

test("phase.set events accumulate", () => {
  const s = new RunState();
  s.apply(ev("phase.set", { name: "discovery", goal: "map the domain", exit_criteria: "scouts reported" }));
  s.apply(ev("phase.set", { name: "build" }));
  assert.equal(s.phases.length, 2);
  assert.equal(s.phases[1].name, "build");
  assert.equal(s.phases[0].exitCriteria, "scouts reported");
});

test("task.report carries structured handoff fields", () => {
  const s = new RunState();
  s.apply(ev("task.created", { task: task("T1") }));
  s.apply(ev("task.report", {
    taskId: "T1", status: "done", report: "r", artifacts: [],
    keyFacts: ["f1"], openQuestions: ["q1"], filesTouched: ["a.ts"],
  }));
  const t = s.tasks.get("T1");
  assert.deepEqual(t.keyFacts, ["f1"]);
  assert.deepEqual(t.openQuestions, ["q1"]);
  assert.deepEqual(t.filesTouched, ["a.ts"]);
});

test("decision notes survive the note cap", () => {
  const s = new RunState();
  s.apply(ev("note.added", { kind: "decision", text: "use sqlite" }));
  for (let i = 0; i < 1200; i++) s.apply(ev("note.added", { text: `n${i}` }));
  assert.ok(s.notes.some((n) => n.kind === "decision" && n.text === "use sqlite"));
  assert.ok(s.notes.length <= 1000);
});

test("notes are retained with keys", () => {
  const s = new RunState();
  s.apply(ev("note.added", { taskId: "T1", key: "finding", text: "x" }));
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].key, "finding");
});

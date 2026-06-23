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

test("team note.added lands on the root blackboard (resume must keep team decisions)", () => {
  const s = new RunState();
  s.apply(ev("note.added", { teamId: "T9", taskId: "T2", kind: "decision", text: "team picked sqlite" }));
  assert.equal(s.notes.length, 1, "team notes are swarm-wide facts");
  assert.equal(s.notes[0].teamId, "T9", "teamId survives so claim owners stay namespaced");
  assert.equal(s.notes[0].text, "team picked sqlite");
  // The team sub-state keeps its own copy for the team detail view.
  assert.equal(s.teams.get("T9").notes.length, 1);
  // Team tasks still stay off the root board.
  s.apply(ev("task.created", { teamId: "T9", task: task("T1") }));
  assert.equal(s.tasks.size, 0);
});

test("team usage events never overwrite the run's cumulative cost", () => {
  const s = new RunState({ m1: { inMiss: 1, inHit: 0.1, out: 2 } });
  const usage = { promptTokens: 1000000, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 1000000 };
  s.apply(ev("usage", { model: "m1", usage, cost: 1.0 }));
  const before = s.cost;
  // Child executor's own cumulative cost (tiny) rides on the event.
  s.apply(ev("usage", { teamId: "T9", model: "m1", usage, cost: 0.01 }));
  assert.ok(s.cost > before, `team usage must accrue (got ${s.cost} after ${before})`);
});

test("code mode: resume idempotency — criteria, build plan, baseline + green SHA restore from the journal", () => {
  // INVARIANT: planCode does NOT re-run on resume, so the engine must rehydrate
  // its tracked state from the journal — else it would re-split criteria, re-plan,
  // and the diff-review baseline would be lost (review silently skipped).
  const s = new RunState();
  const profile = { greenfield: false, commands: { build: "npm run build", test: "npm test" }, conventions: [], manifestFiles: ["package.json"], packageManager: "npm", primaryLanguage: "TypeScript", framework: null, monorepo: { tool: null, packages: [] }, git: { isRepo: true, branch: "main", dirty: false } };
  s.apply(ev("code.plan", { profile, commit: true, branch: "swarm/run_x", baseline: "abc1234" }));
  s.apply(ev("code.criteria", { items: [{ id: "AC1", text: "does X", met: false }, { id: "AC2", text: "does Y", met: false }] }));
  s.apply(ev("code.design", { plan: { modules: [{ id: "m1", files: ["a.ts"], purpose: "p", deps: [] }], scaffoldFirst: false, integrationPerWave: true, waves: [["m1"]] } }));
  s.apply(ev("code.checkpoint", { sha: "green99", taskId: "T2" }));

  assert.equal(s.codeCommitEnabled, true);
  assert.equal(s.codeBranch, "swarm/run_x");
  assert.equal(s.codeBaselineSha, "abc1234", "diff-review baseline restored (else review never runs after resume)");
  assert.equal(s.acceptanceItems.length, 2, "tracked acceptance criteria restored (no re-split on resume)");
  assert.equal(s.acceptanceItems[1].id, "AC2");
  assert.ok(s.buildPlan && s.buildPlan.waves.length === 1, "build plan restored (no re-plan on resume)");
  assert.equal(s.lastGreenSha, "green99", "last green SHA restored (sandbox resume-reset target)");
});

test("source tracking: tool events, notes, and reports roll up deduped", () => {
  const s = new RunState();
  s.apply(ev("task.created", { task: task("T1") }));
  // fetch_url call args count immediately
  s.apply(ev("tool.call", { agentId: "a1", taskId: "T1", name: "fetch_url", args: { url: "https://example.com/page" } }));
  // tool.result urls[] is the full harvested list (www + trailing slash canonicalize away)
  s.apply(
    ev("tool.result", {
      agentId: "a1", taskId: "T1", name: "web_search", ok: true, summary: "…",
      urls: ["https://www.example.com/page/", "https://other.org/a?utm_source=x", "https://third.net/b"],
    })
  );
  // non-web tools never count
  s.apply(ev("tool.result", { agentId: "a1", taskId: "T1", name: "shell", ok: true, summary: "https://not-a-source.com" }));
  // failed web calls never count
  s.apply(ev("tool.result", { agentId: "a1", taskId: "T1", name: "web_search", ok: false, urls: ["https://failed.example.com"] }));
  // blackboard note url + reported sources
  s.apply(ev("note.added", { taskId: "T1", text: "fact", url: "https://noted.io/x" }));
  s.apply(ev("task.report", { taskId: "T1", status: "done", report: "r", artifacts: [], sources: [{ url: "https://cited.dev/paper" }] }));
  assert.equal(s.sourceUrls.size, 5, [...s.sourceUrls].join(", "));
  assert.equal(s.summary().sourceCount, 5);
  // team-stamped tool events roll up to the root like usage
  s.apply(ev("tool.result", { teamId: "T1", agentId: "b1", taskId: "X1", name: "fetch_url", ok: true, urls: ["https://team.dev/page"] }));
  assert.equal(s.sourceUrls.size, 6);
});

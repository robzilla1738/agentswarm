const test = require("node:test");
const assert = require("node:assert");
const { depReportBlock, reportBlock, budgetLine } = require("../../dist/prompts.js");

const baseTask = {
  id: "T1",
  title: "Scout",
  objective: "o",
  role: "researcher",
  deps: [],
  verify: false,
  status: "done",
  attempt: 1,
  wave: 1,
  artifacts: ["out.md"],
  createdAt: 0,
  agentIds: [],
};

test("depReportBlock excerpts long reports and points at read_report", () => {
  const t = { ...baseTask, report: "x".repeat(5000), keyFacts: ["fact one"] };
  const block = depReportBlock(t);
  assert.ok(block.length < 2000);
  assert.ok(block.includes('read_report("T1")'));
  assert.ok(block.includes("fact one"));
});

test("depReportBlock keeps short reports whole without the excerpt marker", () => {
  const t = { ...baseTask, report: "short and sweet" };
  const block = depReportBlock(t);
  assert.ok(block.includes("short and sweet"));
  assert.ok(!block.includes("read_report"));
});

test("reportBlock includes structured handoff fields", () => {
  const t = { ...baseTask, report: "r", keyFacts: ["kf"], openQuestions: ["oq"], filesTouched: ["f.ts"] };
  const block = reportBlock(t);
  assert.ok(block.includes("kf") && block.includes("oq") && block.includes("f.ts"));
});

test("budgetLine escalates urgency near the cap", () => {
  assert.ok(!budgetLine({ total: 10, cost: 0 }, 100).includes("WIND DOWN"));
  assert.ok(budgetLine({ total: 80, cost: 0 }, 100).includes("tightening"));
  assert.ok(budgetLine({ total: 95, cost: 0 }, 100).includes("WIND DOWN NOW"));
});

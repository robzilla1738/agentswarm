const test = require("node:test");
const assert = require("node:assert");
const {
  depReportBlock,
  reportBlock,
  budgetLine,
  acceptanceCriteriaSplitPrompt,
  planBuildSpecPrompt,
  codeConductorAddendum,
  codeParityPrompt,
} = require("../../dist/prompts.js");

const baseProfile = {
  greenfield: true,
  primaryLanguage: null,
  packageManager: null,
  framework: null,
  commands: {},
  monorepo: { tool: null, packages: [] },
  git: { isRepo: false, branch: null, dirty: false },
  conventions: [],
  manifestFiles: [],
};

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

test("reportBlock marks clipped reports with the read_report hint", () => {
  const long = { ...baseTask, report: "x".repeat(5000) };
  assert.ok(reportBlock(long).includes('read_report("T1")'));
  const short = { ...baseTask, report: "short and sweet" };
  assert.ok(!reportBlock(short).includes("read_report"));
});

test("budgetLine escalates urgency near the cap", () => {
  assert.ok(!budgetLine({ total: 10, cost: 0 }, 100).includes("WIND DOWN"));
  assert.ok(budgetLine({ total: 80, cost: 0 }, 100).includes("tightening"));
  assert.ok(budgetLine({ total: 95, cost: 0 }, 100).includes("WIND DOWN NOW"));
});

test("acceptanceCriteriaSplitPrompt EXPANDS scope for exhaustive builds (never drops named capabilities)", () => {
  const mission = "Clone the Claude.ai chat UI with skills and connectors";
  const exhaustive = acceptanceCriteriaSplitPrompt(mission, "1:1 parity", { ambition: "exhaustive", cap: 40, greenfield: true });
  // It must instruct breadth + preservation of named capabilities, not pruning.
  assert.ok(/ENUMERATE THE REAL SURFACE AREA/.test(exhaustive));
  assert.ok(/NEVER silently drop a named capability/i.test(exhaustive));
  assert.ok(exhaustive.includes("40"), "the cap is parameterized into the prompt");
  // Standard keeps the original tight behavior + the parameterized cap.
  const standard = acceptanceCriteriaSplitPrompt(mission, "done when tests pass", { ambition: "standard", cap: 18, greenfield: false });
  assert.ok(/Keep 1–18 items/.test(standard));
  assert.ok(!/ENUMERATE THE REAL SURFACE AREA/.test(standard));
});

test("planBuildSpecPrompt widens decomposition for exhaustive builds", () => {
  const items = [{ id: "AC1", text: "renders chat", met: false }];
  const exhaustive = planBuildSpecPrompt("build it", baseProfile, items, { ambition: "exhaustive", maxModules: 24 });
  assert.ok(/Decompose for BREADTH/.test(exhaustive));
  assert.ok(exhaustive.includes("24"));
  const standard = planBuildSpecPrompt("build it", baseProfile, items, { ambition: "standard", maxModules: 8 });
  assert.ok(/Keep it tight: 2–8 modules/.test(standard));
});

const sampleSpec = {
  productName: "Notion",
  oneLiner: "all-in-one workspace",
  features: [
    { name: "Block editor", description: "rich blocks", priority: "core" },
    { name: "Database views", description: "table/board/calendar", priority: "core" },
  ],
  screens: [{ name: "Sidebar", purpose: "nav", elements: ["page tree", "search"] }],
  dataModel: [{ entity: "Page", fields: ["id", "title"], relations: "has many Block" }],
  recommendedStack: { frontend: "Next.js", database: "Postgres", styling: "Tailwind", testing: "Vitest", rationale: "modern" },
  uxDetails: ["empty state", "slash menu"],
  nonGoals: ["mobile"],
  sources: ["https://notion.so"],
  grounded: true,
};

test("acceptanceCriteriaSplitPrompt GROUNDS the checklist in a researched spec when present", () => {
  const grounded = acceptanceCriteriaSplitPrompt("Notion clone", "1:1 parity", { ambition: "exhaustive", cap: 40, greenfield: true, spec: sampleSpec });
  assert.ok(/GROUNDED PRODUCT SPEC/.test(grounded), "injects the spec block");
  assert.ok(/DERIVE the checklist from the GROUNDED PRODUCT SPEC/.test(grounded), "derives from facts, not memory");
  assert.ok(grounded.includes("Block editor"), "the real researched features appear");
  // Without a spec it falls back to the memory-enumeration rule.
  const ungrounded = acceptanceCriteriaSplitPrompt("Notion clone", "1:1 parity", { ambition: "exhaustive", cap: 40, greenfield: true });
  assert.ok(/ENUMERATE THE REAL SURFACE AREA/.test(ungrounded));
  assert.ok(!/GROUNDED PRODUCT SPEC/.test(ungrounded));
});

test("planBuildSpecPrompt pins the researched stack for greenfield and threads the perspective", () => {
  const items = [{ id: "AC1", text: "renders editor", met: false }];
  const grounded = planBuildSpecPrompt("Notion clone", baseProfile, items, {
    ambition: "exhaustive",
    maxModules: 24,
    spec: sampleSpec,
    perspective: "VERTICAL FEATURE SLICES — one module per feature.",
  });
  assert.ok(/RESEARCHED stack/.test(grounded), "greenfield uses the pinned researched stack");
  assert.ok(/Next\.js · Postgres · Tailwind · Vitest/.test(grounded), "stackLine renders the chosen stack");
  assert.ok(/GROUNDED PRODUCT SPEC/.test(grounded), "the spec is injected into the plan prompt too");
  assert.ok(/PARTITION LENS for THIS proposal/.test(grounded), "the ensemble perspective is threaded in");
  // Without a spec greenfield still says "choose a stack".
  const ungrounded = planBuildSpecPrompt("x", baseProfile, items, { ambition: "exhaustive", maxModules: 24 });
  assert.ok(/choose a stack/.test(ungrounded));
});

test("codeConductorAddendum tells the conductor NOT to re-spawn engine-pre-created tasks", () => {
  const preseeded = codeConductorAddendum(baseProfile, "done", [{ id: "AC1", text: "x", met: false }], undefined, true, true);
  assert.ok(/ALREADY created/i.test(preseeded));
  assert.ok(/DO NOT re-spawn/i.test(preseeded));
  // Without pre-creation it still drives the classic build pipeline itself.
  const freeform = codeConductorAddendum(baseProfile, "done", [{ id: "AC1", text: "x", met: false }], undefined, true, false);
  assert.ok(/WAVE 1 = ONE task only/.test(freeform));
  assert.ok(!/ALREADY created/i.test(freeform));
});

test("codeParityPrompt judges completeness vs the full mission (not just compiles)", () => {
  const p = codeParityPrompt("Clone X with skills + connectors", [{ id: "AC1", text: "x", met: false }], "T1 done", "report", "diff");
  assert.ok(/COMPLETENESS and PARITY/i.test(p));
  assert.ok(/Named capabilities/.test(p));
  assert.ok(/EXACTLY "COMPLETE"/.test(p), "has a clean COMPLETE sentinel");
  assert.ok(/Wired, not dead/i.test(p), "demands every interactive control be wired");
});

test("codeParityPrompt injects deterministic stub signals when provided", () => {
  const stubs = "- dead-handler (1):\n    src/App.tsx:5  onClick={() => {}}";
  const withStubs = codeParityPrompt("Clone X", [], "T1", "report", "diff", stubs);
  assert.ok(/DETERMINISTIC STUB SIGNALS/.test(withStubs));
  assert.ok(withStubs.includes("onClick={() => {}}"));
  const without = codeParityPrompt("Clone X", [], "T1", "report", "diff");
  assert.ok(!/DETERMINISTIC STUB SIGNALS/.test(without), "no stub block when none passed");
});

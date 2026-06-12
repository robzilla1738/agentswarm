// End-to-end test: boots a mock DeepSeek server and drives real missions
// through the compiled engine. Phase 1 = happy path; Phase 2 = invalid API key
// (must fail loudly, not silently "complete").
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// Deterministic conductor wake-ups: no settle debounce in tests (children
// inherit this via { ...process.env }).
process.env.SWARM_SETTLE_DEBOUNCE_MS = "0";
const SWARM = path.join(ROOT, "bin", "swarm.js");

function fail(msg) {
  console.error("\n❌ FAIL: " + msg);
  process.exit(1);
}
const ok = (m) => console.log("  ✓ " + m);

function startMock(extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, "mock-deepseek.js"), "0"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ...extraEnv },
    });
    const t = setTimeout(() => reject(new Error("mock did not start")), 5000);
    proc.stdout.on("data", (b) => {
      const m = /MOCK_PORT=(\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(t);
        resolve({ proc, port: Number(m[1]) });
      }
    });
  });
}

function writeConfig(home, port, extra = {}) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      apiKey: "test-key-0123456789abcdef0123456789",
      baseUrl: `http://127.0.0.1:${port}`,
      maxWorkers: 3,
      hubPort: 0,
      // Deterministic: phases pick their sandbox explicitly.
      sandboxRuntime: "host",
      ...extra,
    }, null, 2)
  );
}

function events(runDir) {
  return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Poll until fn() resolves truthy (fn may throw/reject while files appear). */
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* not ready */ }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) fail(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function phaseHappy() {
  console.log("\n▶ Phase 1: happy path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: scout A and B then synthesize", "--workers", "3"], {
    env, encoding: "utf8", timeout: 60000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm run exited ${res.status}`); }
  ok("swarm run completed");

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  if (ids.length !== 1) fail(`expected 1 run, found ${ids.length}`);
  const runDir = path.join(home, "runs", ids[0]);
  const evs = events(runDir);
  const byType = (t) => evs.filter((e) => e.type === t);

  if (byType("task.created").length !== 3) fail("expected 3 tasks created");
  ok("conductor spawned 3 tasks");

  const waves = new Set(byType("task.created").map((e) => e.task.wave));
  if (waves.size !== 1 || !waves.has(1)) fail(`tasks from one spawn_tasks call must share wave 1, got ${[...waves]}`);
  ok("all tasks of the batch share wave 1");

  const doneIds = new Set(byType("task.status").filter((e) => e.status === "done").map((e) => e.taskId));
  if (doneIds.size !== 3) fail(`expected 3 done, got ${doneIds.size}`);
  ok("all 3 tasks reached done");

  const startedAt = {}, endedAt = {};
  for (const e of byType("task.status")) {
    if (e.status === "running" && startedAt[e.taskId] == null) startedAt[e.taskId] = e.t;
    if (e.status === "done") endedAt[e.taskId] = e.t;
  }
  if (!(startedAt.T3 >= endedAt.T1 && startedAt.T3 >= endedAt.T2)) fail("T3 started before its deps finished");
  ok("dependent task T3 started only after T1 & T2 completed");
  if (startedAt.T1 <= endedAt.T2 && startedAt.T2 <= endedAt.T1) ok("T1 and T2 ran in parallel");

  if (!byType("verify.result").some((v) => v.taskId === "T3" && v.pass)) fail("expected passing verdict on T3");
  ok("adversarial verification ran and passed on T3");

  if (byType("tool.call").filter((e) => e.name === "shell").length < 3) fail("expected >=3 shell calls");
  ok("workers executed real shell commands");

  if (!byType("usage").length) fail("no usage recorded");
  ok(`usage tracked across ${byType("usage").length} model calls`);

  const reportFile = path.join(runDir, "artifacts", "final-report.md");
  if (!fs.existsSync(reportFile) || !/Mission Report/.test(fs.readFileSync(reportFile, "utf8"))) fail("final report missing/incomplete");
  ok("synthesizer wrote final-report.md");

  const htmlFile = path.join(runDir, "artifacts", "final-report.html");
  const htmlBody = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, "utf8") : "";
  if (!/^<!doctype html>/.test(htmlBody) || !/Mission Report/.test(htmlBody)) fail("final-report.html missing/incomplete");
  ok("engine rendered final-report.html alongside the markdown");

  if (byType("run.status").pop().status !== "done") fail("run did not end as done");
  ok("run finished with status=done");

  if (byType("conductor.say").some((e) => /LEDGER-SEEN/.test(String(e.text)))) {
    fail("a fresh (non-resumed, non-trimmed) run must not inject a mission ledger");
  }
  ok("no mission ledger injected on a fresh run");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseAuthFail() {
  console.log("\n▶ Phase 2: invalid API key must fail loudly");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_AUTH: "invalid" });
  ok(`mock (401 mode) on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  // 2a: `swarm run` must refuse at launch (CLI preflight) and create no run.
  const res = spawnSync(process.execPath, [SWARM, "run", "should not start", "--workers", "2"], { env, encoding: "utf8", timeout: 30000 });
  if (res.status === 0) fail("swarm run should have exited non-zero on a bad key");
  if (!/rejected|invalid/i.test(res.stdout + res.stderr)) fail("expected a clear 'key rejected' message");
  const runsDir = path.join(home, "runs");
  const created = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => d.startsWith("run_")) : [];
  if (created.length !== 0) fail(`bad key should create no run, found ${created.length}`);
  ok("CLI refused to launch on a bad key (no phantom run created)");

  // 2b: the executor's own preflight (safety net) — create a run, then _exec it.
  const idOut = spawnSync(process.execPath, ["-e",
    `const {createRun,optionsFromConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "run.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `const cfg=loadConfig();const m=createRun({mission:"auth fail",cwd:process.cwd(),sandbox:true,options:optionsFromConfig(cfg)});console.log(m.id)`,
  ], { env, encoding: "utf8" });
  const id = (idOut.stdout || "").trim();
  if (!id.startsWith("run_")) { console.error(idOut.stderr); fail("could not create run for _exec test"); }
  const exec = spawnSync(process.execPath, [SWARM, "_exec", id], { env, encoding: "utf8", timeout: 30000 });
  if (exec.status !== 0) { console.error(exec.stdout, exec.stderr); fail(`_exec exited ${exec.status}`); }

  const evs = events(path.join(runsDir, id));
  const last = evs.filter((e) => e.type === "run.status").pop();
  if (!last || last.status !== "failed") fail(`executor should mark run failed, got ${last && last.status}`);
  if (!/auth|api key|invalid/i.test(String(last.reason || ""))) fail(`failure reason should mention auth, got: ${last && last.reason}`);
  ok("executor preflight failed the run with status=failed + auth reason");

  const report = fs.readFileSync(path.join(runsDir, id, "artifacts", "final-report.md"), "utf8");
  if (!/Run failed/i.test(report) || !/platform\.deepseek\.com/.test(report)) fail("failure report should be clear and actionable");
  ok("failure produced a clear, actionable report (not a phantom 'done')");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseResume() {
  console.log("\n▶ Phase 3: resume an interrupted run");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  // Create a run, then hand-write the journal of an engine that died with
  // T1 done, T2 mid-flight, and T3 (dependent, verified) still pending.
  const idOut = spawnSync(process.execPath, ["-e",
    `const {createRun,optionsFromConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "run.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `const cfg=loadConfig();const m=createRun({mission:"Test: scout A and B then synthesize",cwd:process.cwd(),sandbox:true,options:optionsFromConfig(cfg)});console.log(JSON.stringify(m))`,
  ], { env, encoding: "utf8" });
  const meta = JSON.parse((idOut.stdout || "{}").trim() || "{}");
  if (!meta.id) { console.error(idOut.stderr); proc.kill(); fail("could not create run for resume test"); }
  const runDir = path.join(home, "runs", meta.id);

  const task = (id, title, role, deps, verify) => ({
    id, title, objective: `${title}. Done when summarized.`, role, deps, verify,
    status: "pending", attempt: 1, wave: 1, artifacts: [], createdAt: Date.now(), agentIds: [],
  });
  const pre = [
    { type: "run.created", meta },
    { type: "run.status", status: "planning" },
    { type: "task.created", task: task("T1", "Scout A", "researcher", [], false) },
    { type: "task.created", task: task("T2", "Scout B", "researcher", [], false) },
    { type: "task.created", task: task("T3", "Synthesize", "writer", ["T1", "T2"], true) },
    { type: "run.status", status: "running" },
    { type: "task.status", taskId: "T1", status: "running", attempt: 1 },
    { type: "task.status", taskId: "T2", status: "running", attempt: 1 },
    { type: "usage", model: "deepseek-v4-flash", usage: { promptTokens: 1000, completionTokens: 100, cacheHitTokens: 0, cacheMissTokens: 1000 }, cost: 0.0002 },
    { type: "task.report", taskId: "T1", status: "done", report: "Scout A done pre-crash.", artifacts: [] },
    { type: "task.status", taskId: "T1", status: "done", attempt: 1 },
    // engine dies here: T2 in flight, T3 never started
  ];
  fs.writeFileSync(
    path.join(runDir, "events.jsonl"),
    pre.map((e, i) => JSON.stringify({ seq: i + 1, t: Date.now(), ...e })).join("\n") + "\n"
  );

  const res = spawnSync(process.execPath, [SWARM, "resume", meta.id, "--fg"], { env, encoding: "utf8", timeout: 60000 });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm resume exited ${res.status}`); }
  ok("swarm resume completed");

  const evs = events(runDir);
  const byType = (t) => evs.filter((e) => e.type === t);

  const resumed = byType("run.resumed");
  if (resumed.length !== 1 || JSON.stringify(resumed[0].resets) !== JSON.stringify(["T2"])) {
    fail(`expected one run.resumed with resets=[T2], got ${JSON.stringify(resumed)}`);
  }
  ok("journal recorded run.resumed with the in-flight task reset");

  if (byType("run.created").length !== 1) fail("resume must not append a second run.created");
  ok("no duplicate run.created");

  const resumeSeq = resumed[0].seq;
  const after = (id, status) =>
    evs.some((e) => e.type === "task.status" && e.taskId === id && e.status === status && e.seq > resumeSeq);
  if (after("T1", "running")) fail("T1 was already done and must NOT re-run after resume");
  ok("completed task T1 kept its result (did not re-run)");
  if (!after("T2", "running") || !after("T2", "done")) fail("reset task T2 should re-run to done after resume");
  ok("interrupted task T2 re-ran and completed");
  if (!after("T3", "running") || !after("T3", "done")) fail("dependent task T3 should run after resume");
  if (!byType("verify.result").some((e) => e.taskId === "T3" && e.seq > resumeSeq)) fail("T3 should have been verified");
  ok("dependent task T3 ran (with verification) once deps settled");

  if (byType("run.status").pop().status !== "done") fail("resumed run did not end as done");
  const reportFile = path.join(runDir, "artifacts", "final-report.md");
  if (!fs.existsSync(reportFile) || !/Mission Report/.test(fs.readFileSync(reportFile, "utf8"))) fail("final report missing after resume");
  ok("resumed run finished with status=done and a final report");

  if (!byType("conductor.say").some((e) => /LEDGER-SEEN/.test(String(e.text)) && e.seq > resumeSeq)) {
    fail("the resumed conductor should have been seeded with a MISSION LEDGER (mock echoes LEDGER-SEEN)");
  }
  ok("resumed conductor was re-seeded with the mission ledger");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseDocker() {
  console.log("\n▶ Phase 4: docker sandbox (runs only when a docker daemon is reachable)");
  if (process.env.SWARM_E2E_SKIP_DOCKER) {
    console.log("  – SWARM_E2E_SKIP_DOCKER set; phase skipped");
    return;
  }
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 8000 });
  if (probe.status !== 0 || !(probe.stdout || "").trim()) {
    console.log("  – docker daemon not reachable; phase skipped");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  // Small image with bash so the pull doesn't dominate the test.
  writeConfig(home, port, { sandboxRuntime: "docker", sandboxImage: "debian:bookworm-slim" });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: scout A and B then synthesize", "--workers", "3"], {
    env, encoding: "utf8", timeout: 300000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm run (docker) exited ${res.status}`); }
  ok("swarm run completed inside a container");

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  const runDir = path.join(home, "runs", ids[0]);
  const evs = events(runDir);
  const byType = (t) => evs.filter((e) => e.type === t);

  if (!byType("log").some((e) => /sandbox: docker container/.test(String(e.msg || "")))) {
    fail("journal should record the docker sandbox runtime");
  }
  ok("journal recorded the docker sandbox runtime");
  if (byType("run.status").pop().status !== "done") fail("docker run did not end as done");
  ok("run finished with status=done");

  const leftovers = spawnSync("docker", ["ps", "-aq", "--filter", `name=swarm-sbx-${ids[0]}`], { encoding: "utf8" });
  if ((leftovers.stdout || "").trim()) fail("sandbox container was not cleaned up");
  ok("container torn down after the run");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseBudget() {
  console.log("\n▶ Phase 5: token budget exhaustion ends the run gracefully");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  // Every mock call charges 920 tokens, so a 2000-token budget trips after the
  // first wave reports — before the dependent T3 can ever start.
  const res = spawnSync(process.execPath, [SWARM, "run", "Test: scout A and B then synthesize", "--workers", "3", "--budget", "2000"], {
    env, encoding: "utf8", timeout: 60000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm run exited ${res.status}`); }
  ok("swarm run completed despite the tiny budget");

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  const runDir = path.join(home, "runs", ids[0]);
  const evs = events(runDir);
  const byType = (t) => evs.filter((e) => e.type === t);

  const last = byType("run.status").pop();
  if (last.status !== "done" || !/token budget/i.test(String(last.reason || ""))) {
    fail(`expected done + 'token budget' reason, got ${last.status} / ${last.reason}`);
  }
  ok("run ended done with a 'token budget reached' reason");

  if (byType("task.status").some((e) => e.taskId === "T3" && e.status === "running")) {
    fail("T3 must never start once the budget is exhausted");
  }
  ok("dependent task T3 was never started after the budget tripped");

  const reportFile = path.join(runDir, "artifacts", "final-report.md");
  if (!fs.existsSync(reportFile)) fail("budget-capped run must still synthesize a report");
  ok("final report was still synthesized");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseVerifyRetry() {
  console.log("\n▶ Phase 6: failed verification retries with feedback, then passes");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "verify-retry" });
  ok(`mock (verify-retry script) on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: one verified task", "--workers", "2"], {
    env, encoding: "utf8", timeout: 60000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm run exited ${res.status}`); }

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  const evs = events(path.join(home, "runs", ids[0]));
  const byType = (t) => evs.filter((e) => e.type === t);

  const verdicts = byType("verify.result").filter((e) => e.taskId === "T1").map((e) => e.pass);
  if (JSON.stringify(verdicts) !== JSON.stringify([false, true])) {
    fail(`expected verdicts [false, true] for T1, got ${JSON.stringify(verdicts)}`);
  }
  ok("verifier failed attempt 1 and passed attempt 2");

  const failedVerdict = byType("verify.result").find((e) => e.taskId === "T1" && !e.pass);
  if (!Array.isArray(failedVerdict.issues) || !/ISSUE-MARKER/.test(String(failedVerdict.issues[0]?.problem))) {
    fail("failed verdict should journal its structured issues");
  }
  ok("failed verdict journaled structured issues (problem/evidence/fix)");

  if (!byType("task.status").some((e) => e.taskId === "T1" && e.status === "running" && e.attempt === 2)) {
    fail("T1 should have re-run as attempt 2 after the failed verdict");
  }
  ok("task re-ran with attempt=2 carrying the verifier's feedback");

  if (!byType("task.report").some((e) => e.taskId === "T1" && /saw-structured-feedback/.test(String(e.report)))) {
    fail("the retry worker should have received the verifier's structured issues in its prompt");
  }
  ok("retry worker received the structured issues verbatim");

  if (!byType("task.status").some((e) => e.taskId === "T1" && e.status === "done")) fail("T1 should end done");
  if (byType("run.status").pop().status !== "done") fail("run should end done");
  ok("run finished with status=done");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseNoteCancel() {
  console.log("\n▶ Phase 7: steer a live run with a note, then cancel it");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "note-cancel" });
  ok(`mock (note-cancel script) on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const idOut = spawnSync(process.execPath, ["-e",
    `const {createRun,optionsFromConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "run.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `const cfg=loadConfig();const m=createRun({mission:"steer then cancel",cwd:process.cwd(),sandbox:true,options:optionsFromConfig(cfg)});console.log(m.id)`,
  ], { env, encoding: "utf8" });
  const id = (idOut.stdout || "").trim();
  if (!id.startsWith("run_")) { console.error(idOut.stderr); proc.kill(); fail("could not create run"); }
  const runDir = path.join(home, "runs", id);

  const engine = spawn(process.execPath, [SWARM, "_exec", id], { env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    await waitFor(() => events(runDir).some((e) => e.type === "task.status" && e.status === "running"), 20000, "a task to start");
    ok("run is live with tasks in flight");

    const note = spawnSync(process.execPath, [SWARM, "note", id, "prioritize the quick probe"], { env, encoding: "utf8", timeout: 15000 });
    if (note.status !== 0) fail(`swarm note exited ${note.status}: ${note.stderr}`);
    await waitFor(() => events(runDir).some((e) => e.type === "operator.note" && /quick probe/.test(String(e.text || ""))), 10000, "operator.note in the journal");
    ok("note reached the journal while agents were mid-task");

    await waitFor(() => events(runDir).some((e) => e.type === "operator.note.consumed"), 20000, "the conductor to consume the note");
    ok("conductor consumed the note on its next decision");

    const cancel = spawnSync(process.execPath, [SWARM, "cancel", id], { env, encoding: "utf8", timeout: 15000 });
    if (cancel.status !== 0) fail(`swarm cancel exited ${cancel.status}: ${cancel.stderr}`);
    const last = await waitFor(() => {
      const s = events(runDir).filter((e) => e.type === "run.status").pop();
      return s && ["done", "failed", "cancelled"].includes(s.status) ? s : null;
    }, 30000, "a terminal run status after cancel");
    if (last.status !== "cancelled") fail(`expected status=cancelled, got ${last.status}`);
    ok("run ended with status=cancelled");

    if (!fs.existsSync(path.join(runDir, "artifacts", "final-report.md"))) {
      fail("cancelled run should still synthesize a report from completed work");
    }
    ok("cancelled run still produced a final report");
  } finally {
    engine.kill("SIGKILL");
    proc.kill();
  }
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseCompaction() {
  console.log("\n▶ Phase 8: agent context compaction on a long task");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "compact" });
  ok(`mock (compact script) on :${port}`);
  // Small limit so ~15KB tool results trip compaction within a few steps.
  writeConfig(home, port, { contextTokenLimit: 8000 });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: bulk reads force compaction", "--workers", "1"], {
    env, encoding: "utf8", timeout: 90000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm run exited ${res.status}`); }

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  const evs = events(path.join(home, "runs", ids[0]));
  const byType = (t) => evs.filter((e) => e.type === t);

  if (!byType("log").some((e) => /context compacted/.test(String(e.msg || "")))) {
    fail("expected a 'context compacted' log event");
  }
  ok("agent compacted its context mid-task");

  if (!byType("task.status").some((e) => e.taskId === "T1" && e.status === "done")) fail("T1 should still finish after compaction");
  if (byType("run.status").pop().status !== "done") fail("run should end done");
  ok("task completed and run finished after compaction");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseHubSmoke() {
  console.log("\n▶ Phase 9: hub REST surface (serve, launch, stream to done, report)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };
  // Ensure test runs with no crawl backend keys
  delete env.FIRECRAWL_API_KEY;
  delete env.CONTEXT_DEV_API_KEY;
  delete env.DEEPCRAWL_API_KEY;

  const hub = spawn(process.execPath, [SWARM, "serve", "--port", "0"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let hubOut = "";
  hub.stdout.on("data", (b) => (hubOut += b.toString()));
  try {
    const base = await waitFor(() => (/(http:\/\/localhost:\d+)/.exec(hubOut) || [])[1], 15000, "hub to print its URL");
    ok(`hub bound a real port: ${base}`);

    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.ok) fail("health endpoint should report ok");
    const config = await (await fetch(`${base}/api/config`)).json();
    if (config.sandboxRuntime !== "host") fail(`default sandboxRuntime should be host, got ${config.sandboxRuntime}`);
    ok("health + config endpoints answer (sandboxRuntime defaults to host)");

    const evil = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
    if (evil.headers.get("access-control-allow-origin")) fail("foreign origins must get no CORS header");
    const local = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:7780" } });
    if (local.headers.get("access-control-allow-origin") !== "http://localhost:7780") {
      fail("localhost origins should be reflected for the dev UI");
    }
    ok("CORS is locked to localhost origins");

    // Crawl-test diagnostic: with no backend configured it must answer
    // instantly (no network) and say so.
    const crawlProbe = await (await fetch(`${base}/api/crawl/test`, { method: "POST" })).json();
    if (crawlProbe.ok !== false || !/no crawl backend/.test(String(crawlProbe.detail))) {
      fail(`crawl test without keys should report 'no crawl backend', got ${JSON.stringify(crawlProbe)}`);
    }
    ok("crawl-test endpoint reports unconfigured backends cleanly");

    // Key clearing round-trip: save a crawler key, clear it with "", verify.
    let cfg2 = await (await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firecrawlApiKey: "fc-test-1234567890" }),
    })).json();
    if (!cfg2.firecrawlKeySet) fail("saving a crawler key via the hub should stick");
    if (cfg2.crawlResolved !== "firecrawl") fail(`crawlResolved should become firecrawl, got ${cfg2.crawlResolved}`);
    cfg2 = await (await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firecrawlApiKey: "" }),
    })).json();
    if (cfg2.firecrawlKeySet) fail("posting an empty string should clear the saved key");
    if (cfg2.crawlResolved !== null) fail("clearing the only crawler key should unresolve the backend");
    ok("crawler keys save, resolve, and clear through the hub config API");

    const launch = await (await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: "Test: scout A and B then synthesize" }),
    })).json();
    if (!launch.id) fail(`hub launch failed: ${JSON.stringify(launch)}`);
    ok(`hub launched a detached run: ${launch.id}`);

    const snap = await waitFor(async () => {
      const s = await (await fetch(`${base}/api/runs/${launch.id}`)).json();
      return ["done", "failed", "cancelled"].includes(s.status) ? s : null;
    }, 60000, "hub-launched run to finish");
    if (snap.status !== "done") fail(`hub-launched run ended ${snap.status}: ${snap.statusReason || ""}`);
    ok("hub-launched run finished with status=done");

    const report = await (await fetch(`${base}/api/runs/${launch.id}/report`)).text();
    if (!/Mission Report/.test(report)) fail("report endpoint should serve the final report");
    ok("report endpoint serves the synthesized report");
  } finally {
    hub.kill("SIGKILL");
    proc.kill();
  }
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseCheckpointResume() {
  console.log("\n▶ Phase 10: warm resume from a task checkpoint");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({});
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const idOut = spawnSync(process.execPath, ["-e",
    `const {createRun,optionsFromConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "run.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `const cfg=loadConfig();const m=createRun({mission:"Test: scout A and B then synthesize",cwd:process.cwd(),sandbox:true,options:optionsFromConfig(cfg)});console.log(JSON.stringify(m))`,
  ], { env, encoding: "utf8" });
  const meta = JSON.parse((idOut.stdout || "{}").trim() || "{}");
  if (!meta.id) { console.error(idOut.stderr); proc.kill(); fail("could not create run for checkpoint test"); }
  const runDir = path.join(home, "runs", meta.id);

  const task = (id, title, role, deps) => ({
    id, title, objective: `${title}. Done when summarized.`, role, deps, verify: false,
    status: "pending", attempt: 1, wave: 1, artifacts: [], createdAt: Date.now(), agentIds: [],
  });
  // Engine "died" while T2 was mid-flight — but it had journaled a checkpoint.
  const pre = [
    { type: "run.created", meta },
    { type: "run.status", status: "planning" },
    { type: "task.created", task: task("T1", "Scout A", "researcher", []) },
    { type: "task.created", task: task("T2", "Scout B", "researcher", []) },
    { type: "task.created", task: task("T3", "Synthesize", "writer", ["T1", "T2"]) },
    { type: "run.status", status: "running" },
    { type: "task.status", taskId: "T1", status: "running", attempt: 1 },
    { type: "task.report", taskId: "T1", status: "done", report: "Scout A done pre-crash.", artifacts: [] },
    { type: "task.status", taskId: "T1", status: "done", attempt: 1 },
    { type: "task.status", taskId: "T2", status: "running", attempt: 1 },
    { type: "task.checkpoint", taskId: "T2", agentId: "w_dead", attempt: 1, summary: "CKPT-MARKER: gathered half the facts about B; remaining: summarize them." },
  ];
  fs.writeFileSync(
    path.join(runDir, "events.jsonl"),
    pre.map((e, i) => JSON.stringify({ seq: i + 1, t: Date.now(), ...e })).join("\n") + "\n"
  );

  const res = spawnSync(process.execPath, [SWARM, "resume", meta.id, "--fg"], { env, encoding: "utf8", timeout: 60000 });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm resume exited ${res.status}`); }

  const evs = events(runDir);
  const t2report = evs.find((e) => e.type === "task.report" && e.taskId === "T2" && /resumed-from-checkpoint/.test(String(e.report)));
  if (!t2report) fail("the retry worker for T2 should have been seeded with its checkpoint (mock reports 'resumed-from-checkpoint' only when it sees one)");
  ok("retry worker received the prior checkpoint and resumed warm");
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("checkpoint-resume run did not end as done");
  ok("run finished with status=done");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseConductorBreaker() {
  console.log("\n▶ Phase 11: conductor circuit breaker (repeated call failures end the run)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "conductor-fail" });
  ok(`mock model server on :${port} (conductor calls fail)`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1", SWARM_BACKOFF_SCALE: "0.01" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: doomed mission", "--fg", "--dir", os.tmpdir()],
    { env, encoding: "utf8", timeout: 90000 });
  proc.kill(); // before asserts — fail() exits without cleanup
  // The run must terminate on its own (no hang) with a clear reason.
  const home2 = path.join(home, "runs");
  const ids = fs.readdirSync(home2).filter((d) => d.startsWith("run_"));
  if (ids.length !== 1) fail("expected exactly one run");
  const evs = events(path.join(home2, ids[0]));
  const last = evs.filter((e) => e.type === "run.status").pop();
  if (!["failed", "done"].includes(last.status)) fail(`run should have terminated, got ${last.status}`);
  if (!evs.some((e) => e.type === "run.status" && /conductor unavailable/.test(String(e.reason || "")))) {
    fail("run should record 'conductor unavailable' after repeated conductor failures");
  }
  ok("run ended with 'conductor unavailable' instead of looping forever");

  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseBlindVerifier() {
  console.log("\n▶ Phase 12: blind verification (verifier must not see the blackboard)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "blind-verify" });
  ok(`mock model server on :${port} (blind-verify script)`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "run", "Test: write a verified brief", "--fg", "--dir", os.tmpdir()],
    { env, encoding: "utf8", timeout: 90000 });
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }

  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  const evs = events(path.join(home, "runs", ids[0]));
  if (!evs.some((e) => e.type === "note.added" && /SECRET-NOTE-XYZ/.test(String(e.text)))) {
    fail("worker should have planted a blackboard note");
  }
  const verdict = evs.find((e) => e.type === "verify.result");
  if (!verdict) fail("task should have been verified");
  if (verdict.feedback !== "clean") fail(`verifier context leaked the blackboard (feedback=${verdict.feedback})`);
  ok("verifier judged blind — the worker's blackboard note never reached it");
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("blind-verify run did not end done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseSigterm() {
  console.log("\n▶ Phase 13: SIGTERM mid-run leaves a clean, resumable journal");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "note-cancel" }); // slow tasks keep the run alive
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const engine = spawn(process.execPath, [SWARM, "run", "Test: probe slowly", "--fg", "--dir", os.tmpdir()],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  const runDir = await waitFor(() => {
    const ids = fs.existsSync(path.join(home, "runs")) ? fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_")) : [];
    return ids.length ? path.join(home, "runs", ids[0]) : null;
  }, 20000, "run directory");
  await waitFor(() => events(runDir).some((e) => e.type === "task.status" && e.status === "running"), 30000, "a task to start");

  engine.kill("SIGTERM");
  await waitFor(() => engine.exitCode !== null, 15000, "engine to exit on SIGTERM");
  ok("engine exited on SIGTERM");

  // Every journal line must parse (flushSync wrote whole lines), the run must
  // not have a terminal status, and the pid file must be gone.
  const raw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n");
  for (const line of raw) JSON.parse(line);
  ok(`journal is intact (${raw.length} well-formed lines)`);
  const evs = raw.map((l) => JSON.parse(l));
  const lastStatus = evs.filter((e) => e.type === "run.status").pop();
  if (["done", "failed", "cancelled"].includes(lastStatus.status)) fail("SIGTERM must not write a terminal status — the run stays resumable");
  if (!evs.some((e) => e.type === "log" && /SIGTERM/.test(String(e.msg)))) fail("journal should record the SIGTERM");
  if (fs.existsSync(path.join(runDir, "run.pid"))) fail("pid file should be cleared on SIGTERM");
  ok("run left non-terminal (resumable) with the SIGTERM recorded");

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

function runMission(env, mission) {
  const res = spawnSync(process.execPath, [SWARM, "run", mission, "--fg", "--dir", os.tmpdir()],
    { env, encoding: "utf8", timeout: 120000 });
  return res;
}

function soleRunEvents(home) {
  const ids = fs.readdirSync(path.join(home, "runs")).filter((d) => d.startsWith("run_"));
  if (ids.length !== 1) fail(`expected exactly one run, got ${ids.length}`);
  return { runDir: path.join(home, "runs", ids[0]), evs: events(path.join(home, "runs", ids[0])) };
}

async function phaseRateLimit() {
  console.log("\n▶ Phase 14: AIMD limiter absorbs a 429 storm");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_429_FIRST: "3" });
  ok(`mock model server on :${port} (first 3 calls get 429)`);
  writeConfig(home, port, { maxConcurrentCalls: 4 });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: scout A and B then synthesize");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("rate-limited run should still finish done");
  if (!evs.some((e) => e.type === "limiter.state")) fail("limiter.state event should record the AIMD ceiling drop");
  ok("run completed through the 429s and journaled the limiter adjustment");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseModelTiers() {
  console.log("\n▶ Phase 15: model tiering (cheap scouts, strong leads)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "model-tiers" });
  ok(`mock model server on :${port}`);
  writeConfig(home, port, { cheapModel: "mock-cheap", strongModel: "mock-strong" });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: tiered scouting");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);
  const spawned = evs.filter((e) => e.type === "agent.spawned" && e.role !== "verifier");
  const models = new Set(spawned.map((e) => e.model));
  if (!models.has("mock-cheap") || !models.has("mock-strong")) {
    fail(`expected workers on mock-cheap AND mock-strong, got: ${[...models].join(", ")}`);
  }
  ok("workers ran on their spawn-spec tiers (mock-cheap + mock-strong)");
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("tiered run did not finish done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseTeam() {
  console.log("\n▶ Phase 16: hierarchical team (team:true runs a sub-swarm)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "team" });
  ok(`mock model server on :${port} (team script)`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: build the subsystem via a team");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);

  if (!evs.some((e) => e.type === "team.created" && e.taskId === "T1")) fail("team.created event missing");
  const teamEvents = evs.filter((e) => e.teamId === "T1");
  if (!teamEvents.some((e) => e.type === "task.created")) fail("child swarm should journal teamId-stamped task events");
  ok(`child swarm journaled ${teamEvents.length} teamId-stamped events`);

  // Root run sees exactly ONE task (the team), settled done with the consolidated report.
  const rootCreated = evs.filter((e) => e.type === "task.created" && !e.teamId);
  if (rootCreated.length !== 1) fail(`root should have exactly 1 task, got ${rootCreated.length}`);
  const teamReport = evs.find((e) => e.type === "team.report" && e.taskId === "T1");
  if (!teamReport || !/TEAM-CONSOLIDATED/.test(String(teamReport.report))) fail("consolidated team report missing");
  ok("root settled one task carrying the team's consolidated report");

  // Child usage rolls up into the same journal (budget single-truth).
  if (!evs.some((e) => e.type === "usage" && e.teamId === "T1")) fail("team usage events should be journaled with teamId");
  ok("team usage journaled and rolled up");
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("team run did not finish done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseLongHorizon() {
  console.log("\n▶ Phase 17: living plan document (update_plan)");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "long-horizon" });
  ok(`mock model server on :${port}`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: long horizon mission");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { runDir: rd, evs } = soleRunEvents(home);
  const planFile = path.join(rd, "artifacts", "mission-plan.md");
  if (!fs.existsSync(planFile) || !/PLAN-MARKER-V1/.test(fs.readFileSync(planFile, "utf8"))) {
    fail("mission-plan.md should exist with the conductor's plan");
  }
  if (!evs.some((e) => e.type === "plan.updated" && /PLAN-MARKER-V1/.test(String(e.excerpt)))) {
    fail("plan.updated event missing");
  }
  ok("conductor maintained mission-plan.md and journaled plan.updated");
  if (evs.filter((e) => e.type === "run.status").pop().status !== "done") fail("long-horizon run did not finish done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseDepChain() {
  console.log("\n▶ Phase 18: failure cascades block transitively with root causes");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "dep-chain" });
  ok(`mock model server on :${port} (dep-chain script)`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: a chain doomed at the root");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);
  const blocked = {};
  for (const e of evs) {
    if (e.type === "task.status" && e.status === "blocked" && blocked[e.taskId] == null) blocked[e.taskId] = e;
  }
  if (!blocked.T1 || !blocked.T2 || !blocked.T3) fail(`expected T1,T2,T3 all blocked, got ${Object.keys(blocked).join(",")}`);
  ok("the whole chain (T1→T2→T3) ended blocked");

  if (!/dependency T1 did not complete \(BLOCKED-ROOT/.test(String(blocked.T2.reason))) {
    fail(`T2's reason should carry T1's failure verbatim, got: ${blocked.T2.reason}`);
  }
  if (!/root cause T1: BLOCKED-ROOT/.test(String(blocked.T3.reason))) {
    fail(`T3's reason should name the ROOT cause (T1), got: ${blocked.T3.reason}`);
  }
  ok("blocked tasks carry the root failure, not just 'dependency did not complete'");

  // Fixpoint: T2 and T3 must block in the same scheduler pass — no conductor
  // turn (conductor.action) may land between them.
  const between = evs.filter(
    (e) => e.type === "conductor.action" && e.seq > blocked.T2.seq && e.seq < blocked.T3.seq
  );
  if (between.length) fail("cascade blocking took multiple conductor turns (not a single fixpoint pass)");
  ok("the cascade blocked in one pass (no conductor turn in between)");

  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseDiagnostics() {
  console.log("\n▶ Phase 19: failed tasks surface their last failing tool call");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "diag" });
  ok(`mock model server on :${port} (diag script)`);
  writeConfig(home, port, { maxStepsPerTask: 3 });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: doomed by a missing file");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);
  const failedEv = evs.find((e) => e.type === "task.status" && e.taskId === "T1" && e.status === "failed");
  if (!failedEv) fail("T1 should have failed");
  if (!/last tool failure: read_file/.test(String(failedEv.reason))) {
    fail(`T1's failure should name the failing tool call, got: ${failedEv.reason}`);
  }
  ok("task failure carries the last failing tool call as diagnostics");
  if (!/worker ended without reporting/.test(String(failedEv.reason))) {
    fail(`expected the no-report cause in the reason, got: ${failedEv.reason}`);
  }
  ok("no-report cause and tool diagnostics are both in the journal");

  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseStrictVerify() {
  console.log("\n▶ Phase 20: strict mode demands tool-gathered evidence from verifiers");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "strict-verify" });
  ok(`mock model server on :${port} (strict-verify script)`);
  writeConfig(home, port, { verification: "strict" });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: strictly verified brief");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { evs } = soleRunEvents(home);
  const byType = (t) => evs.filter((e) => e.type === t);

  if (!byType("log").some((e) => /without evidence — re-running/.test(String(e.msg)))) {
    fail("engine should have rejected the tool-free pass and re-run the verifier");
  }
  ok("tool-free pass verdict triggered an evidence-required re-run");

  const verifierSpawns = byType("agent.spawned").filter((e) => e.role === "verifier" && e.taskId === "T1");
  if (verifierSpawns.length !== 2) fail(`expected 2 verifier passes, got ${verifierSpawns.length}`);
  ok("a second verifier agent ran");

  const verdict = byType("verify.result").find((e) => e.taskId === "T1");
  if (!verdict || !verdict.pass || !/EVIDENCE-OK/.test(String(verdict.feedback))) {
    fail(`the accepted verdict should be the evidence-backed one, got: ${verdict && verdict.feedback}`);
  }
  ok("the evidence-backed verdict is the one that counted");

  if (byType("run.status").pop().status !== "done") fail("strict-verify run did not end done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseCitations() {
  console.log("\n▶ Phase 21: sources flow from workers to a cited final report");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "citations" });
  ok(`mock model server on :${port} (citations script)`);
  writeConfig(home, port);
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = runMission(env, "Test: research alpha and beta with citations");
  proc.kill();
  if (res.status !== 0) { console.error(res.stdout, res.stderr); fail(`swarm run exited ${res.status}`); }
  const { runDir, evs } = soleRunEvents(home);
  const byType = (t) => evs.filter((e) => e.type === t);

  const t1report = byType("task.report").find((e) => e.taskId === "T1");
  if (!Array.isArray(t1report.sources) || !/example\.com\/alpha/.test(String(t1report.sources[0]?.url))) {
    fail("T1's report event should carry its structured sources");
  }
  ok("worker sources journaled on task.report");

  if (!byType("note.added").some((e) => e.url === "https://example.com/alpha")) {
    fail("note(url=...) should journal the source URL");
  }
  ok("blackboard notes carry source URLs");

  const report = fs.readFileSync(path.join(runDir, "artifacts", "final-report.md"), "utf8");
  if (/NO-SOURCES-IN-PROMPT/.test(report)) {
    fail("the synthesizer never received the numbered, deduplicated source list");
  }
  if (!/## Sources/.test(report) || !/example\.com\/alpha/.test(report) || !/beta\.org\/report/.test(report)) {
    fail("final report should end with a Sources section listing the cited URLs");
  }
  if (!/\[1\]/.test(report)) fail("final report should cite sources inline as [n]");
  ok("final report cites inline and ships a Sources section");

  if (byType("run.status").pop().status !== "done") fail("citations run did not end done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseForecast() {
  console.log("\n▶ Phase 22: forecast mode — panel, mechanical aggregation, ledger, resolution");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "forecast" });
  ok(`mock model server on :${port} (forecast script)`);
  // forecastMarketWeight 0: the engine's market anchor would otherwise hit
  // live prediction-market APIs mid-test — determinism beats coverage here
  // (the blend math is unit-tested).
  writeConfig(home, port, { forecastPanelSize: 3, forecastMarketWeight: 0 });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  const res = spawnSync(process.execPath, [SWARM, "forecast", "Will the test event happen?", "--fg"], {
    env, encoding: "utf8", timeout: 120000,
  });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`swarm forecast exited ${res.status}`); }
  const { runDir, evs } = soleRunEvents(home);
  const byType = (t) => evs.filter((e) => e.type === t);

  // The sharpened question is journaled before any orchestration.
  const q = byType("forecast.question")[0];
  if (!q || q.question.kind !== "binary" || q.question.resolutionDate !== "2020-02-01") {
    fail("forecast.question should carry the sharpened binary question with its date");
  }
  ok("question sharpened and journaled (binary, dated)");

  // The analytical gate bounced the ungrounded first submission (no prior /
  // base rates) back to the outside-view panelist with mechanical feedback.
  const gateFails = byType("verify.result").filter((e) => e.mechanical && !e.pass && /prior|base_rates/.test(e.feedback));
  if (gateFails.length !== 1) fail(`expected exactly one mechanical gate rejection, got ${gateFails.length}`);
  const gatedTask = gateFails[0].taskId;
  if (!byType("task.status").some((e) => e.taskId === gatedTask && e.status === "running" && e.attempt === 2)) {
    fail("the gated panelist should have retried (attempt 2)");
  }
  ok(`analytical gate rejected an ungrounded forecast and forced a retry (${gatedTask})`);

  // Three conductor panelists + the engine's inverted-framing probe.
  const submitted = byType("forecast.submitted");
  if (submitted.length !== 4) {
    fail(`expected 4 forecast.submitted (3 panelists + probe; rejected attempts unjournaled), got ${submitted.length}`);
  }
  const probs = submitted.map((e) => e.forecast.probability).sort((a, b) => a - b);
  if (JSON.stringify(probs) !== JSON.stringify([0.6, 0.7, 0.75, 0.8])) {
    fail(`panel probabilities should be [0.6,0.7,0.75,0.8], got ${JSON.stringify(probs)}`);
  }
  const priors = submitted.map((e) => e.forecast.prior).filter((p) => typeof p === "number").sort((a, b) => a - b);
  if (JSON.stringify(priors) !== JSON.stringify([0.55, 0.65, 0.7])) {
    fail(`panelist base-rate priors should be journaled [0.55,0.65,0.7], got ${JSON.stringify(priors)}`);
  }
  ok("4 forecasts submitted (3 panelists with priors + probe), percentages normalized");

  // The probe: engine asked P(NO), got 25%, flipped it, and owns the label.
  const probeSub = submitted.find((e) => e.forecast.method === "inverted-framing");
  if (!probeSub || Math.abs(probeSub.forecast.probability - 0.75) > 1e-9 || probeSub.forecast.prior !== undefined) {
    fail(`probe should join as inverted-framing at 0.75 with no prior, got ${JSON.stringify(probeSub && probeSub.forecast)}`);
  }
  const probeTask = byType("task.created").map((e) => e.task).find((t) => /Coherence probe/.test(t.title));
  if (!probeTask || probeTask.status !== "done" || probeTask.id !== probeSub.taskId) {
    fail("probe should exist as a synthetic done task matching the forecast.submitted event");
  }
  ok("inverted-framing probe ran, flipped P(NO)=25% to P(YES)=75%, and joined the panel");

  // The aggregate is the engine's deterministic math — distinct sources per
  // panelist ⇒ evidence overlap 0 ⇒ full extremization k. Re-derive, never
  // hard-code.
  const { aggregateBinary, scaleK } = require(path.join(ROOT, "dist", "forecast.js"));
  const expected = aggregateBinary([0.6, 0.7, 0.75, 0.8], scaleK(2.5, 0));
  const aggEv = byType("forecast.aggregated")[0];
  if (!aggEv) fail("no forecast.aggregated event");
  const agg = aggEv.aggregate;
  if (Math.abs(agg.probability - expected.probability) > 1e-9 || agg.n !== 4) {
    fail(`aggregate mismatch: got ${JSON.stringify(agg)}, expected p=${expected.probability}`);
  }
  if (agg.evidenceOverlap !== 0) fail(`distinct sources should give evidenceOverlap 0, got ${agg.evidenceOverlap}`);
  ok(`mechanical aggregation matches re-derived math (headline ${Math.round(agg.probability * 100)}%, n=4, overlap 0)`);

  // The synthesizer received and echoed the exact engine-computed number.
  const headlinePct = Math.round(expected.probability * 100);
  const report = fs.readFileSync(path.join(runDir, "artifacts", "final-report.md"), "utf8");
  if (/NO-AGGREGATE-IN-PROMPT/.test(report)) fail("the synthesizer never received the aggregate block");
  if (!new RegExp(`FORECAST-HEADLINE: P\\(YES\\) = ${headlinePct}%`).test(report)) {
    fail(`final report should carry the exact headline ${headlinePct}%`);
  }
  ok("final report carries the exact aggregated probability");

  // The ledger recorded the forecast (panel + priors + triggers + overlap).
  const ledgerFile = path.join(home, "forecasts", "ledger.jsonl");
  const ledgerLines = fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const created = ledgerLines.find((r) => r.rec === "created");
  if (!created || created.panel.length !== 4 || created.id !== aggEv.ledgerId) {
    fail("ledger should hold a created record with the 4-member panel, id matching the journal");
  }
  if (created.panel.filter((m) => typeof m.prior === "number").length !== 3 || created.evidenceOverlap !== 0) {
    fail("ledger created record should persist the panelists' priors and the evidence overlap");
  }
  if (!Array.isArray(created.triggers) || !created.triggers.some((t) => /TRIGGER/.test(t))) {
    fail("ledger created record should union the panel's update triggers");
  }
  ok("forecast persisted to the ledger with priors, evidence overlap, and update triggers");

  // Past-due resolution: a mini-agent determines the outcome and scores it.
  const resolveOut = spawnSync(process.execPath, ["-e",
    `const {resolveDue}=require(${JSON.stringify(path.join(ROOT, "dist", "resolve.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `resolveDue(loadConfig()).then(r=>console.log("RESOLVE="+JSON.stringify(r))).catch(e=>{console.error(e);process.exit(1)})`,
  ], { env, encoding: "utf8", timeout: 60000 });
  proc.kill();
  if (resolveOut.status !== 0) { console.error(resolveOut.stdout, resolveOut.stderr); fail("resolveDue failed"); }
  const resolveRes = JSON.parse(/RESOLVE=(.*)/.exec(resolveOut.stdout)[1]);
  if (resolveRes.resolved.length !== 1 || resolveRes.resolved[0].outcome !== 1) {
    fail(`expected one YES resolution, got ${JSON.stringify(resolveRes)}`);
  }
  const expectedBrier = Math.pow(expected.probability - 1, 2);
  if (Math.abs(resolveRes.resolved[0].brier - expectedBrier) > 1e-9) {
    fail(`brier should be (p−1)² = ${expectedBrier}, got ${resolveRes.resolved[0].brier}`);
  }
  ok(`resolution engine scored the forecast (Brier ${resolveRes.resolved[0].brier.toFixed(4)})`);

  if (!fs.existsSync(path.join(home, "forecasts", "audit", `${created.id}.json`))) {
    fail("machine resolutions should leave an audit file");
  }
  ok("resolution left an audit trail");

  // The flywheel: the resolved record now reduces into calibration stats.
  const { loadLedger, calibrationStats } = require(path.join(ROOT, "dist", "forecast.js"));
  const prevHome = process.env.AGENTSWARM_HOME;
  process.env.AGENTSWARM_HOME = home;
  const stats = calibrationStats(loadLedger());
  process.env.AGENTSWARM_HOME = prevHome;
  if (stats.n !== 1 || Math.abs(stats.brierMean - expectedBrier) > 1e-9) {
    fail(`calibration stats should score the one resolved forecast, got ${JSON.stringify(stats)}`);
  }
  ok("calibration stats reflect the resolved forecast (the flywheel closes)");

  if (byType("run.status").pop().status !== "done") fail("forecast run did not end done");
  ok("run finished with status=done");
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseTournamentPreset() {
  console.log("\n▶ Phase 23: tournament import — preset question bypass, ledger origin, platform-resolution fallback");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentswarm-e2e-"));
  const { proc, port } = await startMock({ MOCK_SCENARIO: "forecast" });
  ok(`mock model server on :${port} (forecast script)`);
  writeConfig(home, port, { forecastPanelSize: 3, forecastMarketWeight: 0 });
  const env = { ...process.env, AGENTSWARM_HOME: home, NO_COLOR: "1" };

  // A tournament-imported run: the question arrives pre-sharpened with its
  // market provenance — exactly what `swarm tournament` constructs.
  const preset = {
    text: "Will the imported market event occur?",
    kind: "binary",
    resolutionCriteria: "Resolves exactly as the source market resolves: https://manifold.markets/market/fake123",
    resolutionDate: "2020-03-01",
  };
  const create = spawnSync(process.execPath, ["-e",
    `const {createRun, optionsFromConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "run.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `const cfg=loadConfig();` +
    `const meta=createRun({mission:"Forecast: tournament preset test",cwd:process.cwd(),sandbox:true,options:optionsFromConfig(cfg,{` +
    `mode:"forecast",panelSize:3,presetQuestion:${JSON.stringify(preset)},` +
    `forecastOrigin:{kind:"tournament",platform:"manifold",externalId:"fake123-e2e",url:"https://manifold.markets/market/fake123",marketProbAtCreate:0.62}` +
    `})});console.log("RUN_ID="+meta.id);`,
  ], { env, encoding: "utf8", timeout: 15000 });
  if (create.status !== 0) { console.error(create.stdout, create.stderr); proc.kill(); fail("createRun failed"); }
  const id = /RUN_ID=(\S+)/.exec(create.stdout)[1];

  const res = spawnSync(process.execPath, [SWARM, "_exec", id], { env, encoding: "utf8", timeout: 120000 });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); proc.kill(); fail(`_exec exited ${res.status}`); }
  const evs = events(path.join(home, "runs", id));
  const byType = (t) => evs.filter((e) => e.type === t);

  // The preset bypassed the sharpener: the journaled question is verbatim.
  const q = byType("forecast.question")[0];
  if (!q || q.question.text !== preset.text || q.question.resolutionDate !== "2020-03-01") {
    fail(`preset question should be journaled verbatim, got ${JSON.stringify(q && q.question)}`);
  }
  ok("preset question bypassed the sharpener and was journaled verbatim");

  // The ledger record carries the market provenance and price-at-import.
  const ledgerLines = fs.readFileSync(path.join(home, "forecasts", "ledger.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const created = ledgerLines.find((r) => r.rec === "created");
  if (!created || !created.origin || created.origin.platform !== "manifold" ||
      created.origin.externalId !== "fake123-e2e" || created.origin.marketProbAtCreate !== 0.62) {
    fail(`ledger should carry the tournament origin, got ${JSON.stringify(created && created.origin)}`);
  }
  ok("ledger created record carries origin (platform, externalId, market price at import)");

  // Resolution: the platform lookup for the fake id fails, so resolveDue
  // falls back to the scripted mini-agent — the chain must degrade, not die.
  const resolveOut = spawnSync(process.execPath, ["-e",
    `const {resolveDue}=require(${JSON.stringify(path.join(ROOT, "dist", "resolve.js"))});` +
    `const {loadConfig}=require(${JSON.stringify(path.join(ROOT, "dist", "config.js"))});` +
    `resolveDue(loadConfig()).then(r=>console.log("RESOLVE="+JSON.stringify(r))).catch(e=>{console.error(e);process.exit(1)})`,
  ], { env, encoding: "utf8", timeout: 90000 });
  proc.kill();
  if (resolveOut.status !== 0) { console.error(resolveOut.stdout, resolveOut.stderr); fail("resolveDue failed"); }
  const resolveRes = JSON.parse(/RESOLVE=(.*)/.exec(resolveOut.stdout)[1]);
  if (resolveRes.resolved.length !== 1 || resolveRes.resolved[0].outcome !== 1) {
    fail(`expected the fallback resolver to settle YES, got ${JSON.stringify(resolveRes)}`);
  }
  ok("platform resolution fell back to the mini-agent and settled the forecast");

  fs.rmSync(home, { recursive: true, force: true });
}

async function main() {
  await phaseHappy();
  await phaseAuthFail();
  await phaseResume();
  await phaseDocker();
  await phaseBudget();
  await phaseVerifyRetry();
  await phaseNoteCancel();
  await phaseCompaction();
  await phaseHubSmoke();
  await phaseCheckpointResume();
  await phaseConductorBreaker();
  await phaseBlindVerifier();
  await phaseSigterm();
  await phaseRateLimit();
  await phaseModelTiers();
  await phaseTeam();
  await phaseLongHorizon();
  await phaseDepChain();
  await phaseDiagnostics();
  await phaseStrictVerify();
  await phaseCitations();
  await phaseForecast();
  await phaseTournamentPreset();
  console.log(
    "\n✅ E2E passed — pipeline, auth failure, resume (with ledger re-seed), budget cap, verify-retry, steering + cancel, compaction, hub API, checkpoint resume, conductor breaker, blind verification, SIGTERM safety, 429 limiter, model tiers, hierarchical teams, the living plan, cascade root causes, failure diagnostics, forecast mode (panel → mechanical aggregation → ledger → resolution → calibration), and tournament imports (preset question, ledger origin, platform-resolution fallback) all work."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

// End-to-end test: boots a mock DeepSeek server and drives real missions
// through the compiled engine. Phase 1 = happy path; Phase 2 = invalid API key
// (must fail loudly, not silently "complete").
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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

  if (byType("run.status").pop().status !== "done") fail("run did not end as done");
  ok("run finished with status=done");

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

  proc.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

async function phaseDocker() {
  console.log("\n▶ Phase 4: docker sandbox (runs only when a docker daemon is reachable)");
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

  if (!byType("task.status").some((e) => e.taskId === "T1" && e.status === "running" && e.attempt === 2)) {
    fail("T1 should have re-run as attempt 2 after the failed verdict");
  }
  ok("task re-ran with attempt=2 carrying the verifier's feedback");

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
  console.log(
    "\n✅ E2E passed — pipeline, auth failure, resume, budget cap, verify-retry, live steering + cancel, context compaction, and the hub REST surface all work."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

// Unit tests for code-chat sessions: storage round-trips, turn index, the
// existing-dir delete guard, and the ordered prior-turn context block.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AGENTSWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sess-"));
const {
  createSession,
  loadSessionMeta,
  appendTurn,
  readTurns,
  listSessionIds,
  deleteSession,
  isEmptyDir,
  sessionContextBlock,
} = require("../../dist/session.js");
const { appendMemory } = require("../../dist/memory.js");
const { runDir } = require("../../dist/config.js");

const OPTS = { model: "m", conductorModel: "m", maxWorkers: 1, maxStepsPerTask: 1, maxTasks: 1, maxTokens: 100000 };

test("createSession (managed): makes a workspace inside the session dir; round-trips", () => {
  const s = createSession({ title: "My App", options: OPTS });
  assert.ok(s.id.startsWith("sess_"));
  assert.equal(s.workspaceKind, "managed");
  assert.ok(fs.existsSync(s.workspace), "managed workspace dir is created");
  assert.ok(s.workspace.includes(s.id), "managed workspace lives under the session dir");
  const loaded = loadSessionMeta(s.id);
  assert.equal(loaded.id, s.id);
  assert.equal(loaded.title, "My App");
  assert.ok(listSessionIds().includes(s.id));
});

test("createSession (existing dir): points at the user's path, flags preexistingGit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-userdir-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const s = createSession({ workspace: dir, options: OPTS });
  assert.equal(s.workspaceKind, "existing");
  assert.equal(path.resolve(s.workspace), path.resolve(dir));
  assert.equal(s.preexistingGit, true);
});

test("isEmptyDir: dotfiles don't count; real files do", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-empty-"));
  assert.equal(isEmptyDir(dir), true);
  fs.writeFileSync(path.join(dir, ".gitignore"), "x");
  assert.equal(isEmptyDir(dir), true, "only dotfiles ⇒ still empty");
  fs.writeFileSync(path.join(dir, "index.js"), "x");
  assert.equal(isEmptyDir(dir), false);
});

test("turns.jsonl: append + read preserves order and linkage", () => {
  const s = createSession({ title: "T", options: OPTS });
  assert.deepEqual(readTurns(s.id), []);
  appendTurn(s.id, { turnId: "run_1", message: "build it" });
  appendTurn(s.id, { turnId: "run_2", message: "add auth", parentRunId: "run_1" });
  const turns = readTurns(s.id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnId, "run_1");
  assert.equal(turns[1].parentRunId, "run_1");
});

test("deleteSession (managed): removes the session dir AND its workspace", () => {
  const s = createSession({ title: "gone", options: OPTS });
  const ws = s.workspace;
  assert.ok(fs.existsSync(ws));
  deleteSession(s.id);
  assert.ok(!fs.existsSync(ws), "managed workspace is removed with the session");
  assert.equal(loadSessionMeta(s.id), null);
});

test("deleteSession: cascade-removes the turn run dirs (no orphans left behind)", () => {
  const s = createSession({ title: "cascade", options: OPTS });
  const turnId = "run_cascade1";
  const rd = runDir(turnId);
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "events.jsonl"), "{}\n");
  appendTurn(s.id, { turnId, message: "build it" });
  assert.ok(fs.existsSync(rd), "turn run dir exists before delete");
  deleteSession(s.id);
  assert.ok(!fs.existsSync(rd), "turn run dir is cascade-removed with the session");
});

test("deleteSession (existing dir): NEVER touches the user's directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-keep-"));
  fs.writeFileSync(path.join(dir, "important.txt"), "do not delete");
  const s = createSession({ workspace: dir, options: OPTS });
  deleteSession(s.id);
  assert.ok(fs.existsSync(path.join(dir, "important.txt")), "user's files survive session deletion");
  assert.equal(loadSessionMeta(s.id), null);
});

test("sessionContextBlock: empty on turn 1; folds prior DONE turns in order", () => {
  const s = createSession({ title: "ctx", options: OPTS });
  // Turn 1 only → no prior context to inject yet.
  appendTurn(s.id, { turnId: "run_t1", message: "build a todo app" });
  assert.equal(sessionContextBlock(s.id, s.workspace), "");

  // Each completed turn writes a memory entry to the workspace (as appendMemory does).
  appendMemory(s.workspace, {
    runId: "run_t1",
    mission: "build a todo app",
    finishedAt: 1,
    status: "done",
    summary: "Added todo list with add/remove",
    keyDecisions: ["used localStorage for persistence"],
  });
  // Turn 2 arrives → context should now describe turn 1.
  appendTurn(s.id, { turnId: "run_t2", message: "add a delete button", parentRunId: "run_t1" });
  const block = sessionContextBlock(s.id, s.workspace);
  assert.match(block, /THIS CODE-CHAT SO FAR/);
  assert.match(block, /Turn 1/);
  assert.match(block, /todo app/);
  assert.match(block, /localStorage/);
});

test("sessionContextBlock: a non-done prior turn is excluded", () => {
  const s = createSession({ title: "ctx2", options: OPTS });
  appendTurn(s.id, { turnId: "run_f1", message: "first" });
  appendMemory(s.workspace, { runId: "run_f1", mission: "first", finishedAt: 1, status: "failed", summary: "broke", keyDecisions: [] });
  appendTurn(s.id, { turnId: "run_f2", message: "second" });
  assert.equal(sessionContextBlock(s.id, s.workspace), "", "a failed prior turn is not folded into context");
});

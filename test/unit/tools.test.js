// Unit tests for worker tools: grep_files and replace_in_file multi-edit.
// Runs against a real tmp dir through the host sandbox (no model needed).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { workerToolset } = require("../../dist/tools.js");
const { createSandbox } = require("../../dist/sandbox.js");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tools-"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tools-run-"));
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.mkdirSync(path.join(work, "node_modules", "junk"), { recursive: true });
fs.writeFileSync(path.join(work, "src", "a.ts"), "export function alpha() {\n  return BETA_CONST;\n}\n");
fs.writeFileSync(path.join(work, "src", "b.md"), "beta_const is documented here\nBETA_CONST too\n");
fs.writeFileSync(path.join(work, "node_modules", "junk", "c.ts"), "BETA_CONST in deps must be skipped\n");

const cfg = { safeMode: true, maxToolResultChars: 20000 };
const sandbox = createSandbox("host", { runId: "test_tools", hostDir: work, cfg });
const ctx = {
  cfg,
  meta: { id: "test", mission: "", createdAt: 0, cwd: work, sandbox: true, options: {} },
  runDirPath: runDir,
  workdir: work,
  sandbox,
  agentId: "t1",
  signal: new AbortController().signal,
  addNote: () => {},
  addArtifact: () => {},
  readBlackboard: () => "",
};

const tools = workerToolset(undefined);

test("grep_files finds matches with path:line:text and skips node_modules", async () => {
  const out = await tools.grep_files.run({ pattern: "BETA_CONST" }, ctx);
  assert.match(out, /src\/a\.ts:2:/);
  assert.match(out, /src\/b\.md:2:/);
  assert.ok(!out.includes("node_modules"), "dependency dirs are excluded");
});

test("grep_files honors glob and ignore_case", async () => {
  const tsOnly = await tools.grep_files.run({ pattern: "beta_const", glob: "*.ts", ignore_case: true }, ctx);
  assert.match(tsOnly, /a\.ts/);
  assert.ok(!tsOnly.includes("b.md"), "glob filters extensions");
  const none = await tools.grep_files.run({ pattern: "zzz_never_matches" }, ctx);
  assert.equal(none, "no matches");
});

test("grep_files caps results", async () => {
  fs.writeFileSync(path.join(work, "many.txt"), Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n"));
  const out = await tools.grep_files.run({ pattern: "^hit", max_results: 5, path: "many.txt" }, ctx);
  assert.equal(out.split("\n").filter((l) => /hit/.test(l) && !/truncated/.test(l)).length, 5);
  assert.match(out, /truncated/);
});

test("replace_in_file single edit still works", async () => {
  fs.writeFileSync(path.join(work, "one.txt"), "hello world\n");
  const out = await tools.replace_in_file.run({ path: "one.txt", find: "world", replace: "swarm" }, ctx);
  assert.match(out, /replaced 1 occurrence/);
  assert.equal(fs.readFileSync(path.join(work, "one.txt"), "utf8"), "hello swarm\n");
});

test("replace_in_file edits[] applies in order, atomically", async () => {
  fs.writeFileSync(path.join(work, "multi.txt"), "aaa bbb ccc bbb\n");
  const out = await tools.replace_in_file.run(
    {
      path: "multi.txt",
      edits: [
        { find: "aaa", replace: "AAA" },
        { find: "bbb", replace: "BBB", all: true },
      ],
    },
    ctx
  );
  assert.match(out, /replaced 3 occurrence\(s\) via 2 edit\(s\)/);
  assert.equal(fs.readFileSync(path.join(work, "multi.txt"), "utf8"), "AAA BBB ccc BBB\n");
});

test("a failing edit mid-batch writes nothing", async () => {
  fs.writeFileSync(path.join(work, "atomic.txt"), "first second\n");
  await assert.rejects(
    () =>
      tools.replace_in_file.run(
        {
          path: "atomic.txt",
          edits: [
            { find: "first", replace: "1st" },
            { find: "MISSING", replace: "x" },
          ],
        },
        ctx
      ),
    /edit 2: find string not found in file — no edits were applied/
  );
  assert.equal(fs.readFileSync(path.join(work, "atomic.txt"), "utf8"), "first second\n", "file untouched");
});

test("ambiguous match without all=true fails the batch", async () => {
  fs.writeFileSync(path.join(work, "ambig.txt"), "dup dup\n");
  await assert.rejects(
    () => tools.replace_in_file.run({ path: "ambig.txt", find: "dup", replace: "x" }, ctx),
    /matches 2 times/
  );
});

test("replace_in_file without find/replace or edits is an error", async () => {
  await assert.rejects(() => tools.replace_in_file.run({ path: "one.txt" }, ctx), /provide find\+replace, or an edits array/);
});

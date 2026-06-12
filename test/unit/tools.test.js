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

// ---------- write confinement (symlink escapes) ----------

test("write through a symlink pointing outside the workdir is blocked", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-outside-"));
  fs.symlinkSync(outside, path.join(work, "escape"));
  await assert.rejects(
    () => tools.write_file.run({ path: "escape/stolen.txt", content: "x" }, ctx),
    /safeMode: writes are restricted/
  );
  assert.ok(!fs.existsSync(path.join(outside, "stolen.txt")), "nothing written outside");
});

test("a symlinked file inside the workdir pointing outside is blocked", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-outside2-"));
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, "original");
  fs.symlinkSync(target, path.join(work, "alias.txt"));
  await assert.rejects(
    () => tools.write_file.run({ path: "alias.txt", content: "overwritten" }, ctx),
    /safeMode: writes are restricted/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

test("legitimate writes still pass (including not-yet-existing subdirs)", async () => {
  const out = await tools.write_file.run({ path: "new/sub/file.txt", content: "ok" }, ctx);
  assert.match(out, /wrote/);
  assert.equal(fs.readFileSync(path.join(work, "new", "sub", "file.txt"), "utf8"), "ok");
});

test("save_artifact blocks symlink escapes from the artifacts folder", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-outside3-"));
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  fs.symlinkSync(outside, path.join(runDir, "artifacts", "leak"));
  await assert.rejects(
    () => tools.save_artifact.run({ name: "leak/out.txt", content: "x" }, ctx),
    /must stay inside the artifacts folder/
  );
});

test("grep_files fails loudly on an invalid regex instead of reporting 'no matches'", async () => {
  await assert.rejects(
    () => tools.grep_files.run({ pattern: "broken(" }, ctx),
    /grep failed/,
    "exit 2 with no matches is an error, not a clean miss"
  );
});

test("grep_files fails loudly on a nonexistent search path", async () => {
  await assert.rejects(() => tools.grep_files.run({ pattern: "x", path: "src/no-such-dir" }, ctx), /grep failed/);
});

test("synthToolset can recover full task reports via read_report", () => {
  const { synthToolset } = require("../../dist/tools.js");
  const synth = synthToolset();
  assert.ok(synth.read_report, "synthesizer needs read_report — its prompt excerpts are clipped at 1600 chars");
  assert.ok(synth.read_file && synth.list_dir && synth.save_artifact);
  assert.ok(!synth.web_search && !synth.shell, "synthesis stays offline — research happens before it");
});

test("new keyless data tools are registered with the expected surface", () => {
  const { workerToolset } = require("../../dist/tools.js");
  const all = workerToolset(undefined);
  assert.ok(all.wiki_summary, "wiki_summary tool exists");
  const tsEnum = all.time_series.schema.parameters.properties.source.enum;
  assert.ok(tsEnum.includes("wikipageviews"), "time_series gained the wikipageviews source");
  assert.ok(/PredictIt/i.test(all.market_odds.schema.description), "market_odds names PredictIt");
  assert.ok(/Semantic Scholar/i.test(all.academic_search.schema.description), "academic_search names Semantic Scholar");
  assert.ok(/PubMed/i.test(all.academic_search.schema.description), "academic_search names PubMed");
});

test("web_search and fetch_url coalesce through the run-scoped webCache", async () => {
  const { workerToolset } = require("../../dist/tools.js");
  const all = workerToolset(undefined);
  const cache = new Map();
  // Monkey-patch via the cache itself: pre-seed and verify both tools consult it.
  cache.set("fetch|https://example.com/x|false", Promise.resolve("CACHED-FETCH"));
  cache.set("search|q|15|false|", Promise.resolve("CACHED-SEARCH"));
  const ctx2 = { ...ctx, webCache: cache, cfg: { ...cfg } };
  assert.equal(await all.fetch_url.run({ url: "https://example.com/x" }, ctx2), "CACHED-FETCH");
  assert.equal(await all.web_search.run({ query: "q" }, ctx2), "CACHED-SEARCH");
});

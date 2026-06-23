const test = require("node:test");
const assert = require("node:assert");
const {
  looksGreenfield,
  detectCommands,
  parseCheckOutput,
  partitionWaves,
  coerceBuildModules,
  moduleFileOwner,
  buildRepoMap,
  gitDiffSince,
} = require("../../dist/codeintel.js");

test("looksGreenfield: only dotfiles / README / LICENSE counts as empty", () => {
  assert.equal(looksGreenfield([]), true);
  assert.equal(looksGreenfield(["README.md", ".gitignore", "LICENSE"]), true);
  assert.equal(looksGreenfield(["package.json"]), false);
  assert.equal(looksGreenfield(["src", ".git"]), false);
});

test("detectCommands: reads package.json scripts, skips non-terminating", () => {
  const cmds = detectCommands({
    packageJson: JSON.stringify({
      scripts: { build: "tsc", test: "vitest run", dev: "vite", typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^5" },
    }),
    lockfiles: ["package-lock.json"],
  });
  assert.equal(cmds.build, "npm run build");
  assert.equal(cmds.test, "npm run test");
  assert.equal(cmds.typecheck, "npm run typecheck");
  assert.equal(cmds.install, "npm ci");
});

test("detectCommands: cargo / go fallbacks", () => {
  assert.equal(detectCommands({ cargo: "[package]", lockfiles: [] }).test, "cargo test");
  assert.equal(detectCommands({ gomod: "module x", lockfiles: [] }).build, "go build ./...");
});

test("parseCheckOutput: test counts + no-tests signal", () => {
  const passed = parseCheckOutput("test", "Tests: 0 failed, 142 passed, 142 total", 0);
  assert.equal(passed.pass, true);
  assert.equal(passed.total, 142);

  const failed = parseCheckOutput("test", "Tests: 3 failed, 139 passed, 142 total", 1);
  assert.equal(failed.pass, false);
  assert.equal(failed.failed, 3);

  const none = parseCheckOutput("test", "no tests ran", 0);
  assert.equal(none.pass, false, "explicit 'no tests ran' must NOT be a pass");
  assert.match(none.firstFailures[0], /no tests ran/);

  // INVARIANT (TDD oracle): "no tests" needs EXPLICIT zero-collection evidence.
  // A passing command that just doesn't print a count must be a PASS, not noTests
  // — else a green tree (Go, custom runners) is falsely reported red.
  const goPass = parseCheckOutput("test", "ok  github.com/x/y  0.123s", 0);
  assert.equal(goPass.pass, true, "exit-0 count-less test output must be a PASS, not noTests");
  assert.ok(!goPass.firstFailures.some((f) => /no tests ran/.test(f)), "count-less pass carries no no-tests marker");

  const jestNone = parseCheckOutput("test", "No tests found, exiting with code 0", 0);
  assert.equal(jestNone.pass, false, "explicit 'No tests found' is a real no-tests RED");
});

test("parseCheckOutput: typecheck error lines", () => {
  const r = parseCheckOutput("typecheck", "src/a.ts(3,1): error TS2345: bad\nok", 1);
  assert.equal(r.pass, false);
  assert.ok(r.failed >= 1);
});

test("partitionWaves: disjoint modules with deps topo-sort into conflict-free waves", () => {
  const waves = partitionWaves({
    modules: [
      { id: "core", files: ["src/core.ts"], deps: [] },
      { id: "api", files: ["src/api.ts"], deps: ["core"] },
      { id: "util", files: ["src/util.ts"], deps: [] },
    ],
  });
  assert.deepEqual(waves[0].sort(), ["core", "util"]);
  assert.deepEqual(waves[1], ["api"]);
});

test("partitionWaves: rejects file collisions and cycles", () => {
  assert.equal(
    partitionWaves({ modules: [{ id: "a", files: ["src/x.ts"], deps: [] }, { id: "b", files: ["./src/x.ts"], deps: [] }] }),
    null,
    "two modules owning the same file (after normalization) is invalid"
  );
  assert.equal(
    partitionWaves({ modules: [{ id: "a", files: ["a.ts"], deps: ["b"] }, { id: "b", files: ["b.ts"], deps: ["a"] }] }),
    null,
    "dependency cycle is invalid"
  );
  assert.equal(partitionWaves({ modules: [] }), null, "empty plan is unusable");
  assert.equal(
    partitionWaves({ modules: [{ id: "a", files: [], deps: [] }, { id: "b", files: [], deps: [] }] }),
    null,
    "a partition where no module owns any file enforces nothing → unusable"
  );
  assert.equal(
    partitionWaves({ modules: [{ id: "a", files: [], deps: [] }, { id: "a", files: [], deps: [] }] }),
    null,
    "duplicate module id is invalid"
  );
});

test("coerceBuildModules: drops malformed entries, fills ids", () => {
  const mods = coerceBuildModules([
    { id: "x", files: ["a.ts"], purpose: "p", deps: ["y"], hard: true },
    { files: ["b.ts"] },
    "garbage",
    null,
  ]);
  assert.equal(mods.length, 2, "non-object entries are dropped");
  assert.equal(mods[0].hard, true);
  assert.equal(mods[1].id, "M2", "missing id is filled from the original index");
});

test("moduleFileOwner: maps each owned file to its module", () => {
  const owner = moduleFileOwner({ modules: [{ id: "m1", files: ["./src/a.ts"], deps: [] }] });
  assert.equal(owner.get("src/a.ts"), "m1");
});

test("buildRepoMap: parses grep output into per-file symbols, ranks, and degrades on error", async () => {
  const grepOut = [
    "src/index.ts:1:export function main() {",
    "src/index.ts:5:export class App {",
    "src/util.ts:2:export const clip = (s) => s",
    "garbage-without-colons",
  ].join("\n");
  const exec = async () => ({ code: 0, out: grepOut, timedOut: false });
  const map = await buildRepoMap(exec, "/x", new AbortController().signal, 6000);
  const idx = map.files.find((f) => f.path === "src/index.ts");
  assert.ok(idx, "index.ts present");
  assert.equal(idx.symbols.length, 2);
  assert.equal(map.files[0].path, "src/index.ts", "entry-pointy + symbol-rich file ranks first");

  const failing = async () => {
    throw new Error("no exec");
  };
  const empty = await buildRepoMap(failing, "/x", new AbortController().signal, 6000);
  assert.deepEqual(empty, { files: [], truncated: false });
});

test("buildRepoMap: empty grep output ⇒ empty map; over-budget ⇒ truncated with fewer files", async () => {
  const sig = new AbortController().signal;
  const blank = await buildRepoMap(async () => ({ code: 0, out: "", timedOut: false }), "/x", sig, 6000);
  assert.deepEqual(blank, { files: [], truncated: false });

  // Many files, each with a long signature; a tiny budget must truncate.
  const many = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts:1:export function veryLongSymbolNameNumber${i}(argumentOne, argumentTwo, argumentThree) {`).join("\n");
  const map = await buildRepoMap(async () => ({ code: 0, out: many, timedOut: false }), "/x", sig, 200);
  assert.equal(map.truncated, true, "over-budget map is flagged truncated");
  assert.ok(map.files.length > 0 && map.files.length < 50, `kept a budget-limited subset (${map.files.length}/50)`);
});

test("gitDiffSince: parses changed files; a bogus ref degrades to [] (never throws)", async () => {
  const sig = new AbortController().signal;
  const ok = await gitDiffSince(async () => ({ code: 0, out: "src/a.ts\nsrc/b.ts\n", timedOut: false }), "/x", "HEAD~1", sig);
  assert.deepEqual(ok, ["src/a.ts", "src/b.ts"]);
  const bad = await gitDiffSince(async () => { throw new Error("bad revision"); }, "/x", "nope", sig);
  assert.deepEqual(bad, [], "an unresolvable ref yields [] rather than throwing");
});

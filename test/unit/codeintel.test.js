const test = require("node:test");
const assert = require("node:assert");
const {
  looksGreenfield,
  detectCommands,
  parseCheckOutput,
  codeCacheCleanCommand,
  partitionWaves,
  coerceBuildModules,
  coerceProductSpec,
  detectServeCommand,
  isWebApp,
  serveDaemonCommand,
  moduleFileOwner,
  buildRepoMap,
  gitDiffSince,
} = require("../../dist/codeintel.js");

/** Minimal RepoProfile for the cache-clean tests. */
function profile(over = {}) {
  return {
    greenfield: false,
    primaryLanguage: null,
    packageManager: null,
    framework: null,
    commands: {},
    monorepo: { tool: null, packages: [] },
    git: { isRepo: true, branch: "main", dirty: false },
    conventions: [],
    manifestFiles: [],
    ...over,
  };
}

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

test("codeCacheCleanCommand: JS/TS projects clear regenerable caches, never source/deliverables", () => {
  // A JS project (detected by package manager) clears the framework + TS incremental caches.
  const cmd = codeCacheCleanCommand(profile({ packageManager: "npm", primaryLanguage: "TypeScript", framework: "Next.js" }));
  assert.ok(cmd, "a JS/TS project must get a clean command");
  assert.match(cmd, /rm -rf /);
  for (const c of [".next", "node_modules/.cache", "tsconfig.tsbuildinfo", "*.tsbuildinfo"]) {
    assert.ok(cmd.includes(c), `should clear the regenerable cache ${c}`);
  }
  // NEVER touch source, node_modules itself, or a build output that could be the deliverable.
  for (const danger of [" src", " node_modules ", " dist", " build", " out "]) {
    assert.ok(!cmd.includes(danger), `must not remove ${danger.trim()}`);
  }
  // A no-match glob must not fail the gate.
  assert.match(cmd, /; true\s*$/);
});

test("codeCacheCleanCommand: detects JS by a package.json manifest even without a package manager", () => {
  const cmd = codeCacheCleanCommand(profile({ manifestFiles: ["package.json"] }));
  assert.ok(cmd && cmd.includes(".next"), "package.json alone marks a JS project");
});

test("codeCacheCleanCommand: Python clears mypy/pytest caches", () => {
  const cmd = codeCacheCleanCommand(profile({ primaryLanguage: "Python", manifestFiles: ["pyproject.toml"] }));
  assert.ok(cmd && cmd.includes(".mypy_cache") && cmd.includes(".pytest_cache"));
});

test("codeCacheCleanCommand: nothing safe to clear → null (e.g. Rust/Go, content-addressed caches)", () => {
  assert.equal(codeCacheCleanCommand(profile({ primaryLanguage: "Rust", manifestFiles: ["Cargo.toml"] })), null);
  assert.equal(codeCacheCleanCommand(profile({ primaryLanguage: "Go", manifestFiles: ["go.mod"] })), null);
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

const { scanStubs, formatStubFindings } = require("../../dist/codeintel.js");

/** Build a minimal unified-diff hunk that ADDS the given lines to `file`. */
function addedDiff(file, lines) {
  const body = lines.map((l) => `+${l}`).join("\n");
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

test("scanStubs: flags empty click handlers, href=#, TODO, not-implemented", () => {
  const diff = addedDiff("src/App.tsx", [
    `      <button onClick={() => {}}>New Page</button>`,
    `      <a href="#">Settings</a>`,
    `      // TODO: wire this up`,
    `      throw new Error("not implemented");`,
    `      <div>Real content {count}</div>`,
  ]);
  const kinds = scanStubs(diff).map((f) => f.kind);
  assert.ok(kinds.includes("dead-handler"), "empty onClick is a dead-handler");
  assert.ok(kinds.includes("dead-link"), 'href="#" is a dead-link');
  assert.ok(kinds.includes("todo-marker"), "TODO is flagged");
  assert.ok(kinds.includes("not-implemented"), "throw new Error('not implemented') is flagged");
});

test("scanStubs: flags console-only handlers but not real handlers that also log", () => {
  const stubs = addedDiff("src/App.tsx", [
    `      <button onClick={() => console.log("clicked")}>Save</button>`,
    `      <button onClick={() => { console.error("nope"); }}>Delete</button>`,
  ]);
  const kinds = scanStubs(stubs).map((f) => f.kind);
  assert.equal(kinds.filter((k) => k === "stub-console").length, 2, "both console-only handlers are flagged");
  const real = addedDiff("src/App.tsx", [
    `      <button onClick={() => { console.log("saving"); save(); }}>Save</button>`,
    `      <button onClick={handleClick}>Go</button>`,
  ]);
  assert.deepEqual(scanStubs(real), [], "a handler that logs AND does real work is not flagged");
});

test("scanStubs: wired controls and real code are NOT flagged", () => {
  const diff = addedDiff("src/App.tsx", [
    `      <button onClick={handleNewPage}>New Page</button>`,
    `      <a href="/settings">Settings</a>`,
    `      const total = items.reduce((a, b) => a + b.n, 0);`,
    `      return <div>{total}</div>;`,
  ]);
  assert.deepEqual(scanStubs(diff), [], "fully-wired UI produces no findings");
});

test("scanStubs: bare empty return only flagged in handler/route files", () => {
  const handler = addedDiff("src/api/userRoute.ts", ["export function handler() {", "  return null;", "}"]);
  assert.ok(scanStubs(handler).some((f) => f.kind === "empty-return"), "return null in a route file is suspect");
  const ui = addedDiff("src/components/Avatar.tsx", ["function Avatar() {", "  return null;", "}"]);
  assert.deepEqual(scanStubs(ui), [], "return null in a normal component is fine (conditional render)");
});

test("scanStubs: ignores removed lines, tests, generated paths, and markdown", () => {
  // removed line containing a stub marker must not count
  const removed = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,1 @@\n-  // TODO old\n+  const y = realWork();\n`;
  assert.deepEqual(scanStubs(removed), [], "a removed TODO is not a finding");
  assert.deepEqual(scanStubs(addedDiff("src/x.test.ts", ["  onClick={() => {}}"])), [], "test files are skipped");
  assert.deepEqual(scanStubs(addedDiff("dist/bundle.js", ["  onClick={() => {}}"])), [], "generated paths are skipped");
  assert.deepEqual(scanStubs(addedDiff("README.md", ["TODO: docs"])), [], "markdown is skipped");
});

test("scanStubs: line numbers track the hunk; never throws on junk", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,3 @@\n context line\n+  onClick={() => {}}\n+  ok();\n`;
  const f = scanStubs(diff);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 11, "added stub is on new-file line 11 (10 = context)");
  assert.doesNotThrow(() => scanStubs("not a diff at all\n@@ garbage\n+++ "));
  assert.deepEqual(scanStubs(""), []);
});

test("formatStubFindings: groups by kind; empty in, empty out", () => {
  assert.equal(formatStubFindings([]), "");
  const out = formatStubFindings([
    { file: "a.tsx", line: 1, kind: "dead-handler", snippet: "onClick={() => {}}" },
    { file: "b.tsx", line: 2, kind: "dead-handler", snippet: "onClick={undefined}" },
    { file: "c.tsx", line: 3, kind: "dead-link", snippet: 'href="#"' },
  ]);
  assert.match(out, /dead-handler \(2\)/);
  assert.match(out, /dead-link \(1\)/);
  assert.match(out, /a\.tsx:1/);
});

test("coerceProductSpec: distills a valid spec, defaults missing fields", () => {
  const raw = {
    productName: "Notion",
    oneLiner: "an all-in-one workspace",
    features: [
      { name: "Block editor", description: "rich text blocks", priority: "core" },
      { name: "Templates", description: "starter pages", priority: "secondary" },
      { name: "", description: "dropped — no name" },
    ],
    screens: [{ name: "Sidebar", purpose: "navigation", elements: ["tree", "search"] }],
    dataModel: [{ entity: "Page", fields: ["id", "title"], relations: "has many Block" }],
    recommendedStack: { frontend: "Next.js", database: "Postgres", rationale: "modern" },
    uxDetails: ["empty state", "keyboard shortcuts"],
    nonGoals: ["mobile app"],
    grounded: true,
  };
  const spec = coerceProductSpec(raw, ["https://notion.so"]);
  assert.ok(spec, "spec produced");
  assert.equal(spec.productName, "Notion");
  assert.equal(spec.features.length, 2, "the nameless feature is dropped");
  assert.equal(spec.features[1].priority, "secondary");
  assert.equal(spec.screens[0].elements.length, 2);
  assert.equal(spec.dataModel[0].relations, "has many Block");
  assert.equal(spec.recommendedStack.frontend, "Next.js");
  assert.equal(spec.grounded, true, "grounded stays true when sources back it");
  assert.deepEqual(spec.sources, ["https://notion.so"]);
});

test("coerceProductSpec: grounded is false without real sources, even if the model claims true", () => {
  const spec = coerceProductSpec(
    { productName: "X", features: [{ name: "f", description: "d", priority: "core" }], grounded: true },
    []
  );
  assert.ok(spec);
  assert.equal(spec.grounded, false, "no sources → not grounded");
});

test("coerceProductSpec: null on garbage / no substance", () => {
  assert.equal(coerceProductSpec(null, []), null);
  assert.equal(coerceProductSpec("nope", []), null);
  assert.equal(coerceProductSpec({ productName: "Empty", features: [], screens: [] }, []), null);
});

test("detectServeCommand: recovers the dev server with a deterministic port per framework", () => {
  // Next.js dev → -p flag + PORT env, wrapped via `npm run`
  const next = detectServeCommand({ packageJson: JSON.stringify({ scripts: { dev: "next dev", build: "next build", start: "next start" }, dependencies: { next: "^15" } }), lockfiles: ["package-lock.json"] }, 4317);
  assert.ok(next, "Next.js dev script is recognized as a serve command");
  assert.match(next.cmd, /npm run dev/);
  assert.match(next.cmd, /-p 4317/);
  assert.match(next.cmd, /PORT=4317/);
  assert.equal(next.needsBuild, false);

  // Vite dev → --port --strictPort
  const vite = detectServeCommand({ packageJson: JSON.stringify({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, devDependencies: { vite: "^5", vue: "^3" } }), lockfiles: [] }, 4318);
  assert.match(vite.cmd, /--port 4318/);
  assert.match(vite.cmd, /--strictPort/);

  // CRA → PORT env, BROWSER=none
  const cra = detectServeCommand({ packageJson: JSON.stringify({ scripts: { start: "react-scripts start" }, dependencies: { react: "^18", "react-scripts": "5" } }), lockfiles: [] }, 4319);
  assert.match(cra.cmd, /PORT=4319/);
  assert.match(cra.cmd, /BROWSER=none/);

  // A non-web project (cargo / plain lib) → null
  assert.equal(detectServeCommand({ cargo: "[package]", lockfiles: [] }, 4000), null);
  assert.equal(detectServeCommand({ packageJson: JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }), lockfiles: [] }, 4000), null);
});

test("isWebApp: true for JS UI frameworks, false otherwise", () => {
  const p = (framework) => ({ greenfield: false, primaryLanguage: "TypeScript", packageManager: "npm", framework, commands: {}, monorepo: { tool: null, packages: [] }, git: { isRepo: true, branch: "main", dirty: false }, conventions: [], manifestFiles: [] });
  assert.equal(isWebApp(p("Next.js")), true);
  assert.equal(isWebApp(p("React")), true);
  assert.equal(isWebApp(p("Vue")), true);
  assert.equal(isWebApp(p("Express")), false);
  assert.equal(isWebApp(p(null)), false);
});

test("serveDaemonCommand: runs the serve cmd through `sh -c` so a PORT= env prefix is an assignment, not nohup's program", () => {
  const cmd = serveDaemonCommand("PORT=4317 npm run dev -- -p 4317", "/runs/x/serve.log", "/runs/x/serve.pid");
  // Must wrap in `sh -c` so `PORT=…` is parsed by the shell as an env assignment.
  assert.match(cmd, /nohup sh -c /);
  // The env prefix must NOT appear directly after `nohup` (that is the bug: nohup
  // would treat `PORT=4317` as its program operand → ENOENT, server never binds).
  assert.ok(!/nohup PORT=/.test(cmd), "PORT= must not follow nohup directly");
  // Daemonized + pid captured.
  assert.match(cmd, /< \/dev\/null/);
  assert.match(cmd, /echo \$! >/);
});

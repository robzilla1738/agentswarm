const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshLedger(homeDir) {
  process.env.AGENTSWARM_HOME = homeDir;
  for (const m of ["../../dist/codeledger.js", "../../dist/config.js"]) {
    delete require.cache[require.resolve(m)];
  }
  return require("../../dist/codeledger.js");
}

test("repoKey: prefers normalized git remote, else hashes the path", () => {
  const { repoKey } = freshLedger(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rf-")));
  assert.equal(repoKey("git@github.com:me/proj.git", "/x"), "remote:https://github.com/me/proj");
  assert.equal(repoKey("https://github.com/me/proj.git", "/x"), "remote:https://github.com/me/proj");
  assert.match(repoKey("", "/abs/path"), /^path:[0-9a-f]{16}$/);
  assert.equal(repoKey("", "/a"), repoKey(null, "/a"), "same path → same key");
});

test("manifestHash: stable for same setup, changes when commands change", () => {
  const { manifestHash } = freshLedger(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rf-")));
  const a = manifestHash({ commands: { build: "x" }, manifestFiles: ["package.json"], packageManager: "npm", primaryLanguage: "TS" });
  const b = manifestHash({ commands: { build: "x" }, manifestFiles: ["package.json"], packageManager: "npm", primaryLanguage: "TS" });
  const c = manifestHash({ commands: { build: "y" }, manifestFiles: ["package.json"], packageManager: "npm", primaryLanguage: "TS" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("mergeConfirmedCommands: detection wins, confirmed fills gaps", () => {
  const { mergeConfirmedCommands } = freshLedger(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rf-")));
  const { commands, filled } = mergeConfirmedCommands(
    { build: "npm run build" },
    { build: "STALE", test: "npm run test:ci", lint: "eslint ." }
  );
  assert.equal(commands.build, "npm run build", "detected build is authoritative");
  assert.equal(commands.test, "npm run test:ci", "confirmed test fills the gap");
  assert.deepEqual(filled.sort(), ["lint", "test"]);
});

test("append then load round-trips, honors key + manifestHash, latest wins", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rf-"));
  const { appendRepoFacts, loadRepoFacts } = freshLedger(home);
  appendRepoFacts({ key: "k1", manifestHash: "h1", at: 1, commands: { test: "old" }, conventions: [] });
  appendRepoFacts({ key: "k1", manifestHash: "h1", at: 2, commands: { test: "new" }, conventions: ["x"] });
  appendRepoFacts({ key: "k1", manifestHash: "h2", at: 3, commands: { test: "other-setup" }, conventions: [] });

  const hit = loadRepoFacts("k1", "h1");
  assert.equal(hit.commands.test, "new", "latest matching record wins");
  assert.equal(loadRepoFacts("k1", "hX"), null, "no matching manifest hash → stale → null");
  assert.equal(loadRepoFacts("nope", "h1"), null, "unknown key → null");
});

test("loadRepoFacts: missing file and malformed lines degrade to null/skip", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rf-"));
  const { loadRepoFacts, repoFactsPath, appendRepoFacts } = freshLedger(home);
  assert.equal(loadRepoFacts("k", "h"), null, "no file yet → null");
  appendRepoFacts({ key: "k", manifestHash: "h", at: 1, commands: {}, conventions: [] });
  fs.appendFileSync(repoFactsPath(), "{not json}\n", "utf8");
  assert.ok(loadRepoFacts("k", "h"), "malformed line is skipped, good record still found");
});

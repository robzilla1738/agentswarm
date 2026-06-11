// Unit tests for validateArtifactFormat — the zero-token structural checks
// the mechanical pre-verifier runs on claimed artifacts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateArtifactFormat } = require("../../dist/util.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-validate-"));
function file(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

test("valid JSON passes", () => {
  assert.equal(validateArtifactFormat(file("a.json", '{"ok": [1, 2, 3]}')), null);
});

test("broken JSON is flagged", () => {
  const problem = validateArtifactFormat(file("b.json", '{"ok": [1, 2,'));
  assert.match(problem, /not valid JSON/);
});

test("rectangular CSV passes", () => {
  assert.equal(validateArtifactFormat(file("a.csv", "name,age\nalice,30\nbob,41\n")), null);
});

test("quoted fields with commas and newlines pass", () => {
  const csv = 'name,quote\nalice,"hello, world"\nbob,"line one\nline two"\n';
  assert.equal(validateArtifactFormat(file("q.csv", csv)), null);
});

test("ragged CSV is flagged with the offending record", () => {
  const problem = validateArtifactFormat(file("c.csv", "a,b,c\n1,2,3\n4,5\n"));
  assert.match(problem, /record 1 has 3 field\(s\), record 3 has 2/);
});

test("blank lines in CSV are ignored", () => {
  assert.equal(validateArtifactFormat(file("d.csv", "a,b\n1,2\n\n3,4\n")), null);
});

test("real HTML passes", () => {
  const html = `<!doctype html><html><head><title>x</title></head><body>${"content ".repeat(40)}</body></html>`;
  assert.equal(validateArtifactFormat(file("a.html", html)), null);
});

test("stub HTML is flagged", () => {
  assert.match(validateArtifactFormat(file("b.html", "<html></html>")), /stub/);
  assert.match(validateArtifactFormat(file("c.html", "just plain text ".repeat(30))), /stub/);
});

test("unchecked formats pass through", () => {
  assert.equal(validateArtifactFormat(file("notes.md", "x")), null);
  assert.equal(validateArtifactFormat(file("data.bin", "\x00\x01")), null);
});

test("missing file is not this check's problem", () => {
  assert.equal(validateArtifactFormat(path.join(tmp, "missing.json")), null);
});

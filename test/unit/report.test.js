const test = require("node:test");
const assert = require("node:assert");
const { mdToHtml, renderFinalHtml } = require("../../dist/report.js");

test("headings, paragraphs, emphasis", () => {
  const html = mdToHtml("# Title\n\nSome **bold** and *italic* and `code`.\n\n## Section");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<h2>Section<\/h2>/);
});

test("fenced code blocks are escaped and never inline-formatted", () => {
  const html = mdToHtml("```js\nconst a = \"<b>\" && **x**;\n```");
  assert.match(html, /<pre><code class="lang-js">/);
  assert.match(html, /&lt;b&gt;/);
  assert.ok(!html.includes("<strong>"), "no bold inside code blocks");
});

test("links, bare urls, and images", () => {
  const html = mdToHtml("See [docs](https://example.com/a) and https://example.com/b plus ![alt](https://example.com/c.png)");
  assert.match(html, /<a href="https:\/\/example.com\/a"[^>]*>docs<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/b"/);
  assert.match(html, /<img src="https:\/\/example.com\/c.png" alt="alt"/);
});

test("tables render with header and rows", () => {
  const html = mdToHtml("| Name | Score |\n|------|------:|\n| a | 1 |\n| b | 2 |");
  assert.match(html, /<table><thead><tr><th>Name<\/th><th>Score<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>a<\/td><td>1<\/td>/);
  assert.match(html, /<td>b<\/td><td>2<\/td>/);
});

test("nested and ordered lists", () => {
  const html = mdToHtml("- one\n- two\n  - nested\n- three\n\n1. first\n2. second");
  assert.match(html, /<ul><li>one/);
  assert.match(html, /<ul><li>nested/);
  assert.match(html, /<ol><li>first/);
  // balanced tags
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length);
  assert.equal((html.match(/<ol>/g) || []).length, (html.match(/<\/ol>/g) || []).length);
});

test("blockquotes and hr", () => {
  const html = mdToHtml("> quoted **text**\n> second line\n\n---");
  assert.match(html, /<blockquote>/);
  assert.match(html, /<strong>text<\/strong>/);
  assert.match(html, /<hr>/);
});

test("raw html in markdown is escaped (no injection)", () => {
  const html = mdToHtml('<script>alert("x")</script>\n\nplain');
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("renderFinalHtml is a self-contained document", () => {
  const doc = renderFinalHtml({
    markdown: "# Mission accomplished\n\n**Outcome**: success.",
    mission: 'Build the "thing" & test it',
    runId: "run-abc123",
    status: "done",
    finishedAt: 1750000000000,
  });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<title>Mission accomplished<\/title>/);
  assert.match(doc, /class="badge done"/);
  assert.match(doc, /run-abc123/);
  assert.match(doc, /&quot;thing&quot; &amp; test/);
  assert.ok(!/<script/i.test(doc), "no scripts in the report document");
});

test("renderFinalHtml falls back to the mission as title", () => {
  const doc = renderFinalHtml({
    markdown: "no heading here",
    mission: "Research X",
    runId: "r1",
    status: "failed",
    finishedAt: 1750000000000,
  });
  assert.match(doc, /<title>Research X<\/title>/);
  assert.match(doc, /class="badge failed"/);
});

// ---------- source aggregation (citation pipeline) ----------

const { aggregateSources, sourcesBlock } = require("../../dist/report.js");

function taskWith(id, sources) {
  return { id, title: id, objective: "", role: "researcher", deps: [], verify: false,
    status: "done", attempt: 1, wave: 1, artifacts: [], createdAt: 0, agentIds: [], sources };
}

test("aggregateSources dedupes by canonical URL and merges metadata", () => {
  const out = aggregateSources([
    taskWith("T1", [{ url: "https://www.example.com/alpha/?utm_source=x", note: "perf" }]),
    taskWith("T2", [
      { url: "https://example.com/alpha", title: "Alpha Primer" },
      { url: "https://beta.org/report", title: "Beta", date: "2026-01" },
    ]),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].n, 1);
  assert.deepEqual(out[0].taskIds, ["T1", "T2"]);
  assert.equal(out[0].title, "Alpha Primer"); // filled in by the later task
  assert.equal(out[0].note, "perf"); // first occurrence kept
  assert.equal(out[1].n, 2);
  assert.deepEqual(out[1].taskIds, ["T2"]);
});

test("aggregateSources handles tasks without sources", () => {
  assert.deepEqual(aggregateSources([taskWith("T1", undefined), taskWith("T2", [])]), []);
});

test("sourcesBlock renders numbered, attributed lines", () => {
  const block = sourcesBlock(aggregateSources([
    taskWith("T1", [{ url: "https://a.com/x", title: "A", date: "2026" }]),
  ]));
  assert.match(block, /^\[1\] A — https:\/\/a\.com\/x \(2026\) \[cited by T1\]$/);
});

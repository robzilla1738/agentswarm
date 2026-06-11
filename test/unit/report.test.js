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

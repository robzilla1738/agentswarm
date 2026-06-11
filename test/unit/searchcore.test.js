const test = require("node:test");
const assert = require("node:assert");
const {
  queryTerms,
  expandQueries,
  canonicalizeUrl,
  classifySource,
  detectDate,
  selectPassages,
  scorePage,
  resultQualityScore,
  mergeCandidates,
} = require("../../dist/searchcore.js");
const { parseBingHtml } = require("../../dist/webtools.js");

test("queryTerms drops short tokens and dedupes", () => {
  assert.deepEqual(queryTerms("How is AI ai used in FastAPI lifespan events?"), [
    "how",
    "used",
    "fastapi",
    "lifespan",
    "events",
  ]);
  assert.ok(!queryTerms("is it an AI?").length, "1-2 char tokens all dropped");
});

test("expandQueries widens recall without noise, deduped and capped", () => {
  // question query → original + keyword core + guide angle
  const q = expandQueries("How do I configure FastAPI lifespan events?");
  assert.equal(q[0], "How do I configure FastAPI lifespan events?");
  assert.ok(q.includes("how configure fastapi lifespan events"), "keyword core variant");
  assert.ok(q.some((s) => s.endsWith("guide")), "docs/guide angle for questions");
  assert.ok(q.length <= 3, "capped");
  // plain keyword query where the core equals the input → no duplicate variants
  const k = expandQueries("redis vector search");
  assert.deepEqual(k, ["redis vector search"]);
  // respects the cap
  assert.ok(expandQueries("what is the best way to do x y z", 2).length <= 2);
});

test("canonicalizeUrl strips tracking params, www, trailing slash; sorts query", () => {
  assert.equal(
    canonicalizeUrl("https://WWW.Example.com/docs/?utm_source=x&b=2&fbclid=abc&a=1"),
    "https://example.com/docs?a=1&b=2"
  );
  assert.equal(canonicalizeUrl("https://example.com/path/"), "https://example.com/path");
  assert.equal(canonicalizeUrl("https://example.com"), "https://example.com/");
  // Same page through two engines → same key
  assert.equal(
    canonicalizeUrl("https://www.foo.com/a?utm_campaign=z"),
    canonicalizeUrl("https://foo.com/a/")
  );
});

test("classifySource buckets domains", () => {
  assert.equal(classifySource("nasa.gov"), "government");
  assert.equal(classifySource("mit.edu"), "academic");
  assert.equal(classifySource("reddit.com"), "social");
  assert.equal(classifySource("reuters.com"), "news");
  assert.equal(classifySource("example.io"), "secondary");
});

test("detectDate prefers ISO over bare year", () => {
  assert.equal(detectDate("released 2024 then updated on 2025-03-14 ok"), "2025-03-14");
  assert.equal(detectDate("circa 2023 sometime"), "2023");
  assert.equal(detectDate("no dates here"), undefined);
});

test("selectPassages returns scored windows matching the query", () => {
  const filler = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const text = `${filler} FastAPI lifespan events run startup and shutdown handlers. ${filler}`;
  const passages = selectPassages(text, "fastapi lifespan events");
  assert.ok(passages.length >= 1);
  assert.ok(passages[0].score > 0.9, `best passage should match all terms, got ${passages[0].score}`);
  assert.ok(passages[0].text.includes("lifespan events"));
});

test("selectPassages falls back to the lead window when nothing matches", () => {
  const passages = selectPassages("completely unrelated prose about gardening tips", "kubernetes ingress");
  assert.equal(passages.length, 1);
  assert.equal(passages[0].score, 0);
});

test("scorePage boosts docs and primary sources, penalizes registries", () => {
  const terms = ["fastapi", "lifespan"];
  const docs = scorePage(
    { url: "https://docs.foo.dev/guide", domain: "docs.foo.dev", title: "Guide", text: "fastapi lifespan ".repeat(300) },
    terms
  );
  const registry = scorePage(
    { url: "https://pypi.org/project/foo", domain: "pypi.org", title: "foo", text: "fastapi lifespan" },
    terms
  );
  assert.ok(docs > registry, `docs (${docs}) should outrank registry (${registry})`);
});

test("mergeCandidates dedupes by canonical url and quality-ranks", () => {
  const mk = (url, rank, engine, extra = {}) => ({ title: "t", url, snippet: "", rank, engine, ...extra });
  const merged = mergeCandidates(
    [
      mk("https://www.same.com/page?utm_source=a", 3, "ddg"),
      mk("https://same.com/page/", 1, "bing"),
      mk("https://official.dev/docs/intro", 5, "ddg", { snippet: "official documentation" }),
      mk("https://random.blog/post", 2, "bing"),
    ],
    10
  );
  const urls = merged.map((c) => c.url);
  assert.equal(urls.filter((u) => u.includes("same.com")).length, 1, "duplicates collapse");
  assert.equal(merged.length, 3);
  assert.ok(
    urls.indexOf("https://official.dev/docs/intro") < urls.indexOf("https://random.blog/post"),
    "docs/official signals outrank a better engine rank"
  );
});

test("resultQualityScore rewards docs/github, decays with rank", () => {
  const base = { title: "", snippet: "", engine: "ddg" };
  const top = resultQualityScore({ ...base, url: "https://a.com", rank: 1 });
  const low = resultQualityScore({ ...base, url: "https://a.com", rank: 10 });
  assert.ok(top > low);
  const gh = resultQualityScore({ ...base, url: "https://github.com/x/y", rank: 10 });
  assert.ok(gh > low);
});

test("parseBingHtml extracts results and decodes /ck/ redirects", () => {
  const real = "https://docs.example.com/guide";
  const encoded = "a1" + Buffer.from(real, "utf8").toString("base64url");
  const html = `
    <ol id="b_results">
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}&p=x">Example <b>Guide</b></a></h2>
        <div class="b_caption"><p>The official guide, updated 2025-01-02.</p></div></li>
      <li class="b_algo"><h2><a href="https://plain.example.org/page">Plain</a></h2><p>snippet two</p></li>
    </ol>`;
  const hits = parseBingHtml(html, 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, real, "bing redirect decoded");
  assert.equal(hits[0].title, "Example Guide");
  assert.equal(hits[0].date, "2025-01-02");
  assert.equal(hits[1].url, "https://plain.example.org/page");
});

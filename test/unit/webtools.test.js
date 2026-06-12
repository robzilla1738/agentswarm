// Unit tests for the web acquisition layer: engine rate-limit cooldowns,
// zero-result reformulation, fetch_url error/charset/PDF handling, and the
// keyless academic engine parsers. All network is stubbed.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");

const {
  webSearch,
  fetchUrl,
  arxivSearch,
  crossrefSearch,
  _resetEngineCooldowns,
} = require("../../dist/webtools.js");

function cfgWith(over = {}) {
  return {
    searchBackend: "auto",
    tinyfishApiKey: "",
    firecrawlApiKey: "",
    contextdevApiKey: "",
    deepcrawlApiKey: "",
    deepcrawlBaseUrl: "",
    crawlBackend: "auto",
    ...over,
  };
}

/** Stub global.fetch; handler returns { status?, headers?, body? }. */
function stubFetch(handler) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const out = (await handler(String(url), init, calls.length)) ?? {};
    const body = out.body ?? "";
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      statusText: out.statusText ?? "",
      headers: { get: (k) => (out.headers ?? {})[k.toLowerCase()] ?? null },
      text: async () => buf.toString("utf8"),
      json: async () => JSON.parse(buf.toString("utf8") || "{}"),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  return { calls, restore: () => (global.fetch = orig) };
}

test("a 429 storm starts an engine cooldown and later calls skip the engine", async (t) => {
  _resetEngineCooldowns();
  t.after(() => _resetEngineCooldowns());
  const fc1 = stubFetch(() => ({ status: 429, headers: { "retry-after": "60" } }));
  await assert.rejects(
    () => webSearch(cfgWith(), "anything", 5),
    /rate-limited|cooling down/,
    "all engines rate-limited should surface the cooldown"
  );
  fc1.restore();

  // Engines are now cooling: no fetch should even be attempted.
  const fc2 = stubFetch(() => ({ body: "<html></html>" }));
  await assert.rejects(() => webSearch(cfgWith(), "anything", 5), /cooling down/);
  assert.equal(fc2.calls.length, 0, "cooling engines must not be fetched");
  fc2.restore();
});

test("zero results trigger one reformulated retry", async () => {
  _resetEngineCooldowns();
  const fc = stubFetch(() => ({ body: "<html><body>no results markup</body></html>" }));
  const out = await webSearch(cfgWith(), '"Quoted Exotic Phrase" site:exotic.example', 5);
  fc.restore();
  assert.deepEqual(out, []);
  // Case-sensitive: the reformulated query is lowercased, the original is not.
  const reformulated = fc.calls.filter((c) => /quoted%20exotic%20phrase/.test(c.url));
  assert.ok(reformulated.length > 0, "expected a second sweep with the simplified query");
  assert.ok(!reformulated.some((c) => /site/.test(c.url)), "operators are stripped from the retry");
});

test("fetch_url throws on HTTP errors instead of returning the error page", async () => {
  const fc = stubFetch(() => ({ status: 403, statusText: "Forbidden", body: "<html>Subscribe to read</html>" }));
  await assert.rejects(
    () => fetchUrl(cfgWith(), "https://paywalled.example/article", false, 10_000),
    /not usable as a source/
  );
  fc.restore();
});

test("fetch_url decodes non-UTF-8 charsets from the content-type header", async () => {
  // windows-1252: 0x93/0x94 curly quotes, 0xE9 é
  const body = Buffer.concat([
    Buffer.from("<html><body>", "latin1"),
    Buffer.from([0x93]),
    Buffer.from("fancy", "latin1"),
    Buffer.from([0x94, 0x20]),
    Buffer.from("caf", "latin1"),
    Buffer.from([0xe9]),
    Buffer.from("</body></html>", "latin1"),
  ]);
  const fc = stubFetch(() => ({ headers: { "content-type": "text/html; charset=windows-1252" }, body }));
  const out = await fetchUrl(cfgWith(), "https://legacy.example/page", false, 10_000);
  fc.restore();
  assert.match(out, /“fancy”/);
  assert.match(out, /café/);
});

test("fetch_url extracts text from PDFs", async () => {
  const content = "BT (PDF body text for the extraction gate to accept without complaint here.) Tj ET";
  const stream = zlib.deflateSync(Buffer.from(content, "latin1"));
  const pdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Contents 4 0 R >> endobj\n" +
        `4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
      "latin1"
    ),
    stream,
    Buffer.from("\nendstream endobj\n%%EOF\n", "latin1"),
  ]);
  const fc = stubFetch(() => ({ headers: { "content-type": "application/pdf" }, body: pdf }));
  const out = await fetchUrl(cfgWith(), "https://papers.example/x.pdf", false, 10_000);
  fc.restore();
  assert.match(out, /^\[PDF, 1 page\]/);
  assert.match(out, /PDF body text/);
});

test("fetch_url flags paywall shells on thin HTML", async () => {
  const fc = stubFetch(() => ({
    headers: { "content-type": "text/html" },
    body: "<html><body>Please sign in to continue reading.</body></html>",
  }));
  const out = await fetchUrl(cfgWith(), "https://gated.example/story", false, 10_000);
  fc.restore();
  assert.match(out, /^WARNING: this page returned only a paywall/);
});

test("arxivSearch parses Atom entries", async () => {
  _resetEngineCooldowns();
  const xml = `<?xml version="1.0"?><feed>
    <entry><id>http://arxiv.org/abs/2501.01234</id><title>Swarm Orchestration at Scale</title>
    <summary>We study orchestration.</summary><published>2025-01-15T00:00:00Z</published></entry>
  </feed>`;
  const fc = stubFetch(() => ({ body: xml }));
  const out = await arxivSearch("swarm orchestration", 5);
  fc.restore();
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Swarm Orchestration at Scale");
  assert.equal(out[0].url, "http://arxiv.org/abs/2501.01234");
  assert.equal(out[0].date, "2025-01-15");
  assert.equal(out[0].engine, "arxiv");
});

test("crossrefSearch parses works JSON", async () => {
  _resetEngineCooldowns();
  const json = JSON.stringify({
    message: {
      items: [
        {
          title: ["Multi-Agent Systems Review"],
          DOI: "10.1000/xyz123",
          issued: { "date-parts": [[2024, 6]] },
          "container-title": ["Journal of AI"],
        },
      ],
    },
  });
  const fc = stubFetch(() => ({ body: json }));
  const out = await crossrefSearch("multi-agent systems", 5);
  fc.restore();
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://doi.org/10.1000/xyz123");
  assert.equal(out[0].date, "2024-6");
  assert.equal(out[0].snippet, "Journal of AI");
});

test("one engine answering empty while another fails is 'no results', not an error", async () => {
  _resetEngineCooldowns();
  // DDG answers cleanly with zero parseable hits; Bing 500s. A worker must
  // see an empty result set, not a thrown engine error. ("cats" cannot be
  // reformulated further, so this is the terminal path.)
  const fc = stubFetch((url) => {
    if (/bing\.com/.test(url)) return { status: 500, body: "oops" };
    return { body: "<html><body>no results markup</body></html>" };
  });
  const out = await webSearch(cfgWith(), "cats", 5);
  fc.restore();
  assert.deepEqual(out, []);
});

test("tinyfish-only backend falls back to scraping engines when tinyfish fails", async () => {
  _resetEngineCooldowns();
  const ddgHit =
    '<a class="result__a" href="https://example.com/cats">Cats</a>' +
    '<a class="result__snippet" href="#">all about cats</a>';
  const fc = stubFetch((url) => {
    if (/tinyfish/.test(url)) return { status: 500, body: "outage" };
    if (/duckduckgo/.test(url)) return { body: `<html><body>${ddgHit}</body></html>` };
    return { body: "<html></html>" }; // bing: reachable, no hits
  });
  const warns = [];
  const out = await webSearch(
    cfgWith({ searchBackend: "tinyfish", tinyfishApiKey: "tk-1" }),
    "cats",
    5,
    undefined,
    false,
    (m) => warns.push(m)
  );
  fc.restore();
  assert.ok(out.length > 0, "fallback engines must supply results during a tinyfish outage");
  assert.equal(out[0].url, "https://example.com/cats");
  assert.ok(warns.some((w) => /tinyfish failed/.test(w)), "the fallback is surfaced as a warning");
});

test("harvestUrls extracts, normalizes, dedupes, and caps", () => {
  const { harvestUrls } = require("../../dist/util.js");
  const text =
    "1. A https://example.com/a#frag 2. B (https://example.com/b). " +
    "dupe https://example.com/a trailing https://example.com/c, " +
    "quoted 'https://example.com/d' not-a-url ftp://nope";
  const urls = harvestUrls(text);
  assert.deepEqual(urls.sort(), [
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
    "https://example.com/d",
  ]);
  const many = Array.from({ length: 80 }, (_, i) => `https://x.y/p${i}`).join(" ");
  assert.equal(harvestUrls(many).length, 50, "capped at 50");
});

test("context.dev joins the auto search fan-out when keyed", async (t) => {
  _resetEngineCooldowns();
  t.after(() => _resetEngineCooldowns());
  const fc = stubFetch((url, init) => {
    if (url.includes("api.context.dev/v1/web/search")) {
      assert.equal(init.method, "POST");
      assert.equal(JSON.parse(init.body).query, "rust async runtimes");
      assert.match(init.headers.authorization, /^Bearer ck$/);
      return {
        body: JSON.stringify({
          results: [
            { url: "https://tokio.rs", title: "Tokio", description: "An async runtime", relevance: "high" },
            { url: "https://low.example.com", title: "Low", description: "meh", relevance: "low" },
          ],
        }),
      };
    }
    return { body: "<html></html>" }; // DDG/Bing parse to nothing
  });
  try {
    const hits = await webSearch(cfgWith({ contextdevApiKey: "ck" }), "rust async runtimes", 10);
    const urls = hits.map((h) => h.url);
    assert.ok(urls.includes("https://tokio.rs"), urls.join(", "));
    assert.ok(urls.indexOf("https://tokio.rs") < urls.indexOf("https://low.example.com"), "high relevance ranks first");
  } finally {
    fc.restore();
  }
});

test("contextdev-only backend falls back to free engines on outage", async (t) => {
  _resetEngineCooldowns();
  t.after(() => _resetEngineCooldowns());
  const fc = stubFetch((url) => {
    if (url.includes("api.context.dev")) return { status: 500, body: "boom" };
    if (url.includes("duckduckgo")) {
      return {
        body: '<a class="result__a" href="https://fallback.example.com/x">Fallback</a>',
      };
    }
    return { body: "<html></html>" };
  });
  try {
    const warns = [];
    const hits = await webSearch(
      cfgWith({ searchBackend: "contextdev", contextdevApiKey: "ck" }),
      "anything", 5, undefined, false, (m) => warns.push(m)
    );
    assert.ok(hits.some((h) => h.url.includes("fallback.example.com")), JSON.stringify(hits));
    assert.ok(warns.some((w) => /contextdev failed/.test(w)), warns.join(" | "));
  } finally {
    fc.restore();
  }
});

test("fetchUrl warns when the scrape backend fails and falls back to direct", async () => {
  const fc = stubFetch((url) => {
    if (url.includes("api.context.dev")) return { status: 403, body: "nope" };
    return { body: "<html><body><p>direct content here</p></body></html>", headers: { "content-type": "text/html" } };
  });
  try {
    const warns = [];
    const text = await fetchUrl(
      cfgWith({ crawlBackend: "contextdev", contextdevApiKey: "ck" }),
      "https://site.example.com/page", false, 10_000, undefined, (m) => warns.push(m)
    );
    assert.match(text, /direct content here/);
    assert.ok(warns.some((w) => /scrape backend failed/.test(w)), warns.join(" | "));
  } finally {
    fc.restore();
  }
});

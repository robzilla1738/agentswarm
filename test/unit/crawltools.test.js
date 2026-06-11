const test = require("node:test");
const assert = require("node:assert");
const {
  resolveCrawlBackend,
  hasScrapeBackend,
  crawlSite,
  scrapeUrl,
  slugForUrl,
} = require("../../dist/crawltools.js");

function cfgWith(over = {}) {
  return {
    firecrawlApiKey: "",
    contextdevApiKey: "",
    deepcrawlApiKey: "",
    deepcrawlBaseUrl: "",
    crawlBackend: "auto",
    ...over,
  };
}

/** Stub global.fetch with a sequence of responses; returns recorded calls. */
function stubFetch(handler) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init, calls.length);
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status ?? 200,
      json: async () => out.json,
      text: async () => JSON.stringify(out.json ?? {}),
    };
  };
  return { calls, restore: () => (global.fetch = orig) };
}

test("resolveCrawlBackend: auto priority, pinned, off", () => {
  assert.equal(resolveCrawlBackend(cfgWith()), null);
  assert.equal(resolveCrawlBackend(cfgWith({ contextdevApiKey: "k" })), "contextdev");
  assert.equal(
    resolveCrawlBackend(cfgWith({ firecrawlApiKey: "f", contextdevApiKey: "k" })),
    "contextdev",
    "contextdev wins auto priority (cost-effective)"
  );
  // deepcrawl needs BOTH base url and key
  assert.equal(resolveCrawlBackend(cfgWith({ deepcrawlApiKey: "k" })), null);
  assert.equal(
    resolveCrawlBackend(cfgWith({ deepcrawlApiKey: "k", deepcrawlBaseUrl: "https://c.x" })),
    "deepcrawl"
  );
  // pinned to an unconfigured backend → null
  assert.equal(resolveCrawlBackend(cfgWith({ crawlBackend: "firecrawl" })), null);
  assert.equal(
    resolveCrawlBackend(cfgWith({ crawlBackend: "off", firecrawlApiKey: "f" })),
    null,
    "off disables even when configured"
  );
});

test("hasScrapeBackend excludes deepcrawl", () => {
  assert.equal(hasScrapeBackend(cfgWith({ firecrawlApiKey: "f" })), true);
  assert.equal(hasScrapeBackend(cfgWith({ contextdevApiKey: "c" })), true);
  assert.equal(
    hasScrapeBackend(cfgWith({ deepcrawlApiKey: "k", deepcrawlBaseUrl: "https://c.x" })),
    false
  );
});

test("slugForUrl is filesystem-safe", () => {
  for (const url of [
    "https://a.com/../../etc/passwd",
    "https://docs.foo.com/api/v1/things?q=1&x=%2F",
    "https://uni.example/päge/ünïcode",
    "not a url at all",
  ]) {
    const { host, slug } = slugForUrl(url);
    for (const part of [host, slug]) {
      assert.match(part, /^[a-z0-9._-]+$/, `unsafe slug part from ${url}: ${part}`);
      assert.ok(!part.includes("/"), "no path separators");
      assert.ok(!part.includes(".."), `traversal in ${part}`);
    }
  }
  assert.deepEqual(slugForUrl("https://docs.foo.com/"), { host: "docs.foo.com", slug: "index" });
});

test("firecrawl crawl: start job, poll to completion, map pages", async () => {
  const fc = stubFetch((url, init, n) => {
    if (url.endsWith("/v1/crawl") && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.limit, 5, "page limit forwarded");
      assert.match(init.headers.authorization, /^Bearer fc-test$/);
      return { json: { success: true, id: "job1" } };
    }
    if (url.endsWith("/v1/crawl/job1")) {
      if (n === 2) return { json: { status: "scraping", data: [] } };
      return {
        json: {
          status: "completed",
          data: [
            { markdown: "# A", metadata: { sourceURL: "https://x.y/a", title: "A" } },
            { markdown: "", metadata: { sourceURL: "https://x.y/empty", title: "E" } },
            { markdown: "# B", metadata: { sourceURL: "https://x.y/b", title: "B" } },
          ],
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const out = await crawlSite(cfgWith({ firecrawlApiKey: "fc-test" }), {
      url: "https://x.y",
      maxPages: 5,
      pollMs: 1,
    });
    assert.equal(out.backend, "firecrawl");
    assert.deepEqual(out.pages.map((p) => p.title), ["A", "B"]);
    assert.ok(out.warnings.some((w) => w.includes("empty page")), "empty page warned");
  } finally {
    fc.restore();
  }
});

test("firecrawl 401 surfaces a friendly key message", async () => {
  const fc = stubFetch(() => ({ status: 401, json: { error: "unauthorized" } }));
  try {
    await assert.rejects(
      crawlSite(cfgWith({ firecrawlApiKey: "fc-bad" }), { url: "https://x.y", maxPages: 3, pollMs: 1 }),
      /firecrawl API key invalid.*401/
    );
  } finally {
    fc.restore();
  }
});

test("context.dev crawl parses results[] and respects maxPages", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    markdown: `# P${i}`,
    metadata: { url: `https://d.c/p${i}`, title: `P${i}` },
  }));
  const fc = stubFetch((url) => {
    assert.match(url, /api\.context\.dev\/v1\/web\/crawl$/);
    return { json: { results: many } };
  });
  try {
    const out = await crawlSite(cfgWith({ contextdevApiKey: "ck" }), { url: "https://d.c", maxPages: 10 });
    assert.equal(out.pages.length, 10, "clamped to maxPages");
    assert.equal(out.pages[0].url, "https://d.c/p0");
  } finally {
    fc.restore();
  }
});

test("deepcrawl accepts both shapes and rejects unknown ones", async () => {
  const cfg = cfgWith({ deepcrawlApiKey: "dk", deepcrawlBaseUrl: "https://crawler.x/" });
  let shape = { results: [{ markdown: "# R", metadata: { url: "https://s.t/r", title: "R" } }] };
  const fc = stubFetch((url) => {
    assert.equal(url, "https://crawler.x/crawl", "trailing slash trimmed");
    return { json: shape };
  });
  try {
    let out = await crawlSite(cfg, { url: "https://s.t", maxPages: 3 });
    assert.equal(out.pages[0].title, "R");

    shape = { pages: [{ url: "https://s.t/p", title: "P", markdown: "# P" }] };
    out = await crawlSite(cfg, { url: "https://s.t", maxPages: 3 });
    assert.equal(out.pages[0].title, "P");

    shape = { weird: true };
    await assert.rejects(crawlSite(cfg, { url: "https://s.t", maxPages: 3 }), /unrecognized response shape/);
  } finally {
    fc.restore();
  }
});

test("scrapeUrl uses firecrawl scrape and prepends the title", async () => {
  const fc = stubFetch((url, init) => {
    assert.match(url, /api\.firecrawl\.dev\/v1\/scrape$/);
    assert.equal(JSON.parse(init.body).url, "https://x.y/page");
    return { json: { data: { markdown: "body text", metadata: { title: "Page" } } } };
  });
  try {
    const text = await scrapeUrl(cfgWith({ firecrawlApiKey: "fc" }), "https://x.y/page");
    assert.equal(text, "# Page\n\nbody text");
  } finally {
    fc.restore();
  }
});

test("scrapeUrl throws when only deepcrawl is configured", async () => {
  await assert.rejects(
    scrapeUrl(cfgWith({ deepcrawlApiKey: "dk", deepcrawlBaseUrl: "https://c.x" }), "https://a.b"),
    /no scrape-capable/
  );
});

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Load config module fresh under a throwaway AGENTSWARM_HOME. */
function freshConfig(homeDir) {
  process.env.AGENTSWARM_HOME = homeDir;
  const mod = require.resolve("../../dist/config.js");
  delete require.cache[mod];
  return require("../../dist/config.js");
}

test("crawl integration keys round-trip through save/load (trimmed)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  const prevEnv = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const { saveConfig, loadConfig, coerceConfigValue } = freshConfig(home);
    saveConfig({
      firecrawlApiKey: "fc-abc123",
      contextdevApiKey: "ctx-xyz",
      crawlBackend: "firecrawl",
      deepcrawlBaseUrl: String(coerceConfigValue("deepcrawlBaseUrl", "  https://crawler.x  ")),
    });
    const cfg = loadConfig();
    assert.equal(cfg.firecrawlApiKey, "fc-abc123");
    assert.equal(cfg.contextdevApiKey, "ctx-xyz");
    assert.equal(cfg.crawlBackend, "firecrawl");
    assert.equal(cfg.deepcrawlBaseUrl, "https://crawler.x", "whitespace trimmed by coercion");
  } finally {
    if (prevHome) process.env.AGENTSWARM_HOME = prevHome;
    else delete process.env.AGENTSWARM_HOME;
    if (prevEnv) process.env.FIRECRAWL_API_KEY = prevEnv;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("crawlBackend enum rejects bogus values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  try {
    const { coerceConfigValue } = freshConfig(home);
    assert.throws(() => coerceConfigValue("crawlBackend", "bogus"), /must be one of/);
    assert.equal(coerceConfigValue("crawlBackend", "contextdev"), "contextdev");
  } finally {
    if (prevHome) process.env.AGENTSWARM_HOME = prevHome;
    else delete process.env.AGENTSWARM_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("env override wins over config file for crawl keys", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  const prevEnv = process.env.FIRECRAWL_API_KEY;
  try {
    const { saveConfig } = freshConfig(home);
    saveConfig({ firecrawlApiKey: "fc-from-file" });
    process.env.FIRECRAWL_API_KEY = "fc-from-env";
    const { loadConfig } = freshConfig(home);
    assert.equal(loadConfig().firecrawlApiKey, "fc-from-env");
  } finally {
    if (prevEnv) process.env.FIRECRAWL_API_KEY = prevEnv;
    else delete process.env.FIRECRAWL_API_KEY;
    if (prevHome) process.env.AGENTSWARM_HOME = prevHome;
    else delete process.env.AGENTSWARM_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("publicConfig masks crawl keys and never leaks them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  const prevEnv = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const { loadConfig, saveConfig } = freshConfig(home);
    saveConfig({ firecrawlApiKey: "fc-supersecret-key-1234" });
    const hubMod = require.resolve("../../dist/hub.js");
    delete require.cache[hubMod];
    const { publicConfig } = require("../../dist/hub.js");
    const pub = publicConfig(loadConfig());
    assert.equal(pub.firecrawlKeySet, true);
    assert.match(pub.firecrawlKeyMasked, /^fc-su…1234$/);
    assert.equal(pub.crawlResolved, "firecrawl");
    assert.ok(!JSON.stringify(pub).includes("fc-supersecret-key-1234"), "raw key must not appear");
  } finally {
    if (prevEnv) process.env.FIRECRAWL_API_KEY = prevEnv;
    if (prevHome) process.env.AGENTSWARM_HOME = prevHome;
    else delete process.env.AGENTSWARM_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("crawl_site tool only registers when a backend is configured", () => {
  const { workerToolset, verifierToolset } = require("../../dist/tools.js");
  const { DEFAULTS } = require("../../dist/config.js");
  assert.ok(!workerToolset().crawl_site, "no cfg → no crawl_site");
  assert.ok(!workerToolset({ ...DEFAULTS }).crawl_site, "unconfigured → no crawl_site");
  assert.ok(
    workerToolset({ ...DEFAULTS, firecrawlApiKey: "fc-x" }).crawl_site,
    "configured → crawl_site present"
  );
  assert.ok(!verifierToolset().crawl_site, "verifier never gets crawl_site");
});

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

// ---------- v0.6.0: per-model context windows ----------

const { contextLimitFor, DEFAULT_WINDOWS } = require("../../dist/config.js");

test("contextLimitFor caps the configured limit by the model's window", () => {
  const cfg = { contextTokenLimit: 120_000, contextWindows: { tiny: 32_000, huge: 1_000_000 } };
  assert.equal(contextLimitFor(cfg, "tiny"), Math.floor(32_000 * 0.85), "small windows clamp below the config");
  assert.equal(contextLimitFor(cfg, "huge"), 120_000, "big windows keep the configured limit");
  assert.equal(contextLimitFor(cfg, "unknown-model"), 120_000, "unknown models keep the configured limit");
});

test("DEFAULT_WINDOWS ships entries for the default models", () => {
  assert.ok(DEFAULT_WINDOWS["deepseek-v4-flash"] >= 100_000);
  assert.ok(DEFAULT_WINDOWS["claude-sonnet-4-6"] >= 100_000);
});

test("clearing model falls back to the provider default instead of bricking runs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  try {
    const { saveConfig, loadConfig } = freshConfig(home);
    // What `swarm config unset model` used to write — and what a hand-edit can still produce.
    saveConfig({ model: "", conductorModel: "" });
    const cfg = loadConfig();
    assert.ok(cfg.model, "model:\"\" must not survive loadConfig");
    assert.equal(cfg.conductorModel, cfg.model);
  } finally {
    if (prevHome === undefined) delete process.env.AGENTSWARM_HOME;
    else process.env.AGENTSWARM_HOME = prevHome;
  }
});

test("saveConfig drops keys patched to undefined so defaults re-apply", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  try {
    const { saveConfig, loadConfig, DEFAULTS } = freshConfig(home);
    saveConfig({ maxWorkers: 99 });
    assert.equal(loadConfig().maxWorkers, 99);
    saveConfig({ maxWorkers: undefined }); // `swarm config unset maxWorkers`
    assert.equal(loadConfig().maxWorkers, DEFAULTS.maxWorkers);
  } finally {
    if (prevHome === undefined) delete process.env.AGENTSWARM_HOME;
    else process.env.AGENTSWARM_HOME = prevHome;
  }
});

test("isSecretConfigKey covers nested provider creds", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  try {
    const { isSecretConfigKey } = freshConfig(home);
    assert.ok(isSecretConfigKey("apiKey"));
    assert.ok(isSecretConfigKey("tinyfishApiKey"));
    assert.ok(isSecretConfigKey("modalTokenSecret"));
    assert.ok(isSecretConfigKey("providers"), "providers holds raw per-provider apiKeys");
    assert.ok(!isSecretConfigKey("model"));
  } finally {
    if (prevHome === undefined) delete process.env.AGENTSWARM_HOME;
    else process.env.AGENTSWARM_HOME = prevHome;
  }
});

test("maxWorkers range honors the 256 ceiling, taskTimeoutMs is settable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cfg-"));
  const prevHome = process.env.AGENTSWARM_HOME;
  try {
    const { coerceConfigValue, SETTABLE_KEYS, DEFAULTS } = freshConfig(home);
    assert.equal(coerceConfigValue("maxWorkers", 256), 256);
    assert.equal(coerceConfigValue("maxWorkers", 999), 256, "out-of-range clamps to the ceiling");
    assert.equal(coerceConfigValue("maxWorkers", 0), 1, "floor stays at 1");
    assert.throws(() => coerceConfigValue("maxWorkers", "abc"), /must be a number/);
    assert.ok(SETTABLE_KEYS.includes("taskTimeoutMs"), "taskTimeoutMs is operator-settable");
    assert.equal(DEFAULTS.taskTimeoutMs, 1_200_000);
    assert.equal(coerceConfigValue("taskTimeoutMs", 1_000), 60_000, "clamps to the 1-minute floor");
    assert.equal(coerceConfigValue("taskTimeoutMs", 99_999_999_999), 86_400_000, "clamps to the 24-hour ceiling");
  } finally {
    if (prevHome === undefined) delete process.env.AGENTSWARM_HOME;
    else process.env.AGENTSWARM_HOME = prevHome;
  }
});

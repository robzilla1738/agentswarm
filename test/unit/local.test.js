const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { PROVIDERS } = require("../../dist/providers.js");
const { ollamaTagsUrl, gateFor, listModels } = require("../../dist/deepseek.js");
const { resolveRunModels } = require("../../dist/run.js");

/** Minimal config carrying only the fields the functions under test read. */
function cfg(over = {}) {
  return {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
    conductorModel: "deepseek-v4-flash",
    maxConcurrentCalls: 16,
    ...over,
  };
}

/** Spin a throwaway OpenAI-compatible /models (and Ollama /api/tags) server. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ base: `http://127.0.0.1:${port}/v1`, port, close: () => server.close() });
    });
  });
}

function modelsServer(ids) {
  // The OpenAI-compatible base already includes /v1, so the real request path is
  // /v1/models — match by suffix so the test mirrors the production URL.
  return startServer((req, res) => {
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
}

// ---------------------------------------------------------------- provider registry

test("local providers are flagged local with a concurrency cap; custom included", () => {
  for (const id of ["ollama", "lmstudio", "custom"]) {
    assert.equal(PROVIDERS[id].local, true, `${id} must be local`);
    assert.equal(PROVIDERS[id].keyRequired, false, `${id} must be keyless`);
    assert.ok(PROVIDERS[id].maxConcurrency > 0, `${id} must cap concurrency`);
  }
  // Local providers ship no default model → the engine auto-picks what's loaded.
  assert.equal(PROVIDERS.ollama.defaultModel, "");
  assert.equal(PROVIDERS.lmstudio.defaultModel, "");
  // Cloud providers keep a usable default and no extra cap.
  assert.equal(PROVIDERS.deepseek.maxConcurrency, undefined);
  assert.ok(PROVIDERS.deepseek.defaultModel);
});

// ---------------------------------------------------------------- ollama /api/tags url

test("ollamaTagsUrl: derives /api/tags from the OpenAI-compat base", () => {
  assert.equal(ollamaTagsUrl("http://localhost:11434/v1"), "http://localhost:11434/api/tags");
  assert.equal(ollamaTagsUrl("http://localhost:11434/v1/"), "http://localhost:11434/api/tags");
  assert.equal(ollamaTagsUrl("http://host:11434"), "http://host:11434/api/tags");
});

// ---------------------------------------------------------------- concurrency cap

test("gateFor: a local provider caps concurrency at provider.maxConcurrency", () => {
  // Distinct base URLs so the per-baseUrl gate cache never collides across cases.
  const local = gateFor(cfg({ provider: "lmstudio", baseUrl: "http://t-local-a/v1", maxConcurrentCalls: 16 }));
  assert.equal(local.state().ceiling, 4, "16 wide → capped to the local max of 4");

  const cloud = gateFor(cfg({ provider: "deepseek", baseUrl: "http://t-cloud-a/v1", maxConcurrentCalls: 16 }));
  assert.equal(cloud.state().ceiling, 16, "cloud providers are uncapped");

  const userLower = gateFor(cfg({ provider: "ollama", baseUrl: "http://t-local-b/v1", maxConcurrentCalls: 2 }));
  assert.equal(userLower.state().ceiling, 2, "a user's lower maxConcurrentCalls still wins over the cap");
});

// ---------------------------------------------------------------- model auto-pick

test("resolveRunModels: an already-set model is returned unchanged (no network)", async () => {
  // baseUrl points at a dead port — if this touched the network it would throw.
  const r = await resolveRunModels(cfg({ provider: "lmstudio", baseUrl: "http://127.0.0.1:1/v1", model: "my-local-model", conductorModel: "" }));
  assert.equal(r.model, "my-local-model");
  assert.equal(r.conductorModel, "my-local-model", "empty conductor mirrors the resolved worker model");
});

test("resolveRunModels: cloud provider with empty override falls through to cfg.model", async () => {
  const r = await resolveRunModels(cfg({ model: "deepseek-v4-pro", conductorModel: "" }));
  assert.equal(r.model, "deepseek-v4-pro");
  assert.equal(r.conductorModel, "deepseek-v4-pro", "empty conductor mirrors the worker model");
});

test("resolveRunModels: local + no model → auto-picks the first model the server reports", async () => {
  const srv = await modelsServer(["local-a", "local-b"]);
  try {
    const r = await resolveRunModels(cfg({ provider: "custom", baseUrl: srv.base, model: "", conductorModel: "" }));
    assert.equal(r.model, "local-a");
    assert.equal(r.conductorModel, "local-a");
  } finally {
    srv.close();
  }
});

test("resolveRunModels: local + server has no model loaded → clear, actionable error", async () => {
  const srv = await modelsServer([]);
  try {
    await assert.rejects(
      () => resolveRunModels(cfg({ provider: "lmstudio", baseUrl: srv.base, model: "" })),
      /No model is loaded/
    );
  } finally {
    srv.close();
  }
});

test("resolveRunModels: local + unreachable server → clear, actionable error", async () => {
  await assert.rejects(
    () => resolveRunModels(cfg({ provider: "lmstudio", baseUrl: "http://127.0.0.1:1/v1", model: "" })),
    /Could not reach/
  );
});

// ---------------------------------------------------------------- listModels keyless

test("listModels: works keyless against an OpenAI-compatible /models", async () => {
  const srv = await modelsServer(["a", "b", "c"]);
  try {
    const models = await listModels(cfg({ provider: "custom", baseUrl: srv.base, apiKey: "" }));
    assert.deepEqual(models, ["a", "b", "c"]);
  } finally {
    srv.close();
  }
});

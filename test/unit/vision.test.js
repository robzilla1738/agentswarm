const test = require("node:test");
const assert = require("node:assert");
const { sanitizeMessages } = require("../../dist/deepseek.js");
const { resolveVisionModel } = require("../../dist/config.js");

test("sanitizeMessages: a user message with imageParts becomes multimodal content", () => {
  const out = sanitizeMessages(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "compare these", imageParts: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] },
    ],
    false
  );
  assert.equal(out[0].content, "sys", "system stays a string");
  assert.ok(Array.isArray(out[1].content), "user content becomes an array of parts");
  assert.equal(out[1].content.length, 3, "1 text + 2 images");
  assert.equal(out[1].content[0].type, "text");
  assert.equal(out[1].content[0].text, "compare these");
  assert.equal(out[1].content[1].type, "image_url");
  assert.equal(out[1].content[1].image_url.url, "data:image/png;base64,AAA");
});

test("sanitizeMessages: plain string messages are unchanged (backward compatible)", () => {
  const out = sanitizeMessages([{ role: "user", content: "hi" }], false);
  assert.equal(out[0].content, "hi", "a string user message is left as a string");
  // assistant tool-call turns keep their shape (and reasoning_content under thinking).
  const a = sanitizeMessages([{ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] }], true);
  assert.ok(Array.isArray(a[0].tool_calls));
  assert.equal(a[0].reasoning_content, "");
});

test("resolveVisionModel: unset → null", () => {
  assert.equal(resolveVisionModel({ visionModel: "", provider: "deepseek", apiKey: "k", providers: {} }), null);
});

test("resolveVisionModel: provider:model resolves that provider's stored creds + base URL", () => {
  const r = resolveVisionModel({ visionModel: "openai:gpt-5.1", provider: "deepseek", apiKey: "dk", providers: { openai: { apiKey: "ok" } } });
  assert.ok(r, "resolved");
  assert.equal(r.model, "gpt-5.1");
  assert.equal(r.cfg.provider, "openai");
  assert.equal(r.cfg.apiKey, "ok");
  assert.match(r.cfg.baseUrl, /openai/);
});

test("resolveVisionModel: provider:model with no key (and no env) → null", () => {
  if (process.env.OPENAI_API_KEY) return; // env would legitimately resolve it
  assert.equal(resolveVisionModel({ visionModel: "openai:gpt-5.1", provider: "deepseek", apiKey: "dk", providers: {} }), null);
});

test("resolveVisionModel: bare model needs a vision-capable active provider", () => {
  // deepseek is not vision-capable → null even with a key
  assert.equal(resolveVisionModel({ visionModel: "some-model", provider: "deepseek", apiKey: "dk", providers: {} }), null);
  // openai is vision-capable → resolves on the active provider
  const b = resolveVisionModel({ visionModel: "gpt-5.1", provider: "openai", apiKey: "ok", providers: {} });
  assert.ok(b);
  assert.equal(b.model, "gpt-5.1");
});

test("resolveVisionModel: explicit keyless local provider:model resolves (local VLM)", () => {
  const l = resolveVisionModel({ visionModel: "lmstudio:llava", provider: "deepseek", apiKey: "dk", providers: {} });
  assert.ok(l, "explicit local provider:model resolves without a key");
  assert.equal(l.cfg.provider, "lmstudio");
  assert.equal(l.model, "llava");
});

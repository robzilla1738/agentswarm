const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findChrome, browserAvailable, HeadlessBrowser } = require("../../dist/browser.js");

test("browserAvailable: chrome binary AND a WebSocket impl", () => {
  const chrome = findChrome();
  assert.equal(browserAvailable(), chrome !== null && typeof globalThis.WebSocket === "function");
});

test("HeadlessBrowser renders a file:// fixture (screenshot + DOM read + click)", { timeout: 45000 }, async (t) => {
  if (!browserAvailable()) {
    t.skip("no headless browser on this host");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-browser-test-"));
  const html = path.join(dir, "index.html");
  fs.writeFileSync(
    html,
    `<!doctype html><title>Fixture</title><body>
      <h1 id="h">Hello</h1>
      <button id="b" onclick="document.getElementById('h').textContent='Clicked'">Go</button>
    </body>`
  );
  const b = new HeadlessBrowser();
  try {
    await b.start({ width: 800, height: 600 });
    await b.navigate("file://" + html);

    assert.equal(await b.evaluate("document.title"), "Fixture");
    assert.equal(await b.evaluate("document.getElementById('h').textContent"), "Hello");

    const png = await b.screenshot();
    assert.ok(png.length > 100, "screenshot returns PNG bytes");
    assert.equal(png[0], 0x89, "PNG magic byte");

    const dataUrl = await b.screenshotDataUrl();
    assert.match(dataUrl, /^data:image\/png;base64,/);

    // Click the button center → its handler must mutate the DOM.
    const rect = await b.evaluate(
      "(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()"
    );
    await b.click(rect.x, rect.y);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await b.evaluate("document.getElementById('h').textContent"), "Clicked", "the click ran the handler");
  } finally {
    await b.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

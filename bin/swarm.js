#!/usr/bin/env node
try {
  require("../dist/cli.js").main();
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND" && /dist[\/\\]cli/.test(String(e.message))) {
    console.error("agentswarm isn't built yet. From the repo root run:\n\n  npm run setup\n\nthen try again.");
    process.exit(1);
  }
  throw e;
}

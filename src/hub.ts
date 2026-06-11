import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { URL } from "url";
import {
  SwarmConfig,
  SETTABLE_KEYS,
  coerceConfigValue,
  loadConfig,
  maskKey,
  runDir,
  saveConfig,
} from "./config";
import { appendControl } from "./control";
import { resolveCrawlBackend } from "./crawltools";
import { listModels, validateAuth } from "./deepseek";
import { PROVIDERS, PROVIDER_IDS, isProviderId } from "./providers";
import { eventsFile, readEvents, readNewEvents, TailState } from "./journal";
import {
  createRun,
  deleteRun,
  isRunLive,
  launchDetached,
  listRuns,
  loadMeta,
  loadRunState,
  optionsFromConfig,
  readPid,
  resumeInfo,
} from "./run";
import { SANDBOX_KINDS, SandboxKind, dockerAvailable, resolveSandboxKind, testSandbox } from "./sandbox";
import { RunOptions } from "./types";
import { errMsg, pathInside } from "./util";

const PKG_VERSION: string = (() => {
  try {
    // dist/hub.js → ../package.json; npm always ships package.json.
    return String(require("../package.json").version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export interface HubOptions {
  port: number;
  uiDir: string | null;
  binPath: string;
}

export function startHub(opts: HubOptions): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((e) => {
      sendJson(res, 500, { error: errMsg(e) });
    });
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: HubOptions): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${opts.port}`);
  const p = url.pathname;
  // Localhost-only CORS. The hub launches runs and reads reports with the
  // operator's keys — a random website's JS must never get a readable
  // response. The dev UI on another localhost port is the one legitimate
  // cross-origin client; everyone else gets no CORS headers at all.
  const origin = String(req.headers.origin || "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (p.startsWith("/api/")) {
    await api(req, res, url, opts);
    return;
  }
  serveStatic(req, res, p, opts.uiDir);
}

// ---------------------------------------------------------------- api

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, opts: HubOptions): Promise<void> {
  const cfg = loadConfig();
  const p = url.pathname;
  const method = req.method || "GET";

  if (p === "/api/health") return sendJson(res, 200, { ok: true, version: PKG_VERSION, apiKey: Boolean(cfg.apiKey) });

  if (p === "/api/config" && method === "GET") return sendJson(res, 200, publicConfig(cfg));
  if (p === "/api/config" && method === "POST") {
    const body = await readBody(req);
    const patch: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (k === "providers") continue; // handled below
      if (!SETTABLE_KEYS.includes(k as keyof SwarmConfig)) continue;
      try {
        patch[k] = coerceConfigValue(k as keyof SwarmConfig, v);
      } catch (e) {
        errors.push(errMsg(e));
      }
    }
    // Per-provider credentials: { providers: { openai: { apiKey, baseUrl } } }
    if (body.providers && typeof body.providers === "object") {
      const creds: Record<string, { apiKey?: string; baseUrl?: string }> = {};
      for (const [id, cred] of Object.entries(body.providers as Record<string, any>)) {
        if (!isProviderId(id)) {
          errors.push(`unknown provider: ${id}`);
          continue;
        }
        if (!cred || typeof cred !== "object") continue;
        const c: { apiKey?: string; baseUrl?: string } = {};
        if (typeof cred.apiKey === "string") c.apiKey = cred.apiKey.trim();
        if (typeof cred.baseUrl === "string") c.baseUrl = cred.baseUrl.trim();
        creds[id] = c;
      }
      (patch as any).providers = creds;
    }
    // All-or-nothing: a typo in one field must not half-apply the form.
    if (errors.length) return sendJson(res, 400, { error: errors.join("; ") });
    const next = saveConfig(patch);
    return sendJson(res, 200, publicConfig(next));
  }

  if (p === "/api/validate" && method === "GET") {
    const r = await validateAuth(cfg);
    return sendJson(res, 200, r);
  }

  if (p === "/api/sandbox/test" && method === "POST") {
    const body = await readBody(req);
    const kind: SandboxKind = SANDBOX_KINDS.includes(body.runtime)
      ? (body.runtime as SandboxKind)
      : resolveSandboxKind(cfg);
    const r = await testSandbox(cfg, kind);
    return sendJson(res, 200, { kind, ...r });
  }

  if (p === "/api/models" && method === "GET") {
    try {
      const models = await listModels(cfg);
      return sendJson(res, 200, { models });
    } catch (e) {
      return sendJson(res, 200, { models: Object.keys(cfg.pricing), error: errMsg(e) });
    }
  }

  // Directory browser for the launch-folder picker. Localhost-only hub, same
  // user permissions as the CLI — lists directory names, never file contents.
  if (p === "/api/fs/dirs" && method === "GET") {
    const raw = url.searchParams.get("path") || os.homedir();
    const dir = path.resolve(raw);
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return sendJson(res, 200, {
        path: dir,
        parent: parent === dir ? null : parent,
        home: os.homedir(),
        dirs: entries,
      });
    } catch (e) {
      return sendJson(res, 400, { error: errMsg(e) });
    }
  }

  if (p === "/api/runs" && method === "GET") {
    return sendJson(res, 200, { runs: listRuns(cfg.pricing) });
  }

  if (p === "/api/runs" && method === "POST") {
    const body = await readBody(req);
    if (!body.mission || typeof body.mission !== "string") {
      return sendJson(res, 400, { error: "mission is required" });
    }
    const provider = PROVIDERS[cfg.provider];
    if (!cfg.apiKey && provider.keyRequired) {
      return sendJson(res, 400, { error: `No ${provider.label} API key configured. Set it in Settings first.` });
    }
    const auth = await validateAuth(cfg);
    if (auth.status === "invalid") {
      return sendJson(res, 400, {
        error: `${provider.label} key rejected: ${auth.message || "invalid"}. Open Settings and paste a valid key.`,
      });
    }
    const overrides = sanitizeOptions(body.options);
    const sandbox = body.sandbox !== false; // default to sandbox for UI-created runs
    const cwd = sandbox ? process.cwd() : String(body.cwd || process.cwd());
    if (!sandbox) {
      if (!path.isAbsolute(cwd)) {
        return sendJson(res, 400, { error: "cwd must be an absolute path" });
      }
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return sendJson(res, 400, { error: `directory not found: ${cwd}` });
      }
    }
    const meta = createRun({
      mission: body.mission.trim(),
      cwd,
      sandbox,
      options: optionsFromConfig(cfg, overrides),
    });
    launchDetached(meta.id, opts.binPath);
    return sendJson(res, 200, { id: meta.id });
  }

  const m = p.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
  if (m) {
    const id = m[1];
    const sub = m[2] || "";
    const meta = loadMeta(id);
    if (!meta) return sendJson(res, 404, { error: "run not found" });

    if (sub === "" && method === "GET") {
      const state = loadRunState(id, cfg.pricing);
      if (!state) return sendJson(res, 404, { error: "run not found" });
      return sendJson(res, 200, snapshot(state, id));
    }

    if (sub === "" && method === "DELETE") {
      try {
        deleteRun(id);
      } catch (e) {
        return sendJson(res, 409, { error: errMsg(e) });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (sub === "/events" && method === "GET") {
      const since = Number(url.searchParams.get("since") || "0");
      const events = readEvents(runDir(id)).filter((e) => e.seq > since);
      return sendJson(res, 200, { events, live: isRunLive(id) });
    }

    if (sub === "/stream" && method === "GET") {
      return streamEvents(res, id, url.searchParams.get("quiet") === "1");
    }

    if (sub === "/note" && method === "POST") {
      const body = await readBody(req);
      if (!body.text) return sendJson(res, 400, { error: "text required" });
      appendControl(runDir(id), { kind: "note", text: String(body.text) });
      return sendJson(res, 200, { ok: true });
    }

    if (sub === "/cancel" && method === "POST") {
      appendControl(runDir(id), { kind: "cancel" });
      // Belt and braces: SIGINT the engine so the abort lands instantly even
      // mid-API-call. The engine's handler cancels gracefully (still
      // synthesizes a report from completed work).
      const pid = readPid(id);
      if (pid) {
        try {
          process.kill(pid, "SIGINT");
        } catch {
          /* already gone — the control line covers it */
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    if (sub === "/resume" && method === "POST") {
      const info = resumeInfo(id);
      if (!info.resumable) return sendJson(res, 409, { error: info.reason || "not resumable" });
      launchDetached(id, opts.binPath, true);
      return sendJson(res, 200, { ok: true });
    }

    if (sub === "/report" && method === "GET") {
      const file = path.join(runDir(id), "artifacts", "final-report.md");
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "no report yet" });
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(fs.readFileSync(file));
      return;
    }

    if (sub === "/artifacts" && method === "GET") {
      return sendJson(res, 200, { artifacts: listArtifactFiles(id) });
    }

    const art = sub.match(/^\/artifacts\/(.+)$/);
    if (art && method === "GET") {
      const rel = decodeURIComponent(art[1]);
      const base = path.join(runDir(id), "artifacts");
      const file = path.join(base, rel);
      // pathInside (not startsWith): "artifacts-evil" passes a prefix check.
      if (!pathInside(base, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return sendJson(res, 404, { error: "not found" });
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

function streamEvents(res: http.ServerResponse, id: string, quiet = false): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const file = eventsFile(runDir(id));
  const state: TailState = { offset: 0, carry: "" };

  const flush = () => {
    let evs;
    try {
      evs = readNewEvents(file, state);
    } catch {
      return;
    }
    for (const ev of evs) {
      // quiet mode: skip streaming chatter for clients rendering many agents.
      if (quiet && ev.type === "agent.delta") continue;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  };

  // Liveness side-channel: lets the UI distinguish "quiet but alive" from
  // "engine process died without a terminal status".
  const sendLive = () => {
    res.write(`event: live\ndata: ${JSON.stringify({ live: isRunLive(id) })}\n\n`);
  };

  // Initial backlog + then poll. (fs.watch is unreliable on some platforms;
  // a 400ms poll over an append-only file is cheap and robust.)
  flush();
  sendLive();
  const poll = setInterval(flush, 400);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  const liveTimer = setInterval(sendLive, 3000);
  const stop = () => {
    clearInterval(poll);
    clearInterval(ping);
    clearInterval(liveTimer);
  };
  res.on("close", stop);
  res.on("error", stop);
}

// ---------------------------------------------------------------- helpers

export function publicConfig(cfg: SwarmConfig) {
  const active = PROVIDERS[cfg.provider];
  // Active provider's suggestions first, then anything else with pricing.
  const knownModels = [
    ...active.knownModels,
    ...Object.keys(cfg.pricing).filter((m) => !active.knownModels.includes(m)),
  ];
  return {
    provider: cfg.provider,
    providers: PROVIDER_IDS.map((id) => {
      const info = PROVIDERS[id];
      const cred = cfg.providers[id] || {};
      const key = id === cfg.provider ? cfg.apiKey : cred.apiKey || "";
      return {
        id,
        label: info.label,
        keyRequired: info.keyRequired,
        keyUrl: info.keyUrl,
        local: Boolean(info.local),
        note: info.note,
        keySet: Boolean(key),
        keyMasked: maskKey(key),
        baseUrl: cred.baseUrl || info.baseUrl,
        defaultBaseUrl: info.baseUrl,
        defaultModel: info.defaultModel,
        knownModels: info.knownModels,
      };
    }),
    apiKeySet: Boolean(cfg.apiKey) || !active.keyRequired,
    apiKeyMasked: maskKey(cfg.apiKey),
    tinyfishKeySet: Boolean(cfg.tinyfishApiKey),
    tinyfishKeyMasked: maskKey(cfg.tinyfishApiKey),
    searchBackend: cfg.searchBackend,
    crawlBackend: cfg.crawlBackend,
    crawlResolved: resolveCrawlBackend(cfg),
    firecrawlKeySet: Boolean(cfg.firecrawlApiKey),
    firecrawlKeyMasked: maskKey(cfg.firecrawlApiKey),
    contextdevKeySet: Boolean(cfg.contextdevApiKey),
    contextdevKeyMasked: maskKey(cfg.contextdevApiKey),
    deepcrawlKeySet: Boolean(cfg.deepcrawlApiKey),
    deepcrawlKeyMasked: maskKey(cfg.deepcrawlApiKey),
    deepcrawlBaseUrl: cfg.deepcrawlBaseUrl,
    sandboxRuntime: cfg.sandboxRuntime,
    sandboxResolved: resolveSandboxKind(cfg),
    sandboxImage: cfg.sandboxImage,
    dockerUp: dockerAvailable(),
    e2bKeySet: Boolean(cfg.e2bApiKey),
    e2bKeyMasked: maskKey(cfg.e2bApiKey),
    e2bTemplate: cfg.e2bTemplate,
    modalConfigured: Boolean(cfg.modalTokenId && cfg.modalTokenSecret),
    vercelConfigured: Boolean(cfg.vercelToken),
    vercelTeamId: cfg.vercelTeamId,
    vercelProjectId: cfg.vercelProjectId,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    conductorModel: cfg.conductorModel,
    maxWorkers: cfg.maxWorkers,
    maxStepsPerTask: cfg.maxStepsPerTask,
    maxTasks: cfg.maxTasks,
    maxTokensPerRun: cfg.maxTokensPerRun,
    verification: cfg.verification,
    thinking: cfg.thinking,
    reasoningEffort: cfg.reasoningEffort,
    safeMode: cfg.safeMode,
    contextTokenLimit: cfg.contextTokenLimit,
    contextWindows: cfg.contextWindows,
    cheapModel: cfg.cheapModel,
    strongModel: cfg.strongModel,
    knownModels,
    pricing: cfg.pricing,
  };
}

function sanitizeOptions(raw: unknown): Partial<RunOptions> {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<RunOptions> = {};
  const num = (k: keyof RunOptions, lo: number, hi: number) => {
    const v = Number(o[k]);
    if (Number.isFinite(v)) (out as any)[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  };
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  if (typeof o.conductorModel === "string" && o.conductorModel.trim()) out.conductorModel = o.conductorModel.trim();
  num("maxWorkers", 1, 32);
  num("maxStepsPerTask", 3, 200);
  num("maxTasks", 1, 1000);
  num("maxTokens", 50_000, 2_000_000_000);
  if (o.verification === "off" || o.verification === "normal" || o.verification === "strict") {
    out.verification = o.verification;
  }
  if (typeof o.thinking === "boolean") out.thinking = o.thinking;
  if (o.reasoningEffort === "low" || o.reasoningEffort === "medium" || o.reasoningEffort === "high" || o.reasoningEffort === "max") {
    out.reasoningEffort = o.reasoningEffort;
  }
  if (typeof o.safeMode === "boolean") out.safeMode = o.safeMode;
  if (SANDBOX_KINDS.includes(o.sandboxRuntime as SandboxKind)) {
    out.sandboxRuntime = o.sandboxRuntime as SandboxKind;
  }
  return out;
}

function snapshot(state: ReturnType<typeof loadRunState>, id: string) {
  if (!state) return { error: "not found" };
  return {
    id,
    meta: state.meta,
    status: state.status,
    statusReason: state.statusReason,
    summary: state.summary(),
    tasks: state.taskList(),
    agents: [...state.agents.values()],
    notes: state.notes,
    conductorLog: state.conductorLog,
    operatorNotes: state.operatorNotes,
    usageByModel: Object.fromEntries(state.usageByModel),
    cost: state.cost,
    finalSummary: state.finalSummary,
    finalReportPath: state.finalReportPath,
    live: isRunLive(id),
    lastSeq: state.lastSeq,
  };
}

function listArtifactFiles(id: string): { name: string; size: number }[] {
  const base = path.join(runDir(id), "artifacts");
  const out: { name: string; size: number }[] = [];
  const walk = (d: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + "/");
      else {
        let size = 0;
        try { size = fs.statSync(path.join(d, e.name)).size; } catch { /* race */ }
        out.push({ name: prefix + e.name, size });
      }
    }
  };
  walk(base, "");
  return out;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, p: string, uiDir: string | null): void {
  if (!uiDir || !fs.existsSync(uiDir)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fallbackPage());
    return;
  }
  let rel = decodeURIComponent(p.replace(/^\/+/, ""));
  if (rel === "") rel = "index.html";
  let file = path.join(uiDir, rel);
  if (!pathInside(uiDir, file)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  // SPA / static-export fallbacks.
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const htmlCandidate = file.replace(/\/$/, "") + ".html";
    if (fs.existsSync(htmlCandidate)) file = htmlCandidate;
    else if (fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
    else file = path.join(uiDir, "index.html");
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function fallbackPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>agentswarm hub</title>
<style>body{background:#050505;color:#f2f2f2;font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:680px;margin:8vh auto;padding:0 24px}code{background:#161616;border:1px solid #262626;padding:2px 7px;border-radius:5px;color:#e5e5e5;font-family:ui-monospace,monospace}a{color:#fff}p{color:#a1a1a1}</style>
</head><body>
<h1>agentswarm hub is running</h1>
<p>The API is live, but the web UI hasn't been built yet.</p>
<p>Build it once (from the repo root):</p>
<p><code>npm run setup</code></p>
<p>…then restart <code>swarm serve</code> and reload this page. (Engine already built? <code>npm run build:ui</code> is enough.) Or run the UI in dev mode against this hub:</p>
<p><code>npm run dev:ui</code> → open <a href="http://localhost:7780">http://localhost:7780</a></p>
<p>The REST API is available under <code>/api/*</code>.</p>
</body></html>`;
}

// ---------------------------------------------------------------- io

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

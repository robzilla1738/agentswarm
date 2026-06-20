import * as fs from "fs";
import * as path from "path";
import { SwarmConfig } from "./config";
import { ToolSchema } from "./deepseek";
import { SandboxRuntime } from "./sandbox";
import { ForecastKind, RunMeta } from "./types";
import { crawlSite, resolveCrawlBackend, slugForUrl } from "./crawltools";
import {
  DataFeed,
  TimeSeriesSource,
  dataFeed,
  formatMarketHits,
  formatTables,
  formatTimeSeries,
  marketOdds,
  optionsImplied,
  sportsbookLines,
  timeSeries,
  wikiSummary,
  wikiTables,
} from "./datatools";
import { renderDocHtml } from "./report";
import { mergeCandidates } from "./searchcore";
import { ensureDir, errMsg, escapeHtml, pathInside, truncateMiddle } from "./util";
import { arxivSearch, crossrefSearch, fetchUrl, looksBiomedical, pubmedSearch, semanticScholarSearch, webSearch } from "./webtools";

export interface ToolCtx {
  cfg: SwarmConfig;
  meta: RunMeta;
  runDirPath: string;
  /** Root working directory *inside the sandbox runtime*. */
  workdir: string;
  sandbox: SandboxRuntime;
  agentId: string;
  taskId?: string;
  signal: AbortSignal;
  addNote: (text: string, key?: string, kind?: string, url?: string) => void;
  /** Keyword search over every blackboard note in the run (not just the digest tail). */
  searchNotes?: (query: string) => string;
  /** Full report text of a settled task (dep excerpts link here). */
  readReport?: (taskId: string) => string;
  /** Advisory claim check: warning text if another live task claimed this path. */
  checkClaim?: (relPath: string) => string | null;
  /** Journal a durable progress checkpoint for this task (warm restarts after a crash). */
  addCheckpoint?: (summary: string) => void;
  addArtifact: (relPath: string) => void;
  readBlackboard: () => string;
  /** Journal an operator-visible diagnostic (tool infrastructure problems). */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /**
   * Run-scoped result cache for fetch_url/web_search, shared across every
   * agent in the run: wide swarms hit the same pages and queries constantly.
   * Promises are cached (not results) so concurrent identical requests
   * coalesce into one network call; failures are evicted so they retry.
   */
  webCache?: Map<string, Promise<string>>;
}

/** Cache-through helper for webCache: coalesces concurrent calls, evicts failures. */
async function cached(ctx: ToolCtx, key: string, work: () => Promise<string>): Promise<string> {
  const cache = ctx.webCache;
  if (!cache) return work();
  const hit = cache.get(key);
  if (hit) return hit;
  const p = work();
  cache.set(key, p);
  try {
    return await p;
  } catch (e) {
    cache.delete(key); // a transient failure must not poison the run
    throw e;
  }
}

export interface ToolDef {
  schema: ToolSchema;
  run: (args: any, ctx: ToolCtx) => Promise<string>;
}

// ---------- safety ----------

const DANGEROUS: { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/, why: "sudo is not allowed" },
  { re: /\brm\s+(-[a-zA-Z]+\s+)*(\/|~)(\s|$|\/\*)/, why: "refusing to rm at filesystem root or home" },
  { re: /\b(shutdown|reboot|halt)\b/, why: "system power commands are not allowed" },
  { re: /\bmkfs\b|\bdiskutil\s+erase/i, why: "disk formatting is not allowed" },
  { re: /\bdd\s+[^|]*of=\/dev\//, why: "writing to raw devices is not allowed" },
  { re: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;/, why: "fork bomb" },
];

function checkCommand(cmd: string, cfg: SwarmConfig): void {
  if (!cfg.safeMode) return;
  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) throw new Error(`blocked by safeMode: ${d.why}`);
  }
}

function resolveRead(p: string, ctx: ToolCtx): string {
  return path.resolve(ctx.workdir, p);
}

/** Single-quote a string for sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Where a write actually lands: realpath of the deepest existing ancestor plus
 * the not-yet-created remainder. Confinement checks must use this, or a
 * symlink inside the workdir smuggles writes anywhere on the host.
 */
function realDestination(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  while (!fs.existsSync(dir)) {
    tail.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    dir = fs.realpathSync(dir);
  } catch {
    /* races/permissions: keep the lexical path */
  }
  return path.join(dir, ...tail);
}

function realBase(base: string): string {
  try {
    return fs.realpathSync(base);
  } catch {
    return base;
  }
}

function resolveWrite(p: string, ctx: ToolCtx): string {
  const abs = path.resolve(ctx.workdir, p);
  // Remote sandboxes own their filesystem — host-side realpath is meaningless there.
  const real = ctx.sandbox.localFs ? realDestination(abs) : abs;
  const ok =
    pathInside(realBase(ctx.workdir), real) ||
    pathInside(realBase(ctx.runDirPath), real) ||
    !ctx.cfg.safeMode;
  if (!ok) {
    throw new Error(
      `safeMode: writes are restricted to the working directory (${ctx.workdir}). ` +
        `Use a relative path, or save deliverables with save_artifact.`
    );
  }
  return abs;
}

// ---------- sandbox-aware file IO ----------

async function readFileVia(ctx: ToolCtx, abs: string): Promise<string> {
  return ctx.sandbox.localFs ? fs.readFileSync(abs, "utf8") : ctx.sandbox.readFile(abs);
}

async function writeFileVia(ctx: ToolCtx, abs: string, content: string): Promise<void> {
  if (ctx.sandbox.localFs) {
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, "utf8");
  } else {
    await ctx.sandbox.writeFile(abs, content);
  }
}

// ---------- tool definitions ----------

export function workerToolset(cfg?: SwarmConfig): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};

  tools.shell = {
    schema: {
      name: "shell",
      description:
        "Run a bash command in the working directory. Returns exit code, stdout and stderr (interleaved). Use for builds, tests, git, package managers, inspecting the system. Long-running servers will be killed at the timeout — do not start blocking daemons.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run" },
          cwd: { type: "string", description: "Optional subdirectory to run in (relative to the working directory)" },
          timeout_sec: { type: "number", description: "Timeout in seconds (default 180, max 900)" },
        },
        required: ["command"],
      },
    },
    run: async (args, ctx) => {
      const cmd = String(args.command ?? "");
      if (!cmd.trim()) throw new Error("command is required");
      checkCommand(cmd, ctx.cfg);
      const cwd = args.cwd ? resolveRead(String(args.cwd), ctx) : ctx.workdir;
      if (ctx.sandbox.localFs && !fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
      const timeout = Math.min(Math.max(Number(args.timeout_sec) || 180, 5), 900);
      const t0 = Date.now();
      const r = await ctx.sandbox.exec(cmd, { cwd, timeoutSec: timeout, signal: ctx.signal });
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const status = r.timedOut ? `TIMED OUT after ${timeout}s` : `exit ${r.code}`;
      return `[${status} in ${dur}s]\n${r.out || "(no output)"}`;
    },
  };

  tools.read_file = {
    schema: {
      name: "read_file",
      description:
        "Read a text file. Prefer reading specific line ranges of big files. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number", description: "1-based, optional" },
          end_line: { type: "number", description: "inclusive, optional" },
        },
        required: ["path"],
      },
    },
    run: async (args, ctx) => {
      const abs = resolveRead(String(args.path), ctx);
      const raw = await readFileVia(ctx, abs);
      const lines = raw.split("\n");
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(lines.length, Number(args.end_line) || lines.length);
      const slice = lines.slice(start - 1, end);
      const numbered = slice
        .map((l, i) => `${String(start + i).padStart(5)}│${l}`)
        .join("\n");
      const header = `${abs} (${lines.length} lines, showing ${start}-${end})\n`;
      return header + numbered;
    },
  };

  tools.write_file = {
    schema: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given content. Creates parent directories. Paths are relative to the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    run: async (args, ctx) => {
      const abs = resolveWrite(String(args.path), ctx);
      const content = String(args.content ?? "");
      if (content.length > 5_000_000) throw new Error("content too large (>5MB)");
      await writeFileVia(ctx, abs, content);
      const warn = ctx.checkClaim?.(String(args.path));
      return `wrote ${abs} (${content.length} chars)${warn ? `\n${warn}` : ""}`;
    },
  };

  tools.replace_in_file = {
    schema: {
      name: "replace_in_file",
      description:
        "Exact string replacement in a file. `find` must match exactly (including whitespace). Fails if not found, or if ambiguous when all=false. For several edits to the same file, pass `edits` — they apply in order, all-or-nothing, in one call.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
          all: { type: "boolean", description: "Replace every occurrence (default false)" },
          edits: {
            type: "array",
            description: "Batch mode: multiple find/replace pairs applied in order, atomically (replaces top-level find/replace)",
            items: {
              type: "object",
              properties: {
                find: { type: "string" },
                replace: { type: "string" },
                all: { type: "boolean" },
              },
              required: ["find", "replace"],
            },
          },
        },
        required: ["path"],
      },
    },
    run: async (args, ctx) => {
      const abs = resolveWrite(String(args.path), ctx);
      const raw = await readFileVia(ctx, abs);
      const edits =
        Array.isArray(args.edits) && args.edits.length
          ? (args.edits as Record<string, unknown>[]).map((e) => ({
              find: String(e.find ?? ""),
              replace: String(e.replace ?? ""),
              all: Boolean(e.all),
            }))
          : args.find !== undefined && args.replace !== undefined
            ? [{ find: String(args.find), replace: String(args.replace), all: Boolean(args.all) }]
            : null;
      if (!edits) throw new Error("provide find+replace, or an edits array");
      // Validate-then-apply against the progressively edited content:
      // any failing edit aborts the whole batch with nothing written.
      let next = raw;
      let total = 0;
      const at = (i: number) => (edits.length > 1 ? `edit ${i + 1}: ` : "");
      for (let i = 0; i < edits.length; i++) {
        const { find, replace, all } = edits[i];
        if (!find) throw new Error(`${at(i)}find must not be empty`);
        const count = next.split(find).length - 1;
        if (count === 0) {
          throw new Error(`${at(i)}find string not found in file${edits.length > 1 ? " — no edits were applied" : ""}`);
        }
        if (count > 1 && !all) {
          throw new Error(
            `${at(i)}find string matches ${count} times; provide more context or set all=true${edits.length > 1 ? " — no edits were applied" : ""}`
          );
        }
        next = all ? next.split(find).join(replace) : next.replace(find, replace);
        total += all ? count : 1;
      }
      await writeFileVia(ctx, abs, next);
      const warn = ctx.checkClaim?.(String(args.path));
      return `replaced ${total} occurrence(s) via ${edits.length} edit(s) in ${abs}${warn ? `\n${warn}` : ""}`;
    },
  };

  tools.grep_files = {
    schema: {
      name: "grep_files",
      description:
        "Search file contents with a regex (grep -E syntax). Returns matching lines as path:line:text. Use this to locate code or text instead of shell grep pipelines — one round-trip, works identically in remote sandboxes, skips node_modules/.git/build output.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Extended regex (grep -E)" },
          path: { type: "string", description: "Directory or file to search (default: working directory)" },
          glob: { type: "string", description: "Filename filter, e.g. *.ts" },
          ignore_case: { type: "boolean" },
          max_results: { type: "number", description: "Default 50, max 200" },
        },
        required: ["pattern"],
      },
    },
    run: async (args, ctx) => {
      const pattern = String(args.pattern ?? "");
      if (!pattern.trim()) throw new Error("pattern is required");
      const root = args.path ? resolveRead(String(args.path), ctx) : ctx.workdir;
      const max = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
      const flags = `-rnE${args.ignore_case ? "i" : ""}`;
      const include = args.glob ? ` --include=${shq(String(args.glob))}` : "";
      const excludes = ["node_modules", ".git", "dist", ".next", "out", "build", "target", "__pycache__", ".venv"]
        .map((d) => ` --exclude-dir=${d}`)
        .join("");
      // No `| head`: a pipe would mask grep's exit code, and an invalid regex
      // or unreadable path must fail loudly, not read as "no matches".
      // (Output volume is already bounded by the sandbox's collect cap.)
      const cmd = `grep ${flags}${include}${excludes} -e ${shq(pattern)} ${shq(root)}`;
      const r = await ctx.sandbox.exec(cmd, { cwd: ctx.workdir, timeoutSec: 60, signal: ctx.signal });
      // Sandbox exec merges stderr into out — separate grep's diagnostics.
      const all = r.out.split("\n").filter(Boolean);
      const diags = all.filter((l) => l.startsWith("grep:"));
      const lines = all.filter((l) => !l.startsWith("grep:"));
      // Exit 1 = clean no-match. Anything past 1 with zero matches is a real
      // failure (bad pattern, missing path); with matches it's partial
      // (some files unreadable) and the matches still count.
      if (r.code !== 0 && r.code !== 1 && !lines.length) {
        throw new Error(`grep failed (exit ${r.code}): ${diags.join("; ").slice(0, 300) || "no error detail"}`);
      }
      if (!lines.length) return "no matches";
      const shown = lines.slice(0, max);
      const more = lines.length > max ? `\n…more matches truncated (raise max_results or narrow the pattern)` : "";
      return shown.join("\n") + more;
    },
  };

  tools.list_dir = {
    schema: {
      name: "list_dir",
      description: "List files and directories as a tree (skips node_modules, .git, build output).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Default: working directory" },
          depth: { type: "number", description: "Max depth, default 2, max 4" },
        },
      },
    },
    run: async (args, ctx) => {
      const root = args.path ? resolveRead(String(args.path), ctx) : ctx.workdir;
      const maxDepth = Math.min(Math.max(Number(args.depth) || 2, 1), 4);
      if (!ctx.sandbox.localFs) {
        // Remote filesystem: one find(1) round-trip instead of a local walk.
        const r = await ctx.sandbox.exec(
          `find . -maxdepth ${maxDepth} \\( -name node_modules -o -name .git -o -name dist -o -name .next -o -name build -o -name __pycache__ -o -name .venv \\) -prune -o -print | sed 's|^\\./||' | sort | head -400`,
          { cwd: root, timeoutSec: 30, signal: ctx.signal }
        );
        if (r.code !== 0) throw new Error(`list failed: ${r.out.slice(0, 200)}`);
        const body = r.out.split("\n").filter((l) => l.trim() && l.trim() !== ".").join("\n");
        return `${root}/\n` + (body || "(empty)");
      }
      const SKIP = new Set([
        "node_modules", ".git", "dist", ".next", "out", "build", "target",
        "__pycache__", ".venv", "venv", ".cache", ".DS_Store",
      ]);
      const lines: string[] = [];
      const walk = (dir: string, depth: number, prefix: string) => {
        if (lines.length > 400) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          lines.push(`${prefix}[unreadable: ${errMsg(e)}]`);
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          if (lines.length > 400) {
            lines.push(`${prefix}… (truncated)`);
            return;
          }
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`);
            if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1, prefix + "  ");
          } else {
            let size = "";
            try {
              size = ` (${fs.statSync(path.join(dir, e.name)).size}b)`;
            } catch { /* race */ }
            lines.push(`${prefix}${e.name}${size}`);
          }
        }
      };
      walk(root, 1, "");
      return `${root}/\n` + (lines.join("\n") || "(empty)");
    },
  };

  tools.web_search = {
    schema: {
      name: "web_search",
      description:
        "Search the web. Fans out across multiple engines (DuckDuckGo, Bing, +TinyFish if configured), merges and quality-ranks results, and dedupes by canonical URL. Returns ranked results with title, URL and snippet. " +
        "Set deep=true to widen the query into complementary phrasings, fetch the top pages, and return quotable passages with publication dates — use for thorough research and any claim that needs grounding. Setting freshness also sweeps GDELT's global news index (keyless, direct article links). Raise count (up to 50) to pull more sources per call.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "Max results, default 15, max 50" },
          deep: { type: "boolean", description: "Multi-phrasing sweep + fetch pages for quotable passages" },
          freshness: {
            type: "string",
            enum: ["day", "week", "month", "year"],
            description: "Only results published within this window (best-effort per engine) — use for current-events evidence",
          },
        },
        required: ["query"],
      },
    },
    run: async (args, ctx) => {
      const count = Math.min(Math.max(Number(args.count) || 15, 1), 50);
      const freshness = ["day", "week", "month", "year"].includes(String(args.freshness))
        ? (String(args.freshness) as "day" | "week" | "month" | "year")
        : undefined;
      const query = String(args.query);
      const deep = Boolean(args.deep);
      return cached(ctx, `search|${query}|${count}|${deep}|${freshness ?? ""}`, async () => {
        const hits = await webSearch(ctx.cfg, query, count, ctx.signal, deep, (msg) => ctx.log?.("warn", msg), false, freshness);
        if (!hits.length) return "no results";
        return hits
          .map((h, i) => {
            const head = `${i + 1}. ${h.title}${h.date ? ` (${h.date})` : ""}\n   ${h.url}\n   ${h.snippet}`;
            const quotes = (h.passages || []).map((p) => `   > ${p}`).join("\n");
            return quotes ? `${head}\n${quotes}` : head;
          })
          .join("\n");
      });
    },
  };

  tools.academic_search = {
    schema: {
      name: "academic_search",
      description:
        "Search scholarly sources: arXiv preprints, Crossref journal/conference metadata, and Semantic Scholar (with citation counts — an influence signal); biomedical phrasing also sweeps PubMed (all keyless APIs). Returns papers with title, link (arXiv/DOI/PubMed), abstract snippet, citation count where available, and date. Use for scientific or technical questions where peer-reviewed and preprint sources beat the open web.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "Max results, default 15, max 40" },
        },
        required: ["query"],
      },
    },
    run: async (args, ctx) => {
      const count = Math.min(Math.max(Number(args.count) || 15, 1), 40);
      const q = String(args.query);
      const calls = [
        arxivSearch(q, count, ctx.signal),
        crossrefSearch(q, count, ctx.signal),
        semanticScholarSearch(q, count, ctx.signal),
      ];
      if (looksBiomedical(q)) calls.push(pubmedSearch(q, count, ctx.signal));
      const settled = await Promise.allSettled(calls);
      const candidates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      if (!candidates.length) {
        const err = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        if (err) throw err.reason;
        return "no results";
      }
      const merged = mergeCandidates(candidates, count);
      return merged
        .map((h, i) => `${i + 1}. ${h.title}${h.date ? ` (${h.date})` : ""} [${h.engine}]\n   ${h.url}\n   ${h.snippet}`)
        .join("\n");
    },
  };

  tools.market_odds = {
    schema: {
      name: "market_odds",
      description:
        "Query prediction markets and forecasting platforms (Manifold, Polymarket, Kalshi, PredictIt — keyless; Metaculus too when its free token is configured) for live crowd probabilities on a topic. Returns matching questions with current P(YES), volume/forecaster count, close date, and URL. Crowd odds are a strong baseline forecast — cite the market URL like any other source, and reason explicitly about why you agree or deviate.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or question to find markets for (try multiple phrasings across calls)" },
          count: { type: "number", description: "Max markets, default 10, max 25" },
        },
        required: ["query"],
      },
    },
    run: async (args, ctx) => {
      const count = Math.min(Math.max(Number(args.count) || 10, 1), 25);
      const hits = await marketOdds(ctx.cfg, String(args.query), count, ctx.signal, (m) => ctx.log?.("warn", m));
      return formatMarketHits(hits);
    },
  };

  tools.sports_odds = {
    schema: {
      name: "sports_odds",
      description:
        "Sharp sportsbook consensus for a single upcoming game (The Odds API; needs the free oddsApiKey): de-vigged moneyline win probability, the point spread, and the over/under total, each a book-median across many bookmakers. The closing line is the single most accurate public predictor of a game — center your total/margin quantiles on it and your win probability on the moneyline, then justify any deviation. ALWAYS pass `sport` (the league) and `date` from the question when known — they disambiguate same-name teams across leagues and a team-pair that plays more than once. Returns null-equivalent text when no matching game is found.",
      parameters: {
        type: "object",
        properties: {
          home: { type: "string", description: "One team (home or away — order need not match the book)" },
          away: { type: "string", description: "The other team" },
          sport: { type: "string", description: "League/sport, e.g. NBA, NFL, MLB, NHL, EPL — disambiguates same-name teams across leagues" },
          date: { type: "string", description: "Game date YYYY-MM-DD when known — pins a specific game in a series" },
        },
        required: ["home", "away"],
      },
    },
    run: async (args, ctx) => {
      const sport = args.sport ? String(args.sport) : "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? "")) ? String(args.date) : undefined;
      // The league word rides in the query (leagueKeyHint parses it); the date goes through opts.
      const query = `${sport} ${String(args.home)} ${String(args.away)}`.trim();
      if (!ctx.cfg.oddsApiKey) return "sportsbook odds need the free oddsApiKey (set it in Settings) — none configured";
      const line = await sportsbookLines(ctx.cfg, query, { date, signal: ctx.signal });
      if (!line) return `no matching upcoming game found for "${query}"${date ? ` on ${date}` : ""}`;
      const lines: string[] = [`${line.sportTitle}: ${line.away} @ ${line.home} (${line.commence.slice(0, 16).replace("T", " ")} UTC) — median of ${line.nBooks} books`];
      if (line.h2h) lines.push(`Moneyline (de-vigged): ${line.home} ${Math.round(line.h2h.pHome * 100)}%${typeof line.h2h.pDraw === "number" ? ` / Draw ${Math.round(line.h2h.pDraw * 100)}%` : ""} / ${line.away} ${Math.round(line.h2h.pAway * 100)}%`);
      if (line.spread) lines.push(`Spread: ${line.spread.favorite === "home" ? line.home : line.away} -${line.spread.line}`);
      if (line.total) lines.push(`Total (over/under): ${line.total.line} points`);
      return lines.join("\n");
    },
  };

  tools.time_series = {
    schema: {
      name: "time_series",
      description:
        "Fetch a statistical/financial/weather time series. Sources: fred (St. Louis Fed — raw id like CPIAUCSL/UNRATE OR a plain-word alias: unemployment, cpi, fedfunds, 10y, 2y, gdp, vix, permits, housing_starts, lumber, steel, cement, mortgage30 — needs the free fredApiKey), worldbank (INDICATOR:COUNTRY — keyless), yahoo (daily market data incl. FUTURES: AAPL, ^GSPC, EURUSD=X, BTC-USD, CL=F crude, NG=F natgas, LBS=F lumber, HG=F copper, GC=F gold — keyless), secfacts (SEC XBRL fundamentals, series \"TICKER:tag\" e.g. \"AAPL:Revenues\", \"NVDA:NetIncomeLoss\" — keyless), usaspending (federal contract obligations over time, series \"recipient:Name\"|\"agency:Name\"|\"naics:code\" — keyless), eia (energy series id — free eiaApiKey, else use yahoo CL=F/NG=F), bls (employment/wages, alias nonfarm_payrolls/unemployment_rate/cpi or a series id — free key, throttled keyless v1 otherwise), gdelt (news-coverage volume — keyless), gdelttone (media sentiment — keyless), openmeteo (daily weather \"lat,lon[,variable]\" — ERA5 archive turns weather base rates into counted frequencies; keyless), nws (US hourly forecast \"lat,lon\" — keyless), wikipageviews (daily Wikipedia pageviews — attention leading indicator; keyless). Returns a stats summary, recent observations, and a ready-made ```chart block. Use real series to ground trend extrapolation instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["fred", "worldbank", "yahoo", "secfacts", "usaspending", "eia", "bls", "gdelt", "gdelttone", "openmeteo", "nws", "wikipageviews"] },
          series: {
            type: "string",
            description:
              "FRED id or alias, World Bank INDICATOR:COUNTRY, Yahoo symbol, secfacts TICKER:tag, usaspending recipient:/agency:/naics:, eia/bls series id, GDELT query, lat,lon[,variable] for weather, or a Wikipedia article title",
          },
          start: { type: "string", description: "Start date YYYY-MM-DD (optional)" },
          end: { type: "string", description: "End date YYYY-MM-DD (optional)" },
          project_to: {
            type: "string",
            description:
              "YYYY-MM-DD: also fit an OLS trend line and project it to this date (e.g. the resolution date) with an 80% residual band — deterministic trend math to anchor extrapolation",
          },
        },
        required: ["source", "series"],
      },
    },
    run: async (args, ctx) => {
      const source = String(args.source) as TimeSeriesSource;
      if (!["fred", "worldbank", "yahoo", "secfacts", "usaspending", "eia", "bls", "gdelt", "gdelttone", "openmeteo", "nws", "wikipageviews"].includes(source)) {
        throw new Error("source must be fred | worldbank | yahoo | secfacts | usaspending | eia | bls | gdelt | gdelttone | openmeteo | nws | wikipageviews");
      }
      const r = await timeSeries(
        ctx.cfg,
        source,
        String(args.series),
        args.start ? String(args.start) : undefined,
        args.end ? String(args.end) : undefined,
        ctx.signal,
        (lvl, msg) => ctx.log?.(lvl, msg)
      );
      const projectTo = /^\d{4}-\d{2}-\d{2}$/.test(String(args.project_to ?? "")) ? String(args.project_to) : undefined;
      return formatTimeSeries(r, projectTo);
    },
  };

  tools.options_implied = {
    schema: {
      name: "options_implied",
      description:
        'Options-implied probability that a ticker trades ABOVE a strike price at a target date, computed from Yahoo\'s option chain via Black-Scholes N(d2) using the market\'s own implied volatility (keyless). The financial gold standard for "will PRICE exceed X by DATE" questions — note it is risk-neutral, so cite it as a strong baseline, not gospel. P(below) = 1 − P(above).',
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker with listed options (AAPL, SPY, ^SPX, TSLA)" },
          strike: { type: "number", description: "The threshold price the question asks about" },
          by: { type: "string", description: "Target date YYYY-MM-DD (the nearest listed expiry on/after it is used)" },
        },
        required: ["symbol", "strike", "by"],
      },
    },
    run: async (args, ctx) => {
      const r = await optionsImplied(String(args.symbol), Number(args.strike), String(args.by), ctx.signal);
      const ivNote = r.interpolated ? `interpolated to ${r.horizonDate} from expiries ${r.expiry}` : `expiry ${r.expiry} (horizon outside listed range — σ held flat)`;
      return [
        `${r.symbol} spot ${r.spot} · strike ${r.strike} · horizon ${r.horizonDate} (${r.tYears.toFixed(2)}y) · implied vol ${(r.iv * 100).toFixed(1)}% (${ivNote})`,
        `Risk-neutral P(${r.symbol} > ${r.strike} by ${r.horizonDate}) = ${(r.probAbove * 100).toFixed(1)}%  ·  P(below) = ${((1 - r.probAbove) * 100).toFixed(1)}%`,
        `Contracts used: ${r.contractsUsed}. Caveat: risk-neutral probabilities ≠ real-world for far-dated or high-risk-premium events — treat as a strong anchor, then adjust.`,
      ].join("\n");
    },
  };

  tools.data_feed = {
    schema: {
      name: "data_feed",
      description:
        "Pull a structured reference feed that isn't a plain time series (keyless, SEC EDGAR). feed=sec_filings lists a US company's recent filings (query=ticker, optional metric=form like 10-K/8-K) with direct document URLs; feed=company returns its registry/entity profile (name, SIC industry, exchanges, HQ). For fundamentals AS A SERIES use time_series source secfacts; for contract spending use time_series source usaspending.",
      parameters: {
        type: "object",
        properties: {
          feed: { type: "string", enum: ["sec_filings", "company"] },
          query: { type: "string", description: "US-listed ticker, e.g. AAPL, NVDA" },
          metric: { type: "string", description: "sec_filings only: filter to a form (10-K, 10-Q, 8-K)" },
        },
        required: ["feed", "query"],
      },
    },
    run: async (args, ctx) => {
      const feed = String(args.feed) as DataFeed;
      if (!["sec_filings", "company"].includes(feed)) throw new Error("feed must be sec_filings | company");
      return dataFeed(ctx.cfg, { feed, query: String(args.query), metric: args.metric ? String(args.metric) : undefined }, ctx.signal);
    },
  };

  tools.wiki_tables = {
    schema: {
      name: "wiki_tables",
      description:
        'Extract the data tables from a Wikipedia page (or any URL) as TSV — the durable keyless home of election polling averages ("Opinion polling for the next X election" pages), historical results, and base-rate lists ("List of ..."). Returns a table index plus the largest table; call again with table_index to read another.',
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: 'Wikipedia page title (e.g. "Opinion polling for the 2026 United States Senate elections") or a full URL' },
          table_index: { type: "number", description: "Which table to print (from the index the first call returns)" },
          max_rows: { type: "number", description: "Row cap, default 60" },
        },
        required: ["page"],
      },
    },
    run: async (args, ctx) => {
      const tables = await wikiTables(String(args.page), ctx.signal);
      const idx = Number.isFinite(Number(args.table_index)) ? Number(args.table_index) : undefined;
      const maxRows = Math.min(Math.max(Number(args.max_rows) || 60, 5), 200);
      return formatTables(tables, idx, maxRows);
    },
  };

  tools.wiki_summary = {
    schema: {
      name: "wiki_summary",
      description:
        "Fetch the Wikipedia summary for a topic (keyless REST API): a plain-text extract plus short description and canonical URL. The fastest way to ground an entity, definition, or event before deeper searching — no scraping round-trip. Encyclopedic, not current: pair with web_search for anything time-sensitive.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: 'Wikipedia article title (e.g. "Inflation", "2026 FIFA World Cup", "CRISPR")' },
        },
        required: ["title"],
      },
    },
    run: async (args, ctx) => wikiSummary(String(args.title), ctx.signal),
  };

  tools.fetch_url = {
    schema: {
      name: "fetch_url",
      description:
        "Fetch a URL and return readable text (HTML is converted to text/markdown). Set raw=true for raw bodies like JSON or code.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          raw: { type: "boolean" },
        },
        required: ["url"],
      },
    },
    run: async (args, ctx) => {
      const url = String(args.url);
      if (!/^https?:\/\//.test(url)) throw new Error("only http(s) URLs are supported");
      // Truncate once, here, to the agent-loop cap — a larger cap would just be
      // middle-cut a second time at agent.ts's maxToolResultChars clamp.
      return cached(ctx, `fetch|${url}|${Boolean(args.raw)}`, () =>
        fetchUrl(ctx.cfg, url, Boolean(args.raw), ctx.cfg.maxToolResultChars, ctx.signal, (m) => ctx.log?.("warn", m))
      );
    },
  };

  tools.note = {
    schema: {
      name: "note",
      description:
        "Post a durable fact/discovery to the swarm's shared blackboard so the conductor and other agents can see it. Use sparingly — facts other tasks need, not progress chatter. Mark kind='decision' for choices the rest of the mission must respect, and kind='conflict' when independent sources disagree on a material fact (both are never trimmed from digests).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          key: { type: "string", description: "Optional short label" },
          kind: {
            type: "string",
            enum: ["finding", "decision", "conflict", "open-question", "handoff", "claim"],
            description:
              "Category (default finding). kind='conflict' flags sources that disagree — name both. kind='claim' with key=<file path> advertises you are editing that file",
          },
          url: { type: "string", description: "Source URL backing this note, when it came from the web" },
        },
        required: ["text"],
      },
    },
    run: async (args, ctx) => {
      const kind = ["finding", "decision", "conflict", "open-question", "handoff", "claim"].includes(String(args.kind))
        ? String(args.kind)
        : undefined;
      const url = /^https?:\/\//.test(String(args.url ?? "")) ? String(args.url) : undefined;
      ctx.addNote(String(args.text), args.key ? String(args.key) : undefined, kind, url);
      return "noted on the blackboard";
    },
  };

  tools.search_notes = {
    schema: {
      name: "search_notes",
      description:
        "Keyword-search the ENTIRE blackboard history (the digest in your prompt only shows the recent tail). Use when you need a fact another agent may have posted earlier in the run.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to match against note text/labels" },
        },
        required: ["query"],
      },
    },
    run: async (args, ctx) => {
      if (!ctx.searchNotes) return "note search is unavailable in this context";
      return ctx.searchNotes(String(args.query ?? ""));
    },
  };

  tools.read_report = {
    schema: {
      name: "read_report",
      description:
        "Read the FULL report of a settled task (dependency reports in your prompt are excerpts). Use when an excerpt cuts off details you need.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "e.g. T3" },
        },
        required: ["task_id"],
      },
    },
    run: async (args, ctx) => {
      if (!ctx.readReport) return "report lookup is unavailable in this context";
      return ctx.readReport(String(args.task_id ?? ""));
    },
  };

  tools.checkpoint = {
    schema: {
      name: "checkpoint",
      description:
        "Journal a durable progress checkpoint: a dense summary of what you've completed, key findings, and what remains. If the run is interrupted, the next attempt resumes from your latest checkpoint instead of starting over. Use after completing each major chunk of a long task.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Completed work (exact paths/commands), key findings, and remaining steps",
          },
        },
        required: ["summary"],
      },
    },
    run: async (args, ctx) => {
      const summary = String(args.summary ?? "").trim();
      if (!summary) throw new Error("summary is required");
      ctx.addCheckpoint?.(summary);
      return "checkpoint saved";
    },
  };

  tools.save_artifact = {
    schema: {
      name: "save_artifact",
      description:
        "Save a deliverable into the run's artifacts folder (shown prominently to the operator). Provide content, or from_path to copy an existing file. Any file type works — save deliverables in the format that fits them (.csv/.json for data, .html for documents, runnable code files), not just markdown. " +
        "POLISHED DOCUMENTS: save MARKDOWN content under a .html name and it is rendered into the swarm's styled document automatically (typography, tables, dark mode) — never hand-write HTML/CSS. Embed charts with ```chart fenced blocks containing JSON: " +
        '{"type":"line","title":"BTC 90d","unit":"$","labels":["Mar","Apr"],"series":[{"name":"BTC","values":[61000,68000]}]} · ' +
        '{"type":"bar","labels":[...],"series":[{"values":[...]}]} · {"type":"donut","segments":[{"label":"BTC","value":52}]} · ' +
        '{"type":"stat","items":[{"label":"Market cap","value":"$2.1T","delta":"+4.2%"}]}.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename, may include subdirs like data/results.csv" },
          content: { type: "string" },
          from_path: { type: "string" },
        },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const name = String(args.name).replace(/^\/+/, "");
      const artifactsRoot = path.join(ctx.runDirPath, "artifacts");
      ensureDir(artifactsRoot);
      const dest = path.join(artifactsRoot, name);
      // Realpath-based: neither ../ traversal nor a planted symlink may move
      // the artifact outside the run's artifacts folder.
      if (!pathInside(realBase(artifactsRoot), realDestination(dest))) {
        throw new Error("artifact name must stay inside the artifacts folder");
      }
      ensureDir(path.dirname(dest));
      let rendered = false;
      if (typeof args.content === "string") {
        let body = args.content;
        // .html + markdown content → the house document shell (agents write
        // markdown + chart blocks; the style is the engine's job). Content
        // already starting with a tag/comment is real HTML — write verbatim,
        // or mdToHtml would escape its markup into visible text.
        if (/\.html?$/i.test(name) && !/^\s*</.test(body)) {
          const date = new Date().toISOString().slice(0, 10);
          body = renderDocHtml({
            markdown: body,
            metaHtml: `<span>${escapeHtml(path.basename(name))}</span><span>${date}</span>`,
          });
          rendered = true;
        }
        fs.writeFileSync(dest, body, "utf8");
      } else if (args.from_path) {
        // Artifacts always land on the host so the operator can open them,
        // even when the workspace lives in a remote sandbox.
        await ctx.sandbox.pull(resolveRead(String(args.from_path), ctx), dest);
      } else {
        throw new Error("provide content or from_path");
      }
      ctx.addArtifact(name);
      return `saved artifacts/${name}${rendered ? " (markdown rendered into the styled document shell)" : ""}`;
    },
  };

  // Only offered when a crawl backend (Firecrawl / context.dev / deepcrawl)
  // is configured — there is no free fallback for whole-site crawls.
  if (cfg && resolveCrawlBackend(cfg)) {
    tools.crawl_site = {
      schema: {
        name: "crawl_site",
        description:
          "Crawl a website (JS-rendered, clean markdown) and save every discovered page as a markdown file under crawl/<host>/ in the working directory. Returns an index of the saved files — read individual pages afterwards with read_file. Use for ingesting documentation sites or multi-page content; use fetch_url for single pages.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Starting URL to crawl" },
            max_pages: { type: "number", description: "Page limit (default 15, max 50)" },
            include_paths: {
              type: "array",
              items: { type: "string" },
              description: "Limit the crawl to URL path prefixes/globs, e.g. /docs/*",
            },
          },
          required: ["url"],
        },
      },
      run: async (args, ctx) => {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//.test(url)) throw new Error("only http(s) URLs are supported");
        const maxPages = Math.min(Math.max(Number(args.max_pages) || 15, 1), 50);
        const includePaths = Array.isArray(args.include_paths)
          ? args.include_paths.map(String).filter(Boolean)
          : undefined;
        const out = await crawlSite(ctx.cfg, { url, maxPages, includePaths, signal: ctx.signal });
        if (!out.pages.length) {
          return `crawled ${url} via ${out.backend}: no pages with content${out.warnings.length ? `\nwarnings: ${out.warnings.join("; ")}` : ""}`;
        }
        const used = new Set<string>();
        const lines: string[] = [];
        for (const page of out.pages) {
          const { host, slug } = slugForUrl(page.url || url);
          let rel = `crawl/${host}/${slug}.md`;
          for (let n = 2; used.has(rel); n++) rel = `crawl/${host}/${slug}-${n}.md`;
          used.add(rel);
          const abs = resolveWrite(rel, ctx);
          const header = `# ${page.title || page.url || "untitled"}\n\nSource: ${page.url || url}\n\n`;
          await writeFileVia(ctx, abs, header + page.markdown);
          if (lines.length < 50) {
            lines.push(`  ${rel} — "${page.title || "untitled"}" (${page.markdown.length.toLocaleString()} chars)`);
          }
        }
        const hidden = out.pages.length - lines.length;
        return [
          `crawled ${url} via ${out.backend}: ${out.pages.length} page${out.pages.length > 1 ? "s" : ""} saved`,
          ...lines,
          ...(hidden > 0 ? [`  …and ${hidden} more (list crawl/ to see all)`] : []),
          ...(out.warnings.length ? [`warnings: ${out.warnings.join("; ")}`] : []),
        ].join("\n");
      },
    };
  }

  return tools;
}

export function verifierToolset(): Record<string, ToolDef> {
  const all = workerToolset();
  return {
    shell: all.shell,
    read_file: all.read_file,
    list_dir: all.list_dir,
    fetch_url: all.fetch_url,
    web_search: all.web_search,
  };
}

export function synthToolset(): Record<string, ToolDef> {
  const all = workerToolset();
  return {
    read_file: all.read_file,
    list_dir: all.list_dir,
    save_artifact: all.save_artifact,
    // Task report excerpts in the synth prompt are clipped at 1600 chars;
    // read_report is how the synthesizer recovers the full text.
    read_report: all.read_report,
  };
}

// ---------- terminal tool schemas (handled by the agent loop, not executed) ----------

export const REPORT_TOOL: ToolSchema = {
  name: "report",
  description:
    "End your task and report back to the conductor. This is the ONLY thing the conductor sees from your work — be specific: what you did, what you verified, key findings, exact file paths.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "blocked"] },
      report: {
        type: "string",
        description: "Concrete results with evidence. If blocked: exactly what is missing.",
      },
      artifacts: {
        type: "array",
        items: { type: "string" },
        description:
          "Deliverable files, by the exact name you passed to save_artifact (e.g. 'timeline.md', not 'artifacts/timeline.md'). Files you only wrote to the workspace go in files_touched instead.",
      },
      key_facts: {
        type: "array",
        items: { type: "string" },
        description: "3-8 standalone facts downstream tasks need (figures, paths, URLs, decisions)",
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
        description: "Unresolved questions or risks the conductor should know about",
      },
      files_touched: {
        type: "array",
        items: { type: "string" },
        description: "Every file you created or modified (exact paths)",
      },
      sources: {
        type: "array",
        description:
          "Web sources your findings rely on — REQUIRED whenever your work drew on the web. They flow into the final report's bibliography; a web-sourced claim without an entry here cannot be cited.",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            date: { type: "string", description: "Publication date if known (ISO or year)" },
            note: { type: "string", description: "What this source supports" },
          },
          required: ["url"],
        },
      },
    },
    required: ["status", "report"],
  },
};

/**
 * Terminal tool for forecaster-panel agents (replaces report). Kind-aware so
 * a binary panelist must give a probability and a numeric panelist must give
 * quantiles — the engine validates, clamps, and aggregates mechanically.
 */
export function submitForecastTool(kind: ForecastKind, options?: string[]): ToolSchema {
  const binary = kind === "binary";
  const kindProps =
    kind === "binary"
      ? {
          prior: {
            type: "number",
            description:
              "FIRST COMMITMENT: the probability your reference classes ALONE imply (percentage 1-99), before weighing any current evidence. Compute this from your base_rates before reading the news mattered.",
          },
          probability: {
            type: "number",
            description:
              "Your FINAL probability the question resolves YES, as a percentage between 1 and 99, after adjusting the prior with concrete current evidence. Never 0 or 100 — certainty is never earned.",
          },
        }
      : kind === "mc"
        ? {
            option_probs: {
              type: "object",
              additionalProperties: { type: "number" },
              description:
                `Your probability for EVERY option, keys exactly as listed${options?.length ? `: ${options.map((o) => JSON.stringify(o)).join(", ")}` : ""}. Give them as percentages summing to ~100 OR as fractions summing to 1 — the engine normalizes either way, so just keep one consistent scale.`,
            },
          }
        : kind === "date"
          ? {
              p10: { type: "string", description: "ISO date (YYYY-MM-DD): a 10% chance the event happens before this" },
              p25: { type: "string", description: "Optional ISO date: 25th percentile" },
              p50: { type: "string", description: "ISO date: your median estimate of when the event happens" },
              p75: { type: "string", description: "Optional ISO date: 75th percentile" },
              p90: { type: "string", description: "ISO date: a 10% chance the event happens after this" },
              p_never: {
                type: "number",
                description: "Percentage chance the event does NOT happen by the question's horizon date at all",
              },
            }
          : {
              p5: { type: "number", description: "Optional 5th percentile: a 5% chance the true value is below this" },
              p10: { type: "number", description: "Your 10th percentile: a 10% chance the true value is below this" },
              p25: { type: "number", description: "Optional 25th percentile — sharpens the distribution" },
              p50: { type: "number", description: "Your median estimate" },
              p75: { type: "number", description: "Optional 75th percentile — sharpens the distribution" },
              p90: { type: "number", description: "Your 90th percentile: a 10% chance the true value is above this" },
              p95: { type: "number", description: "Optional 95th percentile: a 5% chance the true value is above this" },
            };
  return {
    name: "submit_forecast",
    description:
      "End your forecasting task by submitting your final structured forecast. This replaces report(...) — it is the ONLY output the conductor and the mechanical aggregator see. Your number is combined with the other panelists' in code; give your honest independent credence, not a hedge toward 50%.",
    parameters: {
      type: "object",
      properties: {
        ...kindProps,
        method: {
          type: "string",
          description: "Your assigned primary method, e.g. outside-view | inside-view | trend | market-anchored",
        },
        rationale: {
          type: "string",
          description:
            "Your reasoning: reference classes and base rates FIRST, then case-specific adjustments, with the strongest consideration on each side.",
        },
        base_rates: {
          type: "array",
          items: { type: "string" },
          description: "Reference classes you used, each with its historical frequency and source",
        },
        key_drivers: {
          type: "array",
          items: { type: "string" },
          description: "The factors your forecast is most sensitive to",
        },
        update_triggers: {
          type: "array",
          items: { type: "string" },
          description: "Concrete observable events that should move this forecast, with the direction they move it",
        },
        sources: {
          type: "array",
          description:
            "Web sources your forecast rests on — REQUIRED when you drew on the web. They flow into the final report's bibliography.",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              title: { type: "string" },
              date: { type: "string", description: "Publication date if known (ISO or year)" },
              note: { type: "string", description: "What this source supports" },
            },
            required: ["url"],
          },
        },
      },
      required: [
        ...(binary ? ["prior", "probability"] : kind === "mc" ? ["option_probs"] : ["p10", "p50", "p90"]),
        "method",
        "rationale",
      ],
    },
  };
}

export const VERDICT_TOOL: ToolSchema = {
  name: "verdict",
  description: "Deliver your verification verdict.",
  parameters: {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      feedback: {
        type: "string",
        description: "If fail: exactly what is wrong and where. If pass: one-line confirmation of the evidence.",
      },
      issues: {
        type: "array",
        description: "On fail: one entry per concrete problem. The worker's retry sees these verbatim — make each actionable.",
        items: {
          type: "object",
          properties: {
            problem: { type: "string", description: "What is wrong" },
            evidence: { type: "string", description: "What you observed that proves it (command output, file content, URL)" },
            fix: { type: "string", description: "The exact change that would resolve it" },
          },
          required: ["problem"],
        },
      },
    },
    required: ["pass", "feedback"],
  },
};

export const SUBMIT_FINAL_TOOL: ToolSchema = {
  name: "submit_final",
  description: "Submit the final mission deliverable.",
  parameters: {
    type: "object",
    properties: {
      report_markdown: {
        type: "string",
        description: "The definitive final report document (markdown).",
      },
      summary: { type: "string", description: "Short summary (≤8 sentences) for the console." },
    },
    required: ["report_markdown", "summary"],
  },
};

export const SPAWN_TASKS_TOOL: ToolSchema = {
  name: "spawn_tasks",
  description: "Spawn new tasks; each becomes an autonomous worker agent. Tasks with no unmet deps start immediately, in parallel.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title" },
            objective: {
              type: "string",
              description: "Self-contained objective with explicit success criteria ('Done when …'). The worker sees nothing else except `context` and dep reports.",
            },
            role: { type: "string", description: "Specialist role, e.g. researcher | coder | analyst | writer | reviewer | data-wrangler" },
            deps: {
              type: "array",
              items: { type: "string" },
              description: "Task ids that must finish first; their reports are given to this worker",
            },
            verify: { type: "boolean", description: "Adversarially verify this task's result before accepting it" },
            context: { type: "string", description: "Facts, paths, URLs, constraints the worker needs inlined" },
            model: {
              type: "string",
              enum: ["cheap", "default", "strong"],
              description: "Model tier: cheap for scouts/bulk extraction, strong for leads, integration, and verified deliverables",
            },
            team: {
              type: "boolean",
              description: "Run as a sub-swarm: this task gets its own conductor that decomposes it into parallel sub-tasks and reports one consolidated result. Use for coherent multi-task subsystems (e.g. 'build the backend'). Teams cannot spawn teams.",
            },
            team_max_workers: { type: "number", description: "Parallelism inside the team (default: half the run's)" },
            team_budget_tokens: { type: "number", description: "Token slice for the team (default: a quarter of what remains)" },
          },
          required: ["title", "objective"],
        },
      },
    },
    required: ["tasks"],
  },
};

export const CONDUCTOR_READ_REPORT_TOOL: ToolSchema = {
  name: "read_report",
  description:
    "Read the full report of any settled task. Updates show one-line summaries once many tasks settle — use this when a summary isn't enough to plan from.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "e.g. T17" },
    },
    required: ["task_id"],
  },
};

export const UPDATE_PLAN_TOOL: ToolSchema = {
  name: "update_plan",
  description:
    "Maintain the mission's living plan document (artifacts/mission-plan.md, full overwrite). On missions beyond ~20 tasks, keep it current: approach, phases, what's done, what's next, open risks. Its head is pinned into every update you receive, surviving history trimming and restarts.",
  parameters: {
    type: "object",
    properties: {
      markdown: { type: "string", description: "The complete plan document (markdown)" },
    },
    required: ["markdown"],
  },
};

export const SET_PHASE_TOOL: ToolSchema = {
  name: "set_phase",
  description:
    "Declare the mission's current phase/milestone. Use on long missions to structure the work (e.g. 'discovery' → 'build' → 'integrate' → 'polish'). The phase and its exit criteria are pinned into every update you receive, surviving history trimming.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short phase name" },
      goal: { type: "string", description: "What this phase accomplishes" },
      exit_criteria: { type: "string", description: "Concrete conditions that end this phase" },
    },
    required: ["name"],
  },
};

export const WAIT_TOOL: ToolSchema = {
  name: "wait",
  description: "Do nothing for now; wake again when running tasks report.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string" } },
  },
};

export const FINISH_TOOL: ToolSchema = {
  name: "finish",
  description:
    "Declare the mission complete (or as complete as the budget allows). A synthesizer agent will then compose the final report from all task reports.",
  parameters: {
    type: "object",
    properties: {
      notes: {
        type: "string",
        description: "Guidance for the synthesizer: what matters most, what to highlight, any caveats.",
      },
    },
  },
};

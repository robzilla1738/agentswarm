import * as fs from "fs";
import * as path from "path";
import { SwarmConfig } from "./config";
import { ToolSchema } from "./deepseek";
import { SandboxRuntime } from "./sandbox";
import { RunMeta } from "./types";
import { ensureDir, errMsg, pathInside, truncateMiddle } from "./util";
import { fetchUrl, webSearch } from "./webtools";

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
  addNote: (text: string, key?: string) => void;
  addArtifact: (relPath: string) => void;
  readBlackboard: () => string;
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

function resolveWrite(p: string, ctx: ToolCtx): string {
  const abs = path.resolve(ctx.workdir, p);
  const ok =
    pathInside(ctx.workdir, abs) || pathInside(ctx.runDirPath, abs) || !ctx.cfg.safeMode;
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

export function workerToolset(): Record<string, ToolDef> {
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
      return `wrote ${abs} (${content.length} chars)`;
    },
  };

  tools.replace_in_file = {
    schema: {
      name: "replace_in_file",
      description:
        "Exact string replacement in a file. `find` must match exactly (including whitespace). Fails if not found, or if ambiguous when all=false.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
          all: { type: "boolean", description: "Replace every occurrence (default false)" },
        },
        required: ["path", "find", "replace"],
      },
    },
    run: async (args, ctx) => {
      const abs = resolveWrite(String(args.path), ctx);
      const raw = await readFileVia(ctx, abs);
      const find = String(args.find);
      const replace = String(args.replace);
      const count = raw.split(find).length - 1;
      if (count === 0) throw new Error("find string not found in file");
      if (count > 1 && !args.all) {
        throw new Error(`find string matches ${count} times; provide more context or set all=true`);
      }
      const next = args.all ? raw.split(find).join(replace) : raw.replace(find, replace);
      await writeFileVia(ctx, abs, next);
      return `replaced ${args.all ? count : 1} occurrence(s) in ${abs}`;
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
        "Search the web. Returns ranked results with title, URL and snippet. " +
        "Set deep=true to also fetch top pages and return quotable passages (slower; use for claims that need grounding).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "Max results, default 6, max 10" },
          deep: { type: "boolean", description: "Fetch page content for quotable passages" },
        },
        required: ["query"],
      },
    },
    run: async (args, ctx) => {
      const count = Math.min(Math.max(Number(args.count) || 6, 1), 10);
      const hits = await webSearch(ctx.cfg, String(args.query), count, ctx.signal, Boolean(args.deep));
      if (!hits.length) return "no results";
      return hits
        .map((h, i) => {
          const head = `${i + 1}. ${h.title}${h.date ? ` (${h.date})` : ""}\n   ${h.url}\n   ${h.snippet}`;
          const quotes = (h.passages || []).map((p) => `   > ${p}`).join("\n");
          return quotes ? `${head}\n${quotes}` : head;
        })
        .join("\n");
    },
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
      return fetchUrl(ctx.cfg, url, Boolean(args.raw), 60_000, ctx.signal);
    },
  };

  tools.note = {
    schema: {
      name: "note",
      description:
        "Post a durable fact/discovery to the swarm's shared blackboard so the conductor and other agents can see it. Use sparingly — facts other tasks need, not progress chatter.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          key: { type: "string", description: "Optional short label" },
        },
        required: ["text"],
      },
    },
    run: async (args, ctx) => {
      ctx.addNote(String(args.text), args.key ? String(args.key) : undefined);
      return "noted on the blackboard";
    },
  };

  tools.save_artifact = {
    schema: {
      name: "save_artifact",
      description:
        "Save a deliverable into the run's artifacts folder (shown prominently to the operator). Provide content, or from_path to copy an existing file.",
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
      const dest = path.join(ctx.runDirPath, "artifacts", name);
      if (!pathInside(path.join(ctx.runDirPath, "artifacts"), dest)) {
        throw new Error("artifact name must stay inside the artifacts folder");
      }
      ensureDir(path.dirname(dest));
      if (typeof args.content === "string") {
        fs.writeFileSync(dest, args.content, "utf8");
      } else if (args.from_path) {
        // Artifacts always land on the host so the operator can open them,
        // even when the workspace lives in a remote sandbox.
        await ctx.sandbox.pull(resolveRead(String(args.from_path), ctx), dest);
      } else {
        throw new Error("provide content or from_path");
      }
      ctx.addArtifact(name);
      return `saved artifacts/${name}`;
    },
  };

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
        description: "Paths of files you created/changed that matter",
      },
    },
    required: ["status", "report"],
  },
};

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
          },
          required: ["title", "objective"],
        },
      },
    },
    required: ["tasks"],
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

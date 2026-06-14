import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  SETTABLE_KEYS,
  SwarmConfig,
  coerceConfigValue,
  configPath,
  isSecretConfigKey,
  loadConfig,
  maskKey,
  runDir,
  saveConfig,
} from "./config";
import { appendControl } from "./control";
import { listModels } from "./deepseek";
import { validateAuth } from "./deepseek";
import { PROVIDERS } from "./providers";
import { startHub } from "./hub";
import { Journal } from "./journal";
import {
  clearPid,
  createRun,
  isRunLive,
  launchDetached,
  listRuns,
  loadMeta,
  loadRunState,
  optionsFromConfig,
  resumeInfo,
  writePid,
} from "./run";
import { Executor } from "./executor";
import { SANDBOX_KINDS, SandboxKind, dockerAvailable, resolveSandboxKind, testSandbox } from "./sandbox";
import { TerminalRenderer, watchRun } from "./terminal";
import {
  ISO_DATE,
  backtest,
  backtestNumeric,
  calibrationStats,
  daysToIso,
  isoToDays,
  loadLedger,
  resolveLedgerEntry,
  simulationLedgerSummary,
  supersededIds,
} from "./forecast";
import { TOURNAMENT_SOURCES, TournamentSource, listClosingQuestions } from "./datatools";
import { resolveDue, watchOpenForecasts } from "./resolve";
import { ForecastQuestion, RunMeta, RunOptions } from "./types";
import { ansi, errMsg, fmtMoney, fmtTokens } from "./util";

const BIN_PATH = path.join(__dirname, "..", "bin", "swarm.js");

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value — they must not swallow the next positional
 *  (`swarm run --fg "mission"` would otherwise eat the mission). */
const BOOL_FLAGS = new Set(["fg", "open", "resume", "auto", "dry-run", "reforecast", "single", "simulate"]);

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith("no-")) {
        flags[key.slice(3)] = false;
      } else if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const cmd = _[0];

  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        printHelp();
        break;
      case "run":
        await cmdRun(_.slice(1).join(" "), flags);
        break;
      case "forecast":
        await cmdRun(_.slice(1).join(" "), { ...flags, mode: "forecast" });
        break;
      case "_exec":
        await cmdExec(_[1], Boolean(flags.resume));
        break;
      case "resume":
        await cmdResume(_[1], flags);
        break;
      case "sandbox":
        await cmdSandbox(_[1]);
        break;
      case "serve":
        await cmdServe(flags);
        break;
      case "watch":
        await cmdWatch(_[1]);
        break;
      case "ls":
      case "list":
        cmdList();
        break;
      case "forecasts":
        await cmdForecasts(_[1], flags);
        break;
      case "tournament":
        await cmdTournament(flags);
        break;
      case "resolve":
        await cmdResolve(_.slice(1));
        break;
      case "calibration":
        cmdCalibration();
        break;
      case "backtest":
        cmdBacktest();
        break;
      case "report":
        cmdReport(_[1], flags);
        break;
      case "note":
        cmdNote(_[1], _.slice(2).join(" "));
        break;
      case "cancel":
        cmdCancel(_[1]);
        break;
      case "config":
        await cmdConfig(_.slice(1), flags);
        break;
      case "models":
        await cmdModels();
        break;
      case "demo":
        await cmdDemo(flags);
        break;
      default:
        console.error(ansi.red(`unknown command: ${cmd}`));
        printHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error(ansi.red("error: ") + errMsg(e));
    process.exit(1);
  }
}

// ---------------------------------------------------------------- run

export function optionOverrides(flags: Args["flags"], cfg: SwarmConfig): Partial<RunOptions> {
  const o: Partial<RunOptions> = {};
  // Validate numeric flags through the config ranges: non-numeric input throws
  // here (red error, exit 1) instead of leaking NaN into the scheduler, where
  // `activeWorkerCount() < NaN` would hang the run with zero tasks started.
  const numFlag = (flag: string, key: keyof SwarmConfig): number => {
    try {
      return Number(coerceConfigValue(key, flags[flag]));
    } catch {
      throw new Error(`--${flag} must be a number`);
    }
  };
  if (flags.workers) o.maxWorkers = numFlag("workers", "maxWorkers");
  if (flags.steps) o.maxStepsPerTask = numFlag("steps", "maxStepsPerTask");
  if (flags.tasks) o.maxTasks = numFlag("tasks", "maxTasks");
  if (flags.budget) {
    // Not coerced through the config range: its 50K floor protects the
    // persisted default, but a one-off run may want a deliberately tiny cap.
    const n = Number(flags.budget);
    if (!Number.isFinite(n)) throw new Error("--budget must be a number");
    o.maxTokens = Math.min(2_000_000_000, Math.max(1_000, Math.round(n)));
  }
  if (typeof flags.model === "string") o.model = flags.model;
  if (typeof flags.conductor === "string") o.conductorModel = flags.conductor;
  if (typeof flags.verify === "string" && ["off", "normal", "strict"].includes(flags.verify)) {
    o.verification = flags.verify as RunOptions["verification"];
  }
  if (flags.thinking === false) o.thinking = false;
  if (typeof flags.effort === "string") {
    if (!["low", "medium", "high", "max"].includes(flags.effort)) {
      throw new Error("--effort must be one of: low | medium | high | max");
    }
    o.reasoningEffort = flags.effort as RunOptions["reasoningEffort"];
  }
  if (flags.safe === false) o.safeMode = false;
  if (typeof flags.mode === "string") {
    if (!["research", "forecast"].includes(flags.mode)) {
      throw new Error("--mode must be one of: research | forecast");
    }
    o.mode = flags.mode as RunOptions["mode"];
  }
  if (typeof flags.by === "string") {
    if (!ISO_DATE.test(flags.by) || !Number.isFinite(Date.parse(flags.by))) {
      throw new Error("--by must be an ISO date (YYYY-MM-DD)");
    }
    o.resolutionDate = flags.by;
  }
  if (flags.panel) o.panelSize = numFlag("panel", "forecastPanelSize");
  // Forecast: --single forces one forecast (skip open-ended decomposition).
  if (flags.single === true || flags.single === "true") o.forecastSingle = true;
  // Forecast: --simulate forces the grounded scenario simulation on (it also
  // auto-runs on decomposed questions).
  if (flags.simulate === true || flags.simulate === "true") o.forecastSimulate = true;
  if (typeof flags.sandbox === "string") {
    const v = flags.sandbox;
    if (v !== "auto" && !SANDBOX_KINDS.includes(v as SandboxKind)) {
      throw new Error(`--sandbox must be one of: ${SANDBOX_KINDS.join(" | ")} | auto`);
    }
    o.sandboxRuntime = v === "auto" ? resolveSandboxKind({ ...cfg, sandboxRuntime: "auto" }) : (v as SandboxKind);
  }
  return o;
}

async function cmdRun(mission: string, flags: Args["flags"]): Promise<void> {
  if (!mission.trim()) {
    console.error(ansi.red('Provide a mission: swarm run "build X / research Y"'));
    process.exit(1);
  }
  const cfg = loadConfig();
  // Validate flags before any network round-trip so typos fail instantly.
  const overrides = optionOverrides(flags, cfg);
  if (!cfg.apiKey && PROVIDERS[cfg.provider].keyRequired) {
    console.error(ansi.red(`No ${PROVIDERS[cfg.provider].label} API key set. `) + "Run: swarm config set apiKey <...>");
    process.exit(1);
  }
  process.stdout.write(ansi.gray("validating API key… "));
  const auth = await validateAuth(cfg);
  if (auth.status === "invalid") {
    console.error(ansi.red(`\n✗ ${PROVIDERS[cfg.provider].label} key rejected: `) + (auth.message || "invalid key"));
    console.error(ansi.gray("  Set a valid key: ") + "swarm config set apiKey <...>");
    process.exit(1);
  }
  process.stdout.write(auth.status === "ok" ? ansi.green("ok\n") : ansi.gray("skipped\n"));
  const sandbox = flags.sandbox !== false && !flags.cwd;
  if (typeof flags.sandbox === "string" && flags.cwd) {
    console.log(ansi.yellow("note: ") + "--cwd runs execute directly on the host — --sandbox is ignored");
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const meta = createRun({
    mission: mission.trim(),
    cwd,
    sandbox,
    options: optionsFromConfig(cfg, overrides),
  });

  if (flags.fg) {
    await execForeground(cfg, meta, true);
    return;
  }

  // Default: launch detached, attach a live dashboard by tailing the journal.
  launchDetached(meta.id, BIN_PATH);
  console.log(
    `${ansi.cyan("🐝 swarm launched")} ${ansi.gray(meta.id)} ${ansi.gray("· workdir:")} ${meta.cwd}`
  );
  await new Promise((r) => setTimeout(r, 400));

  let detaching = false;
  const onSig = () => {
    detaching = true;
  };
  process.on("SIGINT", onSig);
  await watchRunUntilSignal(meta.id, cfg.pricing, () => detaching);
  process.off("SIGINT", onSig);
  if (detaching && isRunLive(meta.id)) {
    console.log(
      "\n" +
        ansi.yellow("detached") +
        ` — run continues in the background.\n  reattach:  swarm watch ${meta.id}\n  steer:     swarm note ${meta.id} "..."\n  stop:      swarm cancel ${meta.id}`
    );
  } else {
    printFinalLine(meta.id);
  }
}

/** `swarm sandbox [test]` — show the resolved runtime; boot + echo + teardown. */
async function cmdSandbox(sub?: string): Promise<void> {
  const cfg = loadConfig();
  const resolved = resolveSandboxKind(cfg);
  console.log(`configured: ${cfg.sandboxRuntime} → resolved: ${ansi.bold(resolved)}`);
  console.log(ansi.gray(`docker daemon: ${dockerAvailable() ? "up" : "not reachable"} · e2b key: ${cfg.e2bApiKey ? "set" : "—"} · modal: ${cfg.modalTokenId ? "set" : "—"} · vercel: ${cfg.vercelToken ? "set" : "—"}`));
  if (resolved === "host") {
    console.log(ansi.gray("host = the run's isolated workspace on this machine (the default; nothing to install)."));
    console.log(ansi.gray("for container/cloud isolation: swarm config set sandboxRuntime docker|e2b|modal|vercel|auto"));
  }
  if (sub === "test" || (sub && SANDBOX_KINDS.includes(sub as never))) {
    const kind = SANDBOX_KINDS.includes(sub as never) ? (sub as (typeof SANDBOX_KINDS)[number]) : resolved;
    process.stdout.write(`testing ${kind}… `);
    const r = await testSandbox(cfg, kind);
    console.log(r.ok ? ansi.green("✓ ok ") + ansi.gray(r.detail) : ansi.red("✗ ") + r.detail);
    process.exit(r.ok ? 0 : 1);
  }
}

async function cmdExec(id: string, resume = false): Promise<void> {
  if (!id) throw new Error("_exec requires a run id");
  const meta = loadMeta(id);
  if (!meta) throw new Error(`run not found: ${id}`);
  const cfg = loadConfig();
  await execForeground(cfg, meta, false, resume);
  process.exit(0);
}

/** Resume an interrupted run: settled tasks keep their results, in-flight tasks re-run. */
async function cmdResume(id: string, flags: Args["flags"]): Promise<void> {
  if (!id) throw new Error("usage: swarm resume <run-id>");
  const info = resumeInfo(id);
  if (!info.resumable) {
    console.error(ansi.red("✗ cannot resume: ") + (info.reason || "unknown"));
    process.exit(1);
  }
  const cfg = loadConfig();
  const meta = loadMeta(id)!;
  console.log(`${ansi.cyan("🐝 resuming")} ${ansi.gray(id)} ${ansi.gray("· workdir:")} ${meta.cwd}`);

  if (flags.fg) {
    await execForeground(cfg, meta, true, true);
    return;
  }
  launchDetached(id, BIN_PATH, true);
  await new Promise((r) => setTimeout(r, 400));
  let detaching = false;
  const onSig = () => {
    detaching = true;
  };
  process.on("SIGINT", onSig);
  await watchRunUntilSignal(id, cfg.pricing, () => detaching);
  process.off("SIGINT", onSig);
  if (detaching && isRunLive(id)) {
    console.log("\n" + ansi.yellow("detached") + ` — run continues in the background. Reattach: swarm watch ${id}`);
  } else {
    printFinalLine(id);
  }
}

async function execForeground(cfg: SwarmConfig, meta: RunMeta, render: boolean, resume = false): Promise<void> {
  // Reduce the journal BEFORE opening it for appends — the seed must reflect
  // exactly what the dead engine left behind.
  const seed = resume ? loadRunState(meta.id, cfg.pricing) : null;
  const journal = new Journal(runDir(meta.id));
  const renderer = render ? new TerminalRenderer(cfg.pricing) : null;
  if (renderer) {
    journal.onEvent = (ev) => renderer.ingest(ev);
    renderer.start();
  }
  writePid(meta.id);

  const executor = new Executor(cfg, meta, journal);
  if (resume && seed) {
    const resets = seed
      .taskList()
      .filter((t) => t.status === "running" || t.status === "verifying")
      .map((t) => t.id);
    journal.append("run.resumed", { resets });
    executor.seedFromState(seed, resets);
  } else {
    journal.append("run.created", { meta });
  }
  const onSig = () => {
    if (renderer) {
      renderer.stop();
      console.log(ansi.yellow("\ncancelling…"));
    }
    executor.cancel();
  };
  process.on("SIGINT", onSig);

  // A crash without a terminal status would leave the run "running" forever
  // in every viewer. Record the failure, flush, and exit non-zero.
  const onFatal = (e: unknown) => {
    try {
      journal.append("run.status", { status: "failed", reason: `engine crashed: ${errMsg(e)}` });
    } catch {
      /* nothing left to do */
    }
    journal.flush().finally(() => {
      clearPid(meta.id);
      if (renderer) renderer.stop();
      process.exit(1);
    });
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  // SIGTERM (kill, system shutdown): flush buffered journal lines synchronously
  // and exit WITHOUT a terminal status — the run stays resumable, and viewers
  // show it as interrupted once the pid disappears.
  const onTerm = () => {
    journal.append("log", { level: "warn", msg: "engine received SIGTERM — exiting; resume with: swarm resume " + meta.id });
    journal.flushSync();
    clearPid(meta.id);
    if (renderer) renderer.stop();
    process.exit(143);
  };
  process.on("SIGTERM", onTerm);

  try {
    await executor.run();
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onTerm);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    clearPid(meta.id);
    await journal.flush();
    if (renderer) renderer.stop();
  }
  if (render) printFinalLine(meta.id);
}

async function watchRunUntilSignal(
  id: string,
  pricing: SwarmConfig["pricing"],
  shouldStop: () => boolean
): Promise<void> {
  const { eventsFile, readNewEvents } = await import("./journal");
  const renderer = new TerminalRenderer(pricing);
  const file = eventsFile(runDir(id));
  const tail = { offset: 0, carry: "" };
  renderer.start();
  return new Promise((resolve) => {
    const tick = () => {
      if (shouldStop()) {
        renderer.stop();
        return resolve();
      }
      try {
        for (const ev of readNewEvents(file, tail)) renderer.ingest(ev);
      } catch {
        /* not ready */
      }
      const st = renderer.getState().status;
      if (["done", "failed", "cancelled"].includes(st)) {
        setTimeout(() => {
          try {
            for (const ev of readNewEvents(file, tail)) renderer.ingest(ev);
          } catch { /* ignore */ }
          renderer.stop();
          resolve();
        }, 400);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ---------------------------------------------------------------- serve

async function cmdServe(flags: Args["flags"]): Promise<void> {
  const cfg = loadConfig();
  const port = Number(flags.port) || (flags.port === "0" ? 0 : cfg.hubPort);
  const uiDir = findUiDir();
  const server = startHub({ port, uiDir, binPath: BIN_PATH });
  // Report the port actually bound (matters for --port 0 / collisions).
  server.on("listening", () => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://localhost:${bound}`;
    console.log(`${ansi.cyan("🐝 agentswarm hub")} ${ansi.gray("·")} ${ansi.bold(url)}`);
    console.log(ansi.gray(`   api:      ${url}/api`));
    console.log(ansi.gray(`   ui:       ${uiDir ? "built ✓ (served here)" : "not built — run: npm run setup   (or: npm run build:ui)"}`));
    console.log(ansi.gray(`   api key:  ${cfg.apiKey ? maskKey(cfg.apiKey) + " ✓" : ansi.red("not set — open Settings or: swarm config set apiKey <sk-...>")}`));
    console.log(ansi.gray("   Ctrl-C to stop the hub (background runs keep going).\n"));
    if (flags.open) openBrowser(url);
  });
  server.on("error", (e) => {
    console.error(ansi.red(`hub failed: ${errMsg(e)}`));
    process.exit(1);
  });
  await new Promise(() => {}); // run forever
}

function findUiDir(): string | null {
  const candidates = [
    path.join(__dirname, "..", "ui", "out"),
    path.join(process.cwd(), "ui", "out"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- watch / list / report

async function cmdWatch(id: string): Promise<void> {
  if (!id) throw new Error("usage: swarm watch <id>");
  id = resolveId(id);
  if (!loadMeta(id)) throw new Error(`run not found: ${id}`);
  const cfg = loadConfig();
  await watchRun(id, cfg.pricing);
  printFinalLine(id);
}

function cmdList(): void {
  const cfg = loadConfig();
  const runs = listRuns(cfg.pricing);
  if (!runs.length) {
    console.log(ansi.gray("no runs yet. start one: ") + 'swarm run "your mission"');
    return;
  }
  console.log(ansi.bold("runs") + ansi.gray(`  (~/.agentswarm/runs)`));
  for (const r of runs) {
    const live = r.pid ? ansi.cyan(" ●live") : "";
    const st = r.status === "done" ? ansi.green(r.status) : r.status === "failed" ? ansi.red(r.status) : ansi.yellow(r.status);
    const tok = fmtTokens(r.usage.promptTokens + r.usage.completionTokens);
    console.log(
      `  ${ansi.gray(r.id)}  ${st.padEnd(14)} ${ansi.gray(`${r.tasks.done}/${r.tasks.total} tasks`)}  ${ansi.gray(tok + " tok")}  ${ansi.green(fmtMoney(r.cost))}${live}`
    );
    console.log(`     ${clipLine(r.mission, 90)}`);
  }
}

function cmdReport(id: string, flags: Args["flags"]): void {
  if (!id) throw new Error("usage: swarm report <id>");
  id = resolveId(id);
  const file = path.join(runDir(id), "artifacts", "final-report.md");
  if (!fs.existsSync(file)) {
    console.error(ansi.yellow("no final report yet for ") + id);
    process.exit(1);
  }
  if (flags.open) {
    const html = path.join(runDir(id), "artifacts", "final-report.html");
    const target = fs.existsSync(html) ? html : file;
    openBrowser("file://" + target);
    console.log(target);
    return;
  }
  process.stdout.write(fs.readFileSync(file, "utf8") + "\n");
  const arts = path.join(runDir(id), "artifacts");
  console.log(ansi.gray(`\nartifacts: ${arts}`));
}

function cmdNote(id: string, text: string): void {
  if (!id || !text) throw new Error('usage: swarm note <id> "message"');
  id = resolveId(id);
  if (!loadMeta(id)) throw new Error(`run not found: ${id}`);
  appendControl(runDir(id), { kind: "note", text });
  console.log(ansi.green("✓ ") + (isRunLive(id) ? "note delivered to the conductor" : "note queued (run is not live)"));
}

function cmdCancel(id: string): void {
  if (!id) throw new Error("usage: swarm cancel <id>");
  id = resolveId(id);
  if (!loadMeta(id)) throw new Error(`run not found: ${id}`);
  appendControl(runDir(id), { kind: "cancel" });
  console.log(ansi.yellow("⛔ cancel requested for ") + id);
}

// ---------------------------------------------------------------- forecasts

async function cmdForecasts(sub?: string, flags: Args["flags"] = {}): Promise<void> {
  const cfg = loadConfig();
  if (sub === "watch") {
    console.log(ansi.cyan("checking update triggers of open forecasts…"));
    const alerts = await watchOpenForecasts(cfg, { log: (lvl, msg) => lvl !== "info" && console.error(ansi.gray(`  ${msg}`)) });
    if (!alerts.length) {
      console.log(ansi.gray("no open forecasts with update triggers to watch"));
      return;
    }
    for (const a of alerts) {
      console.log(`\n${a.fired ? ansi.yellow("▲ trigger fired") : ansi.green("· quiet")}  ${ansi.gray(a.id)}  ${a.question}`);
      console.log(`  ${a.summary}`);
      if (a.fired && !flags.reforecast) console.log(ansi.gray(`  re-forecast: swarm forecasts watch --reforecast`));
    }
    const fired = alerts.filter((a) => a.fired);
    if (flags.reforecast && fired.length) {
      // A fired trigger means the recorded probability is stale: re-run the
      // SAME question with a fresh small panel; the new ledger record
      // supersedes the old one (both still resolve and score).
      const ledger = loadLedger();
      for (const a of fired) {
        const entry = ledger.find((e) => e.id === a.id);
        if (!entry) continue;
        const meta = createRun({
          mission: `Re-forecast (update trigger fired): ${entry.question.text}\nWhat fired: ${a.summary}`,
          cwd: process.cwd(),
          sandbox: true,
          options: optionsFromConfig(cfg, {
            maxTasks: Math.min(cfg.maxTasks, 16),
            maxTokens: Math.min(cfg.maxTokensPerRun, 4_000_000),
            ...(cfg.cheapModel ? { model: cfg.cheapModel } : {}),
            // Updates are cheaper runs than first forecasts, but they should
            // still respect the configured panel size up to a cap of 5.
            panelSize: Math.min(Math.max(3, cfg.forecastPanelSize || 3), 5),
            mode: "forecast",
            presetQuestion: entry.question,
            supersedes: entry.id,
            ...(entry.origin ? { forecastOrigin: entry.origin } : {}),
          }),
        });
        console.log(`\n${ansi.cyan("re-forecasting")} ${ansi.gray(entry.id)} ${clipLine(entry.question.text, 80)}`);
        try {
          await execForeground(cfg, meta, false);
        } catch (e) {
          console.error(ansi.red(`  re-forecast failed: ${errMsg(e)}`));
          continue;
        }
        const updated = loadLedger().find((e) => e.runId === meta.id);
        if (updated) {
          const oldP = entry.aggregate.probability;
          const newP = updated.aggregate.probability;
          const delta =
            typeof oldP === "number" && typeof newP === "number"
              ? ` ${Math.round(oldP * 100)}% → ${Math.round(newP * 100)}%`
              : "";
          console.log(`  ${ansi.green("✓")} superseded by ${updated.id}${delta}`);
        }
      }
    }
    return;
  }
  const entries = loadLedger();
  if (!entries.length) {
    console.log(ansi.gray("no forecasts yet. make one: ") + 'swarm forecast "Will X happen by 2026-12-31?"');
    return;
  }
  console.log(ansi.bold("forecasts") + ansi.gray("  (~/.agentswarm/forecasts/ledger.jsonl)"));
  const superseded = supersededIds(entries);
  for (const e of entries) {
    const agg = e.aggregate;
    const headline =
      typeof agg.probability === "number"
        ? `${Math.round(agg.probability * 100)}%`
        : agg.optionProbs
          ? (() => {
              const top = Object.entries(agg.optionProbs!).sort((a, b) => b[1] - a[1])[0];
              return top ? `${Math.round(top[1] * 100)}% "${top[0].slice(0, 18)}"` : "—";
            })()
          : agg.quantiles
            ? e.question.kind === "date"
              ? `p50 ${daysToIso(agg.quantiles.p50)}`
              : `p50 ${agg.quantiles.p50}`
            : "—";
    const due = !e.resolution && Date.parse(`${e.question.resolutionDate}T23:59:59Z`) <= Date.now();
    const status = e.resolution
      ? e.resolution.outcome === "void"
        ? ansi.gray("void")
        : ansi.green(`resolved ${e.resolution.outcome === 1 ? "YES" : e.resolution.outcome === 0 ? "NO" : e.resolution.outcome}`) +
          (e.resolution.brier !== undefined ? ansi.gray(`  brier ${e.resolution.brier.toFixed(3)}`) : "") +
          (e.resolution.intervalScore !== undefined ? ansi.gray(`  interval ${e.resolution.intervalScore.toFixed(2)}`) : "")
      : due
        ? ansi.yellow("DUE — run: swarm resolve")
        : ansi.gray(`open until ${e.question.resolutionDate}`);
    const chain = superseded.has(e.id) ? ansi.gray("  (superseded)") : e.supersedes ? ansi.gray(`  (supersedes ${e.supersedes})`) : "";
    const set = e.setId ? ansi.gray("  ⊂ sub-forecast") : "";
    console.log(`  ${ansi.gray(e.id)}  ${ansi.bold(headline.padEnd(6))} ${status}${chain}${set}`);
    console.log(`     ${clipLine(e.question.text, 90)}`);
  }
  const stats = calibrationStats(entries);
  if (stats.n) {
    console.log(ansi.gray(`\n${stats.n} resolved · mean Brier ${stats.brierMean.toFixed(3)} · details: swarm calibration`));
  }
}

/**
 * Batch-forecast open market questions that close soon. The point is ledger
 * velocity: resolved forecasts activate the calibration flywheel (adaptive k,
 * calibration block, learned weights), and questions imported from market
 * platforms resolve in days — with the platform publishing the ground truth.
 */
async function cmdTournament(flags: Args["flags"]): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.apiKey && PROVIDERS[cfg.provider].keyRequired && !flags["dry-run"]) {
    console.error(ansi.red(`No ${PROVIDERS[cfg.provider].label} API key set. `) + "Run: swarm config set apiKey <...>");
    process.exit(1);
  }
  const overrides = optionOverrides(flags, cfg);
  const intFlag = (name: string, def: number, lo: number, hi: number): number => {
    if (flags[name] === undefined) return def;
    const n = Number(flags[name]);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const count = intFlag("count", 10, 1, 50);
  const within = intFlag("close-within", 14, 1, 120);
  const rawSources =
    typeof flags.source === "string" ? flags.source.split(",").map((s) => s.trim().toLowerCase()) : ["all"];
  const sources: TournamentSource[] = rawSources.includes("all")
    ? [...TOURNAMENT_SOURCES]
    : rawSources.filter((s): s is TournamentSource => (TOURNAMENT_SOURCES as string[]).includes(s));
  if (!sources.length) throw new Error(`--source must be a comma list of: ${TOURNAMENT_SOURCES.join(" | ")} | all`);

  console.log(
    ansi.cyan(`🏆 tournament — importing up to ${count} open binary questions closing within ${within}d`) +
      ansi.gray(`  (${sources.join(", ")})`)
  );
  const candidates = await listClosingQuestions(cfg, sources, { withinDays: within, count: count * 3 }, undefined, (m) =>
    console.error(ansi.yellow(`  ${m}`))
  );
  // Idempotent batches: a question already in the ledger is never re-imported.
  const have = new Set(
    loadLedger()
      .map((e) => (e.origin ? `${e.origin.platform}:${e.origin.externalId}` : ""))
      .filter(Boolean)
  );
  const fresh = candidates.filter((q) => !have.has(`${q.platform}:${q.externalId}`)).slice(0, count);
  if (!fresh.length) {
    console.log(ansi.gray("no new questions in the window — already forecast, or nothing closing soon"));
    return;
  }
  for (const q of fresh) {
    console.log(
      `  ${ansi.gray(q.platform.padEnd(10))} closes ${q.closes} · market ${String(Math.round(q.probability * 100)).padStart(2)}%  ${clipLine(q.title, 78)}`
    );
  }
  if (flags["dry-run"]) {
    console.log(ansi.gray(`\n--dry-run: ${fresh.length} question(s) would be forecast`));
    return;
  }

  process.stdout.write(ansi.gray("validating API key… "));
  const auth = await validateAuth(cfg);
  if (auth.status === "invalid") {
    console.error(ansi.red(`\n✗ ${PROVIDERS[cfg.provider].label} key rejected: `) + (auth.message || "invalid key"));
    process.exit(1);
  }
  process.stdout.write(auth.status === "ok" ? ansi.green("ok\n") : ansi.gray("skipped\n"));

  let stopped = false;
  const onSig = () => {
    stopped = true; // execForeground's own handler cancels the in-flight run
  };
  process.on("SIGINT", onSig);
  let recorded = 0;
  for (const q of fresh) {
    if (stopped) break;
    const question: ForecastQuestion = {
      text: q.title.slice(0, 500),
      kind: "binary",
      resolutionCriteria: (
        `Resolves exactly as the source market resolves: ${q.url}` +
        (q.criteria ? ` — market rules: ${q.criteria}` : "")
      ).slice(0, 1000),
      resolutionDate: q.closes,
    };
    const meta = createRun({
      mission: `Forecast: ${q.title}`,
      cwd: process.cwd(),
      sandbox: true,
      options: optionsFromConfig(cfg, {
        // Tournament defaults: small cheap panels — volume over polish. Any
        // explicit flag (--panel/--budget/--model/...) wins over these. The
        // budget must survive a compact research wave + panel + red team;
        // 2M starved real runs before the panel ever spawned.
        maxTasks: Math.min(cfg.maxTasks, 16),
        maxTokens: Math.min(cfg.maxTokensPerRun, 4_000_000),
        ...(cfg.cheapModel ? { model: cfg.cheapModel } : {}),
        panelSize: 3,
        ...overrides,
        mode: "forecast",
        presetQuestion: question,
        forecastOrigin: {
          kind: "tournament",
          platform: q.platform,
          externalId: q.externalId,
          url: q.url,
          marketProbAtCreate: q.probability,
        },
      }),
    });
    console.log(`\n${ansi.cyan("forecasting")} ${ansi.gray(`[${q.platform}]`)} ${clipLine(q.title, 88)}`);
    try {
      await execForeground(cfg, meta, false);
    } catch (e) {
      console.error(ansi.red(`  run failed: ${errMsg(e)}`));
      continue;
    }
    const entry = loadLedger().find((e) => e.runId === meta.id);
    if (entry && typeof entry.aggregate.probability === "number") {
      const p = Math.round(entry.aggregate.probability * 100);
      const m = Math.round(q.probability * 100);
      console.log(
        `  ${ansi.green("✓")} swarm ${ansi.bold(`${p}%`)} vs market ${m}%  ${ansi.gray(`· ${entry.id} · resolves ${q.closes}`)}`
      );
      recorded++;
    } else {
      console.log(
        `  ${ansi.yellow("∅ no aggregate recorded")} ${ansi.gray(`(${meta.id} — usually the budget died before the panel; inspect with: swarm watch ${meta.id}, or raise --budget)`)}`
      );
    }
  }
  process.off("SIGINT", onSig);
  console.log(
    `\n${ansi.bold(String(recorded))} forecast(s) recorded — resolve once due: swarm resolve` +
      ansi.gray("  (cron-friendly batch: swarm tournament --auto)")
  );
  if (flags.auto && !stopped) {
    console.log(ansi.cyan("\n--auto: resolving past-due forecasts…"));
    await cmdResolve([]);
  }
}

async function cmdResolve(rest: string[]): Promise<void> {
  const cfg = loadConfig();
  if (rest[0] === "set") {
    const id = rest[1];
    const raw = rest.slice(2).join(" ");
    if (!id || !raw) throw new Error("usage: swarm resolve set <id> yes|no|void|never|<value>|<option>|<YYYY-MM-DD>");
    const entry = loadLedger().find((e) => e.id === id);
    if (!entry) throw new Error(`forecast not found: ${id}`);
    if (entry.resolution) throw new Error(`${id} is already resolved`);
    const kind = entry.question.kind;
    let outcome: 0 | 1 | number | string | "void";
    if (raw === "void") outcome = "void";
    else if (kind === "binary" && raw === "yes") outcome = 1;
    else if (kind === "binary" && raw === "no") outcome = 0;
    else if (kind === "numeric" && Number.isFinite(Number(raw))) outcome = Number(raw);
    else if (kind === "date" && raw === "never") outcome = "never";
    else if (kind === "date" && ISO_DATE.test(raw) && isoToDays(raw) !== null) outcome = isoToDays(raw)!;
    else if (kind === "mc") {
      const match = (entry.question.options ?? []).find((o) => o.trim().toLowerCase() === raw.trim().toLowerCase());
      if (!match) {
        throw new Error(`outcome must be void or one of the question's options: ${(entry.question.options ?? []).join(" | ")}`);
      }
      outcome = match;
    } else {
      const hint =
        kind === "numeric" ? "<number> | void" : kind === "date" ? "<YYYY-MM-DD> | never | void" : "yes | no | void";
      throw new Error(`outcome must be ${hint}`);
    }
    const rec = resolveLedgerEntry(entry, outcome, { evidence: "operator override", sources: [], resolvedBy: "operator" });
    console.log(
      ansi.green("✓ resolved ") + id + (rec.brier !== undefined ? ansi.gray(`  brier ${rec.brier.toFixed(3)}`) : "")
    );
    return;
  }
  console.log(ansi.cyan("resolving past-due forecasts…"));
  const result = await resolveDue(cfg, {
    log: (lvl, msg) => (lvl === "info" ? console.log(ansi.gray(`  ${msg}`)) : console.error(ansi.yellow(`  ${msg}`))),
  });
  if (!result.resolved.length && !result.skipped.length) {
    console.log(ansi.gray("nothing due. see open forecasts: swarm forecasts"));
    return;
  }
  for (const r of result.resolved) {
    const o = r.outcome === "void" ? "void" : r.outcome === 1 ? "YES" : r.outcome === 0 ? "NO" : String(r.outcome);
    console.log(
      `  ${ansi.green("✓")} ${ansi.gray(r.id)} → ${ansi.bold(o)}` +
        (r.brier !== undefined ? ansi.gray(`  brier ${r.brier.toFixed(3)}`) : "") +
        `  ${clipLine(r.question, 70)}`
    );
  }
  for (const s of result.skipped) {
    console.log(`  ${ansi.yellow("∅")} ${ansi.gray(s.id)} ${clipLine(s.question, 60)}\n    ${ansi.gray(s.reason)}`);
  }
}

function cmdCalibration(): void {
  const entries = loadLedger();
  const stats = calibrationStats(entries);
  if (!stats.n) {
    console.log(ansi.gray("no resolved binary forecasts yet — resolve some first: swarm resolve"));
    return;
  }
  console.log(ansi.bold("calibration") + ansi.gray(`  (${stats.n} resolved · mean Brier ${stats.brierMean.toFixed(3)} — 0.25 = "always 50%", lower is better)`));
  console.log(ansi.gray("  band        said   resolved YES   n"));
  for (const b of stats.bins) {
    const said = `${Math.round(b.meanP * 100)}%`.padStart(4);
    const hit = `${Math.round(b.hitRate * 100)}%`.padStart(6);
    console.log(`  ${`${b.lo * 100}–${b.hi * 100}%`.padEnd(11)} ${said}        ${hit}   ${b.n}`);
  }
  if (stats.mcBins.length) {
    console.log(ansi.bold("\nmc option calibration") + ansi.gray("  (per-option probabilities, separate base rate from binary)"));
    console.log(ansi.gray("  band        said   realized   n"));
    for (const b of stats.mcBins) {
      const said = `${Math.round(b.meanP * 100)}%`.padStart(4);
      const hit = `${Math.round(b.hitRate * 100)}%`.padStart(6);
      console.log(`  ${`${b.lo * 100}–${b.hi * 100}%`.padEnd(11)} ${said}    ${hit}   ${b.n}`);
    }
  }
  const methods = Object.entries(stats.byMethod).sort((a, b) => a[1].brierMean - b[1].brierMean);
  if (methods.length) {
    console.log(ansi.bold("\nby panel method") + ansi.gray("  (mean Brier per panelist method)"));
    for (const [m, s] of methods) console.log(`  ${m.padEnd(18)} ${s.brierMean.toFixed(3)}  ${ansi.gray(`n=${s.n}`)}`);
  }
}

/**
 * Replay the resolved ledger under each aggregation strategy — the proof (or
 * refutation) that each learned mechanism actually buys Brier. Deterministic,
 * no tokens: learned parameters are fitted out-of-fold so a strategy can't
 * grade its own homework.
 */
function cmdBacktest(): void {
  const ledger = loadLedger();
  const report = backtest(ledger);
  if (!report.rows.length) {
    console.log(
      ansi.gray("no resolved binary forecasts with panels to replay — grow the ledger first: swarm tournament, then swarm resolve")
    );
  } else {
    const n = report.rows[0].n;
    console.log(ansi.bold("backtest") + ansi.gray(`  (${n} resolved binary forecasts replayed; 95% CI by seeded bootstrap)`));
    console.log(ansi.gray("  strategy                                          brier   [95% CI]        log loss"));
    const best = Math.min(...report.rows.map((r) => r.brierMean));
    for (const r of report.rows) {
      const mark = r.brierMean === best ? ansi.green(" ◀ best") : "";
      console.log(
        `  ${r.config.padEnd(48)} ${r.brierMean.toFixed(4)}  [${r.brierLo.toFixed(4)}–${r.brierHi.toFixed(4)}]  ${r.logLossMean.toFixed(4)}${mark}`
      );
    }
    if (report.vsMarket) {
      const { n: vn, swarmBrier, marketBrier } = report.vsMarket;
      const verdict =
        swarmBrier < marketBrier
          ? ansi.green(`the swarm BEAT the market by ${(marketBrier - swarmBrier).toFixed(4)} Brier`)
          : ansi.yellow(`the market leads by ${(swarmBrier - marketBrier).toFixed(4)} Brier`);
      console.log(
        `\n  ${ansi.bold("vs market")} (tournament imports, n=${vn}): swarm ${swarmBrier.toFixed(4)} vs market-at-import ${marketBrier.toFixed(4)} — ${verdict}`
      );
    }
    const sk = report.skipped;
    if (sk.nonBinary || sk.noPanel) {
      console.log(ansi.gray(`\n  skipped: ${sk.nonBinary} non-binary, ${sk.noPanel} without a usable panel`));
    }
    console.log(ansi.gray("  note: 'published headline' is what the engine actually said at the time; the other rows re-derive."));
  }

  // Numeric/date interval calibration — graded by pinball, interval score, and
  // p10–p90 coverage (well-calibrated ≈ 0.80), same out-of-fold + bootstrap rigor.
  const num = backtestNumeric(ledger);
  if (num.rows.length) {
    const nn = num.rows[0].n;
    console.log(
      "\n" +
        ansi.bold("backtest (numeric/date)") +
        ansi.gray(`  (${nn} resolved interval forecasts replayed; pinball 95% CI by seeded bootstrap; coverage target ≈0.80)`)
    );
    console.log(ansi.gray("  strategy                                          pinball  [95% CI]            interval  cover"));
    const bestP = Math.min(...num.rows.map((r) => r.pinballMean));
    for (const r of num.rows) {
      const mark = r.pinballMean === bestP ? ansi.green(" ◀ best") : "";
      const note = r.learnedEqualsDefault ? ansi.gray(" (=default; needs ≥25 resolved)") : "";
      console.log(
        `  ${r.config.padEnd(48)} ${r.pinballMean.toFixed(4)} [${r.pinballLo.toFixed(4)}–${r.pinballHi.toFixed(4)}]  ${r.intervalMean.toFixed(3).padStart(9)}  ${r.coverage.toFixed(2)}${mark}${note}`
      );
    }
  } else if (report.rows.length) {
    console.log(
      ansi.gray(`\n  numeric/date: none resolved yet (${num.skipped.unresolved} unresolved) — interval tuning needs swarm resolve`)
    );
  }

  // Scenario-simulation coverage: did binary forecasts that ran the simulation
  // score differently from those that didn't? Descriptive only — questions vary
  // in difficulty, so this is not a causal sim-on/sim-off comparison.
  const sim = simulationLedgerSummary(ledger);
  if (sim.onN) {
    const fmt = (b: number | null) => (b === null ? "—" : b.toFixed(4));
    console.log(
      "\n" +
        ansi.bold("scenario simulation") +
        ansi.gray(`  (binary forecasts; sim-on=${sim.onN}, sim-off=${sim.offN} — descriptive, not causal)`)
    );
    console.log(`  sim-on  mean Brier: ${fmt(sim.onBrier)}   sim-off mean Brier: ${fmt(sim.offBrier)}`);
  }
}

// ---------------------------------------------------------------- config / models

async function cmdConfig(rest: string[], flags: Args["flags"]): Promise<void> {
  const sub = rest[0] || "list";
  if (sub === "list" || sub === "get") {
    const cfg = loadConfig();
    if (sub === "get" && rest[1]) {
      const key = rest[1] as keyof SwarmConfig;
      if (key === "providers") {
        // Nested per-provider creds — mask every apiKey, never dump raw.
        const masked = Object.fromEntries(
          Object.entries(cfg.providers ?? {}).map(([id, c]) => [
            id,
            { ...c, ...(c?.apiKey ? { apiKey: maskKey(c.apiKey) } : {}) },
          ])
        );
        console.log(JSON.stringify(masked, null, 2));
        return;
      }
      const v = isSecretConfigKey(key) ? maskKey(String(cfg[key] ?? "")) : cfg[key];
      console.log(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));
      return;
    }
    console.log(ansi.bold("config") + ansi.gray(`  (${configPath()})`));
    for (const k of SETTABLE_KEYS) {
      let v: unknown = cfg[k];
      // Every secret-bearing key prints masked — `config list` output ends up
      // in terminal scrollback and pasted bug reports.
      if (isSecretConfigKey(k)) {
        v = v ? maskKey(String(v)) : k === "apiKey" ? ansi.red("(not set)") : "(not set)";
      }
      console.log(`  ${k.padEnd(18)} ${ansi.gray(String(v))}`);
    }
    return;
  }
  if (sub === "set") {
    const key = rest[1] as keyof SwarmConfig;
    const value = rest.slice(2).join(" ");
    if (!key || value === "") throw new Error("usage: swarm config set <key> <value>");
    if (!SETTABLE_KEYS.includes(key)) {
      throw new Error(`unknown/settable keys: ${SETTABLE_KEYS.join(", ")}`);
    }
    const coerced = coerceConfigValue(key, value);
    if (key === "apiKey") {
      const k = String(coerced);
      if (k.includes("...") || k.includes("…") || k.length < 20) {
        throw new Error(
          `that doesn't look like a real API key (got ${k.length} chars). ` +
            `Paste the full key from your provider's console.`
        );
      }
    }
    saveConfig({ [key]: coerced } as Partial<SwarmConfig>);
    console.log(ansi.green("✓ ") + `set ${key}`);
    if (key === "apiKey") console.log(ansi.gray("  verify it works: ") + "swarm models");
    return;
  }
  if (sub === "unset") {
    const key = rest[1] as keyof SwarmConfig;
    if (!key) throw new Error("usage: swarm config unset <key>");
    if (!SETTABLE_KEYS.includes(key)) {
      throw new Error(`unknown key. Keys: ${SETTABLE_KEYS.join(", ")}`);
    }
    // apiKey/baseUrl route into the active provider's creds, so clearing
    // means writing "". Everything else is deleted from the file outright —
    // the default applies again (unset model:"" would brick every run).
    const cred = key === "apiKey" || key === "baseUrl";
    saveConfig({ [key]: cred ? "" : undefined } as Partial<SwarmConfig>);
    console.log(ansi.green("✓ ") + `cleared ${key}` + (cred ? "" : ansi.gray(" — default applies")));
    return;
  }
  if (sub === "path") {
    console.log(configPath());
    return;
  }
  throw new Error("usage: swarm config [list|get <key>|set <key> <value>|unset <key>|path]");
}

async function cmdModels(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.log(ansi.gray("known (priced) models:"));
    for (const m of Object.keys(cfg.pricing)) console.log("  " + m);
    console.log(ansi.gray("\nset an API key to list live models: swarm config set apiKey <sk-...>"));
    return;
  }
  try {
    const models = await listModels(cfg);
    console.log(ansi.bold("available models"));
    for (const m of models) {
      const priced = cfg.pricing[m] ? ansi.green(" priced") : "";
      console.log("  " + m + priced);
    }
  } catch (e) {
    console.error(ansi.red("could not list models: ") + errMsg(e));
  }
}

// ---------------------------------------------------------------- demo

async function cmdDemo(flags: Args["flags"]): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.apiKey && PROVIDERS[cfg.provider].keyRequired) {
    console.error(ansi.red("Demo needs an API key for the active provider. ") + "Run: swarm config set apiKey <...>");
    process.exit(1);
  }
  const mission =
    typeof flags.mission === "string"
      ? flags.mission
      : "Research the current state of open-weight agent-swarm systems (Kimi K2.6, others), then produce a concise comparison report with a recommendation for a developer wanting long-horizon autonomy on a budget. Save the report as comparison.md.";
  const meta = createRun({
    mission,
    cwd: process.cwd(),
    sandbox: true,
    options: optionsFromConfig(cfg, { maxWorkers: 4, maxTasks: 12, ...optionOverrides(flags, cfg) }),
  });
  console.log(ansi.cyan("running demo mission in an isolated workspace…\n"));
  await execForeground(cfg, meta, true);
}

// ---------------------------------------------------------------- shared

function resolveId(idOrPrefix: string): string {
  if (loadMeta(idOrPrefix)) return idOrPrefix;
  // allow short prefixes
  try {
    const dir = path.join(runDir(idOrPrefix), "..");
    const ids = fs.readdirSync(dir).filter((d) => d.startsWith(idOrPrefix));
    if (ids.length === 1) return ids[0];
  } catch {
    /* ignore */
  }
  return idOrPrefix;
}

function printFinalLine(id: string): void {
  const meta = loadMeta(id);
  if (!meta) return;
  const reportFile = path.join(runDir(id), "artifacts", "final-report.md");
  console.log("");
  if (fs.existsSync(reportFile)) {
    console.log(ansi.green("✓ final report: ") + reportFile);
    console.log(ansi.gray("  view: ") + `swarm report ${id}` + ansi.gray("  ·  open in browser: ") + `swarm report ${id} --open`);
  } else {
    console.log(ansi.gray(`run ${id} ended without a final report (see: swarm watch ${id})`));
  }
}

function clipLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return ansi.gray(t.length > n ? t.slice(0, n - 1) + "…" : t);
}

function printHelp(): void {
  const b = ansi.bold;
  console.log(`${b("agentswarm")} — a local agent swarm for long-horizon work (DeepSeek, OpenAI, Anthropic, Grok, MiniMax, OpenRouter, Ollama, LM Studio)

${b("USAGE")}
  swarm run "<mission>" [options]     decompose & execute a mission with a parallel swarm
  swarm forecast "<question>" [--by YYYY-MM-DD] [--panel N] [--single] [--simulate]
                                      forecast an event: research waves + an independent
                                      forecaster panel, aggregated into a calibrated probability.
                                      open-ended questions ("what will happen with X?") fan out
                                      into several resolvable sub-forecasts; --single forces one.
                                      --simulate runs a grounded scenario Monte Carlo (auto on
                                      decomposed questions): ranked scenarios + a driver tornado
  swarm serve [--port 7777] [--open]  start the mission-control web UI + API
  swarm watch <id>                    attach a live dashboard to a run
  swarm resume <id> [--fg]            resume an interrupted run (done tasks keep their results)
  swarm ls                            list runs
  swarm forecasts [watch] [--reforecast]
                                      list the forecast ledger; watch re-checks update triggers,
                                      --reforecast re-runs questions whose triggers fired (the new
                                      forecast supersedes the stale one in the ledger)
  swarm tournament [--count 10] [--close-within 14] [--source all] [--dry-run] [--auto]
                                      batch-forecast open market questions (Manifold/Polymarket/
                                      Kalshi/Metaculus) that close soon — grows the calibration
                                      ledger fast; the source platform supplies the resolution.
                                      --auto also resolves past-due forecasts (cron-friendly)
  swarm resolve [set <id> <outcome>]  resolve past-due forecasts & score them (Brier/log);
                                      set = operator override (yes|no|void|<value>)
  swarm calibration                   the system's track record: reliability table + per-method Brier
  swarm backtest                      replay the resolved ledger under each aggregation strategy
                                      (adaptive k, market anchor, recalibration — fitted out-of-fold)
                                      and report Brier deltas + the swarm-vs-market skill line
  swarm report <id> [--open]          print (or open) a run's final report
  swarm note <id> "<text>"            steer a live run (the conductor reads it)
  swarm cancel <id>                   stop a run gracefully (still synthesizes)
  swarm config [list|get|set ...]     manage config (~/.agentswarm/config.json)
  swarm sandbox [test|<runtime>]      show / smoke-test the shell runtime (host, docker, e2b, modal, vercel)
  swarm models                        list models from the active provider
  swarm demo                          run a self-contained demo mission

${b("RUN OPTIONS")}
  --workers N        max parallel agents (default ${loadConfig().maxWorkers})
  --steps N          max tool steps per task (default ${loadConfig().maxStepsPerTask})
  --tasks N          max total tasks (default ${loadConfig().maxTasks})
  --budget N         token budget for the whole run (default ${fmtTokens(loadConfig().maxTokensPerRun)})
  --model X          worker model (default ${loadConfig().model})
  --conductor X      conductor model (default ${loadConfig().conductorModel})
  --verify off|normal|strict   adversarial verification (default ${loadConfig().verification})
  --effort low|medium|high|max  reasoning effort (default ${loadConfig().reasoningEffort})
  --no-thinking      disable thinking mode
  --no-safe          disable command/path safety guards (careful)
  --sandbox X        shell runtime for this run: host | docker | e2b | modal | vercel | auto
                     (default ${loadConfig().sandboxRuntime}; host = isolated workspace, no install needed)
  --cwd <path>       run against a real directory (default: isolated workspace)
  --fg               run in the foreground in this process (Ctrl-C cancels)

${b("FIRST RUN")}
  swarm config set apiKey <key>             # key for the active provider (default: DeepSeek)
  swarm config set provider <id>            # deepseek | openai | anthropic | xai | minimax | openrouter | ollama | lmstudio | custom
  swarm serve --open                        # open the web UI
`);
}

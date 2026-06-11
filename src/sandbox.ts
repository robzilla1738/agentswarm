import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { SECRET_ENV_KEYS, SwarmConfig } from "./config";
import { SandboxRuntimeKind } from "./types";
import { ensureDir, errMsg } from "./util";

/**
 * Sandbox runtimes — where agent shell commands (and, for remote runtimes,
 * files) actually live.
 *
 *   host    workspace directory on this machine, no isolation (always works)
 *   docker  local Linux container per run; the run's workspace is bind-mounted
 *           so file tools stay on the host filesystem
 *   e2b     E2B cloud sandbox        (npm optional dep "e2b")
 *   modal   Modal cloud sandbox      (npm optional dep "modal")
 *   vercel  Vercel Sandbox           (npm optional dep "@vercel/sandbox")
 *
 * Cloud SDKs are loaded lazily via require() so the core engine keeps zero
 * hard runtime dependencies.
 */
export type SandboxKind = SandboxRuntimeKind;

export const SANDBOX_KINDS: SandboxKind[] = ["host", "docker", "e2b", "modal", "vercel"];

export interface ExecResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

export interface ExecOpts {
  /** Absolute path inside the runtime. Defaults to the runtime workdir. */
  cwd?: string;
  timeoutSec: number;
  signal?: AbortSignal;
}

export interface SandboxRuntime {
  readonly kind: SandboxKind;
  readonly label: string;
  /** Root working directory inside the runtime. */
  readonly workdir: string;
  /** True when files live on the host fs (host, docker bind-mount). */
  readonly localFs: boolean;
  start(log?: (msg: string) => void): Promise<void>;
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  /** Remote-fs file IO (only used when localFs is false). Paths are absolute inside the runtime. */
  readFile(abs: string): Promise<string>;
  writeFile(abs: string, content: string): Promise<void>;
  /** Copy a file out of the runtime onto the host (artifacts). */
  pull(remoteAbs: string, localAbs: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxInput {
  runId: string;
  /** Host workspace directory for this run (meta.cwd). */
  hostDir: string;
  cfg: SwarmConfig;
}

// ---------------------------------------------------------------- resolution

let dockerOk: boolean | null = null;

/** Is a container daemon actually reachable (not just the CLI installed)? */
export function dockerAvailable(refresh = false): boolean {
  if (dockerOk !== null && !refresh) return dockerOk;
  try {
    const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 8000, encoding: "utf8" });
    dockerOk = r.status === 0 && Boolean((r.stdout || "").trim());
  } catch {
    dockerOk = false;
  }
  return dockerOk;
}

/**
 * Resolve the configured runtime. The default config is "host" — the run's
 * isolated workspace on this machine, no sandbox required. "auto" is the
 * opt-in auto-detect: cloud sandboxes when configured (e2b → modal → vercel),
 * then a local container daemon, then the host.
 */
export function resolveSandboxKind(cfg: SwarmConfig): SandboxKind {
  if (cfg.sandboxRuntime !== "auto") return cfg.sandboxRuntime;
  if (cfg.e2bApiKey) return "e2b";
  if (cfg.modalTokenId && cfg.modalTokenSecret) return "modal";
  if (cfg.vercelToken) return "vercel";
  if (dockerAvailable()) return "docker";
  return "host";
}

export function createSandbox(kind: SandboxKind, input: SandboxInput): SandboxRuntime {
  switch (kind) {
    case "docker": return new DockerRuntime(input);
    case "e2b": return new E2BRuntime(input);
    case "modal": return new ModalRuntime(input);
    case "vercel": return new VercelRuntime(input);
    default: return new HostRuntime(input);
  }
}

/** Boot a runtime, run a hello command, tear down. Used by the hub's test endpoint. */
export async function testSandbox(cfg: SwarmConfig, kind: SandboxKind): Promise<{ ok: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "swarm-sbx-test-"));
  const rt = createSandbox(kind, { runId: `test_${Date.now().toString(36)}`, hostDir: dir, cfg });
  try {
    await rt.start();
    const r = await rt.exec("echo swarm-sandbox-ok && uname -a", { timeoutSec: 60 });
    if (r.code !== 0 || !r.out.includes("swarm-sandbox-ok")) {
      return { ok: false, detail: `command failed (exit ${r.code}): ${r.out.slice(0, 300)}` };
    }
    return { ok: true, detail: r.out.split("\n").filter(Boolean).slice(0, 2).join(" · ").slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  } finally {
    await rt.destroy().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tryRequire(name: string): any | null {
  try {
    // Optional cloud SDKs; absence is handled with a clear operator message.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(name);
  } catch {
    return null;
  }
}

function needSdk(pkg: string, provider: string): never {
  throw new Error(
    `The ${provider} sandbox needs the "${pkg}" package. Install it in the agentswarm folder: npm install ${pkg}`
  );
}

// ---------------------------------------------------------------- host

/** Run a command on the host (also used by docker via argv spawn). */
function spawnCollect(
  cmd: string,
  argv: string[],
  opts: { cwd?: string; shell?: string; timeoutSec: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      shell: opts.shell ?? false,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let bytes = 0;
    const CAP = 400_000;
    const grab = (b: Buffer) => {
      bytes += b.length;
      if (out.length < CAP) out += b.toString("utf8").slice(0, CAP - out.length);
    };
    child.stdout?.on("data", grab);
    child.stderr?.on("data", grab);

    let timedOut = false;
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutSec * 1000);
    const onAbort = () => killTree();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: -1, out: out + `\n[spawn error: ${e.message}]`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (bytes > CAP) out += `\n[output capped at ${CAP} bytes; ${bytes} produced]`;
      resolve({ code, out, timedOut });
    });
  });
}

class HostRuntime implements SandboxRuntime {
  readonly kind: SandboxKind = "host";
  readonly label = "host process";
  readonly localFs = true;
  readonly workdir: string;

  constructor(input: SandboxInput) {
    this.workdir = input.hostDir;
  }

  async start(): Promise<void> {
    ensureDir(this.workdir);
  }

  exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const env = { ...process.env };
    for (const k of SECRET_ENV_KEYS) delete env[k];
    return spawnCollect(command, [], {
      shell: "/bin/bash",
      cwd: opts.cwd ?? this.workdir,
      timeoutSec: opts.timeoutSec,
      signal: opts.signal,
      env,
    });
  }

  async readFile(abs: string): Promise<string> {
    return fs.readFileSync(abs, "utf8");
  }

  async writeFile(abs: string, content: string): Promise<void> {
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, "utf8");
  }

  async pull(remoteAbs: string, localAbs: string): Promise<void> {
    ensureDir(path.dirname(localAbs));
    fs.copyFileSync(remoteAbs, localAbs);
  }

  async destroy(): Promise<void> {
    /* nothing to tear down */
  }
}

// ---------------------------------------------------------------- docker

const CONTAINER_WORKDIR = "/workspace";

class DockerRuntime implements SandboxRuntime {
  readonly kind: SandboxKind = "docker";
  readonly localFs = true;
  readonly workdir: string;
  private name: string;
  private image: string;

  constructor(private input: SandboxInput) {
    // File tools keep using the host path — the bind mount makes both views
    // of the workspace identical.
    this.workdir = input.hostDir;
    this.name = `swarm-sbx-${input.runId.replace(/[^a-zA-Z0-9_.-]/g, "")}`;
    this.image = input.cfg.sandboxImage || "node:22-bookworm";
  }

  get label(): string {
    return `docker container (${this.image})`;
  }

  /** Map a host path under the workspace to its in-container path. */
  private containerPath(hostAbs: string): string {
    const rel = path.relative(this.workdir, hostAbs);
    if (rel === "" || rel === ".") return CONTAINER_WORKDIR;
    if (rel.startsWith("..")) return CONTAINER_WORKDIR; // outside the mount — stay home
    return path.posix.join(CONTAINER_WORKDIR, rel.split(path.sep).join("/"));
  }

  async start(log?: (msg: string) => void): Promise<void> {
    if (!dockerAvailable(true)) {
      throw new Error(
        "Docker daemon is not reachable. Start Docker Desktop / OrbStack / Colima, " +
          "or set the sandbox runtime to a cloud provider or host in Settings."
      );
    }
    ensureDir(this.workdir);
    spawnSync("docker", ["rm", "-f", this.name], { timeout: 20000 });
    // Pull explicitly first so a cold image doesn't eat the run's first command.
    const have = spawnSync("docker", ["image", "inspect", this.image], { timeout: 15000 });
    if (have.status !== 0) {
      log?.(`docker: pulling ${this.image} (first time only)…`);
      const pull = spawnSync("docker", ["pull", this.image], { timeout: 600_000, encoding: "utf8" });
      if (pull.status !== 0) throw new Error(`docker pull ${this.image} failed: ${(pull.stderr || "").slice(0, 300)}`);
    }
    const run = spawnSync(
      "docker",
      [
        "run", "-d", "--init", "--name", this.name,
        "--memory", "4g", "--cpus", "4", "--pids-limit", "1024",
        "-v", `${this.workdir}:${CONTAINER_WORKDIR}`,
        "-w", CONTAINER_WORKDIR,
        this.image, "sleep", "infinity",
      ],
      { timeout: 60_000, encoding: "utf8" }
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || "").slice(0, 400)}`);
    log?.(`docker: container ${this.name} up (${this.image})`);
  }

  exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const cwd = this.containerPath(opts.cwd ?? this.workdir);
    // In-container `timeout` guards against the docker CLI dying while the
    // process inside lives on; the outer watchdog guards the CLI itself.
    return spawnCollect(
      "docker",
      ["exec", "-w", cwd, this.name, "timeout", "-k", "5", String(opts.timeoutSec), "bash", "-lc", command],
      { timeoutSec: opts.timeoutSec + 15, signal: opts.signal }
    ).then((r) => (r.code === 124 ? { ...r, timedOut: true } : r));
  }

  async readFile(abs: string): Promise<string> {
    return fs.readFileSync(abs, "utf8");
  }

  async writeFile(abs: string, content: string): Promise<void> {
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, "utf8");
  }

  async pull(remoteAbs: string, localAbs: string): Promise<void> {
    ensureDir(path.dirname(localAbs));
    fs.copyFileSync(remoteAbs, localAbs);
  }

  async destroy(): Promise<void> {
    spawnSync("docker", ["rm", "-f", this.name], { timeout: 30_000 });
  }
}

// ---------------------------------------------------------------- remote base

/**
 * Remote sandboxes share exec-based file IO (base64 over the shell) so every
 * provider gets correct read/write/pull even where the SDK lacks a files API.
 * Chunked to stay under argv limits.
 */
abstract class RemoteRuntime implements SandboxRuntime {
  abstract readonly kind: SandboxKind;
  abstract readonly label: string;
  abstract readonly workdir: string;
  readonly localFs = false;

  abstract start(log?: (msg: string) => void): Promise<void>;
  abstract exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  abstract destroy(): Promise<void>;

  private async execOk(command: string, what: string): Promise<string> {
    const r = await this.exec(command, { timeoutSec: 120 });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.out.slice(0, 300)}`);
    return r.out;
  }

  /** base64-over-shell transfers buffer the whole file — refuse the huge ones. */
  private async checkSize(abs: string, capBytes: number, what: string): Promise<void> {
    const out = await this.execOk(`wc -c < ${shq(abs)}`, `stat ${abs}`);
    const size = Number(out.trim());
    if (Number.isFinite(size) && size > capBytes) {
      throw new Error(
        `${what}: file is ${Math.round(size / 1e6)}MB (cap ${Math.round(capBytes / 1e6)}MB) — ` +
          `compress it or extract the relevant part in the sandbox first`
      );
    }
  }

  async readFile(abs: string): Promise<string> {
    await this.checkSize(abs, 4_000_000, `read ${abs}`);
    const out = await this.execOk(`base64 < ${shq(abs)}`, `read ${abs}`);
    return Buffer.from(out.replace(/\s+/g, ""), "base64").toString("utf8");
  }

  async writeFile(abs: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dir = path.posix.dirname(abs);
    await this.execOk(`mkdir -p ${shq(dir)} && : > ${shq(abs)}`, `create ${abs}`);
    const CHUNK = 60_000;
    for (let i = 0; i < b64.length || i === 0; i += CHUNK) {
      const part = b64.slice(i, i + CHUNK);
      await this.execOk(`printf %s ${shq(part)} | base64 -d >> ${shq(abs)}`, `write ${abs}`);
      if (b64.length === 0) break;
    }
  }

  async pull(remoteAbs: string, localAbs: string): Promise<void> {
    await this.checkSize(remoteAbs, 32_000_000, `pull ${remoteAbs}`);
    const out = await this.execOk(`base64 < ${shq(remoteAbs)}`, `pull ${remoteAbs}`);
    ensureDir(path.dirname(localAbs));
    fs.writeFileSync(localAbs, Buffer.from(out.replace(/\s+/g, ""), "base64"));
  }
}

/** POSIX single-quote escaping. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- e2b

class E2BRuntime extends RemoteRuntime {
  readonly kind: SandboxKind = "e2b";
  readonly workdir = "/home/user/workspace";
  private sbx: any = null;
  private template: string;

  constructor(private input: SandboxInput) {
    super();
    this.template = input.cfg.e2bTemplate || "base";
  }

  get label(): string {
    return `E2B cloud sandbox (${this.template})`;
  }

  async start(log?: (msg: string) => void): Promise<void> {
    const mod = tryRequire("e2b") ?? needSdk("e2b", "E2B");
    const Sandbox = mod.Sandbox ?? mod.default;
    this.sbx = await Sandbox.create(this.template, {
      apiKey: this.input.cfg.e2bApiKey || process.env.E2B_API_KEY,
      timeoutMs: 3_600_000,
    });
    // The workdir doesn't exist yet — run the bootstrap from a dir that does.
    await this.exec(`mkdir -p ${shq(this.workdir)}`, { timeoutSec: 30, cwd: "/home/user" });
    log?.(`e2b: sandbox ${this.sbx.sandboxId ?? ""} up`);
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    if (!this.sbx) throw new Error("e2b sandbox not started");
    // Keep the sandbox alive as long as the run keeps working.
    this.sbx.setTimeout?.(3_600_000)?.catch?.(() => {});
    const cwd = opts.cwd ?? this.workdir;
    try {
      const r = await this.sbx.commands.run(command, {
        cwd,
        timeoutMs: opts.timeoutSec * 1000,
      });
      return { code: r.exitCode ?? 0, out: joinOut(r.stdout, r.stderr), timedOut: false };
    } catch (e: any) {
      // Non-zero exits surface as CommandExitError carrying the result.
      if (e && typeof e.exitCode === "number") {
        return { code: e.exitCode, out: joinOut(e.stdout, e.stderr) || errMsg(e), timedOut: false };
      }
      const timedOut = /timeout|timed out/i.test(errMsg(e));
      return { code: -1, out: errMsg(e), timedOut };
    }
  }

  async destroy(): Promise<void> {
    await this.sbx?.kill?.().catch?.(() => {});
    this.sbx = null;
  }
}

// ---------------------------------------------------------------- modal

class ModalRuntime extends RemoteRuntime {
  readonly kind: SandboxKind = "modal";
  readonly workdir = "/workspace";
  private sb: any = null;
  private image: string;

  constructor(private input: SandboxInput) {
    super();
    this.image = input.cfg.sandboxImage || "node:22-bookworm";
  }

  get label(): string {
    return `Modal cloud sandbox (${this.image})`;
  }

  async start(log?: (msg: string) => void): Promise<void> {
    const mod = tryRequire("modal") ?? needSdk("modal", "Modal");
    const { cfg } = this.input;
    if (cfg.modalTokenId) process.env.MODAL_TOKEN_ID = cfg.modalTokenId;
    if (cfg.modalTokenSecret) process.env.MODAL_TOKEN_SECRET = cfg.modalTokenSecret;
    const ModalClient = mod.ModalClient ?? mod.default?.ModalClient;
    const client = ModalClient ? new ModalClient() : mod;
    const app = await client.apps.fromName("agentswarm", { createIfMissing: true });
    const image = client.images.fromRegistry(this.image);
    try {
      this.sb = await client.sandboxes.create(app, image, { timeout: 3_600_000 });
    } catch {
      this.sb = await client.sandboxes.create(app, image);
    }
    await this.exec(`mkdir -p ${shq(this.workdir)}`, { timeoutSec: 60, cwd: "/" });
    log?.(`modal: sandbox up (${this.image})`);
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    if (!this.sb) throw new Error("modal sandbox not started");
    const cwd = opts.cwd ?? this.workdir;
    try {
      const p = await this.sb.exec(["bash", "-lc", `cd ${shq(cwd)} 2>/dev/null; ${command}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timed out after ${opts.timeoutSec}s`)), opts.timeoutSec * 1000)
      );
      const result = (async () => {
        const [so, se] = await Promise.all([p.stdout.readText(), p.stderr.readText()]);
        const code = await p.wait();
        return { code, out: joinOut(so, se), timedOut: false };
      })();
      return await Promise.race([result, timer]);
    } catch (e) {
      const timedOut = /timed out/i.test(errMsg(e));
      return { code: -1, out: errMsg(e), timedOut };
    }
  }

  async destroy(): Promise<void> {
    await this.sb?.terminate?.().catch?.(() => {});
    this.sb = null;
  }
}

// ---------------------------------------------------------------- vercel

class VercelRuntime extends RemoteRuntime {
  readonly kind: SandboxKind = "vercel";
  readonly workdir = "/vercel/sandbox";
  private sb: any = null;

  constructor(private input: SandboxInput) {
    super();
  }

  get label(): string {
    return "Vercel sandbox (node22)";
  }

  async start(log?: (msg: string) => void): Promise<void> {
    const mod = tryRequire("@vercel/sandbox") ?? needSdk("@vercel/sandbox", "Vercel");
    const Sandbox = mod.Sandbox ?? mod.default;
    const { cfg } = this.input;
    this.sb = await Sandbox.create({
      ...(cfg.vercelToken ? { token: cfg.vercelToken } : {}),
      ...(cfg.vercelTeamId ? { teamId: cfg.vercelTeamId } : {}),
      ...(cfg.vercelProjectId ? { projectId: cfg.vercelProjectId } : {}),
      runtime: "node22",
      timeout: 2_700_000, // 45 min; extended implicitly by activity on paid plans
    });
    log?.("vercel: sandbox up (node22)");
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    if (!this.sb) throw new Error("vercel sandbox not started");
    const cwd = opts.cwd ?? this.workdir;
    try {
      const timer = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timed out after ${opts.timeoutSec}s`)), opts.timeoutSec * 1000)
      );
      const result = (async () => {
        const done = await this.sb.runCommand({
          cmd: "bash",
          args: ["-lc", `cd ${shq(cwd)} 2>/dev/null; ${command}`],
        });
        const [so, se] = await Promise.all([
          typeof done.stdout === "function" ? done.stdout() : done.stdout,
          typeof done.stderr === "function" ? done.stderr() : done.stderr,
        ]);
        return { code: done.exitCode ?? 0, out: joinOut(so, se), timedOut: false };
      })();
      return await Promise.race([result, timer]);
    } catch (e) {
      const timedOut = /timed out/i.test(errMsg(e));
      return { code: -1, out: errMsg(e), timedOut };
    }
  }

  async destroy(): Promise<void> {
    await this.sb?.stop?.().catch?.(() => {});
    this.sb = null;
  }
}

function joinOut(stdout: unknown, stderr: unknown): string {
  const a = typeof stdout === "string" ? stdout : "";
  const b = typeof stderr === "string" ? stderr : "";
  return [a, b].filter(Boolean).join(b && a && !a.endsWith("\n") ? "\n" : "");
}

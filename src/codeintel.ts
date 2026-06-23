import type { SandboxRuntime } from "./sandbox";
import { CodeCommands, RepoProfile } from "./types";

/**
 * Code mode's deterministic repo intelligence: detect how a working directory
 * actually builds and tests itself, parse check output into compact signals,
 * and own the git commit-on-green primitive. Pure where possible; the few
 * functions that touch the filesystem go through the sandbox's `exec` so they
 * work identically on host / docker / cloud runtimes. None of them ever throw —
 * recon failure must degrade a field to null, never fail the run.
 */

type Exec = SandboxRuntime["exec"];

const SENTINEL = "@@AGENTSWARM@@";

/** The raw manifest text reconRepo collected, fed to the pure detectCommands(). */
export interface RepoManifests {
  packageJson?: string;
  pyproject?: string;
  cargo?: string;
  gomod?: string;
  makefile?: string;
  lockfiles: string[];
}

const GREENFIELD_PROFILE: RepoProfile = {
  greenfield: true,
  primaryLanguage: null,
  packageManager: null,
  framework: null,
  commands: {},
  monorepo: { tool: null, packages: [] },
  git: { isRepo: false, branch: null, dirty: false },
  conventions: [],
  manifestFiles: [],
};

/** Dotfiles / boilerplate that don't make a directory "non-empty" for recon purposes. */
const TRIVIAL = new Set(["readme.md", "readme", "license", "license.md", ".gitignore", ".git", ".ds_store"]);

/** Is this directory effectively empty (greenfield) — only dotfiles / README / LICENSE? */
export function looksGreenfield(entries: string[]): boolean {
  return entries.every((e) => e.startsWith(".") || TRIVIAL.has(e.toLowerCase()));
}

/**
 * One batched probe of the working directory (a single `exec` round-trip, not a
 * serial sequence — a cold cloud sandbox adds one call, not eight). Returns a
 * RepoProfile; any probe failure degrades its field rather than throwing.
 */
export async function reconRepo(exec: Exec, workdir: string, signal: AbortSignal): Promise<RepoProfile> {
  const sec = (name: string) => `printf '%s\\n' "${SENTINEL}${name}"`;
  const probe = [
    sec("LS"), "ls -A 2>/dev/null",
    sec("GITREPO"), "git rev-parse --is-inside-work-tree 2>/dev/null",
    sec("GITBRANCH"), "git rev-parse --abbrev-ref HEAD 2>/dev/null",
    sec("GITDIRTY"), "git status --porcelain 2>/dev/null | head -5",
    sec("PKG"), "cat package.json 2>/dev/null",
    sec("PYPROJECT"), "cat pyproject.toml 2>/dev/null",
    sec("CARGO"), "cat Cargo.toml 2>/dev/null",
    sec("GOMOD"), "cat go.mod 2>/dev/null",
    sec("MAKEFILE"), "head -80 Makefile 2>/dev/null",
    sec("LOCK"), "ls package-lock.json yarn.lock pnpm-lock.yaml bun.lockb 2>/dev/null",
    sec("END"),
  ].join(" ; ");

  let out = "";
  try {
    const r = await exec(probe, { cwd: workdir, timeoutSec: 30, signal });
    out = r.out ?? "";
  } catch {
    return { ...GREENFIELD_PROFILE, greenfield: false }; // recon failed, but the dir isn't necessarily empty
  }

  const sections = splitSections(out);
  const entries = lines(sections.LS);
  if (looksGreenfield(entries)) return { ...GREENFIELD_PROFILE };

  const manifests: RepoManifests = {
    packageJson: sections.PKG?.trim() || undefined,
    pyproject: sections.PYPROJECT?.trim() || undefined,
    cargo: sections.CARGO?.trim() || undefined,
    gomod: sections.GOMOD?.trim() || undefined,
    makefile: sections.MAKEFILE?.trim() || undefined,
    lockfiles: lines(sections.LOCK),
  };

  const isRepo = /true/.test(sections.GITREPO ?? "");
  const branch = isRepo ? (lines(sections.GITBRANCH)[0] || null) : null;
  const dirty = isRepo && Boolean((sections.GITDIRTY ?? "").trim());

  const manifestFiles = [
    manifests.packageJson && "package.json",
    manifests.pyproject && "pyproject.toml",
    manifests.cargo && "Cargo.toml",
    manifests.gomod && "go.mod",
    manifests.makefile && "Makefile",
  ].filter(Boolean) as string[];

  return {
    greenfield: false,
    primaryLanguage: detectLanguage(manifests),
    packageManager: detectPackageManager(manifests),
    framework: detectFramework(manifests),
    commands: detectCommands(manifests),
    monorepo: detectMonorepo(manifests),
    git: { isRepo, branch, dirty },
    conventions: detectConventions(manifests),
    manifestFiles,
  };
}

function splitSections(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  const parts = out.split(SENTINEL);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const name = part.slice(0, nl).trim();
    if (name) map[name] = part.slice(nl + 1);
  }
  return map;
}

function lines(s: string | undefined): string[] {
  return (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Watch/dev-server scripts never terminate — they can't be a build/test gate.
 * dev/serve/start only match as an actual command (line start or after &&/;/|),
 * so a build like "vite build" or a path like "serve-dist" is NOT falsely rejected.
 */
const NON_TERMINATING =
  /--watch\b|\bnodemon\b|\bwebpack-dev-server\b|(?:^|&&|;|\|)\s*(?:next\s+dev|serve|http-server|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve))(?:\s|$)/i;

function parsePackageJson(raw: string | undefined): { scripts: Record<string, string>; deps: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
    return {
      scripts: obj.scripts && typeof obj.scripts === "object" ? obj.scripts : {},
      deps: JSON.stringify(obj.dependencies ?? {}) + JSON.stringify(obj.devDependencies ?? {}),
    };
  } catch {
    return null;
  }
}

function detectPackageManager(m: RepoManifests): string | null {
  if (!m.packageJson) return null;
  const lf = m.lockfiles.join(" ");
  if (/pnpm-lock\.yaml/.test(lf)) return "pnpm";
  if (/yarn\.lock/.test(lf)) return "yarn";
  if (/bun\.lockb/.test(lf)) return "bun";
  return "npm";
}

/**
 * Pure: the repo's real build/test/typecheck/lint/install commands. JS reads
 * package.json scripts (skipping non-terminating ones); otherwise language
 * heuristics. A field is omitted when nothing trustworthy is detected.
 */
export function detectCommands(m: RepoManifests): CodeCommands {
  const cmds: CodeCommands = {};
  const pkg = parsePackageJson(m.packageJson);
  if (pkg) {
    const pm = detectPackageManager(m) ?? "npm";
    const runnable = (name: string): string | undefined => {
      const v = pkg.scripts[name];
      if (!v || NON_TERMINATING.test(v)) return undefined;
      return `${pm} run ${name}`;
    };
    cmds.install = m.lockfiles.some((l) => /package-lock\.json/.test(l)) && pm === "npm" ? "npm ci" : `${pm} install`;
    cmds.build = runnable("build");
    cmds.test = runnable("test") ?? (pkg.scripts.test && !NON_TERMINATING.test(pkg.scripts.test) ? `${pm} test` : undefined);
    cmds.typecheck =
      runnable("typecheck") ??
      runnable("tsc") ??
      (/"typescript"/.test(m.packageJson ?? "") || /typescript/.test(pkg.deps) ? "npx tsc --noEmit" : undefined);
    cmds.lint = runnable("lint");
    return cmds;
  }
  if (m.cargo) {
    return { build: "cargo build", test: "cargo test", typecheck: "cargo check", lint: "cargo clippy -- -D warnings" };
  }
  if (m.gomod) {
    return { build: "go build ./...", test: "go test ./...", typecheck: "go vet ./..." };
  }
  if (m.pyproject) {
    const p = m.pyproject;
    cmds.install = "pip install -e .";
    cmds.test = "python -m pytest -q";
    if (/mypy/.test(p)) cmds.typecheck = "mypy .";
    if (/\bruff\b/.test(p)) cmds.lint = "ruff check .";
    else if (/flake8/.test(p)) cmds.lint = "flake8";
    return cmds;
  }
  if (m.makefile) {
    const mk = m.makefile;
    if (/^build\s*:/m.test(mk)) cmds.build = "make build";
    if (/^test\s*:/m.test(mk)) cmds.test = "make test";
    if (/^lint\s*:/m.test(mk)) cmds.lint = "make lint";
    if (/^(typecheck|check)\s*:/m.test(mk)) cmds.typecheck = "make check";
    return cmds;
  }
  return cmds;
}

function detectLanguage(m: RepoManifests): string | null {
  if (m.packageJson) return /"typescript"/.test(m.packageJson) ? "TypeScript" : "JavaScript";
  if (m.cargo) return "Rust";
  if (m.gomod) return "Go";
  if (m.pyproject) return "Python";
  return null;
}

function detectFramework(m: RepoManifests): string | null {
  const p = m.packageJson ?? "";
  if (/"next"/.test(p)) return "Next.js";
  if (/"react"/.test(p)) return "React";
  if (/"vue"/.test(p)) return "Vue";
  if (/"svelte"/.test(p)) return "Svelte";
  if (/"express"/.test(p)) return "Express";
  if (/"@nestjs\/core"/.test(p)) return "NestJS";
  if (/"fastify"/.test(p)) return "Fastify";
  if (m.pyproject && /django/i.test(m.pyproject)) return "Django";
  if (m.pyproject && /fastapi/i.test(m.pyproject)) return "FastAPI";
  return null;
}

function detectMonorepo(m: RepoManifests): { tool: string | null; packages: string[] } {
  const p = m.packageJson ?? "";
  if (/"workspaces"/.test(p)) return { tool: "npm-workspaces", packages: [] };
  if (m.lockfiles.some((l) => /pnpm-lock/.test(l)) && /"workspaces"|packages:/.test(p)) return { tool: "pnpm", packages: [] };
  if (/"turbo"/.test(p)) return { tool: "turborepo", packages: [] };
  if (/"nx"/.test(p)) return { tool: "nx", packages: [] };
  return { tool: null, packages: [] };
}

function detectConventions(m: RepoManifests): string[] {
  const out: string[] = [];
  const p = m.packageJson ?? "";
  if (/"prettier"/.test(p)) out.push("formatted with prettier");
  if (/"eslint"/.test(p)) out.push("linted with eslint");
  if (/"typescript"/.test(p)) out.push("TypeScript — keep the tree type-clean (tsc --noEmit)");
  if (/"jest"/.test(p)) out.push("tests in jest");
  else if (/"vitest"/.test(p)) out.push("tests in vitest");
  if (m.cargo && /clippy/.test(m.cargo)) out.push("clippy-clean");
  return out;
}

// ---------------------------------------------------------------- check output

/**
 * Pure: distill a check's raw log into a compact signal — pass/fail, counts,
 * and the first few failures — so a worker spends one step on a verdict, not
 * twenty re-reading a truncated test log.
 */
export function parseCheckOutput(
  check: keyof CodeCommands,
  raw: string,
  exitCode: number | null
): { pass: boolean; failed: number; total: number; firstFailures: string[] } {
  const text = raw ?? "";
  const ok = exitCode === 0;
  const ls = text.split("\n");

  if (check === "typecheck") {
    const errs = ls.filter((l) => /error TS\d+|: error:|error\[/.test(l));
    return { pass: ok && errs.length === 0, failed: errs.length, total: errs.length, firstFailures: errs.slice(0, 5) };
  }

  if (check === "test") {
    // jest/vitest: "Tests: 3 failed, 139 passed, 142 total"; pytest: "3 failed, 139 passed"; cargo/go too.
    let failed = num(text, /(\d+)\s+failed/i);
    const passed = num(text, /(\d+)\s+passed/i);
    const totalM = num(text, /(\d+)\s+total/i);
    const total = totalM || (passed != null || failed != null ? (passed ?? 0) + (failed ?? 0) : 0);
    if (failed == null) failed = ok ? 0 : Math.max(1, countErrors(ls));
    const noTests = total === 0 && (/no tests? (ran|found|collected)|0 passed|collected 0 items/i.test(text) || (ok && passed == null));
    const failures = ls.filter((l) => /✕|✗|FAIL(ED)?\b|\bfailed\b|panicked|AssertionError|Error:/.test(l)).slice(0, 5);
    return {
      pass: ok && (failed ?? 0) === 0 && !noTests,
      failed: failed ?? 0,
      total,
      firstFailures: noTests ? ["no tests ran — establish a test command / add tests", ...failures] : failures,
    };
  }

  if (check === "lint") {
    const errors = num(text, /(\d+)\s+error/i) ?? (ok ? 0 : countErrors(ls));
    const problems = num(text, /(\d+)\s+problem/i) ?? errors;
    const failures = ls.filter((l) => /error|warning/i.test(l)).slice(0, 5);
    return { pass: ok && errors === 0, failed: errors, total: problems, firstFailures: failures };
  }

  // build / install: exit code is the source of truth; collect first error lines.
  const errLines = ls.filter((l) => /error|fail|cannot|unresolved|undefined reference/i.test(l)).slice(0, 5);
  const failed = ok ? 0 : Math.max(1, errLines.length);
  return { pass: ok, failed, total: failed, firstFailures: errLines };
}

function num(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

function countErrors(ls: string[]): number {
  return ls.filter((l) => /\berror\b/i.test(l)).length;
}

/** Compact one-line-plus-failures rendering for the run_check tool result. */
export function formatCheckResult(
  check: keyof CodeCommands,
  command: string,
  r: ReturnType<typeof parseCheckOutput>,
  durSec: string
): string {
  const head = r.pass
    ? `PASS ${check} (${command}) ${r.total ? `${r.total - r.failed}/${r.total}` : ""} in ${durSec}s`.trim()
    : `FAIL ${check} (${command}) ${r.total ? `${r.failed}/${r.total} failing` : `exit nonzero`} in ${durSec}s`;
  return r.firstFailures.length ? `${head}\n${r.firstFailures.map((f) => `  ${f}`).join("\n")}` : head;
}

// ---------------------------------------------------------------- git

const GIT_ID = `-c user.name=agentswarm -c user.email=swarm@agentswarm.local -c commit.gpgsign=false`;

function shArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decide whether (and on which branch) the engine may commit-on-green, applying
 * the three-tier brownfield safety. Never pushes, force-pushes, or resets.
 *
 *   sandbox / non-repo host cwd → git init if needed; commit-on-green ON.
 *   real host repo             → checkout swarm/<runid>; REFUSE if the tree is
 *                                dirty (the run still proceeds, just no commits).
 */
export async function gitPrepare(
  exec: Exec,
  workdir: string,
  opts: { isSandbox: boolean; runId: string; signal: AbortSignal }
): Promise<{ ok: boolean; branch: string | null; reason?: string }> {
  const run = (cmd: string) => exec(cmd, { cwd: workdir, timeoutSec: 30, signal: opts.signal });
  try {
    const repo = await run("git rev-parse --is-inside-work-tree 2>/dev/null");
    const isRepo = /true/.test(repo.out ?? "");
    if (!isRepo) {
      // Never silently turn the operator's non-git directory into a repo and
      // commit their whole tree. Auto-init only a sandbox workspace or a
      // genuinely empty host directory; otherwise refuse (the run still proceeds).
      if (!opts.isSandbox) {
        const lsr = await run("ls -A 2>/dev/null");
        const entries = (lsr.out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        if (!looksGreenfield(entries)) {
          return { ok: false, branch: null, reason: "non-empty non-git directory — run `git init` first to enable commit-on-green" };
        }
      }
      const init = await run(`git ${GIT_ID} init -q && git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "agentswarm: baseline" --allow-empty`);
      if (init.code !== 0) return { ok: false, branch: null, reason: `git init failed: ${oneLine(init.out)}` };
      const br = await run("git rev-parse --abbrev-ref HEAD 2>/dev/null");
      return { ok: true, branch: lines(br.out)[0] || null };
    }
    // Existing repo. On the operator's real directory, never touch a dirty tree.
    if (!opts.isSandbox) {
      const dirty = await run("git status --porcelain 2>/dev/null | head -1");
      if ((dirty.out ?? "").trim()) {
        return { ok: false, branch: null, reason: "working tree has uncommitted changes — auto-commit disabled (commit or stash to enable)" };
      }
    }
    const branch = `swarm/${opts.runId}`;
    const co = await run(`git ${GIT_ID} checkout -B ${shArg(branch)} 2>&1`);
    if (co.code !== 0) return { ok: false, branch: null, reason: `could not create work branch: ${oneLine(co.out)}` };
    return { ok: true, branch };
  } catch (e) {
    return { ok: false, branch: null, reason: `git unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Commit the current tree (commit-on-green). Returns the new SHA, or null if
 * there was nothing to commit. Uses a fixed swarm identity (never the
 * operator's git config) and never resets or pushes.
 */
export async function gitCommitGreen(exec: Exec, workdir: string, message: string, signal: AbortSignal): Promise<string | null> {
  const run = (cmd: string) => exec(cmd, { cwd: workdir, timeoutSec: 60, signal });
  try {
    const add = await run(`git ${GIT_ID} add -A`);
    if (add.code !== 0) return null;
    const status = await run("git status --porcelain 2>/dev/null | head -1");
    if (!(status.out ?? "").trim()) return null; // nothing staged → no empty commit
    const commit = await run(`git ${GIT_ID} commit -q --no-verify -m ${shArg(message.slice(0, 200))}`);
    if (commit.code !== 0) return null;
    const sha = await run("git rev-parse --short HEAD 2>/dev/null");
    return lines(sha.out)[0] || null;
  } catch {
    return null;
  }
}

/** Hard-reset the working tree to a known-green commit (resume). SANDBOX-ONLY — never call on the operator's real directory. */
export async function gitResetTo(exec: Exec, workdir: string, sha: string, signal: AbortSignal): Promise<boolean> {
  try {
    const r = await exec(`git ${GIT_ID} reset --hard ${shArg(sha)}`, { cwd: workdir, timeoutSec: 30, signal });
    return r.code === 0;
  } catch {
    return false;
  }
}

function oneLine(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

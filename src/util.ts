import * as fs from "fs";
import * as path from "path";

// ---------- ids / time ----------

let ridCounter = 0;
export function rid(prefix: string): string {
  ridCounter = (ridCounter + 1) % 1296;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
  const c = ridCounter.toString(36).padStart(2, "0");
  return `${prefix}_${t}${r}${c}`;
}

/** Resolves after ms; rejects early if the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A timeout signal, combined with the caller's signal when one is given. */
export function mergeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!signal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([t, signal]) : signal;
}

// ---------- strings ----------

export function truncateMiddle(s: string, max: number, label = "bytes"): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return (
    s.slice(0, head) +
    `\n…[truncated ${s.length - max} ${label}]…\n` +
    s.slice(s.length - tail)
  );
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export function oneLine(s: string, max = 140): string {
  return clip(s.replace(/\s+/g, " ").trim(), max);
}

/** The one HTML escaper — every string interpolated into generated HTML goes through here. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Canonicalize an artifact name an agent reported. Agents narrate the same
 * file as "gpt-timeline.md", "artifacts/gpt-timeline.md", "workspace/…", "./…"
 * or an absolute path into the run dir — all must resolve to the name
 * save_artifact registered, or the mechanical verifier flunks real work.
 */
export function canonicalArtifactRel(raw: string, artifactsDir: string, cwd: string): string {
  let rel = raw.trim().replace(/^\.\//, "");
  if (path.isAbsolute(rel)) {
    if (pathInside(artifactsDir, rel) || rel === artifactsDir) return path.relative(artifactsDir, rel);
    if (pathInside(cwd, rel) || rel === cwd) return path.relative(cwd, rel);
    return rel;
  }
  return rel.replace(/^(artifacts|workspace)\//, "");
}

/** Tools whose results name web sources — their URLs feed the live source counter. */
export const WEB_SOURCE_TOOLS = new Set(["web_search", "web_search_scholar", "fetch_url", "crawl_site"]);

/**
 * Extract distinct http(s) URLs from free text (normalized: no hash, no
 * trailing slash or punctuation). Capped — a crawl result can name thousands.
 */
export function harvestUrls(text: string, max = 50): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`…]+/g)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    try {
      const u = new URL(raw);
      u.hash = "";
      out.add(u.toString().replace(/\/$/, ""));
    } catch {
      /* not a URL */
    }
    if (out.size >= max) break;
  }
  return [...out];
}

/** Rough token estimate — good enough for budgets and compaction triggers. */
export function estTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function safeJson<T = unknown>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

// ---------- formatting ----------

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function fmtMoney(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

// ---------- fs ----------

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown, mode?: number): void {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function pathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------- artifact validation ----------

/**
 * Cheap structural checks for common deliverable formats — catches a worker
 * shipping malformed JSON/CSV/stub HTML before an LLM verifier spends tokens
 * on it. Returns a problem description, or null when the file looks sound
 * (or is a format we don't check).
 */
export function validateArtifactFormat(absPath: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  if (![".json", ".csv", ".html", ".htm"].includes(ext)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return null; // existence/size is the caller's check
  }
  if (ext === ".json") {
    try {
      JSON.parse(raw);
      return null;
    } catch (e) {
      return `not valid JSON (${errMsg(e)})`;
    }
  }
  if (ext === ".csv") {
    const counts = csvFieldCounts(raw, 50);
    if (!counts.length) return "CSV has no records";
    const expect = counts[0];
    const bad = counts.findIndex((c) => c !== expect);
    if (bad > 0) return `inconsistent CSV: record 1 has ${expect} field(s), record ${bad + 1} has ${counts[bad]}`;
    return null;
  }
  // .html / .htm — catch empty shells and plain text passed off as HTML.
  if (raw.length < 200 || !/<[a-z!][^>]*>/i.test(raw) || !/<\/[a-z][a-z0-9]*>/i.test(raw)) {
    return "HTML looks like a stub (too short or no real markup)";
  }
  return null;
}

/** Field count per CSV record (quote-aware, handles newlines inside quotes). */
function csvFieldCounts(raw: string, maxRecords: number): number[] {
  const counts: number[] = [];
  let fields = 1;
  let chars = 0; // non-separator chars seen in the current record
  let inQ = false;
  for (let i = 0; i < raw.length && counts.length < maxRecords; i++) {
    const ch = raw[i];
    if (inQ) {
      if (ch === '"') {
        if (raw[i + 1] === '"') i++;
        else inQ = false;
      }
      chars++;
    } else if (ch === '"') {
      inQ = true;
      chars++;
    } else if (ch === ",") {
      fields++;
      chars++;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      if (chars > 0) counts.push(fields); // skip blank lines
      fields = 1;
      chars = 0;
    } else {
      chars++;
    }
  }
  if (chars > 0 && counts.length < maxRecords) counts.push(fields);
  return counts;
}

// ---------- html ----------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', copy: "©", trade: "™", reg: "®",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Crude but effective HTML → readable text. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---------- ansi ----------

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function wrap(code: string, close = "\x1b[0m") {
  return (s: string) => (useColor ? `\x1b[${code}m${s}${close}` : s);
}

export const ansi = {
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  white: wrap("97"),
};

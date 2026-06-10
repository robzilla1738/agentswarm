import { execFile } from "child_process";
import { SwarmConfig } from "./config";
import { decodeEntities, errMsg, htmlToText, truncateMiddle } from "./util";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Publication date when the backend knows it (SearchKit). */
  date?: string;
  /** Quotable passages from the page content (SearchKit deep mode). */
  passages?: string[];
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 agentswarm/0.1";

/**
 * Web search backends, best first:
 *  1. SearchKit CLI (local, multi-engine, ranked + citable; `deep` fetches
 *     pages and returns quotable passages) — when installed.
 *  2. TinyFish Search (fast, structured) — when a key is configured.
 *  3. DuckDuckGo HTML scraping — always available, last resort.
 */
export async function webSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  deep = false,
  warn?: (msg: string) => void
): Promise<SearchHit[]> {
  if (cfg.searchBackend === "auto" && searchkitOk !== false) {
    try {
      const hits = await searchkitSearch(cfg, query, count, deep, signal);
      searchkitOk = true;
      if (hits.length) return hits;
    } catch (e: any) {
      // Not installed → stop probing for the rest of this process.
      if (e?.code === "ENOENT") searchkitOk = false;
      else if (!searchkitWarned) {
        // Installed but failing — say so once instead of silently degrading.
        searchkitWarned = true;
        warn?.(
          `searchkit failed (${errMsg(e)}); falling back to ${cfg.tinyfishApiKey ? "TinyFish" : "DuckDuckGo"}. ` +
            `Set searchBackend=ddg to skip searchkit.`
        );
      }
      /* fall through */
    }
  }
  if (cfg.searchBackend !== "ddg" && cfg.tinyfishApiKey) {
    try {
      return await tinyfishSearch(cfg, query, count, signal);
    } catch {
      /* fall through to DDG */
    }
  }
  return ddgSearch(query, count, signal);
}

// ---------------------------------------------------------------- searchkit

let searchkitOk: boolean | null = null;
let searchkitWarned = false;

function runCli(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

async function searchkitSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  deep: boolean,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const args = ["search", query, "--json", "--max-results", String(count)];
  if (!deep) args.push("--no-fetch");
  const out = await runCli(cfg.searchkitCmd, args, deep ? 90_000 : 30_000, signal);
  const start = out.indexOf("{");
  if (start < 0) throw new Error("searchkit: no JSON in output");
  const data = JSON.parse(out.slice(start));
  return (data.results || []).slice(0, count).map((r: any) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.snippet || "",
    date: r.published_date || undefined,
    passages: Array.isArray(r.passages)
      ? r.passages.slice(0, 2).map((p: any) => String(p.text || "")).filter(Boolean)
      : undefined,
  }));
}

async function tinyfishSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "X-API-Key": cfg.tinyfishApiKey },
    signal: signal ?? AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`tinyfish search ${res.status}`);
  const data: any = await res.json();
  return (data.results || []).slice(0, count).map((r: any) => ({
    title: r.title || r.site_name || r.url,
    url: r.url,
    snippet: r.snippet || "",
  }));
}

/**
 * DuckDuckGo serves two scrape-friendly endpoints with different markup.
 * A parse miss on one falls through to the other, so a DDG layout change has
 * to break both before search goes dark. Link regexes tolerate either quote
 * style and either attribute order (groups 1+2 or 3+4).
 */
const DDG_ENDPOINTS = [
  {
    url: "https://html.duckduckgo.com/html/?q=",
    linkRe: () =>
      /<a[^>]+class=['"]result__a['"][^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]+class=['"]result__a['"][^>]*>([\s\S]*?)<\/a>/g,
  },
  {
    url: "https://lite.duckduckgo.com/lite/?q=",
    linkRe: () =>
      /<a[^>]+class=['"]result-link['"][^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g,
  },
];

async function ddgSearch(
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  let firstErr: unknown = null;
  let reachedAny = false;
  for (const ep of DDG_ENDPOINTS) {
    try {
      const res = await fetch(ep.url + encodeURIComponent(query), {
        headers: { "user-agent": UA },
        signal: signal ?? AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
      reachedAny = true;
      const hits = parseDdgHtml(await res.text(), count, ep.linkRe());
      if (hits.length) return hits;
    } catch (e) {
      firstErr = firstErr ?? e;
    }
  }
  // Only fail when no endpoint even answered; an endpoint that answered with
  // zero parsed results is a genuine "no results".
  if (!reachedAny && firstErr) throw firstErr;
  return [];
}

function parseDdgHtml(html: string, count: number, linkRe: RegExp): SearchHit[] {
  const hits: SearchHit[] = [];
  const snippetRe =
    /<a[^>]+class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/a>|<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(strip(sm[1] || sm[2] || ""));
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && hits.length < count) {
    let url = m[1] ?? m[3] ?? "";
    const title = strip(m[2] ?? m[4] ?? "");
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url)) continue;
    if (url.includes("duckduckgo.com/y.js")) continue; // ads
    hits.push({ title, url, snippet: snippets[hits.length] || "" });
  }
  return hits;
}

function strip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Fetch a URL as readable text. Uses TinyFish Fetch (real browser, clean
 * markdown) when a key is configured; falls back to a direct request with
 * HTML→text extraction.
 */
export async function fetchUrl(
  cfg: SwarmConfig,
  url: string,
  raw: boolean,
  maxChars: number,
  signal?: AbortSignal
): Promise<string> {
  if (cfg.tinyfishApiKey && !raw) {
    try {
      const text = await tinyfishFetch(cfg, url, signal);
      if (text) return truncateMiddle(text, maxChars, "chars");
    } catch {
      /* fall through to direct */
    }
  }
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/json,text/*;q=0.9,*/*;q=0.5" },
    signal: signal ?? AbortSignal.timeout(25000),
    redirect: "follow",
  });
  const ctype = res.headers.get("content-type") || "";
  const body = await res.text();
  if (!res.ok) {
    return `HTTP ${res.status} ${res.statusText}\n${truncateMiddle(body, 2000, "chars")}`;
  }
  const text = !raw && /html/i.test(ctype) ? htmlToText(body) : body;
  return truncateMiddle(text, maxChars, "chars");
}

async function tinyfishFetch(
  cfg: SwarmConfig,
  url: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: {
      "X-API-Key": cfg.tinyfishApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ urls: [url], format: "markdown" }),
    signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`tinyfish fetch ${res.status}`);
  const data: any = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(data.errors?.[0]?.error || "no result");
  const text = typeof hit.text === "string" ? hit.text : JSON.stringify(hit.text);
  const title = hit.title ? `# ${hit.title}\n\n` : "";
  return title + text;
}

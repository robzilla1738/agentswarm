import { SwarmConfig } from "./config";
import { hasScrapeBackend, scrapeUrl } from "./crawltools";
import {
  Candidate,
  detectDate,
  expandQueries,
  mergeCandidates,
  passageBonus,
  queryTerms,
  rankBonus,
  scorePage,
  selectPassages,
} from "./searchcore";
import { decodeEntities, htmlToText, truncateMiddle } from "./util";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Publication date when detectable (deep mode reads it from the page). */
  date?: string;
  /** Quotable passages from the page content (deep mode). */
  passages?: string[];
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 agentswarm/0.1";

/** How many of the merged pool get fetched for passage extraction in deep mode. */
const DEEP_FETCH = 12;
/** Quotable passages kept per fetched page. */
const DEEP_PASSAGES = 3;

/**
 * Web search: fan out across every available engine in parallel (DuckDuckGo +
 * Bing scraping, plus TinyFish when keyed). In `deep` mode it also fans the
 * query into a few complementary phrasings — so one call sweeps queries ×
 * engines into a much larger pool — then quality-ranks and dedupes by
 * canonical URL, fetches the top pages concurrently for quotable passages,
 * and re-ranks by content quality. Ranking/passage algorithms live in
 * searchcore.ts.
 */
export async function webSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  deep = false,
  warn?: (msg: string) => void
): Promise<SearchHit[]> {
  // Deep searches widen recall by issuing complementary phrasings; the fast
  // path stays a single query so an agent's tool loop isn't slowed.
  const queries = deep ? expandQueries(query) : [query];
  const perEngine = Math.min(count, 15);

  const engineCalls: Promise<Candidate[]>[] = [];
  for (const q of queries) {
    if (cfg.searchBackend === "tinyfish" && cfg.tinyfishApiKey) {
      engineCalls.push(tinyfishSearch(cfg, q, perEngine, signal));
    } else {
      engineCalls.push(ddgSearch(q, perEngine, signal), bingSearch(q, perEngine, signal));
      if (cfg.searchBackend === "auto" && cfg.tinyfishApiKey) {
        engineCalls.push(tinyfishSearch(cfg, q, perEngine, signal));
      }
    }
  }

  const settled = await Promise.allSettled(engineCalls);
  const candidates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  if (!candidates.length) {
    const firstErr = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (firstErr) throw firstErr.reason;
    return [];
  }
  const failures = settled.filter((s) => s.status === "rejected").length;
  if (failures && failures === settled.length) {
    throw (settled.find((s): s is PromiseRejectedResult => s.status === "rejected"))!.reason;
  }
  if (failures) {
    warn?.(`${failures}/${settled.length} search engine calls failed; results come from the rest`);
  }

  const merged = mergeCandidates(candidates, count);
  if (!deep || !merged.length) {
    return merged.map((c) => ({ title: c.title, url: c.url, snippet: c.snippet, date: c.date }));
  }
  return deepEnrich(merged, query, signal);
}

/**
 * Deep mode: fetch the top pages concurrently, extract readable text and
 * quotable passages, and re-rank by composite content quality. Pages that
 * fail to fetch keep their snippet-level hit.
 */
async function deepEnrich(merged: Candidate[], query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const terms = queryTerms(query);
  const toFetch = merged.slice(0, Math.min(merged.length, DEEP_FETCH));
  const pages = await Promise.allSettled(toFetch.map((c) => fetchReadable(c.url, signal)));

  const scoredHits = merged.map((c, i) => {
    const base: SearchHit = { title: c.title, url: c.url, snippet: c.snippet, date: c.date };
    const page = i < pages.length && pages[i].status === "fulfilled" ? (pages[i] as PromiseFulfilledResult<string>).value : "";
    if (!page) return { hit: base, score: rankBonus(i + 1, 20) };
    const passages = selectPassages(page, query);
    const date = detectDate(page.slice(0, 4000)) || c.date;
    let domain = "";
    try {
      domain = new URL(c.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep empty */
    }
    const score =
      scorePage({ url: c.url, domain, title: c.title, text: page, date }, terms) +
      passageBonus(passages) +
      rankBonus(i + 1, 10);
    return {
      hit: { ...base, date, passages: passages.slice(0, DEEP_PASSAGES).map((p) => p.text) },
      score,
    };
  });

  return scoredHits.sort((a, b) => b.score - a.score).map((s) => s.hit);
}

/** Fetch one page as cleaned readable text for passage extraction (~3000 words max). */
async function fetchReadable(url: string, signal?: AbortSignal): Promise<string> {
  // GitHub repo pages bury the README in app markup — the raw file is cleaner.
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/.exec(url);
  if (gh) {
    for (const branch of ["main", "master"]) {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}/README.md`, {
          headers: { "user-agent": UA },
          signal: mergeSignal(20_000, signal),
        });
        if (res.ok) return clip(await res.text());
      } catch {
        /* fall through */
      }
    }
  }
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,text/*;q=0.9,*/*;q=0.5" },
    signal: mergeSignal(20_000, signal),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/|html|xml|json/i.test(ctype)) throw new Error(`not textual: ${ctype}`);
  const body = await res.text();
  const text = /html/i.test(ctype) ? htmlToText(body) : body;
  return clip(text);
}

function clip(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 3000).join(" ");
}

function mergeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!signal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([t, signal]) : signal;
}

// ---------------------------------------------------------------- engines

async function tinyfishSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<Candidate[]> {
  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "X-API-Key": cfg.tinyfishApiKey },
    signal: mergeSignal(20_000, signal),
  });
  if (!res.ok) throw new Error(`tinyfish search ${res.status}`);
  const data: any = await res.json();
  return (data.results || []).slice(0, count).map((r: any, i: number) => ({
    title: r.title || r.site_name || r.url,
    url: r.url,
    snippet: r.snippet || "",
    rank: i + 1,
    engine: "tinyfish",
  }));
}

/**
 * DuckDuckGo serves two scrape-friendly endpoints with different markup.
 * A parse miss on one falls through to the other, so a DDG layout change has
 * to break both before the engine goes dark. Link regexes tolerate either
 * quote style and either attribute order (groups 1+2 or 3+4).
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

async function ddgSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  let firstErr: unknown = null;
  let reachedAny = false;
  for (const ep of DDG_ENDPOINTS) {
    try {
      const res = await fetch(ep.url + encodeURIComponent(query), {
        headers: { "user-agent": UA },
        signal: mergeSignal(20_000, signal),
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

function parseDdgHtml(html: string, count: number, linkRe: RegExp): Candidate[] {
  const hits: Candidate[] = [];
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
    const snippet = snippets[hits.length] || "";
    hits.push({ title, url, snippet, rank: hits.length + 1, engine: "ddg", date: detectDate(snippet) });
  }
  return hits;
}

/** Bing's HTML results page: each hit is an <li class="b_algo"> with an <h2><a> link. */
async function bingSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    signal: mergeSignal(20_000, signal),
  });
  if (!res.ok) throw new Error(`bing search ${res.status}`);
  return parseBingHtml(await res.text(), count);
}

export function parseBingHtml(html: string, count: number): Candidate[] {
  const hits: Candidate[] = [];
  const blocks = html.split(/<li class="b_algo[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (hits.length >= count) break;
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeBingUrl(decodeEntities(link[1]));
    if (!url || !/^https?:\/\//.test(url)) continue;
    const title = strip(link[2]);
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sn ? strip(sn[1]) : "";
    hits.push({ title, url, snippet, rank: hits.length + 1, engine: "bing", date: detectDate(snippet) });
  }
  return hits;
}

/** Bing wraps result URLs in a /ck/ redirect with a base64url-encoded `u` param. */
function decodeBingUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, "https://www.bing.com");
  } catch {
    return null;
  }
  if (!u.hostname.endsWith("bing.com") || !u.pathname.startsWith("/ck/")) return href;
  const encoded = u.searchParams.get("u");
  if (!encoded) return null;
  const value = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : null;
  } catch {
    return null;
  }
}

function strip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Fetch a URL as readable text. Prefers a configured crawl backend's scrape
 * (Firecrawl/context.dev: real browser, clean markdown), then TinyFish Fetch,
 * then a direct request with HTML→text extraction.
 */
export async function fetchUrl(
  cfg: SwarmConfig,
  url: string,
  raw: boolean,
  maxChars: number,
  signal?: AbortSignal
): Promise<string> {
  if (!raw && hasScrapeBackend(cfg)) {
    try {
      const text = await scrapeUrl(cfg, url, signal);
      if (text) return truncateMiddle(text, maxChars, "chars");
    } catch {
      /* fall through to TinyFish → direct */
    }
  }
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

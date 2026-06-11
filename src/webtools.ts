import { SwarmConfig } from "./config";
import { hasScrapeBackend, scrapeUrl } from "./crawltools";
import { extractPdfText } from "./pdftext";
import {
  Candidate,
  detectDate,
  expandQueries,
  looksAcademic,
  mergeCandidates,
  passageBonus,
  queryTerms,
  rankBonus,
  reformulate,
  scorePage,
  selectPassages,
} from "./searchcore";
import { decodeEntities, htmlToText, oneLine, truncateMiddle } from "./util";

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
  warn?: (msg: string) => void,
  _retried = false
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
  // Scholarly questions also sweep the keyless academic APIs (deep mode only).
  if (deep && looksAcademic(query)) {
    engineCalls.push(arxivSearch(query, perEngine, signal), crossrefSearch(query, perEngine, signal));
  }

  const settled = await Promise.allSettled(engineCalls);
  const candidates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  if (!candidates.length) {
    const firstErr = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (firstErr && settled.every((s) => s.status === "rejected")) throw firstErr.reason;
    // Engines answered but nothing parsed/matched: one retry with a
    // simplified phrasing before giving up.
    if (!_retried) {
      const alt = reformulate(query);
      if (alt) {
        warn?.(`no results for "${query}" — retrying as "${alt}"`);
        return webSearch(cfg, alt, count, signal, deep, warn, true);
      }
    }
    if (firstErr) throw firstErr.reason;
    return [];
  }
  const failures = settled.filter((s) => s.status === "rejected").length;
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
    headers: { "user-agent": UA, accept: "text/html,application/pdf,text/*;q=0.9,*/*;q=0.5" },
    signal: mergeSignal(20_000, signal),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (/application\/pdf/i.test(ctype)) {
    const buf = Buffer.from(await res.arrayBuffer());
    const pdf = buf.length <= 20_000_000 ? extractPdfText(buf) : null;
    if (!pdf) throw new Error("pdf with no extractable text");
    return clip(pdf.text);
  }
  if (!/text\/|html|xml|json/i.test(ctype)) throw new Error(`not textual: ${ctype}`);
  const body = decodeBody(Buffer.from(await res.arrayBuffer()), ctype);
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

/**
 * Per-engine rate-limit cooldowns: an engine that answers 429/403/503 sits
 * out (60s, or the server's retry-after up to 120s) instead of getting
 * hammered into a long block mid-research. A tiny retry-after (≤5s) is
 * honored once in-call.
 */
const engineCooldown = new Map<string, number>();

/** Test hook. */
export function _resetEngineCooldowns(): void {
  engineCooldown.clear();
}

async function engineFetch(
  engine: string,
  url: string,
  init: { headers?: Record<string, string> },
  signal?: AbortSignal
): Promise<Response> {
  const until = engineCooldown.get(engine) ?? 0;
  if (until > Date.now()) {
    throw new Error(`${engine} is cooling down after a rate limit (${Math.ceil((until - Date.now()) / 1000)}s left)`);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: mergeSignal(20_000, signal) });
    if (![429, 403, 503].includes(res.status)) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (attempt === 0 && Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 5) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : 60_000;
    engineCooldown.set(engine, Date.now() + ms);
    throw new Error(`${engine} rate-limited (HTTP ${res.status}); cooling down ${Math.round(ms / 1000)}s`);
  }
}

export async function tinyfishSearch(
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

export async function ddgSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  let firstErr: unknown = null;
  let reachedAny = false;
  for (const ep of DDG_ENDPOINTS) {
    try {
      const res = await engineFetch("duckduckgo", ep.url + encodeURIComponent(query), {
        headers: { "user-agent": UA },
      }, signal);
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
export async function bingSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const res = await engineFetch("bing", `https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
  }, signal);
  if (!res.ok) throw new Error(`bing search ${res.status}`);
  return parseBingHtml(await res.text(), count);
}

// ---------------------------------------------------------------- academic engines (keyless)

/** arXiv's Atom API — preprints with abstracts, no key needed. */
export async function arxivSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${Math.min(count, 15)}`;
  const res = await engineFetch("arxiv", url, { headers: { "user-agent": UA } }, signal);
  if (!res.ok) throw new Error(`arxiv search ${res.status}`);
  const xml = await res.text();
  const out: Candidate[] = [];
  for (const entry of xml.split(/<entry>/).slice(1)) {
    if (out.length >= count) break;
    const title = strip((/<title>([\s\S]*?)<\/title>/.exec(entry) || [])[1] || "");
    const id = ((/<id>([\s\S]*?)<\/id>/.exec(entry) || [])[1] || "").trim();
    const summary = strip((/<summary>([\s\S]*?)<\/summary>/.exec(entry) || [])[1] || "");
    const published = (/<published>(\d{4}-\d{2}-\d{2})/.exec(entry) || [])[1];
    if (!id || !title || !/^https?:\/\//.test(id)) continue;
    out.push({ title, url: id, snippet: summary.slice(0, 300), rank: out.length + 1, engine: "arxiv", date: published });
  }
  return out;
}

/** Crossref's works API — journal/conference metadata with DOIs, no key needed. */
export async function crossrefSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.min(count, 15)}&select=title,DOI,abstract,issued,container-title`;
  const res = await engineFetch("crossref", url, { headers: { "user-agent": UA } }, signal);
  if (!res.ok) throw new Error(`crossref search ${res.status}`);
  const data: any = await res.json();
  const out: Candidate[] = [];
  for (const it of data?.message?.items ?? []) {
    if (out.length >= count) break;
    const title = strip(String(Array.isArray(it.title) ? it.title[0] ?? "" : it.title ?? ""));
    if (!title || !it.DOI) continue;
    const date = Array.isArray(it.issued?.["date-parts"]?.[0]) ? it.issued["date-parts"][0].join("-") : undefined;
    const venue = Array.isArray(it["container-title"]) ? it["container-title"][0] : "";
    const snippet = (strip(String(it.abstract ?? "")) || venue || "").slice(0, 300);
    out.push({ title, url: `https://doi.org/${it.DOI}`, snippet, rank: out.length + 1, engine: "crossref", date });
  }
  return out;
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
    headers: { "user-agent": UA, accept: "text/html,application/json,application/pdf,text/*;q=0.9,*/*;q=0.5" },
    signal: signal ?? AbortSignal.timeout(25000),
    redirect: "follow",
  });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok) {
    // An error page is not content: returning it as a successful result lets
    // "HTTP 403 ... subscribe to continue" become a "fact" in someone's report.
    const body = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} — page is not usable as a source (paywall/login/blocked?). ` +
        `Try web_search for an alternative source.${body ? ` Server said: ${oneLine(htmlToText(body), 200)}` : ""}`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (/application\/pdf/i.test(ctype) || buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    if (buf.length > 20_000_000) throw new Error(`PDF is ${Math.round(buf.length / 1e6)}MB — too large to extract`);
    const pdf = extractPdfText(buf);
    if (!pdf) {
      throw new Error("PDF contains no extractable text (likely scanned or encrypted) — find an HTML version of this source.");
    }
    return truncateMiddle(`[PDF, ${pdf.pages} page${pdf.pages > 1 ? "s" : ""}]\n${pdf.text}`, maxChars, "chars");
  }
  const body = decodeBody(buf, ctype);
  const text = !raw && /html/i.test(ctype) ? htmlToText(body) : body;
  if (!raw && /html/i.test(ctype)) {
    const trimmed = text.trim();
    if (trimmed.length < 400 && /subscrib|sign.?in|log.?in|enable javascript|access denied|are you a (human|robot)|captcha/i.test(trimmed)) {
      return `WARNING: this page returned only a paywall/anti-bot shell — the text below is probably not the real content. Try web_search for an alternative source.\n\n${trimmed}`;
    }
  }
  return truncateMiddle(text, maxChars, "chars");
}

/** Decode a response body honoring its content-type charset (UTF-8 fallback). */
function decodeBody(buf: Buffer, ctype: string): string {
  const charset = /charset=([\w-]+)/i.exec(ctype)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      /* unknown label — fall through to utf-8 */
    }
  }
  return buf.toString("utf8");
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

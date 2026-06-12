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
import { decodeEntities, errMsg, htmlToText, mergeSignal, oneLine, truncateMiddle } from "./util";

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
const DEEP_FETCH = 25;
/** Quotable passages kept per fetched page. */
const DEEP_PASSAGES = 3;

/**
 * Web search: fan out across every available engine in parallel (DuckDuckGo +
 * Bing scraping, plus TinyFish and context.dev when keyed). In `deep` mode it also fans the
 * query into a few complementary phrasings — so one call sweeps queries ×
 * engines into a much larger pool — then quality-ranks and dedupes by
 * canonical URL, fetches the top pages concurrently for quotable passages,
 * and re-ranks by content quality. Ranking/passage algorithms live in
 * searchcore.ts.
 */
export type Freshness = "day" | "week" | "month" | "year";

export async function webSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  deep = false,
  warn?: (msg: string) => void,
  _retried = false,
  freshness?: Freshness
): Promise<SearchHit[]> {
  // Deep searches widen recall by issuing complementary phrasings; the fast
  // path stays a single query so an agent's tool loop isn't slowed.
  const queries = deep ? expandQueries(query) : [query];
  const perEngine = Math.min(count, 25);

  const engines = searchEngines(cfg);
  const engineCalls: Promise<Candidate[]>[] = [];
  for (const q of queries) {
    for (const e of engines) {
      // `once` engines (context.dev: server-side fanout, billed per result)
      // run a single call on the original query, not one per phrasing.
      if (e.once && q !== queries[0]) continue;
      let call = e.search(q, perEngine, signal, deep, freshness);
      // When a paid engine is the sole engine by configuration, an outage must
      // not blank web research for the whole mission — fall back to the free
      // scraping engines for this call.
      if (engines.length === 1 && (e.name === "tinyfish" || e.name === "contextdev")) {
        call = call.catch(async (err) => {
          warn?.(`${e.name} failed (${errMsg(err)}); falling back to duckduckgo/bing`);
          const fallback = await Promise.allSettled([ddgSearch(q, perEngine, signal), bingSearch(q, perEngine, signal)]);
          const hits = fallback.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
          if (!hits.length && fallback.every((s) => s.status === "rejected")) throw err;
          return hits;
        });
      }
      engineCalls.push(call);
    }
  }
  // Scholarly questions also sweep the keyless academic APIs (deep mode only);
  // biomedical phrasing adds PubMed, where arXiv/Crossref coverage is thin.
  if (deep && looksAcademic(query)) {
    engineCalls.push(
      arxivSearch(query, perEngine, signal),
      crossrefSearch(query, perEngine, signal),
      semanticScholarSearch(query, perEngine, signal)
    );
    if (looksBiomedical(query)) engineCalls.push(pubmedSearch(query, perEngine, signal));
  }
  // Freshness-scoped sweeps also pull GDELT's keyless news index — direct
  // article links from mostly paywall-light outlets, exactly where the
  // scraped engines' date filters run thin.
  if (freshness) {
    engineCalls.push(gdeltArticleSearch(query, perEngine, signal, freshness));
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
        return webSearch(cfg, alt, count, signal, deep, warn, true, freshness);
      }
    }
    // At least one engine answered with a genuine empty result set: that is
    // "no results", not an error, even if another engine failed alongside it.
    if (firstErr) warn?.(`no results (and ${errMsg(firstErr.reason)})`);
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

// ---------------------------------------------------------------- engines

export interface SearchEngine {
  name: string;
  search: (
    query: string,
    count: number,
    signal?: AbortSignal,
    deep?: boolean,
    freshness?: Freshness
  ) => Promise<Candidate[]>;
  /**
   * Call once per webSearch, not per expanded phrasing — for engines that
   * fan out server-side and/or bill per result (context.dev).
   */
  once?: boolean;
}

/**
 * The engine set a web_search call fans out to under the given config —
 * the single source of truth shared by webSearch and the settings
 * diagnostics endpoint, so "Test search" probes exactly what runs use.
 */
export function searchEngines(cfg: SwarmConfig): SearchEngine[] {
  if (cfg.searchBackend === "tinyfish" && cfg.tinyfishApiKey) {
    return [{ name: "tinyfish", search: (q, n, s, _deep, fresh) => tinyfishSearch(cfg, q, n, s, fresh) }];
  }
  if (cfg.searchBackend === "contextdev" && cfg.contextdevApiKey) {
    return [{ name: "contextdev", once: true, search: (q, n, s, deep) => contextdevSearch(cfg, q, n, s, deep) }];
  }
  const engines: SearchEngine[] = [
    { name: "duckduckgo", search: (q, n, s, _deep, fresh) => ddgSearch(q, n, s, fresh) },
    { name: "bing", search: (q, n, s, _deep, fresh) => bingSearch(q, n, s, fresh) },
  ];
  if (cfg.searchBackend === "auto" && cfg.tinyfishApiKey) {
    engines.push({ name: "tinyfish", search: (q, n, s, _deep, fresh) => tinyfishSearch(cfg, q, n, s, fresh) });
  }
  if (cfg.searchBackend === "auto" && cfg.contextdevApiKey) {
    engines.push({ name: "contextdev", once: true, search: (q, n, s, deep) => contextdevSearch(cfg, q, n, s, deep) });
  }
  return engines;
}

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
  init: { headers?: Record<string, string>; method?: string; body?: string },
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

/**
 * context.dev Web Search: relevance-ranked results in one POST (1 credit per
 * result). In deep mode the API's own queryFanout widens recall server-side —
 * which is why this engine is `once: true` and skips local query expansion.
 */
export async function contextdevSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  deep = false
): Promise<Candidate[]> {
  const res = await engineFetch(
    "contextdev",
    "https://api.context.dev/v1/web/search",
    {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.contextdevApiKey}`, "content-type": "application/json" },
      // The API has no result-count parameter (verified against its OpenAPI
      // spec) — it returns its own relevance-ranked set; `count` only trims.
      body: JSON.stringify({ query: query.slice(0, 500), ...(deep ? { queryFanout: true } : {}) }),
    },
    signal
  );
  if (!res.ok) throw new Error(`context.dev search ${res.status}`);
  const data: any = await res.json();
  return (data.results || [])
    .filter((r: any) => typeof r?.url === "string" && r.url)
    .slice(0, count)
    .map((r: any, i: number) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.description || "",
      // The API orders by relevance; push self-declared medium/low hits down
      // so a "high" from context.dev outranks scraped-engine noise.
      rank: i + 1 + (r.relevance === "low" ? 20 : r.relevance === "medium" ? 5 : 0),
      engine: "contextdev",
      date: detectDate(r.description || ""),
    }));
}

/** Days back each freshness window reaches (used to post-filter engines with no native date filter). */
const FRESHNESS_DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 31, year: 366 };

export async function tinyfishSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  freshness?: Freshness
): Promise<Candidate[]> {
  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "X-API-Key": cfg.tinyfishApiKey },
    signal: mergeSignal(20_000, signal),
  });
  if (!res.ok) throw new Error(`tinyfish search ${res.status}`);
  const data: any = await res.json();
  const hits: Candidate[] = (data.results || []).slice(0, count).map((r: any, i: number) => ({
    title: r.title || r.site_name || r.url,
    url: r.url,
    snippet: r.snippet || "",
    rank: i + 1,
    engine: "tinyfish",
    date: detectDate(String(r.snippet || "")),
  }));
  // The API has no date filter — drop hits whose detected date is clearly
  // outside the window; undated hits stay (freshness is best-effort per engine).
  if (!freshness) return hits;
  const cutoff = Date.now() - FRESHNESS_DAYS[freshness] * 86_400_000;
  return hits.filter((h) => {
    if (!h.date) return true;
    const t = Date.parse(/^\d{4}$/.test(h.date) ? `${h.date}-07-01` : h.date);
    return !Number.isFinite(t) || t >= cutoff;
  });
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

/** DDG date filter (`df=`): d/w/m/y windows. */
const DDG_FRESHNESS: Record<Freshness, string> = { day: "d", week: "w", month: "m", year: "y" };

export async function ddgSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
  freshness?: Freshness
): Promise<Candidate[]> {
  const df = freshness ? `&df=${DDG_FRESHNESS[freshness]}` : "";
  let firstErr: unknown = null;
  let reachedAny = false;
  for (const ep of DDG_ENDPOINTS) {
    try {
      const res = await engineFetch("duckduckgo", ep.url + encodeURIComponent(query) + df, {
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

/** Bing's recency filter (`filters=ex1:"ez<N>"`): 1=24h, 2=week, 3=month; no year window exists. */
const BING_FRESHNESS: Partial<Record<Freshness, string>> = { day: "ez1", week: "ez2", month: "ez3" };

/** Bing's HTML results page: each hit is an <li class="b_algo"> with an <h2><a> link. */
export async function bingSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
  freshness?: Freshness
): Promise<Candidate[]> {
  const ez = freshness ? BING_FRESHNESS[freshness] : undefined;
  const filter = ez ? `&filters=${encodeURIComponent(`ex1:"${ez}"`)}` : "";
  const res = await engineFetch("bing", `https://www.bing.com/search?q=${encodeURIComponent(query)}${filter}`, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
  }, signal);
  if (!res.ok) throw new Error(`bing search ${res.status}`);
  return parseBingHtml(await res.text(), count);
}

// ---------------------------------------------------------------- academic engines (keyless)

/** arXiv's Atom API — preprints with abstracts, no key needed. */
export async function arxivSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${Math.min(count, 20)}`;
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

/**
 * Semantic Scholar Graph API — keyless, and the only academic engine here
 * that returns citation counts: an influence signal arXiv/Crossref can't give
 * the ranker. The shared engine cooldown absorbs its keyless rate limit.
 */
export async function semanticScholarSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const n = Math.min(count, 20);
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,abstract,year,citationCount,url,externalIds&limit=${n}`;
  const res = await engineFetch("semanticscholar", url, { headers: { "user-agent": UA } }, signal);
  if (!res.ok) throw new Error(`semantic scholar search ${res.status}`);
  const data: any = await res.json();
  const out: Candidate[] = [];
  for (const p of data?.data ?? []) {
    if (out.length >= count) break;
    const title = strip(String(p?.title ?? ""));
    const link = p?.url || (p?.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : "");
    if (!title || !/^https?:\/\//.test(link)) continue;
    const cites = typeof p.citationCount === "number" ? p.citationCount : 0;
    const abstract = strip(String(p.abstract ?? ""));
    out.push({
      title,
      url: link,
      snippet: `[${cites} citations] ${abstract}`.slice(0, 300),
      rank: out.length + 1,
      engine: "semanticscholar",
      date: p.year ? String(p.year) : undefined,
    });
  }
  return out;
}

/** Biomedical intent: routes academic sweeps through PubMed too. Stems are prefix-matched (vaccin → vaccine/vaccination). */
const BIOMEDICAL_RE =
  /\b(clinical|trial|patient|disease|cancer|vaccin|drug|therap|epidemi|virus|viral|bacteri|genom|gene\b|protein|medical|medicine|health|fda\b|mortality|infect|outbreak|pandemic|diagnos|symptom|treatment|dosage|pharma|oncolog|cardio|neuro)/i;

export function looksBiomedical(query: string): boolean {
  return BIOMEDICAL_RE.test(query);
}

/**
 * PubMed E-utilities (esearch → esummary, keyless) — the authoritative index
 * for clinical/public-health/epidemiology literature, where arXiv and
 * Crossref coverage is thin.
 */
export async function pubmedSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const n = Math.min(count, 20);
  const es = await engineFetch(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${n}&retmode=json&sort=relevance`,
    { headers: { "user-agent": UA } },
    signal
  );
  if (!es.ok) throw new Error(`pubmed esearch ${es.status}`);
  const ids: string[] = (((await es.json()) as any)?.esearchresult?.idlist ?? []).filter((id: unknown) => /^\d+$/.test(String(id)));
  if (!ids.length) return [];
  const sum = await engineFetch(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`,
    { headers: { "user-agent": UA } },
    signal
  );
  if (!sum.ok) throw new Error(`pubmed esummary ${sum.status}`);
  const result: any = ((await sum.json()) as any)?.result ?? {};
  const out: Candidate[] = [];
  for (const id of ids) {
    const it = result[id];
    const title = strip(String(it?.title ?? ""));
    if (!title) continue;
    const venue = [it.fulljournalname || it.source, it.pubdate].filter(Boolean).join(", ");
    out.push({
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: venue.slice(0, 300),
      rank: out.length + 1,
      engine: "pubmed",
      date: detectDate(String(it.pubdate ?? "")),
    });
  }
  return out;
}

/**
 * GDELT DOC 2.0 article search (keyless) — a global news index that links
 * straight to articles, mostly paywall-light outlets. The API enforces one
 * request per 5 seconds; its 429s land in the shared engine cooldown. Used
 * for freshness-scoped sweeps where scraped engines run thin.
 */
export async function gdeltArticleSearch(
  query: string,
  count: number,
  signal?: AbortSignal,
  freshness?: Freshness
): Promise<Candidate[]> {
  const spans: Record<Freshness, string> = { day: "1d", week: "1w", month: "1m", year: "12m" };
  const timespan = spans[freshness ?? "month"];
  const q = `${query} sourcelang:english`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=${Math.min(count, 25)}&timespan=${timespan}&format=json&sort=hybridrel`;
  const res = await engineFetch("gdelt-doc", url, { headers: { "user-agent": UA } }, signal);
  if (!res.ok) throw new Error(`gdelt article search ${res.status}`);
  // GDELT reports query errors as 200 + plain text — a JSON parse miss is "no results".
  const data: any = await res.json().catch(() => null);
  const out: Candidate[] = [];
  for (const a of data?.articles ?? []) {
    if (out.length >= count) break;
    const link = String(a?.url ?? "");
    const title = strip(String(a?.title ?? ""));
    if (!title || !/^https?:\/\//.test(link)) continue;
    const seen = /^(\d{4})(\d{2})(\d{2})/.exec(String(a.seendate ?? ""));
    out.push({
      title,
      url: link,
      snippet: [a.domain, seen ? `${seen[1]}-${seen[2]}-${seen[3]}` : ""].filter(Boolean).join(" · "),
      rank: out.length + 1,
      engine: "gdelt",
      date: seen ? `${seen[1]}-${seen[2]}-${seen[3]}` : undefined,
    });
  }
  return out;
}

/** Crossref's works API — journal/conference metadata with DOIs, no key needed. */
export async function crossrefSearch(query: string, count: number, signal?: AbortSignal): Promise<Candidate[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.min(count, 20)}&select=title,DOI,abstract,issued,container-title`;
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
  signal?: AbortSignal,
  warn?: (msg: string) => void
): Promise<string> {
  if (!raw && hasScrapeBackend(cfg)) {
    try {
      const text = await scrapeUrl(cfg, url, signal);
      if (text) return truncateMiddle(text, maxChars, "chars");
    } catch (e) {
      // Fall through to TinyFish → direct — but loudly: a misconfigured
      // backend silently degrading to direct fetch hid a dead endpoint once.
      warn?.(`scrape backend failed for ${url} (${errMsg(e)}) — falling back to ${cfg.tinyfishApiKey ? "tinyfish" : "direct fetch"}`);
    }
  }
  if (cfg.tinyfishApiKey && !raw) {
    try {
      const text = await tinyfishFetch(cfg, url, signal);
      if (text) return truncateMiddle(text, maxChars, "chars");
    } catch (e) {
      warn?.(`tinyfish fetch failed for ${url} (${errMsg(e)}) — falling back to direct fetch`);
    }
  }
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/json,application/pdf,text/*;q=0.9,*/*;q=0.5" },
    signal: signal ?? AbortSignal.timeout(25000),
    redirect: "follow",
  });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok) {
    // Dead or blocked pages often live on in the Wayback Machine — recover
    // the closest snapshot before declaring the source unusable.
    if (!raw) {
      const archived = await waybackFetch(url, maxChars, signal).catch(() => null);
      if (archived) {
        warn?.(`HTTP ${res.status} for ${url} — recovered a Wayback Machine snapshot instead`);
        return archived;
      }
    }
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

/**
 * Wayback Machine recovery (keyless): the availability API names the closest
 * snapshot; its content comes back clearly labeled as archived so an agent
 * never mistakes a stale capture for the live page.
 */
async function waybackFetch(url: string, maxChars: number, signal?: AbortSignal): Promise<string | null> {
  const avail = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": UA },
    signal: mergeSignal(15_000, signal),
  });
  if (!avail.ok) return null;
  const data: any = await avail.json().catch(() => null);
  const closest = data?.archived_snapshots?.closest;
  if (!closest?.available || typeof closest.url !== "string") return null;
  const snap = await fetch(closest.url.replace(/^http:/, "https:"), {
    headers: { "user-agent": UA, accept: "text/html,text/*;q=0.9,*/*;q=0.5" },
    signal: mergeSignal(25_000, signal),
    redirect: "follow",
  });
  if (!snap.ok) return null;
  const ctype = snap.headers.get("content-type") || "";
  const body = decodeBody(Buffer.from(await snap.arrayBuffer()), ctype);
  const text = /html/i.test(ctype) ? htmlToText(body) : body;
  if (!text.trim()) return null;
  const ts = String(closest.timestamp ?? "");
  const when = ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : "unknown date";
  return truncateMiddle(
    `[ARCHIVED SNAPSHOT from ${when} — the live page returned an error; this content may be stale]\n${text}`,
    maxChars,
    "chars"
  );
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

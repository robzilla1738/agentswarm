import { SwarmConfig } from "./config";
import { mergeSignal, sleep, truncateMiddle } from "./util";

/**
 * Pluggable crawl/scrape backends (Firecrawl, context.dev, or a custom
 * "deepcrawl" endpoint). Mirrors the webtools.ts search-backend layering:
 * resolve the configured backend, call it, normalize to CrawlPage[].
 */

export type CrawlBackendId = "firecrawl" | "contextdev" | "deepcrawl";

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
}

export interface CrawlOutcome {
  backend: CrawlBackendId;
  pages: CrawlPage[];
  warnings: string[];
}

export interface CrawlOpts {
  url: string;
  maxPages: number;
  includePaths?: string[];
  signal?: AbortSignal;
  /** Firecrawl job poll interval — injectable so tests run in milliseconds. */
  pollMs?: number;
}

const PER_PAGE_CHAR_CAP = 200_000;
const TOTAL_CHAR_BUDGET = 8_000_000;
const CRAWL_DEADLINE_MS = 120_000;

/** auto = first configured: Firecrawl → context.dev → deepcrawl. "off" or nothing configured → null. */
export function resolveCrawlBackend(cfg: SwarmConfig): CrawlBackendId | null {
  if (cfg.crawlBackend === "off") return null;
  const configured = {
    firecrawl: Boolean(cfg.firecrawlApiKey),
    contextdev: Boolean(cfg.contextdevApiKey),
    deepcrawl: Boolean(cfg.deepcrawlApiKey && cfg.deepcrawlBaseUrl),
  };
  if (cfg.crawlBackend !== "auto") return configured[cfg.crawlBackend] ? cfg.crawlBackend : null;
  // Auto mode: context.dev first (cost-effective), then firecrawl, then deepcrawl
  for (const id of ["contextdev", "firecrawl", "deepcrawl"] as const) {
    if (configured[id]) return id;
  }
  return null;
}

/** Backends usable for single-page scrape in fetch_url (the custom deepcrawl contract has no scrape endpoint). */
export function hasScrapeBackend(cfg: SwarmConfig): boolean {
  const b = resolveCrawlBackend(cfg);
  return b === "firecrawl" || b === "contextdev";
}

export async function crawlSite(cfg: SwarmConfig, opts: CrawlOpts): Promise<CrawlOutcome> {
  const backend = resolveCrawlBackend(cfg);
  if (!backend) throw new Error("no crawl backend configured — add a Firecrawl/context.dev/deepcrawl key in Settings");
  const warnings: string[] = [];
  let pages: CrawlPage[];
  if (backend === "firecrawl") pages = await firecrawlCrawl(cfg, opts, warnings);
  else if (backend === "contextdev") pages = await contextdevCrawl(cfg, opts);
  else pages = await deepcrawlCrawl(cfg, opts);

  // Normalize: drop empty/binary pages, cap per-page and total size.
  const clean: CrawlPage[] = [];
  let skipped = 0;
  let total = 0;
  for (const p of pages) {
    if (clean.length >= opts.maxPages) break;
    const md = (p.markdown || "").trim();
    if (!md || md.includes("\u0000")) {
      skipped++;
      continue;
    }
    const body = truncateMiddle(md, PER_PAGE_CHAR_CAP, "chars");
    if (total + body.length > TOTAL_CHAR_BUDGET) {
      warnings.push(`stopped at ${clean.length} pages: total content budget reached`);
      break;
    }
    total += body.length;
    clean.push({ url: p.url, title: p.title, markdown: body });
  }
  if (skipped) warnings.push(`${skipped} empty page${skipped > 1 ? "s" : ""} skipped`);
  return { backend, pages: clean, warnings };
}

/** Single-page scrape via the configured backend. Throws on failure — callers fall through to their own fetch path. */
export async function scrapeUrl(cfg: SwarmConfig, url: string, signal?: AbortSignal): Promise<string> {
  const backend = resolveCrawlBackend(cfg);
  if (backend === "firecrawl") {
    const data = await callJson(
      "firecrawl",
      "https://api.firecrawl.dev/v1/scrape",
      cfg.firecrawlApiKey,
      { url, formats: ["markdown"] },
      30_000,
      signal
    );
    const md = String(data?.data?.markdown ?? "");
    if (!md.trim()) throw new Error("firecrawl: empty scrape result");
    const title = data?.data?.metadata?.title;
    return title ? `# ${title}\n\n${md}` : md;
  }
  if (backend === "contextdev") {
    const data = await callJson(
      "context.dev",
      "https://api.context.dev/v1/web/scrape",
      cfg.contextdevApiKey,
      { url },
      30_000,
      signal
    );
    // Handle multiple response shapes from context.dev API
    let md = "";
    let title = "";

    // Try flat structure first (new API format)
    if (data?.markdown) {
      md = String(data.markdown);
      title = String(data?.metadata?.title ?? data?.title ?? "");
    }
    // Try nested structure (older or alternative format)
    else if (Array.isArray(data?.results) && data.results[0]) {
      md = String(data.results[0].markdown ?? "");
      title = String(data.results[0]?.metadata?.title ?? data.results[0]?.title ?? "");
    }
    // Try top-level title fallback
    else if (data?.data?.markdown) {
      md = String(data.data.markdown);
      title = String(data?.data?.metadata?.title ?? data?.data?.title ?? "");
    }

    if (!md.trim()) throw new Error(`context.dev: empty scrape result for ${url}`);
    return title ? `# ${title}\n\n${md}` : md;
  }
  throw new Error("no scrape-capable crawl backend configured");
}

/** "https://docs.foo.com/a/b?x=1" → filesystem-safe { host, slug } with no separators or traversal. */
export function slugForUrl(url: string): { host: string; slug: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { host: "site", slug: sanitize(url) || "page" };
  }
  const host = sanitize(u.hostname) || "site";
  const slug = sanitize(u.pathname.replace(/\/+$/, "")) || "index";
  return { host, slug };
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

// ---------------------------------------------------------------- backends

async function firecrawlCrawl(cfg: SwarmConfig, opts: CrawlOpts, warnings: string[]): Promise<CrawlPage[]> {
  const start = await callJson(
    "firecrawl",
    "https://api.firecrawl.dev/v1/crawl",
    cfg.firecrawlApiKey,
    {
      url: opts.url,
      limit: opts.maxPages,
      ...(opts.includePaths?.length ? { includePaths: opts.includePaths } : {}),
      scrapeOptions: { formats: ["markdown"] },
    },
    30_000,
    opts.signal
  );
  const jobId = start?.id;
  if (!jobId) throw new Error(`firecrawl: crawl did not start (${start?.error || "no job id"})`);

  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  let last: any = null;
  for (;;) {
    opts.signal?.throwIfAborted();
    last = await getJson("firecrawl", `https://api.firecrawl.dev/v1/crawl/${jobId}`, cfg.firecrawlApiKey, opts.signal);
    if (last?.status === "completed") break;
    if (last?.status === "failed") throw new Error(`firecrawl: crawl failed (${last?.error || "unknown error"})`);
    if (Date.now() > deadline) {
      const partial = mapFirecrawlPages(last);
      if (!partial.length) throw new Error("firecrawl: crawl still running after 120s with no pages yet — try fewer pages");
      warnings.push(`crawl still running after 120s; returning ${partial.length} partial pages`);
      return partial;
    }
    await sleep(pollMs, opts.signal);
  }

  // Completed: collect pages, following `next` pagination until maxPages.
  const pages = mapFirecrawlPages(last);
  let next = last?.next;
  while (next && pages.length < opts.maxPages) {
    const more = await getJson("firecrawl", String(next), cfg.firecrawlApiKey, opts.signal);
    pages.push(...mapFirecrawlPages(more));
    next = more?.next;
  }
  return pages;
}

function mapFirecrawlPages(res: any): CrawlPage[] {
  const data = Array.isArray(res?.data) ? res.data : [];
  return data.map((d: any) => ({
    url: String(d?.metadata?.sourceURL ?? d?.metadata?.url ?? ""),
    title: String(d?.metadata?.title ?? ""),
    markdown: String(d?.markdown ?? ""),
  }));
}

async function contextdevCrawl(cfg: SwarmConfig, opts: CrawlOpts): Promise<CrawlPage[]> {
  const data = await callJson(
    "context.dev",
    "https://api.context.dev/v1/web/crawl",
    cfg.contextdevApiKey,
    {
      url: opts.url,
      max_pages: opts.maxPages,
      ...(opts.includePaths?.length ? { include_paths: opts.includePaths } : {}),
    },
    CRAWL_DEADLINE_MS,
    opts.signal
  );

  // Handle different response shapes from context.dev
  let results: any[] = [];
  if (Array.isArray(data?.results)) {
    results = data.results;
  } else if (Array.isArray(data?.pages)) {
    results = data.pages;
  } else if (Array.isArray(data?.data)) {
    results = data.data;
  }

  return results
    .filter((r: any) => r && (r.markdown || r.content || r.text))
    .map((r: any) => ({
      url: String(r?.metadata?.url ?? r?.url ?? r?.uri ?? ""),
      title: String(r?.metadata?.title ?? r?.title ?? ""),
      markdown: String(r?.markdown ?? r?.content ?? r?.text ?? ""),
    }))
    .filter((p: any) => p.url && p.markdown);
}

async function deepcrawlCrawl(cfg: SwarmConfig, opts: CrawlOpts): Promise<CrawlPage[]> {
  const base = cfg.deepcrawlBaseUrl.replace(/\/+$/, "");
  const data = await callJson(
    "deepcrawl",
    `${base}/crawl`,
    cfg.deepcrawlApiKey,
    {
      url: opts.url,
      max_pages: opts.maxPages,
      ...(opts.includePaths?.length ? { include_paths: opts.includePaths } : {}),
    },
    CRAWL_DEADLINE_MS,
    opts.signal
  );
  // Accept either the context.dev-compatible shape or a flat pages[] list.
  if (Array.isArray(data?.results)) {
    return data.results.map((r: any) => ({
      url: String(r?.metadata?.url ?? r?.url ?? ""),
      title: String(r?.metadata?.title ?? r?.title ?? ""),
      markdown: String(r?.markdown ?? ""),
    }));
  }
  if (Array.isArray(data?.pages)) {
    return data.pages.map((p: any) => ({
      url: String(p?.url ?? ""),
      title: String(p?.title ?? ""),
      markdown: String(p?.markdown ?? p?.content ?? ""),
    }));
  }
  throw new Error("deepcrawl: unrecognized response shape (expected results[] or pages[])");
}

// ---------------------------------------------------------------- plumbing

function friendlyHttpError(service: string, status: number, body: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`${service} API key invalid or unauthorized (HTTP ${status}) — check Settings → Crawl integrations`);
  }
  if (status === 402) return new Error(`${service}: quota or credits exhausted (HTTP 402)`);
  if (status === 429) return new Error(`${service}: rate limited (HTTP 429) — retry later`);
  return new Error(`${service}: HTTP ${status} ${truncateMiddle(body, 300, "chars")}`);
}

async function callJson(
  service: string,
  url: string,
  key: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: mergeSignal(timeoutMs, signal),
  });
  if (!res.ok) throw friendlyHttpError(service, res.status, await res.text().catch(() => ""));
  return res.json();
}

async function getJson(service: string, url: string, key: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    signal: mergeSignal(30_000, signal),
  });
  if (!res.ok) throw friendlyHttpError(service, res.status, await res.text().catch(() => ""));
  return res.json();
}

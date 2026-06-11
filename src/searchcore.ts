/**
 * Native search intelligence, ported from the author's SearchKit project
 * (~/Code/searchkit): canonical-URL dedup, source classification, quality
 * ranking, and quotable-passage extraction. Pure string/URL processing —
 * no external services or processes; the engines that feed it live in
 * webtools.ts.
 */

export interface Passage {
  text: string;
  score: number;
}

export type SourceType = "primary" | "government" | "academic" | "news" | "social" | "secondary";

/** Lowercased alphanumeric query tokens, stopword-ish short tokens dropped. */
export function queryTerms(query: string): string[] {
  const m = query.toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(m.filter((t) => t.length > 2))];
}

/**
 * Generate multiple complementary query phrasings to widen source coverage:
 * the original, a stopword-stripped keyword core (different recall on most engines),
 * a docs/guide angle for question-shaped queries, a quoted phrase variant for
 * precision, and recency-boosted variants. Deterministic and low-noise — capped at `max`.
 */
export function expandQueries(query: string, max = 6): string[] {
  const base = query.trim();
  const out = [base];
  const terms = queryTerms(query);
  const core = terms.join(" ");
  const isQuestion = /^(how|what|why|when|which|where|who|is|are|can|does|do)\b/i.test(base);

  if (core && core.length > 4 && core !== base.toLowerCase()) out.push(core);
  if (isQuestion && terms.length) {
    out.push(`${core} guide`);
    // For questions, also add precision/recency variants to catch docs and recent releases
    if (core && terms.length >= 2) {
      out.push(`"${core}"`);
    }
    if (!/\b(19|20)\d{2}\b|year|date|when|time/.test(base.toLowerCase())) {
      out.push(`${core} 2024 OR 2025`);
    }
  }
  const seen = new Set<string>();
  return out.map((q) => q.trim()).filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, max);
}

/**
 * Fallback phrasing when a query returns nothing: strip quotes and search
 * operators down to the top keyword terms. Returns "" when no useful
 * simplification exists.
 */
export function reformulate(query: string): string {
  const cleaned = query
    .replace(/["'""'']/g, " ")
    .replace(/\b(site|intitle|inurl|filetype):\S+/gi, " ");
  const alt = queryTerms(cleaned).slice(0, 6).join(" ");
  return alt && alt !== query.toLowerCase().trim() ? alt : "";
}

/** Queries that smell academic trigger the scholarly engines in deep mode. */
export function looksAcademic(query: string): boolean {
  return /\b(paper|papers|study|studies|research|arxiv|doi|journal|peer.?review(ed)?|preprint|dataset|benchmark|survey|meta.?analysis|citations?|et al)\b/i.test(
    query
  );
}

const TRACKING_KEYS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

/** Stable canonical form for dedup: strip tracking params, www, trailing slash; sort the query. */
export function canonicalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.toLowerCase();
  }
  const pairs = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_KEYS.has(k.toLowerCase()) && !k.toLowerCase().startsWith("utm_")
  );
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = pairs.length ? "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&") : "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let path = u.pathname || "/";
  if (path !== "/") path = path.replace(/\/+$/, "");
  return `${u.protocol.toLowerCase()}//${host}${path}${query}`;
}

const ACADEMIC_HOSTS = [
  "arxiv.org",
  "doi.org",
  "semanticscholar.org",
  "ncbi.nlm.nih.gov",
  "nature.com",
  "sciencedirect.com",
  "springer.com",
  "link.springer.com",
  "scholar.google.com",
  "acm.org",
  "ieee.org",
];

export function classifySource(domain: string): SourceType {
  const d = domain.toLowerCase();
  if (d.endsWith(".gov") || d.endsWith(".mil")) return "government";
  if (d.endsWith(".edu")) return "academic";
  if (ACADEMIC_HOSTS.some((h) => d === h || d.endsWith("." + h))) return "academic";
  if (["twitter.com", "x.com", "reddit.com", "facebook.com"].some((s) => d.includes(s))) return "social";
  if (d.includes("news") || d.includes("reuters.com") || d.includes("apnews.com") || d.includes("bbc.")) return "news";
  return "secondary";
}

/** Recency boost from an ISO date or bare year: +3 <1y, +2 <2y, +1 <5y, 0 older/undated. */
export function freshnessBoost(date: string | undefined, now = Date.now()): number {
  if (!date) return 0;
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(date.trim());
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 6, m[3] ? Number(m[3]) : 15);
  const years = (now - t) / 31_557_600_000;
  if (years < 1) return 3;
  if (years < 2) return 2;
  if (years < 5) return 1;
  return 0;
}

/** ISO date if present, else a bare year. */
export function detectDate(text: string): string | undefined {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  const year = /\b(20\d{2})\b/.exec(text);
  return year?.[1];
}

const WINDOW_WORDS = 60;
const STRIDE = 30;

/**
 * Quotable passages: slide a 60-word window (stride 30) over the text and
 * score each window by the fraction of query terms it contains. Deterministic
 * lexical matching — no embeddings. Falls back to the lead window so a hit
 * always carries something quotable.
 */
export function selectPassages(text: string, query: string, maxPassages = 3): Passage[] {
  const body = text.trim();
  if (!body) return [];
  const terms = queryTerms(query);
  const tokens = [...body.matchAll(/\S+/g)];
  if (!tokens.length) return [];

  const windows: Passage[] = [];
  for (let i = 0; i < tokens.length; i += STRIDE) {
    const slice = tokens.slice(i, i + WINDOW_WORDS);
    const start = slice[0].index!;
    const last = slice[slice.length - 1];
    const chunk = body.slice(start, last.index! + last[0].length);
    windows.push({ text: chunk, score: scoreChunk(chunk, terms) });
    if (i + WINDOW_WORDS >= tokens.length) break;
  }

  const scored = windows.filter((w) => w.score > 0).sort((a, b) => b.score - a.score);
  const picked = (scored.length ? scored : windows).slice(0, maxPassages);
  return picked.map((p) => ({ text: p.text, score: Math.round(p.score * 10_000) / 10_000 }));
}

function scoreChunk(chunk: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lowered = chunk.toLowerCase();
  let hits = 0;
  for (const t of terms) if (lowered.includes(t)) hits++;
  return hits / terms.length;
}

export interface PageSignal {
  url: string;
  domain: string;
  title: string;
  text: string;
  date?: string;
}

/** Content-quality score for a fetched page (deep mode re-ranking). */
export function scorePage(page: PageSignal, terms: string[]): number {
  let score = 0;
  const domain = page.domain.toLowerCase();
  const url = page.url.toLowerCase();
  const title = page.title.toLowerCase();
  const type = classifySource(domain);
  if (type === "primary" || type === "government" || type === "academic") score += 5;
  if (domain.includes("docs") || url.includes("docs") || title.includes("documentation")) score += 5;
  if (domain === "github.com" || domain === "gitlab.com") score += 4;
  if (["pypi.org", "npmjs.com", "rubygems.org"].includes(domain)) score -= 2;
  score += freshnessBoost(page.date);
  const lowered = page.text.toLowerCase();
  for (const t of terms) if (lowered.includes(t)) score += 1;
  score += Math.min(page.text.length / 4000, 1);
  return score;
}

export interface Candidate {
  title: string;
  url: string;
  snippet: string;
  /** Position within its engine's result list (1-based). */
  rank: number;
  engine: string;
  date?: string;
}

const LOW_VALUE_SNIPPET = ["copy a direct link", "file metadata"];

/** Pre-fetch quality score for one engine result (snippet-level signals only). */
export function resultQualityScore(c: Candidate): number {
  const url = c.url.toLowerCase();
  const title = c.title.toLowerCase();
  const snippet = c.snippet.toLowerCase();
  let score = Math.max(0, 20 - c.rank);
  if (title.includes("official") || snippet.includes("official")) score += 4;
  if (title.includes("documentation") || snippet.includes("documentation") || url.includes("docs")) score += 4;
  if (url.includes("github.com") || url.includes("gitlab.com")) score += 3;
  if (c.engine === "arxiv" || c.engine === "crossref") score += 3;
  score += Math.min(2, freshnessBoost(c.date));
  if (LOW_VALUE_SNIPPET.some((t) => snippet.includes(t))) score -= 10;
  return score;
}

/**
 * Merge results from several engines: quality-rank, dedupe by canonical URL
 * (first/best occurrence wins), cap at maxResults.
 */
export function mergeCandidates(candidates: Candidate[], maxResults: number): Candidate[] {
  const ranked = [...candidates].sort((a, b) => resultQualityScore(b) - resultQualityScore(a));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of ranked) {
    const key = canonicalizeUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= maxResults) break;
  }
  return out;
}

/** Best-passage bonus used in deep-mode composite scoring. */
export function passageBonus(passages: Passage[]): number {
  return passages.length ? passages[0].score * 3 : 0;
}

/** Engine-rank decay bonus used in composite scoring. */
export function rankBonus(rank: number, ceiling: number): number {
  return Math.max(0, ceiling - rank) * 0.2;
}

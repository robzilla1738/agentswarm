import { SwarmConfig } from "./config";
import { errMsg, mergeSignal } from "./util";

/**
 * Forecasting data sources: prediction-market odds and statistical time
 * series. Same posture as webtools.ts — fan out with Promise.allSettled,
 * tolerate any single platform failing or changing its API, and return
 * token-lean text for the agent.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 agentswarm/0.1";

async function apiGet(url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json,text/csv,text/*;q=0.9", ...headers },
    signal: mergeSignal(20_000, signal),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// ---------------------------------------------------------------- prediction markets

export interface MarketHit {
  platform: "metaculus" | "manifold" | "polymarket" | "kalshi";
  title: string;
  url: string;
  /** Current crowd P(YES) in [0,1] when the platform exposes one. */
  probability?: number;
  /** Trading volume (USD-ish) where applicable. */
  volume?: number;
  /** Forecaster count (Metaculus). */
  forecasters?: number;
  /** Close/resolution date (ISO) when known. */
  closes?: string;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const isoDate = (v: unknown): string | undefined => {
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  if (typeof v !== "string" || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
};

/**
 * Metaculus — community predictions from a calibrated forecaster crowd.
 * Their API requires an account token (free); the marketOdds fanout only
 * includes this platform when one is configured.
 */
export async function metaculusSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<MarketHit[]> {
  if (!cfg.metaculusApiKey) throw new Error("metaculus needs an API token (free) — set metaculusApiKey in Settings");
  const res = await apiGet(
    `https://www.metaculus.com/api2/questions/?search=${encodeURIComponent(query)}&limit=${Math.min(count, 20)}&order_by=-activity`,
    signal,
    { authorization: `Token ${cfg.metaculusApiKey}` }
  );
  const data: any = await res.json();
  const out: MarketHit[] = [];
  for (const r of data?.results ?? []) {
    const title = String(r?.title ?? "").trim();
    if (!title) continue;
    // The API has reshaped its prediction field over time — try each known home.
    const probability =
      num(r?.question?.aggregations?.recency_weighted?.latest?.centers?.[0]) ??
      num(r?.community_prediction?.full?.q2) ??
      num(r?.question?.community_prediction?.full?.q2);
    out.push({
      platform: "metaculus",
      title,
      url: r?.page_url ? `https://www.metaculus.com${r.page_url}` : `https://www.metaculus.com/questions/${r?.id}/`,
      probability,
      forecasters: num(r?.nr_forecasters ?? r?.question?.nr_forecasters),
      closes: isoDate(r?.scheduled_close_time ?? r?.close_time ?? r?.question?.scheduled_close_time),
    });
  }
  return out;
}

/** Manifold Markets public API — play-money markets, but dense coverage and a real search endpoint. */
export async function manifoldSearch(query: string, count: number, signal?: AbortSignal): Promise<MarketHit[]> {
  const res = await apiGet(
    `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(query)}&limit=${Math.min(count, 20)}`,
    signal
  );
  const data: any = await res.json();
  const out: MarketHit[] = [];
  for (const m of Array.isArray(data) ? data : []) {
    if (!m?.question || !m?.url) continue;
    // Resolved/expired markets carry stale odds — only live ones are a crowd signal.
    if (m.isResolved === true || (num(m.closeTime) ?? Infinity) < Date.now()) continue;
    out.push({
      platform: "manifold",
      title: String(m.question),
      url: String(m.url),
      probability: m.outcomeType === "BINARY" ? num(m.probability) : undefined,
      volume: num(m.volume),
      closes: isoDate(m.closeTime),
    });
  }
  return out;
}

/** Polymarket Gamma API — real-money markets; outcomePrices arrives as a JSON string per market. */
export async function polymarketSearch(query: string, count: number, signal?: AbortSignal): Promise<MarketHit[]> {
  let events: any[] = [];
  try {
    const res = await apiGet(
      `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}&limit_per_type=${Math.min(count, 20)}`,
      signal
    );
    const data: any = await res.json();
    events = Array.isArray(data?.events) ? data.events : [];
  } catch {
    // Older filter-style endpoint as fallback when search is unavailable.
    const res = await apiGet(
      `https://gamma-api.polymarket.com/events?closed=false&limit=${Math.min(count, 20)}&title_contains=${encodeURIComponent(query)}`,
      signal
    );
    const data: any = await res.json();
    events = Array.isArray(data) ? data : [];
  }
  const out: MarketHit[] = [];
  for (const ev of events) {
    // public-search also surfaces long-closed events whose 0%/100% odds are
    // history, not a forecast — keep live markets only.
    if (ev?.closed === true) continue;
    const slug = String(ev?.slug ?? "");
    const markets = Array.isArray(ev?.markets) ? ev.markets.slice(0, 3) : [];
    for (const m of markets) {
      if (m?.closed === true) continue;
      const title = String(m?.question ?? ev?.title ?? "").trim();
      if (!title) continue;
      let probability: number | undefined;
      try {
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
        const yes = Array.isArray(outcomes) ? outcomes.findIndex((o: unknown) => String(o).toLowerCase() === "yes") : -1;
        if (Array.isArray(prices)) probability = num(prices[yes >= 0 ? yes : 0]);
      } catch {
        /* market without parseable prices still names the question */
      }
      out.push({
        platform: "polymarket",
        title,
        url: slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com",
        probability,
        volume: num(ev?.volume ?? m?.volume),
        closes: isoDate(m?.endDate ?? ev?.endDate),
      });
    }
  }
  return out;
}

/** Kalshi public market data — no text search, so filter open markets by title term overlap (best-effort). */
export async function kalshiSearch(query: string, count: number, signal?: AbortSignal): Promise<MarketHit[]> {
  const res = await apiGet("https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open", signal);
  const data: any = await res.json();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const scored: { hit: MarketHit; score: number }[] = [];
  for (const m of data?.markets ?? []) {
    const title = String(m?.title ?? "").trim();
    if (!title) continue;
    const hay = title.toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    if (score === 0) continue;
    const cents = num(m?.last_price);
    scored.push({
      score,
      hit: {
        platform: "kalshi",
        title,
        url: m?.event_ticker ? `https://kalshi.com/events/${String(m.event_ticker)}` : "https://kalshi.com",
        probability: cents !== undefined ? cents / 100 : undefined,
        volume: num(m?.volume),
        closes: isoDate(m?.close_time),
      },
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.hit.volume ?? 0) - (a.hit.volume ?? 0))
    .slice(0, count)
    .map((s) => s.hit);
}

/**
 * Query every prediction-market platform in parallel and merge by relevance.
 * One dead or reshaped API degrades coverage, never the call.
 */
export async function marketOdds(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal,
  warn?: (msg: string) => void
): Promise<MarketHit[]> {
  const per = Math.min(count, 12);
  const calls: Promise<MarketHit[]>[] = [
    manifoldSearch(query, per, signal),
    polymarketSearch(query, per, signal),
    kalshiSearch(query, per, signal),
  ];
  const names = ["manifold", "polymarket", "kalshi"];
  // Metaculus requires a (free) token — only fan out to it when keyed.
  if (cfg.metaculusApiKey) {
    calls.push(metaculusSearch(cfg, query, per, signal));
    names.push("metaculus");
  }
  const settled = await Promise.allSettled(calls);
  const hits: MarketHit[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") hits.push(...s.value);
    else warn?.(`${names[i]} odds lookup failed: ${errMsg(s.reason)}`);
  });
  if (!hits.length && settled.every((s) => s.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const relevance = (h: MarketHit) => {
    const hay = h.title.toLowerCase();
    return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
  };
  return hits
    .sort((a, b) => relevance(b) - relevance(a) || (b.volume ?? b.forecasters ?? 0) - (a.volume ?? a.forecasters ?? 0))
    .slice(0, count);
}

/** Tool-facing rendering: numbered list in the web_search style so the market URL is citable. */
export function formatMarketHits(hits: MarketHit[]): string {
  if (!hits.length) return "no matching markets found";
  return hits
    .map((h, i) => {
      const p = typeof h.probability === "number" ? `P(YES) ${(h.probability * 100).toFixed(0)}%` : "no live probability";
      const extras = [
        h.forecasters ? `${h.forecasters} forecasters` : undefined,
        h.volume ? `vol ${Math.round(h.volume).toLocaleString()}` : undefined,
        h.closes ? `closes ${h.closes}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return `${i + 1}. [${h.platform}] ${h.title}\n   ${p}${extras ? ` · ${extras}` : ""}\n   ${h.url}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- time series

export type TimeSeriesSource = "fred" | "worldbank" | "yahoo" | "gdelt";

export interface TimeSeriesResult {
  source: TimeSeriesSource;
  series: string;
  points: { date: string; value: number }[];
  /** Human framing for the series (indicator name, ticker, query). */
  label: string;
  unit?: string;
}

/** FRED (St. Louis Fed) — economic series; needs the free fredApiKey. */
async function fredSeries(
  cfg: SwarmConfig,
  series: string,
  start?: string,
  end?: string,
  signal?: AbortSignal
): Promise<TimeSeriesResult> {
  if (!cfg.fredApiKey) {
    throw new Error(
      "FRED needs an API key — get a free one at https://fred.stlouisfed.org/docs/api/api_key.html and set fredApiKey in Settings (swarm config set fredApiKey <key>). Meanwhile, worldbank and yahoo work keyless."
    );
  }
  const params = new URLSearchParams({ series_id: series, api_key: cfg.fredApiKey, file_type: "json" });
  if (start) params.set("observation_start", start);
  if (end) params.set("observation_end", end);
  const res = await apiGet(`https://api.stlouisfed.org/fred/series/observations?${params}`, signal);
  const data: any = await res.json();
  const points = (data?.observations ?? [])
    .map((o: any) => ({ date: String(o.date), value: Number(o.value) }))
    .filter((p: { value: number }) => Number.isFinite(p.value));
  return { source: "fred", series, points, label: `FRED ${series}` };
}

/** World Bank — country indicators, keyless. Series form: INDICATOR:COUNTRY, e.g. NY.GDP.MKTP.CD:US. */
async function worldbankSeries(
  series: string,
  start?: string,
  end?: string,
  signal?: AbortSignal
): Promise<TimeSeriesResult> {
  const [indicator, country = "WLD"] = series.split(":");
  if (!indicator) throw new Error("worldbank series must be INDICATOR:COUNTRY, e.g. NY.GDP.MKTP.CD:US");
  const range = `${(start ?? "1990").slice(0, 4)}:${(end ?? String(new Date().getFullYear())).slice(0, 4)}`;
  const res = await apiGet(
    `https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=2000&date=${range}`,
    signal
  );
  const data: any = await res.json();
  const rows = Array.isArray(data?.[1]) ? data[1] : [];
  const points = rows
    .map((r: any) => ({ date: String(r.date), value: Number(r.value) }))
    .filter((p: { value: number }) => Number.isFinite(p.value))
    .reverse(); // API returns newest-first
  const label = rows[0]?.indicator?.value ? `${rows[0].indicator.value} (${country})` : `World Bank ${series}`;
  return { source: "worldbank", series, points, label };
}

/** Yahoo Finance chart API — daily market data, keyless. Symbols like AAPL, ^GSPC, EURUSD=X, BTC-USD. */
async function yahooSeries(series: string, start?: string, end?: string, signal?: AbortSignal): Promise<TimeSeriesResult> {
  const symbol = series.trim().toUpperCase();
  const params = new URLSearchParams({ interval: "1d" });
  if (start) {
    params.set("period1", String(Math.floor(Date.parse(start) / 1000)));
    params.set("period2", String(end ? Math.floor(Date.parse(end) / 1000) + 86_400 : Math.floor(Date.now() / 1000)));
  } else {
    params.set("range", "1y");
  }
  // Two interchangeable hosts; a 429/403 on one is often transient per-host throttling.
  let res: Response;
  try {
    res = await apiGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, signal);
  } catch {
    try {
      res = await apiGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, signal);
    } catch (e2) {
      // Yahoo rate-limits per IP in short windows. Hand the agent a way
      // forward instead of a bare status code.
      throw new Error(
        `yahoo is throttling or unavailable right now (${errMsg(e2)}) — retry in a minute, or use source "fred" (e.g. SP500, DJIA, NASDAQCOM, VIXCLS series) or "worldbank" instead`
      );
    }
  }
  const data: any = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(
      `yahoo returned no data for "${series}"${data?.chart?.error?.description ? ` (${data.chart.error.description})` : ""} — symbol examples: AAPL, ^GSPC, EURUSD=X, BTC-USD`
    );
  }
  const ts: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes: unknown[] = result.indicators?.quote?.[0]?.close ?? [];
  const points = ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: Number(closes[i]) }))
    .filter((p) => Number.isFinite(p.value));
  return {
    source: "yahoo",
    series: symbol,
    points,
    label: `${result.meta?.longName || result.meta?.shortName || symbol} daily close`,
    unit: result.meta?.currency || undefined,
  };
}

/** GDELT timeline volume — news-coverage intensity for a query, keyless. Series = the search query. */
async function gdeltSeries(series: string, start?: string, end?: string, signal?: AbortSignal): Promise<TimeSeriesResult> {
  const params = new URLSearchParams({ query: series, mode: "timelinevol", format: "json" });
  if (start && end) {
    params.set("startdatetime", start.replace(/-/g, "") + "000000");
    params.set("enddatetime", end.replace(/-/g, "") + "235959");
  } else {
    params.set("timespan", "12m");
  }
  const res = await apiGet(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, signal);
  const data: any = await res.json();
  const raw = data?.timeline?.[0]?.data ?? [];
  const points = raw
    .map((d: any) => ({ date: String(d.date ?? "").slice(0, 10).replace(/^(\d{4})(\d{2})(\d{2}).*$/, "$1-$2-$3"), value: Number(d.value) }))
    .filter((p: { date: string; value: number }) => p.date && Number.isFinite(p.value));
  return { source: "gdelt", series, points, label: `News volume: "${series}"`, unit: "% of coverage" };
}

export async function timeSeries(
  cfg: SwarmConfig,
  source: TimeSeriesSource,
  series: string,
  start?: string,
  end?: string,
  signal?: AbortSignal
): Promise<TimeSeriesResult> {
  switch (source) {
    case "fred":
      return fredSeries(cfg, series, start, end, signal);
    case "worldbank":
      return worldbankSeries(series, start, end, signal);
    case "yahoo":
      return yahooSeries(series, start, end, signal);
    case "gdelt":
      return gdeltSeries(series, start, end, signal);
    default:
      throw new Error(`unknown source "${source}" — use fred | worldbank | yahoo | gdelt`);
  }
}

export interface OlsProjection {
  /** Change per day over the fitted window. */
  slopePerDay: number;
  /** Projected value at the target date. */
  projected: number;
  /** ~80% band from the fit's residuals (±1.28σ). */
  lo: number;
  hi: number;
  /** Days from the last observation to the target. */
  daysAhead: number;
}

/**
 * Ordinary least squares over the full series (x = days since the first
 * point), naively projected to a target date with an ~80% residual band.
 * Deterministic trend math the agent can cite instead of narrating "momentum"
 * — a baseline, not destiny. Returns null when a line can't be fit
 * (fewer than 2 points, or no time variance).
 */
export function olsProject(points: { date: string; value: number }[], targetDate: string): OlsProjection | null {
  if (points.length < 2 || !/^\d{4}-\d{2}-\d{2}/.test(targetDate)) return null;
  const t0 = Date.parse(points[0].date);
  const target = Date.parse(targetDate);
  if (!Number.isFinite(t0) || !Number.isFinite(target)) return null;
  const DAY = 86_400_000;
  const xs = points.map((p) => (Date.parse(p.date) - t0) / DAY);
  const ys = points.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ssr += r * r;
  }
  const sigma = n > 2 ? Math.sqrt(ssr / (n - 2)) : 0;
  const xTarget = (target - t0) / DAY;
  const projected = intercept + slope * xTarget;
  const band = 1.28 * sigma;
  return {
    slopePerDay: slope,
    projected,
    lo: projected - band,
    hi: projected + band,
    daysAhead: Math.round(xTarget - xs[n - 1]),
  };
}

/** Evenly thin a series to at most n points (always keeping the last). */
function thin<T>(points: T[], n: number): T[] {
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * Token-lean rendering: a stats header, the recent tail, an optional OLS
 * trend projection, and a ready-made ```chart block the agent can paste into
 * a report or artifact verbatim.
 */
export function formatTimeSeries(r: TimeSeriesResult, projectTo?: string): string {
  if (!r.points.length) return `${r.label}: no observations in range`;
  const values = r.points.map((p) => p.value);
  const first = r.points[0];
  const last = r.points[r.points.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const delta = last.value - first.value;
  const deltaPct = first.value !== 0 ? ` (${((delta / Math.abs(first.value)) * 100).toFixed(1)}%)` : "";
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toPrecision(4))));
  const headerLines = [
    `${r.label} — ${r.points.length} observations, ${first.date} → ${last.date}${r.unit ? ` (${r.unit})` : ""}`,
    `latest ${fmt(last.value)} (${last.date}) · change over window ${delta >= 0 ? "+" : ""}${fmt(delta)}${deltaPct} · min ${fmt(min)} · max ${fmt(max)}`,
  ];
  if (r.source === "gdelt") {
    headerLines.push("NOTE: news volume measures ATTENTION, not probability — high coverage is not evidence the event will happen.");
  }
  if (projectTo) {
    const proj = olsProject(r.points, projectTo);
    headerLines.push(
      proj
        ? `OLS trend: ${proj.slopePerDay >= 0 ? "+" : ""}${fmt(proj.slopePerDay)}/day over the window · naive projection to ${projectTo} (${proj.daysAhead}d ahead): ${fmt(proj.projected)} (80% residual band ${fmt(proj.lo)}–${fmt(proj.hi)}) — a trend baseline, not destiny.`
        : `OLS trend: not fittable for projection to ${projectTo} (need ≥2 dated observations with time variance).`
    );
  }
  const header = headerLines.join("\n");
  const tail = r.points
    .slice(-24)
    .map((p) => `${p.date}  ${fmt(p.value)}`)
    .join("\n");
  const chartPts = thin(r.points, 24);
  const chart = JSON.stringify({
    type: "line",
    title: r.label,
    ...(r.unit ? { unit: r.unit } : {}),
    labels: chartPts.map((p) => p.date),
    series: [{ name: r.series, values: chartPts.map((p) => Number(p.value.toPrecision(6))) }],
  });
  return `${header}\n\nRECENT OBSERVATIONS\n${tail}\n\nChart block (paste into a markdown artifact to render):\n\`\`\`chart\n${chart}\n\`\`\``;
}

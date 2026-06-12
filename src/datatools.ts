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
  platform: "metaculus" | "manifold" | "polymarket" | "kalshi" | "sportsbook";
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
  /** Platform-native id (market id, ticker, question id) — lets the engine re-fetch this exact market later. */
  externalId?: string;
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
      externalId: r?.id !== undefined ? String(r.id) : undefined,
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
      externalId: m.id ? String(m.id) : undefined,
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
        externalId: m?.id !== undefined ? String(m.id) : undefined,
      });
    }
  }
  return out;
}

/**
 * Kalshi's API has drifted from integer cents (last_price) to dollar strings
 * (last_price_dollars) — read whichever is populated. Returns P(YES) in [0,1].
 */
export function kalshiPrice(m: any): number | undefined {
  const dollars = num(m?.last_price_dollars);
  if (dollars !== undefined && dollars > 0) return Math.min(1, dollars);
  const cents = num(m?.last_price);
  if (cents !== undefined && cents > 0) return Math.min(1, cents / 100);
  // No trade yet: midpoint of the live book when one exists.
  const bid = num(m?.yes_bid_dollars) ?? (num(m?.yes_bid) !== undefined ? num(m.yes_bid)! / 100 : undefined);
  const ask = num(m?.yes_ask_dollars) ?? (num(m?.yes_ask) !== undefined ? num(m.yes_ask)! / 100 : undefined);
  if (bid !== undefined && ask !== undefined && bid > 0 && ask < 1) return (bid + ask) / 2;
  return undefined;
}

function kalshiVolume(m: any): number | undefined {
  return num(m?.volume) ?? num(m?.volume_fp) ?? num(m?.volume_24h_fp) ?? num(m?.open_interest_fp);
}

/** Auto-generated multivariate parlays flood Kalshi's market listing — they are combinations, not questions. */
function kalshiIsParlay(m: any): boolean {
  return Boolean(m?.mve_collection_ticker || m?.custom_strike || m?.is_provisional === true);
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
    if (!title || kalshiIsParlay(m)) continue;
    const hay = title.toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    if (score === 0) continue;
    scored.push({
      score,
      hit: {
        platform: "kalshi",
        title,
        url: m?.event_ticker ? `https://kalshi.com/events/${String(m.event_ticker)}` : "https://kalshi.com",
        probability: kalshiPrice(m),
        volume: kalshiVolume(m),
        closes: isoDate(m?.close_time),
        externalId: m?.ticker ? String(m.ticker) : undefined,
      },
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.hit.volume ?? 0) - (a.hit.volume ?? 0))
    .slice(0, count)
    .map((s) => s.hit);
}

/**
 * Strip the bookmaker's margin from decimal odds: implied probabilities
 * 1/odds normalized to sum 1 across the outcome set.
 */
export function devigProbs(decimalOdds: number[]): number[] {
  const inv = decimalOdds.map((o) => (o > 1 ? 1 / o : 0));
  const sum = inv.reduce((s, v) => s + v, 0);
  return sum > 0 ? inv.map((v) => v / sum) : inv;
}

/**
 * Sportsbook consensus via The Odds API (free tier, optional key): upcoming
 * events with head-to-head prices, de-vigged and averaged across bookmakers.
 * Sharp sportsbook lines are the strongest probability source in sports.
 */
export async function sportsbookSearch(
  cfg: SwarmConfig,
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<MarketHit[]> {
  if (!cfg.oddsApiKey) throw new Error("sportsbook odds need an API key (free) — set oddsApiKey in Settings");
  const res = await apiGet(
    `https://api.the-odds-api.com/v4/sports/upcoming/odds?regions=us,uk,eu&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(cfg.oddsApiKey)}`,
    signal
  );
  const data: any = await res.json();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const out: { hit: MarketHit; score: number }[] = [];
  for (const ev of Array.isArray(data) ? data : []) {
    const home = String(ev?.home_team ?? "");
    const away = String(ev?.away_team ?? "");
    const sport = String(ev?.sport_title ?? "");
    const hay = `${home} ${away} ${sport}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    if (score === 0) continue;
    // De-vig each bookmaker's h2h market, then average per outcome.
    const sums = new Map<string, { sum: number; n: number }>();
    for (const bk of ev?.bookmakers ?? []) {
      const h2h = (bk?.markets ?? []).find((m: any) => m?.key === "h2h");
      const outcomes = Array.isArray(h2h?.outcomes) ? h2h.outcomes : [];
      const prices = outcomes.map((o: any) => Number(o?.price));
      if (!prices.length || prices.some((p: number) => !Number.isFinite(p) || p <= 1)) continue;
      const probs = devigProbs(prices);
      outcomes.forEach((o: any, i: number) => {
        const key = String(o?.name ?? "");
        const cur = sums.get(key) ?? { sum: 0, n: 0 };
        cur.sum += probs[i];
        cur.n++;
        sums.set(key, cur);
      });
    }
    if (!sums.size) continue;
    // The hit's P(YES) is the outcome the query names; otherwise the favorite.
    const named = [...sums.keys()].find((name) => {
      const lower = name.toLowerCase();
      return terms.some((t) => lower.includes(t));
    });
    const ranked = [...sums.entries()].sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n);
    const pick = named ? ([named, sums.get(named)!] as const) : ranked[0];
    out.push({
      score,
      hit: {
        platform: "sportsbook",
        title: `${sport}: ${away} @ ${home} — P(${pick[0]} wins)`,
        url: "https://the-odds-api.com",
        probability: pick[1].sum / pick[1].n,
        closes: isoDate(ev?.commence_time),
        externalId: ev?.id ? String(ev.id) : undefined,
      },
    });
  }
  return out
    .sort((a, b) => b.score - a.score)
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
  // Sportsbook consensus (The Odds API) — only when keyed.
  if (cfg.oddsApiKey) {
    calls.push(sportsbookSearch(cfg, query, per, signal));
    names.push("sportsbook");
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

// ---------------------------------------------------------------- tournament (question import + platform resolution)

export type TournamentSource = "manifold" | "polymarket" | "kalshi" | "metaculus";
export const TOURNAMENT_SOURCES: TournamentSource[] = ["manifold", "polymarket", "kalshi", "metaculus"];

/** An open market question importable as a forecast (binary, live price, known close). */
export interface TournamentQuestion {
  platform: TournamentSource;
  externalId: string;
  title: string;
  url: string;
  /** The market's P(YES) at import — the benchmark the swarm is later scored against. */
  probability: number;
  volume?: number;
  /** ISO date the question closes/resolves. */
  closes: string;
  /** Platform description text, when the listing carries one (folded into resolution criteria). */
  criteria?: string;
}

const dayMs = 86_400_000;

function withinWindow(closes: string | undefined, withinDays: number, now: number): closes is string {
  if (!closes) return false;
  const t = Date.parse(`${closes}T23:59:59Z`);
  return Number.isFinite(t) && t > now && t <= now + withinDays * dayMs;
}

/**
 * Pure mappers (exported for tests): raw platform JSON → importable questions.
 * Each is defensive about shape — a reshaped API degrades to zero hits, never
 * a crash — and applies a light activity floor so junk markets stay out.
 */
export function tournamentFromManifold(data: unknown, withinDays: number, now = Date.now()): TournamentQuestion[] {
  const out: TournamentQuestion[] = [];
  for (const m of Array.isArray(data) ? (data as any[]) : []) {
    if (!m?.id || !m?.question || m.isResolved === true || m.outcomeType !== "BINARY") continue;
    const p = num(m.probability);
    const closes = isoDate(m.closeTime);
    if (p === undefined || !withinWindow(closes, withinDays, now)) continue;
    // Manifold is open-creation: require real participation before a market
    // counts as a crowd signal worth forecasting against.
    if ((num(m.uniqueBettorCount) ?? 0) < 10 && (num(m.volume) ?? 0) < 500) continue;
    out.push({
      platform: "manifold",
      externalId: String(m.id),
      title: String(m.question),
      url: String(m.url ?? `https://manifold.markets/market/${m.id}`),
      probability: p,
      volume: num(m.volume),
      closes,
      criteria: m.textDescription ? String(m.textDescription).slice(0, 600) : undefined,
    });
  }
  return out;
}

export function tournamentFromKalshi(data: unknown, withinDays: number, now = Date.now()): TournamentQuestion[] {
  const out: TournamentQuestion[] = [];
  for (const m of (data as any)?.markets ?? []) {
    if (!m?.ticker || !m?.title || kalshiIsParlay(m)) continue;
    const p = kalshiPrice(m);
    const closes = isoDate(m.close_time);
    if (p === undefined || p < 0.02 || p > 0.98 || !withinWindow(closes, withinDays, now)) continue;
    if ((kalshiVolume(m) ?? 0) < 50) continue;
    // Strike markets share one title across strikes ("How many dissents?") —
    // the YES sub-title carries the strike that makes the question precise.
    const sub = m.yes_sub_title ? ` — ${String(m.yes_sub_title)}` : "";
    out.push({
      platform: "kalshi",
      externalId: String(m.ticker),
      title: `${String(m.title)}${sub}`,
      url: m.event_ticker ? `https://kalshi.com/events/${String(m.event_ticker)}` : "https://kalshi.com",
      probability: p,
      volume: kalshiVolume(m),
      closes,
      criteria: m.rules_primary ? String(m.rules_primary).slice(0, 600) : undefined,
    });
  }
  return out;
}

export function tournamentFromPolymarket(data: unknown, withinDays: number, now = Date.now()): TournamentQuestion[] {
  const out: TournamentQuestion[] = [];
  for (const m of Array.isArray(data) ? (data as any[]) : []) {
    if (m?.id === undefined || !m?.question || m.closed === true) continue;
    const closes = isoDate(m.endDate);
    if (!withinWindow(closes, withinDays, now)) continue;
    let probability: number | undefined;
    try {
      const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
      if (!Array.isArray(outcomes) || outcomes.length !== 2) continue; // binary YES/NO markets only
      const yes = outcomes.findIndex((o: unknown) => String(o).toLowerCase() === "yes");
      if (yes < 0 || !Array.isArray(prices)) continue;
      probability = num(prices[yes]);
    } catch {
      continue;
    }
    // A price pinned at the extremes is a settled question still listed as open.
    if (probability === undefined || probability < 0.02 || probability > 0.98) continue;
    if ((num(m.volumeNum) ?? num(m.volume) ?? 0) < 100) continue;
    out.push({
      platform: "polymarket",
      externalId: String(m.id),
      title: String(m.question),
      url: m.slug ? `https://polymarket.com/market/${String(m.slug)}` : "https://polymarket.com",
      probability,
      volume: num(m.volumeNum) ?? num(m.volume),
      closes,
      criteria: m.description ? String(m.description).slice(0, 600) : undefined,
    });
  }
  return out;
}

export function tournamentFromMetaculus(data: unknown, withinDays: number, now = Date.now()): TournamentQuestion[] {
  const out: TournamentQuestion[] = [];
  for (const r of (data as any)?.results ?? []) {
    const title = String(r?.title ?? "").trim();
    if (!title || r?.id === undefined) continue;
    const probability =
      num(r?.question?.aggregations?.recency_weighted?.latest?.centers?.[0]) ??
      num(r?.community_prediction?.full?.q2) ??
      num(r?.question?.community_prediction?.full?.q2);
    // Metaculus closes forecasting before it resolves — the resolve time is
    // the date the ledger can actually be scored on.
    const closes = isoDate(
      r?.scheduled_resolve_time ?? r?.question?.scheduled_resolve_time ?? r?.scheduled_close_time ?? r?.close_time
    );
    if (probability === undefined || !withinWindow(closes, withinDays, now)) continue;
    if ((num(r?.nr_forecasters ?? r?.question?.nr_forecasters) ?? 0) < 10) continue;
    out.push({
      platform: "metaculus",
      externalId: String(r.id),
      title,
      url: r?.page_url ? `https://www.metaculus.com${r.page_url}` : `https://www.metaculus.com/questions/${r.id}/`,
      probability,
      volume: undefined,
      closes,
      criteria: r?.question?.resolution_criteria ? String(r.question.resolution_criteria).slice(0, 600) : undefined,
    });
  }
  return out;
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * List open binary questions closing within the window across the chosen
 * platforms, soonest first. Tournament mode forecasts these to grow the
 * calibration ledger fast — questions that resolve in days, not months.
 */
export async function listClosingQuestions(
  cfg: SwarmConfig,
  sources: TournamentSource[],
  opts: { withinDays: number; count: number },
  signal?: AbortSignal,
  warn?: (msg: string) => void
): Promise<TournamentQuestion[]> {
  const now = Date.now();
  const calls: Promise<TournamentQuestion[]>[] = [];
  const names: string[] = [];
  if (sources.includes("manifold")) {
    names.push("manifold");
    calls.push(
      apiGet(
        "https://api.manifold.markets/v0/search-markets?term=&filter=open&contractType=BINARY&sort=close-date&limit=100",
        signal
      )
        .then((r) => r.json())
        .then((d) => tournamentFromManifold(d, opts.withinDays, now))
    );
  }
  if (sources.includes("kalshi")) {
    names.push("kalshi");
    // The /markets stream is dominated by auto-generated parlays; page a few
    // cursors so real questions in the window have a chance to surface.
    const kalshiPages = async (): Promise<TournamentQuestion[]> => {
      const acc: TournamentQuestion[] = [];
      let cursor = "";
      for (let page = 0; page < 4 && acc.length < opts.count; page++) {
        const res = await apiGet(
          `https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open&max_close_ts=${Math.floor((now + opts.withinDays * dayMs) / 1000)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          signal
        );
        const d: any = await res.json();
        acc.push(...tournamentFromKalshi(d, opts.withinDays, now));
        cursor = String(d?.cursor ?? "");
        if (!cursor || !(d?.markets ?? []).length) break;
      }
      return acc;
    };
    calls.push(kalshiPages());
  }
  if (sources.includes("polymarket")) {
    names.push("polymarket");
    // Volume-ordered with the window bounded server-side: the most liquid
    // real questions, not the hourly crypto chaff that leads endDate order.
    calls.push(
      apiGet(
        `https://gamma-api.polymarket.com/markets?closed=false&limit=200&order=volumeNum&ascending=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + opts.withinDays * dayMs).toISOString()}`,
        signal
      )
        .then((r) => r.json())
        .then((d) => tournamentFromPolymarket(d, opts.withinDays, now))
    );
  }
  if (sources.includes("metaculus") && cfg.metaculusApiKey) {
    names.push("metaculus");
    calls.push(
      apiGet(
        "https://www.metaculus.com/api2/questions/?status=open&forecast_type=binary&order_by=scheduled_resolve_time&limit=100",
        signal,
        { authorization: `Token ${cfg.metaculusApiKey}` }
      )
        .then((r) => r.json())
        .then((d) => tournamentFromMetaculus(d, opts.withinDays, now))
    );
  }
  const settled = await Promise.allSettled(calls);
  const hits: TournamentQuestion[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") hits.push(...s.value);
    else warn?.(`${names[i]} question listing failed: ${errMsg(s.reason)}`);
  });
  // Cross-platform dedupe by normalized title — the same event listed on two
  // platforms is one question; keep the higher-volume listing.
  const byTitle = new Map<string, TournamentQuestion>();
  for (const h of hits) {
    const key = normTitle(h.title);
    const prev = byTitle.get(key);
    if (!prev || (h.volume ?? 0) > (prev.volume ?? 0)) byTitle.set(key, h);
  }
  // Round-robin across platforms (each platform's list soonest-closing first):
  // volume scales differ wildly between platforms, so a global volume sort
  // would let one platform crowd out the rest.
  const perPlatform = new Map<string, TournamentQuestion[]>();
  for (const h of [...byTitle.values()].sort(
    (a, b) => a.closes.localeCompare(b.closes) || (b.volume ?? 0) - (a.volume ?? 0)
  )) {
    const list = perPlatform.get(h.platform) ?? [];
    list.push(h);
    perPlatform.set(h.platform, list);
  }
  const lists = [...perPlatform.values()];
  const merged: TournamentQuestion[] = [];
  for (let i = 0; merged.length < opts.count; i++) {
    let any = false;
    for (const list of lists) {
      if (i < list.length && merged.length < opts.count) {
        merged.push(list[i]);
        any = true;
      }
    }
    if (!any) break;
  }
  return merged;
}

export interface PlatformResolution {
  outcome: 0 | 1 | "void";
  evidence: string;
}

/**
 * Pure mapper (exported for tests): a platform's market-detail JSON → a hard
 * outcome, or null when the platform hasn't cleanly resolved it yet (partial
 * resolutions like Manifold's resolve-to-probability stay null — an operator
 * or resolution agent judges those).
 */
export function platformOutcome(platform: TournamentSource, data: unknown): PlatformResolution | null {
  const d = data as any;
  if (platform === "manifold") {
    if (d?.isResolved !== true) return null;
    const r = String(d.resolution ?? "").toUpperCase();
    if (r === "YES") return { outcome: 1, evidence: "Manifold resolved YES" };
    if (r === "NO") return { outcome: 0, evidence: "Manifold resolved NO" };
    if (r === "CANCEL") return { outcome: "void", evidence: "Manifold cancelled the market" };
    return null;
  }
  if (platform === "kalshi") {
    const m = d?.market ?? d;
    const r = String(m?.result ?? "").toLowerCase();
    if (r === "yes") return { outcome: 1, evidence: "Kalshi settled YES" };
    if (r === "no") return { outcome: 0, evidence: "Kalshi settled NO" };
    return null;
  }
  if (platform === "polymarket") {
    if (d?.closed !== true) return null;
    try {
      const prices = typeof d.outcomePrices === "string" ? JSON.parse(d.outcomePrices) : d.outcomePrices;
      const outcomes = typeof d.outcomes === "string" ? JSON.parse(d.outcomes) : d.outcomes;
      const yes = Array.isArray(outcomes) ? outcomes.findIndex((o: unknown) => String(o).toLowerCase() === "yes") : -1;
      const p = yes >= 0 && Array.isArray(prices) ? num(prices[yes]) : undefined;
      if (p === undefined) return null;
      if (p >= 0.99) return { outcome: 1, evidence: "Polymarket settled YES (YES share at $1)" };
      if (p <= 0.01) return { outcome: 0, evidence: "Polymarket settled NO (YES share at $0)" };
    } catch {
      return null;
    }
    return null;
  }
  if (platform === "metaculus") {
    const q = d?.question ?? d;
    const r = q?.resolution;
    if (r === 1 || r === 1.0 || r === "yes") return { outcome: 1, evidence: "Metaculus resolved YES" };
    if (r === 0 || r === "no") return { outcome: 0, evidence: "Metaculus resolved NO" };
    if (r === -1 || r === "annulled" || r === "ambiguous") {
      return { outcome: "void", evidence: "Metaculus annulled the question" };
    }
    return null;
  }
  return null;
}

/**
 * Ground-truth resolution for a tournament question: ask the source platform
 * what actually happened. Null = not resolved yet (or the API call failed) —
 * the caller falls back to a resolution agent or leaves the forecast open.
 */
export async function resolveFromPlatform(
  cfg: SwarmConfig,
  origin: { platform: TournamentSource; externalId: string; url: string },
  signal?: AbortSignal
): Promise<PlatformResolution | null> {
  const id = encodeURIComponent(origin.externalId);
  let data: unknown;
  switch (origin.platform) {
    case "manifold":
      data = await (await apiGet(`https://api.manifold.markets/v0/market/${id}`, signal)).json();
      break;
    case "kalshi":
      data = await (await apiGet(`https://api.elections.kalshi.com/trade-api/v2/markets/${id}`, signal)).json();
      break;
    case "polymarket":
      data = await (await apiGet(`https://gamma-api.polymarket.com/markets/${id}`, signal)).json();
      break;
    case "metaculus": {
      if (!cfg.metaculusApiKey) return null;
      data = await (
        await apiGet(`https://www.metaculus.com/api2/questions/${id}/`, signal, {
          authorization: `Token ${cfg.metaculusApiKey}`,
        })
      ).json();
      break;
    }
    default:
      return null;
  }
  const out = platformOutcome(origin.platform, data);
  return out ? { ...out, evidence: `${out.evidence} — ${origin.url}` } : null;
}

// ---------------------------------------------------------------- time series

export type TimeSeriesSource = "fred" | "worldbank" | "yahoo" | "gdelt" | "gdelttone" | "openmeteo" | "nws";

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

/** GDELT timelines, keyless. Series = the search query; volume measures attention, tone measures sentiment valence. */
async function gdeltSeries(
  series: string,
  start?: string,
  end?: string,
  signal?: AbortSignal,
  mode: "timelinevol" | "timelinetone" = "timelinevol"
): Promise<TimeSeriesResult> {
  const params = new URLSearchParams({ query: series, mode, format: "json" });
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
  return mode === "timelinetone"
    ? { source: "gdelttone", series, points, label: `News tone: "${series}"`, unit: "avg tone (−10 dire … +10 glowing)" }
    : { source: "gdelt", series, points, label: `News volume: "${series}"`, unit: "% of coverage" };
}

/**
 * Open-Meteo, keyless: daily weather series for a coordinate. Series form
 * "lat,lon[,variable]" (default temperature_2m_max; e.g. precipitation_sum,
 * snowfall_sum, wind_speed_10m_max). Past dates come from the ERA5 archive —
 * which is how a weather base rate becomes a COUNTED frequency — and the
 * forecast endpoint covers the next 16 days.
 */
async function openmeteoSeries(series: string, start?: string, end?: string, signal?: AbortSignal): Promise<TimeSeriesResult> {
  const [latRaw, lonRaw, variable = "temperature_2m_max"] = series.split(",").map((s) => s.trim());
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('openmeteo series must be "lat,lon[,daily_variable]", e.g. "39.74,-104.99,snowfall_sum"');
  }
  const today = new Date().toISOString().slice(0, 10);
  const historical = Boolean(start && start < today);
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: variable,
    timezone: "UTC",
  });
  let url: string;
  if (historical) {
    params.set("start_date", start!);
    params.set("end_date", end && end < today ? end : today);
    url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  } else {
    params.set("forecast_days", "16");
    url = `https://api.open-meteo.com/v1/forecast?${params}`;
  }
  const res = await apiGet(url, signal);
  const data: any = await res.json();
  const dates: string[] = data?.daily?.time ?? [];
  const values: unknown[] = data?.daily?.[variable] ?? [];
  if (!dates.length) {
    throw new Error(
      `open-meteo returned no data for "${series}"${data?.reason ? ` (${data.reason})` : ""} — check the variable name (daily variables like temperature_2m_max, precipitation_sum, snowfall_sum)`
    );
  }
  const points = dates
    .map((d, i) => ({ date: String(d).slice(0, 10), value: Number(values[i]) }))
    .filter((p) => Number.isFinite(p.value));
  return {
    source: "openmeteo",
    series,
    points,
    label: `${variable} at ${lat},${lon} (${historical ? "ERA5 archive" : "16-day forecast"})`,
    unit: data?.daily_units?.[variable] ? String(data.daily_units[variable]) : undefined,
  };
}

/** NWS (api.weather.gov), keyless, US only: official hourly temperature forecast for a point. Series = "lat,lon". */
async function nwsSeries(series: string, signal?: AbortSignal): Promise<TimeSeriesResult> {
  const [latRaw, lonRaw] = series.split(",").map((s) => s.trim());
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('nws series must be "lat,lon" (US only)');
  const pt: any = await (
    await apiGet(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, signal, { accept: "application/geo+json" })
  ).json();
  const fcUrl = pt?.properties?.forecastHourly;
  if (!fcUrl) throw new Error("NWS has no forecast for that point (US coverage only — use openmeteo elsewhere)");
  const fc: any = await (await apiGet(String(fcUrl), signal, { accept: "application/geo+json" })).json();
  const periods = fc?.properties?.periods ?? [];
  const points = periods
    .map((p: any) => ({ date: String(p.startTime ?? "").slice(0, 16).replace("T", " "), value: Number(p.temperature) }))
    .filter((p: { value: number }) => Number.isFinite(p.value));
  if (!points.length) throw new Error("NWS returned no forecast periods");
  return {
    source: "nws",
    series,
    points,
    label: `NWS hourly temperature forecast at ${lat},${lon}`,
    unit: periods[0]?.temperatureUnit === "C" ? "°C" : "°F",
  };
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
    case "gdelttone":
      return gdeltSeries(series, start, end, signal, "timelinetone");
    case "openmeteo":
      return openmeteoSeries(series, start, end, signal);
    case "nws":
      return nwsSeries(series, signal);
    default:
      throw new Error(`unknown source "${source}" — use fred | worldbank | yahoo | gdelt | gdelttone | openmeteo | nws`);
  }
}

export interface OlsProjection {
  /** Change per day over the fitted window. */
  slopePerDay: number;
  /** Projected value at the target date. */
  projected: number;
  /** ~80% prediction interval: t(n−2)·σ·√(1 + 1/n + (x−x̄)²/Sxx). */
  lo: number;
  hi: number;
  /** Days from the last observation to the target. */
  daysAhead: number;
}

/** Student-t 90th percentile (one-tail) by df — the two-sided 80% band multiplier. */
function tQuantile90(df: number): number {
  const table: [number, number][] = [
    [1, 3.078], [2, 1.886], [3, 1.638], [4, 1.533], [5, 1.476],
    [6, 1.44], [7, 1.415], [8, 1.397], [9, 1.383], [10, 1.372],
    [12, 1.356], [15, 1.341], [20, 1.325], [25, 1.316], [30, 1.31],
    [60, 1.296], [120, 1.289],
  ];
  if (df <= 1) return table[0][1];
  if (df >= 120) return 1.282;
  for (let i = 1; i < table.length; i++) {
    const [d1, t1] = table[i - 1];
    const [d2, t2] = table[i];
    if (df <= d2) return t1 + ((df - d1) / (d2 - d1)) * (t2 - t1);
  }
  return 1.282;
}

/**
 * Ordinary least squares over the full series (x = days since the first
 * point), projected to a target date with a real ~80% prediction interval:
 * t(n−2) · σ · √(1 + 1/n + (x−x̄)²/Sxx). Unlike a flat ±1.28σ residual band,
 * this widens with extrapolation distance — exactly where forecasters lean on
 * the projection hardest. Deterministic trend math the agent can cite instead
 * of narrating "momentum" — a baseline, not destiny. Returns null when a line
 * can't be fit (fewer than 2 points, or no time variance). The band still
 * ignores autocorrelated residuals (near-universal in time series), so treat
 * it as optimistic.
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
  // Full prediction interval: parameter uncertainty (1/n) plus the
  // extrapolation term ((x−x̄)²/Sxx) on top of the residual spread.
  const band = tQuantile90(n - 2) * sigma * Math.sqrt(1 + 1 / n + ((xTarget - mx) * (xTarget - mx)) / sxx);
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
  if (r.source === "gdelttone") {
    headerLines.push("NOTE: tone measures media SENTIMENT, not probability — a darkening tone is a weak, lagging signal at best.");
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

// ---------------------------------------------------------------- options-implied probability

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation — |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

/**
 * Risk-neutral P(S_T > K) from Black-Scholes: N(d2) with
 * d2 = [ln(S/K) + (r − σ²/2)·T] / (σ·√T). The option market's own implied
 * volatility makes this the financial gold standard for price-threshold
 * event probabilities (risk-neutral, so modestly biased vs real-world for
 * far-dated equity events — say so when citing it).
 */
export function impliedProbAbove(spot: number, strike: number, iv: number, tYears: number, r = 0.04): number | null {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(tYears > 0)) return null;
  const d2 = (Math.log(spot / strike) + (r - (iv * iv) / 2) * tYears) / (iv * Math.sqrt(tYears));
  return normCdf(d2);
}

export interface OptionsImplied {
  symbol: string;
  spot: number;
  strike: number;
  expiry: string;
  iv: number;
  probAbove: number;
  contractsUsed: string;
}

/**
 * Yahoo gates its v7 endpoints behind a session cookie + crumb (the v8 chart
 * API stayed open). Acquire once, cache for the process, refresh on failure.
 */
let yahooSession: { cookie: string; crumb: string } | null = null;

async function yahooCrumb(signal?: AbortSignal): Promise<{ cookie: string; crumb: string }> {
  if (yahooSession) return yahooSession;
  const r1 = await fetch("https://fc.yahoo.com", {
    headers: { "user-agent": UA },
    redirect: "manual",
    signal: mergeSignal(20_000, signal),
  });
  const setCookie = r1.headers.get("set-cookie");
  if (!setCookie) throw new Error("yahoo did not issue a session cookie");
  const cookie = setCookie.split(";")[0];
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "user-agent": UA, cookie },
    signal: mergeSignal(20_000, signal),
  });
  if (!r2.ok) throw new Error(`crumb request failed (HTTP ${r2.status})`);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 30) throw new Error("yahoo returned an unusable crumb");
  yahooSession = { cookie, crumb };
  return yahooSession;
}

async function yahooOptionsGet(url: string, signal?: AbortSignal): Promise<any> {
  // Plain call first (works when unthrottled), then the cookie+crumb session.
  try {
    return await (await apiGet(url, signal)).json();
  } catch {
    yahooSession = null;
    const { cookie, crumb } = await yahooCrumb(signal);
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}crumb=${encodeURIComponent(crumb)}`, {
      headers: { "user-agent": UA, accept: "application/json", cookie },
      signal: mergeSignal(20_000, signal),
    });
    if (!res.ok) {
      throw new Error(
        `yahoo options API unavailable (HTTP ${res.status}) — Yahoo throttles per IP; retry in a few minutes, or anchor on market_odds / time_series yahoo instead`
      );
    }
    return res.json();
  }
}

/**
 * Options-implied probability that a ticker trades above a strike at a target
 * date, from Yahoo's option chain (keyless): pick the listed expiry nearest
 * the date, read implied vol at the strike nearest K (averaging call/put IV
 * when both quote), and convert via N(d2).
 */
export async function optionsImplied(
  symbol: string,
  strike: number,
  byIso: string,
  signal?: AbortSignal
): Promise<OptionsImplied> {
  const sym = symbol.trim().toUpperCase();
  const base = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}`;
  const first: any = await yahooOptionsGet(base, signal);
  const root = first?.optionChain?.result?.[0];
  const spot = Number(root?.quote?.regularMarketPrice);
  const expirations: number[] = Array.isArray(root?.expirationDates) ? root.expirationDates : [];
  if (!Number.isFinite(spot) || !expirations.length) {
    throw new Error(`yahoo returned no option chain for "${sym}" — options data exists for listed equities/ETFs/indices`);
  }
  const target = Date.parse(byIso) / 1000;
  if (!Number.isFinite(target)) throw new Error("by must be an ISO date (YYYY-MM-DD)");
  // Nearest listed expiry on/after the target date, else the last available.
  const expiry = expirations.find((e) => e >= target) ?? expirations[expirations.length - 1];
  const chain: any =
    expiry === expirations[0] && root?.options?.[0]?.calls?.length
      ? root
      : ((await yahooOptionsGet(`${base}?date=${expiry}`, signal)) as any)?.optionChain?.result?.[0];
  const opt = chain?.options?.[0];
  const nearest = (contracts: any[]): any | null => {
    let best: any = null;
    for (const c of contracts ?? []) {
      const s = Number(c?.strike);
      const ivc = Number(c?.impliedVolatility);
      if (!Number.isFinite(s) || !(ivc > 0.001)) continue;
      if (!best || Math.abs(s - strike) < Math.abs(Number(best.strike) - strike)) best = c;
    }
    return best;
  };
  const call = nearest(opt?.calls);
  const put = nearest(opt?.puts);
  const ivs = [call, put]
    .filter((c) => c && Math.abs(Number(c.strike) - strike) <= Math.max(strike * 0.1, 1))
    .map((c) => Number(c.impliedVolatility));
  if (!ivs.length) throw new Error(`no liquid contracts near strike ${strike} for ${sym} at that expiry`);
  const iv = ivs.reduce((s, v) => s + v, 0) / ivs.length;
  const tYears = Math.max((expiry * 1000 - Date.now()) / (365.25 * 86_400_000), 1 / 365);
  const probAbove = impliedProbAbove(spot, strike, iv, tYears);
  if (probAbove === null) throw new Error("could not invert the chain into a probability");
  return {
    symbol: sym,
    spot,
    strike,
    expiry: new Date(expiry * 1000).toISOString().slice(0, 10),
    iv,
    probAbove,
    contractsUsed: [call?.contractSymbol, put?.contractSymbol].filter(Boolean).join(" + ") || "(nearest strikes)",
  };
}

// ---------------------------------------------------------------- wikipedia tables

export interface ExtractedTable {
  caption: string;
  rows: string[][];
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const cellText = (html: string) =>
  decodeEntities(
    html
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "") // strip [1]-style refs
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, " / ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();

/**
 * Pure HTML table extraction (zero-dep, exported for tests): every <table>
 * becomes a caption + rows of cell text. Built for Wikipedia's polling and
 * statistics tables — the durable keyless home of election polling averages
 * and countless base-rate lists.
 */
export function extractHtmlTables(html: string): ExtractedTable[] {
  const out: ExtractedTable[] = [];
  for (const tm of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const body = tm[1];
    const caption = cellText(/<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(body)?.[1] ?? "");
    const rows: string[][] = [];
    for (const rm of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cm of rm[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
        cells.push(cellText(cm[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length >= 2) out.push({ caption, rows });
  }
  return out;
}

/** Fetch a Wikipedia page (title or full URL) and extract its data tables. */
export async function wikiTables(page: string, signal?: AbortSignal): Promise<ExtractedTable[]> {
  const url = /^https?:\/\//.test(page)
    ? page
    : `https://en.wikipedia.org/wiki/${encodeURIComponent(page.trim().replace(/\s+/g, "_"))}`;
  const res = await apiGet(url, signal, { accept: "text/html" });
  return extractHtmlTables(await res.text());
}

/** Token-lean TSV rendering of extracted tables: an index plus the selected table's rows. */
export function formatTables(tables: ExtractedTable[], index?: number, maxRows = 60): string {
  if (!tables.length) return "no data tables found on the page";
  if (index === undefined) {
    const listing = tables
      .map((t, i) => `${i}. ${t.caption || t.rows[0]?.slice(0, 6).join(" | ") || "(untitled)"} — ${t.rows.length} rows`)
      .join("\n");
    const biggest = tables.reduce((bi, t, i) => (t.rows.length > tables[bi].rows.length ? i : bi), 0);
    return `${tables.length} table(s) found:\n${listing}\n\nLargest table (#${biggest}) below — pass table_index for another.\n\n${formatTables(tables, biggest, maxRows)}`;
  }
  const t = tables[Math.max(0, Math.min(tables.length - 1, index))];
  const rows = t.rows.slice(0, maxRows).map((r) => r.map((c) => c.slice(0, 80)).join("\t"));
  const more = t.rows.length > maxRows ? `\n… ${t.rows.length - maxRows} more rows` : "";
  return `${t.caption ? `${t.caption}\n` : ""}${rows.join("\n")}${more}`;
}

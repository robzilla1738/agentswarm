// Finance / markets pack. Its power is a DATA-GROUNDED Monte Carlo model:
// options-implied probability (the market's own risk-neutral view), an OLS price
// trend, and a volatility regime — composed by the existing simulation engine
// instead of a single LLM guess. It also resolves exactly from the closing price.
// Uses the generic question sharpener (no custom decomposition), so its value is
// buildDrivers + resolve, not plan.

import { clampProb } from "../forecast";
import { optionsImplied, timeSeries, projectSeries } from "../datatools";
import type { ForecastQuestion, SimDriver } from "../types";
import type { DomainCtx, DomainPack, DomainResolution, IntentMatch } from "./pack";

const INDEX_MAP: Record<string, string> = {
  "s&p 500": "^GSPC", "s&p500": "^GSPC", sp500: "^GSPC", "s and p 500": "^GSPC",
  nasdaq: "^IXIC", "dow jones": "^DJI", "dow": "^DJI",
  bitcoin: "BTC-USD", btc: "BTC-USD", ethereum: "ETH-USD", eth: "ETH-USD",
};
const FINANCE_CONTEXT = /\b(stock|shares?|share price|closing price|close above|close below|market cap|ticker|equity|index|nasdaq|s&p|dow jones|crypto|bitcoin|ethereum)\b/i;
// Common non-ticker uppercase tokens to reject when guessing a bare symbol.
const NOT_TICKERS = new Set(["US", "USA", "UK", "EU", "GDP", "CPI", "CEO", "CFO", "IPO", "AI", "ETF", "NYSE", "SEC", "FED", "UN", "EV"]);

// Direction + strike are extracted from ONE regex match so they can never come
// from different clauses (or drift between extraction and resolution): the
// direction word and the number it governs are captured together. Word
// boundaries (\b) stop a keyword from matching as a substring ("over" inside
// "discover", "top" inside "laptop"). Group 1 = an ABOVE word (YES when the close
// is over the strike), group 2 = a BELOW word (YES when under), group 3 = the number.
const STRIKE_BELOW_WORDS = ["below", "under", "beneath", "less than", "at most"];
const STRIKE_ABOVE_WORDS = ["above", "over", "reach", "hit", "exceed", "cross", "top", "surpass", "greater than", "more than", "at least"];
const STRIKE_RE = new RegExp(
  `\\b(?:(${STRIKE_ABOVE_WORDS.join("|")})|(${STRIKE_BELOW_WORDS.join("|")}))\\b\\s*\\$?([\\d,]+(?:\\.\\d+)?)`,
  "i"
);

/**
 * Parse a ticker + optional strike from a finance mission, conservatively — only
 * STRONG signals claim the domain deterministically ($TICKER, a named
 * index/crypto, or a ticker beside explicit finance context). Ambiguous finance
 * questions fall to the LLM classifier (financePack has an llmHint). `strong`
 * lets matchIntent decide whether to win outright or defer.
 */
export function parseFinance(mission: string): { ticker: string; strike?: number; below?: boolean; label: string; strong: boolean } | null {
  const m = mission.toLowerCase();
  let ticker: string | null = null;
  let label = "";
  let strong = false;
  const dollar = /\$([A-Za-z]{1,5})\b/.exec(mission);
  if (dollar && !NOT_TICKERS.has(dollar[1].toUpperCase())) {
    ticker = dollar[1].toUpperCase();
    label = ticker;
    strong = true;
  }
  if (!ticker) {
    for (const [name, sym] of Object.entries(INDEX_MAP)) {
      // Whole-word match only — a substring test would fire "dow" inside
      // "shutdown" or "eth" inside "whether"/"method".
      const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (re.test(m)) {
        ticker = sym;
        label = name;
        strong = true;
        break;
      }
    }
  }
  if (!ticker && FINANCE_CONTEXT.test(mission)) {
    const cand = [...mission.matchAll(/\b([A-Z]{2,5})\b/g)].map((x) => x[1]).find((t) => !NOT_TICKERS.has(t));
    if (cand) {
      ticker = cand;
      label = cand;
      strong = false; // a bare uppercase token + context — plausible, let the LLM confirm
    }
  }
  if (!ticker) return null;
  const strikeM = STRIKE_RE.exec(mission);
  const strike = strikeM ? Number(strikeM[3].replace(/,/g, "")) : undefined;
  // Direction comes from the SAME match (group 2 = a below word), so the strike
  // and its inequality can't be drawn from different clauses.
  const below = strikeM ? Boolean(strikeM[2]) : undefined;
  if (typeof strike === "number" && Number.isFinite(strike)) strong = true;
  return { ticker, strike: Number.isFinite(strike as number) ? strike : undefined, below, label, strong };
}

export const financePack: DomainPack = {
  id: "finance",
  label: "Finance / markets",
  llmHint: "stock/equity/index/crypto prices, market levels, a ticker closing above/below a price by a date",
  knobs: ["panelSize", "marketWeight", "extremizeK", "simulate"],
  // Student-t copula (ν=6) for the price/vol/trend drivers: equity shocks exhibit
  // fat-tailed CO-MOVEMENT (a vol spike and a price drop arrive together) that a
  // Gaussian copula's zero tail dependence would systematically under-sample.
  copulaDf: 6,

  matchIntent(mission: string): IntentMatch | null {
    const f = parseFinance(mission);
    if (!f || !f.strong) return null; // weak finance signals defer to the LLM classifier
    return { pack: "finance", confidence: 0.75, source: "deterministic", hint: { ticker: f.ticker, strike: f.strike, below: f.below } };
  },

  async buildDrivers(ctx: DomainCtx, q: ForecastQuestion, match: IntentMatch, siblings: SimDriver[]): Promise<SimDriver[]> {
    const drivers = [...siblings];
    const ticker = String(match.hint?.ticker ?? "");
    const strike = typeof match.hint?.strike === "number" ? (match.hint!.strike as number) : undefined;
    // YES = close BELOW the strike (a "below/under/less than X" question). The
    // grounded drivers must point at THAT outcome, or the bottom-up simulated P(YES)
    // is the inverse of how resolve() settles (f.below ? close < strike : close > strike).
    const below = match.hint?.below === true;
    if (!ticker) return drivers;
    const by = q.resolutionDate;

    // The three feeds are independent network round-trips — run them CONCURRENTLY
    // (latency = max, not sum), each isolated so one failure never drops the others.
    const optionsDriver = async (): Promise<SimDriver | null> => {
      // Options-implied P(close > strike) via Black-Scholes (only for a real
      // strike on a binary). The DRIVER uses the REAL-WORLD probability (drift
      // r+ERP) — a forecast of the actual outcome, not the risk-neutral price.
      if (typeof strike !== "number" || q.kind !== "binary") return null;
      try {
        const oi = await optionsImplied(ticker, strike, by, ctx.signal);
        // Emit the driver in the question's OWN polarity: P(close < strike) for a
        // below question (= 1 − P(>strike)), so it reads as the YES outcome directly.
        const probYes = below ? 1 - oi.probAboveReal : oi.probAboveReal;
        return {
          id: below ? "opt_below" : "opt_above",
          label: `Options-implied P(${ticker} ${below ? "<" : ">"} ${strike})`,
          marginal: { kind: "binary", probability: clampProb(probYes) },
          provenance: { kind: "market", ref: `yahoo:options:${ticker}`, label: `IV ${(oi.iv * 100).toFixed(0)}% @ ${oi.expiry} (real-world drift)` },
        };
      } catch (e) {
        ctx.log("info", `finance options driver skipped: ${String((e as Error)?.message ?? e)}`);
        return null;
      }
    };
    const trendDriver = async (): Promise<SimDriver | null> => {
      // Random-walk-with-drift price projection in LOG space (prices are
      // multiplicative — additive drift on a level is wrong, and RW-drift doesn't
      // assume a steep recent slope persists). Lognormal predictive → a trend
      // marginal that fires above the strike when one exists.
      try {
        const px = await timeSeries(ctx.cfg, "yahoo", ticker, undefined, undefined, ctx.signal);
        const proj = projectSeries(px.points, by, "rwdrift", { logSpace: true });
        if (!proj) return null;
        return {
          id: "px_trend",
          label: `${ticker} RW-drift price projection to ${by}`,
          marginal: { kind: "trend", lo: proj.lo, projected: proj.projected, hi: proj.hi, sePred: proj.sePred, df: proj.df, logSpace: true },
          // The strike fires on the question's side: below it for a "close under X"
          // question, above it otherwise (consistent with the combiner's dir:"lt").
          ...(typeof strike === "number" ? { threshold: strike, thresholdDir: below ? "below" : "above" } : {}),
          provenance: { kind: "ols-trend", ref: `yahoo:${ticker}`, label: `RW-drift ${proj.slopePerDay >= 0 ? "+" : ""}${proj.slopePerDay.toFixed(2)}/day` },
        };
      } catch (e) {
        ctx.log("info", `finance trend driver skipped: ${String((e as Error)?.message ?? e)}`);
        return null;
      }
    };
    const volDriver = async (): Promise<SimDriver | null> => {
      // Elevated-volatility regime from FRED VIX (binary) — a grounded fat-tail
      // switch the combiner can correlate against the trend.
      try {
        const vix = await timeSeries(ctx.cfg, "fred", "VIXCLS", undefined, undefined, ctx.signal);
        const vals = vix.points.map((p) => p.value).filter((v) => Number.isFinite(v));
        if (vals.length < 10) return null;
        const sorted = [...vals].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const last = vals[vals.length - 1];
        return {
          id: "vol_regime",
          label: "Elevated-volatility regime (VIX > trailing median)",
          marginal: { kind: "binary", probability: last > med ? 0.6 : 0.4 },
          provenance: { kind: "base-rate", ref: "fred:VIXCLS", label: `VIX ${last.toFixed(0)} vs median ${med.toFixed(0)}` },
        };
      } catch {
        return null; // VIX needs fredApiKey — silently skip when unkeyed
      }
    };

    const fetched = await Promise.all([optionsDriver(), trendDriver(), volDriver()]);
    for (const d of fetched) if (d) drivers.push(d);
    return drivers;
  },

  async resolve(ctx: DomainCtx, entry): Promise<DomainResolution | null> {
    const f = parseFinance(entry.question.text);
    if (!f) return null;
    const by = entry.question.resolutionDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(by)) return null;
    // The close must already exist: only resolve on/after the date.
    if (Date.parse(by) > Date.now()) return null;
    const start = new Date(Date.parse(by) - 8 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.parse(by) + 2 * 86_400_000).toISOString().slice(0, 10);
    let close: number | undefined;
    let closeDate = "";
    try {
      const px = await timeSeries(ctx.cfg, "yahoo", f.ticker, start, end, ctx.signal);
      // Settle ONLY from a close on/before `by`. The +2d window buffer guards
      // against Yahoo timezone truncation, but it can also contain trading days
      // AFTER `by` — never settle from one of those (a future close). If the
      // lookback has no on-or-before point, leave `close` unset and hand off to
      // the web resolver rather than reach forward in time.
      const onOrBefore = px.points.filter((p) => p.date <= by);
      const last = onOrBefore[onOrBefore.length - 1];
      if (last) {
        close = last.value;
        closeDate = last.date;
      }
    } catch {
      return null; // couldn't fetch — let the web resolver try
    }
    if (typeof close !== "number") return null;
    const sources = [`https://finance.yahoo.com/quote/${encodeURIComponent(f.ticker)}/history`];
    const evidence = `${f.ticker} closed ${close} on ${closeDate} (Yahoo Finance).`;
    if (entry.question.kind === "binary" && typeof f.strike === "number") {
      // Direction came from the SAME regex match that produced the strike (f.below),
      // so it can't be drawn from a different clause than the strike.
      const yes = f.below ? close < f.strike : close > f.strike;
      return { outcome: yes ? 1 : 0, evidence: `${evidence} Strike ${f.strike}.`, sources };
    }
    if (entry.question.kind === "numeric") {
      return { outcome: close, evidence, sources };
    }
    return null;
  },
};

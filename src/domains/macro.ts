// Macro / econ + elections packs. Macro grounds NUMERIC questions in a real FRED
// series (OLS trend driver) and resolves "direct" rate series exactly from the
// official print. Elections is intentionally light: the generic market anchor
// (prediction markets) and wiki_tables polling already serve it well, so the pack
// mainly routes for per-domain calibration and surfaces the right UI knobs.

import { timeSeries, olsProject } from "../datatools";
import type { ForecastQuestion, SimDriver } from "../types";
import type { DomainCtx, DomainPack, DomainResolution, IntentMatch } from "./pack";

interface MacroIndicator {
  re: RegExp;
  series: string;
  /** The series IS the quantity asked about (so a numeric question resolves from it exactly). */
  direct: boolean;
  name: string;
}

const MACRO_SERIES: MacroIndicator[] = [
  { re: /\bunemployment\b/i, series: "UNRATE", direct: true, name: "unemployment rate" },
  { re: /\b(fed funds|federal funds|policy rate|fed rate)\b/i, series: "DFF", direct: true, name: "fed funds rate" },
  { re: /\b(10[- ]?year|10y)\b[^.]*\b(treasury|yield|note)\b|\btreasury yield\b/i, series: "DGS10", direct: true, name: "10y treasury yield" },
  { re: /\bmortgage rate\b/i, series: "MORTGAGE30US", direct: true, name: "30y mortgage rate" },
  { re: /\b(cpi|consumer price)\b/i, series: "CPIAUCSL", direct: false, name: "CPI index" },
  { re: /\binflation\b/i, series: "T10YIE", direct: false, name: "10y breakeven inflation" },
  { re: /\b(gdp|gross domestic product)\b/i, series: "GDPC1", direct: false, name: "real GDP" },
  { re: /\b(payrolls?|nonfarm|jobs report)\b/i, series: "PAYEMS", direct: false, name: "nonfarm payrolls" },
];
// A macro mention without a mapped series still routes to the pack (calibration + knobs).
const MACRO_GENERAL = /\b(recession|interest rate|rate (cut|hike)|monetary policy|the fed|central bank|ecb|federal reserve|yield curve|debt ceiling)\b/i;

export function detectMacro(mission: string): { indicator?: MacroIndicator } | null {
  for (const ind of MACRO_SERIES) if (ind.re.test(mission)) return { indicator: ind };
  if (MACRO_GENERAL.test(mission)) return {};
  return null;
}

export const macroPack: DomainPack = {
  id: "macro",
  label: "Macro / economy",
  llmHint: "macroeconomic indicators — inflation, GDP, unemployment, interest rates, Fed/central-bank policy, recession",
  knobs: ["panelSize", "marketWeight", "extremizeK", "decompose", "maxSubQuestions"],

  matchIntent(mission: string): IntentMatch | null {
    const d = detectMacro(mission);
    if (!d) return null;
    return {
      pack: "macro",
      confidence: d.indicator ? 0.7 : 0.62,
      source: "deterministic",
      hint: d.indicator ? { series: d.indicator.series, direct: d.indicator.direct, name: d.indicator.name } : {},
    };
  },

  async buildDrivers(ctx: DomainCtx, q: ForecastQuestion, match: IntentMatch, siblings: SimDriver[]): Promise<SimDriver[]> {
    const drivers = [...siblings];
    const series = match.hint?.series as string | undefined;
    if (!series) return drivers;
    try {
      const ts = await timeSeries(ctx.cfg, "fred", series, undefined, undefined, ctx.signal);
      const proj = olsProject(ts.points, q.resolutionDate);
      if (proj) {
        drivers.push({
          id: "macro_trend",
          label: `${ts.label} OLS projection to ${q.resolutionDate}`,
          marginal: { kind: "trend", lo: proj.lo, projected: proj.projected, hi: proj.hi },
          provenance: { kind: "ols-trend", ref: `fred:${series}`, label: `slope ${proj.slopePerDay.toFixed(3)}/day` },
        });
      }
    } catch (e) {
      ctx.log("info", `macro trend driver skipped: ${String((e as Error)?.message ?? e)}`);
    }
    return drivers;
  },

  async resolve(ctx: DomainCtx, entry): Promise<DomainResolution | null> {
    // Only "direct" rate series whose value IS the asked quantity resolve here.
    const d = detectMacro(entry.question.text);
    const ind = d?.indicator;
    if (!ind?.direct || entry.question.kind !== "numeric") return null;
    const by = entry.question.resolutionDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(by) || Date.parse(by) > Date.now()) return null;
    try {
      const ts = await timeSeries(ctx.cfg, "fred", ind.series, undefined, undefined, ctx.signal);
      const onOrBefore = ts.points.filter((p) => p.date <= by);
      const last = onOrBefore[onOrBefore.length - 1];
      if (!last) return null;
      return {
        outcome: last.value,
        evidence: `${ind.name} was ${last.value} as of ${last.date} (FRED ${ind.series}).`,
        sources: [`https://fred.stlouisfed.org/series/${ind.series}`],
      };
    } catch {
      return null;
    }
  },
};

const ELECTION_RE = /\b(election|elections|electoral|vote|votes|voters?|ballot|primary|primaries|caucus|referendum|poll|polling|seats?|parliament|congress|senate|presiden\w+|prime minister|win the\b|re[- ]?elect)\b/i;

export const electionsPack: DomainPack = {
  id: "elections",
  label: "Elections / politics",
  llmHint: "elections, referendums, who wins an office or seat, vote share, polling outcomes",
  // Elections are best served by the market anchor + polling tables, so emphasize those knobs.
  knobs: ["panelSize", "marketWeight", "extremizeK", "coherenceProbe"],

  matchIntent(mission: string): IntentMatch | null {
    if (!ELECTION_RE.test(mission)) return null;
    return { pack: "elections", confidence: 0.66, source: "deterministic" };
  },
};

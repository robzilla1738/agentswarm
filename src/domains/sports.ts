// Pack #1: sports. This is the existing, battle-tested head-to-head game path
// expressed as a DomainPack — it proves the abstraction by REUSE, importing the
// already-exported helpers in forecast.ts/datatools.ts rather than duplicating
// any math. matchIntent + plan move here verbatim; the per-facet line/σ anchor
// and box-score resolution remain inline in executor.ts/resolve.ts for now (they
// are keyed on q.sports, which this plan still stamps) and migrate behind
// pack.anchor/pack.resolve when the second domain needs those seams.

import { classifySportsMission, sportsSigma } from "../forecast";
import { sportsbookLines, sportsDayIso } from "../datatools";
import type { ForecastQuestion, SportsLineSnapshot } from "../types";
import type { DomainCtx, DomainPack, IntentMatch } from "./pack";

const SPORTS_BRIEF =
  "head-to-head game — winner, total points, and margin of victory, each anchored to the sportsbook line";

export const sportsPack: DomainPack = {
  id: "sports",
  label: "Sports",
  // Deterministic-only: classifySportsMission is the sole authority, so sports
  // never enters the LLM domain-classifier fallback (no llmHint).
  knobs: ["panelSize", "sportsMarketWeight", "simulate"],

  matchIntent(mission: string): IntentMatch | null {
    const facet = classifySportsMission(mission);
    if (!facet) return null;
    return { pack: "sports", confidence: 0.9, source: "deterministic", hint: { facet } };
  },

  async plan(ctx: DomainCtx, match: IntentMatch) {
    // Cheap gate before spending an Odds API credit: no key → leave it to the
    // normal planner so the target is never silently rewritten.
    if (!ctx.cfg.oddsApiKey) return null;
    const ask = match.hint?.facet as "winner" | "total" | "margin" | "full" | undefined;
    if (!ask) return null;
    // Match on the game date FROM THE MISSION TEXT, not the --by resolution
    // deadline (which can be later than the game). sportsbookLines parses the
    // date out of the mission query itself.
    const line = await sportsbookLines(ctx.cfg, ctx.mission, { signal: ctx.signal });
    if (!line) return null;
    const { home, away, sportTitle, sportKey, eventId, commence } = line;
    // Label with the game's LOCAL sports day (what the user asked for), not the
    // raw UTC date — a US night game tipping after UTC midnight still reads as
    // its local date. The resolution deadline is end-of-day UTC; a game that
    // finishes after that simply stays open one extra resolve cycle.
    const resolutionDate = sportsDayIso(Date.parse(commence), sportKey);
    const favorite: "home" | "away" =
      line.spread?.favorite ?? (line.h2h && line.h2h.pAway > line.h2h.pHome ? "away" : "home");
    const favName = favorite === "home" ? home : away;
    const dogName = favorite === "home" ? away : home;
    // 3-way books (soccer and the like) price a Draw — the winner facet must
    // include it as an option, or a level final score voids instead of resolving.
    const threeWay = typeof line.h2h?.pDraw === "number";
    const lineAtCreate: SportsLineSnapshot = {
      t: Date.now(),
      ...(line.h2h ? { pHome: line.h2h.pHome } : {}),
      ...(threeWay ? { pDraw: line.h2h!.pDraw, pAway: line.h2h!.pAway } : {}),
      ...(line.spread ? { spread: line.spread.line } : {}),
      ...(line.total ? { total: line.total.line } : {}),
    };
    const base = { sportKey, eventId, sportTitle, home, away, commence, favorite, lineAtCreate };
    const matchup = `${away} @ ${home} on ${resolutionDate}`;
    const winner: ForecastQuestion = {
      text: `Who wins ${matchup}: ${home}, ${away}${threeWay ? ", or a draw" : ""}?`,
      kind: "mc",
      options: threeWay ? [home, "Draw", away] : [home, away],
      resolutionCriteria: threeWay
        ? 'Resolves to the team with more goals in the official final score, or "Draw" if the scores are level. Voided if the game is not played as scheduled.'
        : "Resolves to the team with more points in the official final box score. Voided if the game is not played as scheduled.",
      resolutionDate,
      sports: { ...base, facet: "winner" },
    };
    const total: ForecastQuestion = {
      text: `What will the combined final score (both teams) be in ${matchup}?`,
      kind: "numeric",
      unit: "points",
      resolutionCriteria: "The sum of both teams' points in the official final box score, including overtime.",
      resolutionDate,
      sports: { ...base, facet: "total", ...(sportsSigma(sportTitle, "total") ? { sigma: sportsSigma(sportTitle, "total")! } : {}) },
    };
    const margin: ForecastQuestion = {
      text: `By how many points will ${favName} beat ${dogName} in ${matchup}? (negative if ${favName} loses)`,
      kind: "numeric",
      unit: "points",
      resolutionCriteria: `${favName}'s points minus ${dogName}'s points in the official final box score (can be negative).`,
      resolutionDate,
      sports: { ...base, facet: "margin", ...(sportsSigma(sportTitle, "margin") ? { sigma: sportsSigma(sportTitle, "margin")! } : {}) },
    };
    // Return only what the mission asks for: an explicit single-facet ask yields
    // just that facet; "full" (a generic "final score" or bare matchup) gets
    // winner+total+margin, collapsed to the winner headline under --single.
    if (ask === "total") return { questions: [total], brief: SPORTS_BRIEF };
    if (ask === "margin") return { questions: [margin], brief: SPORTS_BRIEF };
    if (ask === "winner") return { questions: [winner], brief: SPORTS_BRIEF };
    const single = !ctx.decompose || ctx.single;
    return { questions: single ? [winner] : [winner, total, margin], brief: SPORTS_BRIEF };
  },
};

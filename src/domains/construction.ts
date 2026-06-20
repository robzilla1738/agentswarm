// Construction / project-delivery pack. Its power is STRUCTURAL DECOMPOSITION: a
// project question becomes milestone sub-forecasts (permits, funding, tunneling,
// schedule slip), which the simulation engine composes into a bottom-up
// schedule-risk model. buildDrivers adds a COUNTED reference-class overrun rate
// (from accumulated resolutions) once history exists. Resolution is left to the
// web resolver (no single authoritative API).

import { clampProb } from "../forecast";
import { queryRefClass } from "../refstore";
import type { ForecastQuestion, SimDriver } from "../types";
import type { DomainCtx, DomainPack, IntentMatch } from "./pack";

const CONSTRUCTION_RE =
  /\b(construction|infrastructure|megaproject|project|build(?:ing)?|tunnel|bridge|highway|railway|rail line|metro|subway|pipeline|power plant|refinery|factory|facility|stadium|airport|dam|terminal)\b/i;
const DELIVERY_RE = /\b(complete|completed|completion|operational|open(?:s|ed|ing)?|deliver(?:y|ed)?|finish(?:ed)?|on schedule|behind schedule|groundbreaking|topped out|in service|commission(?:ed|ing)?|by \d{4})\b/i;

/** Canonical reference-class keys for construction — the pack's query default,
 *  the prompt's examples, and the seed corpus all share these so the cold-start
 *  seed actually feeds the driver (one source of truth prevents key drift). */
export const REF_CLASS = "infra_schedule_slip";
export const CONSTRUCTION_COST_OVERRUN = "infra_cost_overrun";

export const constructionPack: DomainPack = {
  id: "construction",
  label: "Construction / projects",
  llmHint: "delivery/completion of a construction or infrastructure project — will it be built/operational/on schedule by a date",
  knobs: ["panelSize", "decompose", "maxSubQuestions", "simulate"],

  matchIntent(mission: string): IntentMatch | null {
    if (!CONSTRUCTION_RE.test(mission) || !DELIVERY_RE.test(mission)) return null;
    return { pack: "construction", confidence: 0.66, source: "deterministic" };
  },

  async plan(ctx: DomainCtx, _match: IntentMatch) {
    // Decompose into milestone sub-conditions whose joint outcome determines the
    // headline — the project-schedule-risk model. LLM proposes the milestones;
    // the engine forecasts and (via the simulation) composes them.
    const prompt = `You are decomposing a construction / infrastructure project-delivery question into 2-4 independently-resolvable MILESTONE sub-forecasts whose JOINT outcome determines the headline. Today is ${ctx.today}.

MISSION
${ctx.mission}
${ctx.operatorDate ? `\nThe operator set the resolution horizon: ${ctx.operatorDate}.` : ""}

Reply with ONLY JSON (no prose, no fence):
{"brief":"one line on how the milestones combine","questions":[{"text":"...","kind":"binary|date|numeric","resolutionCriteria":"...","resolutionDate":"YYYY-MM-DD","refClass":"snake_case_class","unit":"months (numeric only)"}]}

- Each milestone is a concrete, checkable gate: permits/approvals obtained, funding/financing secured, a construction phase complete (date), or schedule slip vs baseline (numeric, unit "months").
- refClass: a normalized reference-class key for base-rate accumulation. Use these canonical keys where they fit (they carry seeded historical base rates): "${REF_CLASS}" (schedule slip vs baseline), "${CONSTRUCTION_COST_OVERRUN}" (cost overrun); otherwise a descriptive snake_case key like "permit_approval", "funding_secured".
- resolutionDate: ISO, on or before the project horizon.
- Keep it to the few milestones that genuinely drive the outcome.`;
    let raw: string;
    try {
      raw = await ctx.ask(prompt, 1200);
    } catch (e) {
      ctx.log("info", `construction decomposition skipped: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    const arr = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const questions: ForecastQuestion[] = [];
    for (const o of arr.slice(0, ctx.maxSubQuestions)) {
      // Milestones are gates: binary | date | numeric. "mc" is rejected — the
      // prompt never offers it and this path never supplies an options list, so
      // an mc milestone would be unforecastable/unresolvable.
      const kind = o?.kind === "date" || o?.kind === "numeric" ? o.kind : "binary";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o?.resolutionDate)) ? String(o.resolutionDate) : ctx.operatorDate;
      if (!o?.text || !o?.resolutionCriteria || !date) continue;
      questions.push({
        text: String(o.text),
        kind,
        resolutionCriteria: String(o.resolutionCriteria),
        resolutionDate: date,
        ...(o.unit ? { unit: String(o.unit) } : {}),
        domain: "construction",
        ...(o.refClass ? { refClass: String(o.refClass) } : { refClass: REF_CLASS }),
      });
    }
    if (!questions.length) return null;
    return { questions, brief: String(parsed?.brief ?? "project delivery decomposed into milestone sub-forecasts") };
  },

  async buildDrivers(_ctx: DomainCtx, q: ForecastQuestion, _match: IntentMatch, siblings: SimDriver[]): Promise<SimDriver[]> {
    const drivers = [...siblings];
    // Counted reference-class overrun rate from accumulated resolutions + the
    // seeded starter corpus. Query the sub-question's OWN refClass when it carries
    // one (G4) — a "funding_secured" facet looks up a different base rate than a
    // "schedule_slip" one — falling back to the pack default. Exclude this question.
    const cls = q.refClass || REF_CLASS;
    const rc = queryRefClass("construction", cls, (r) => r.ledgerId !== q.id);
    if ((rc.binaryN ?? 0) >= 5 && typeof rc.baseRate === "number") {
      // Describe the base rate by the class it actually came from — the driver
      // also queries the cost-overrun class (and any milestone class a sub-question
      // carries), so a hardcoded "schedule slip / % slipped" label would misdescribe
      // those. The wording stays polarity-neutral because YES means different things
      // across classes (slipped/overran vs a milestone met). rc.baseRate is the
      // Beta(½,½)-smoothed rate — never a reckless 0/1 on a thin class; rawBaseRate
      // (k/n) is shown alongside for transparency.
      const noun = cls === REF_CLASS ? "schedule slip" : cls === CONSTRUCTION_COST_OVERRUN ? "cost overrun" : cls.replace(/_/g, " ");
      const rawPct = Math.round((rc.rawBaseRate ?? rc.baseRate) * 100);
      drivers.push({
        id: "ref_overrun",
        label: `Reference-class ${noun} (n=${rc.binaryN})`,
        marginal: { kind: "binary", probability: clampProb(rc.baseRate) },
        provenance: {
          kind: "base-rate",
          ref: `refstore:${cls}`,
          label: `${rc.binaryN} comparable projects, base rate ${rawPct}% → smoothed ${Math.round(rc.baseRate * 100)}%`,
        },
      });
    }
    return drivers;
  },
};

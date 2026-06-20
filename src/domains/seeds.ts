// Starter reference-class corpus — COUNTED historical base rates that make the
// outside-view drivers live before the engine has accrued its own resolved
// history. Each class is a published frequency expressed as N counted binary
// outcomes (k "yes" of n), so queryRefClass returns a real Jeffreys-smoothed base
// rate with an honest credible interval.
//
// SCOPE: the seeds cover the reference classes a pack ACTUALLY consumes today.
// The construction pack decomposes a delivery question into milestone
// sub-forecasts and composes a bottom-up schedule-risk simulation, whose
// counted-overrun driver reads these classes (construction.ts buildDrivers).
// Other domains (macro/elections/business) forecast single questions whose
// outside view already flows through the panel's own base-rate research, and
// they have no reference-class DRIVER to feed — so seeding inert rows there would
// be dead weight. As those packs grow reference-class consumers, add their
// classes here against the SAME keys they query (a shared exported constant, as
// with construction's REF_CLASS, prevents key drift). The seeding MECHANISM is
// fully general; the corpus is deliberately scoped to what's wired.
//
// Figures are rounded to the nearest defensible frequency from the cited source.

import type { RefClassRecord } from "../refstore";
import { REF_CLASS as CONSTRUCTION_SCHEDULE_SLIP, CONSTRUCTION_COST_OVERRUN } from "./construction";

interface SeedClass {
  domain: string;
  refClass: string;
  /** "k of n resolved YES" — the counted base rate. */
  yes: number;
  n: number;
  /** Source/citation, stored on every row for audit. */
  source: string;
}

/** The curated starter classes — keys aligned to their consuming pack's query. */
const SEED_CLASSES: SeedClass[] = [
  // Flyvbjerg, "Survival of the Unfittest" (2009) / "What You Should Know About
  // Megaprojects" (2014): the large majority of major infrastructure projects
  // overrun their schedule and budget. ~9 in 10. Consumed by constructionPack's
  // counted-overrun driver (keyed on REF_CLASS) in the schedule-risk simulation.
  // These two are the dominant, well-documented outside-view classes. The pack's
  // plan prompt may also tag milestone gates with bespoke keys (permit_approval,
  // funding_secured); those are DELIBERATELY not seeded — there is no comparably
  // citable counted base rate for them, and a fabricated prior is worse than the
  // fail-safe of accruing from real resolutions (the buildDrivers label is
  // class-aware, so such a class is described correctly once it has data).
  { domain: "construction", refClass: CONSTRUCTION_SCHEDULE_SLIP, yes: 18, n: 20, source: "Flyvbjerg 2009/2014 — megaproject schedule overruns (~9/10)" },
  { domain: "construction", refClass: CONSTRUCTION_COST_OVERRUN, yes: 17, n: 20, source: "Flyvbjerg 2014 — major project cost overruns" },
];

/** Expand the counted classes into individual RefClassRecord rows (k ones, n−k zeros). */
export function seedCorpus(now = 0): RefClassRecord[] {
  const out: RefClassRecord[] = [];
  for (const c of SEED_CLASSES) {
    for (let i = 0; i < c.n; i++) {
      out.push({
        v: 1,
        kind: "refclass",
        t: now,
        domain: c.domain,
        refClass: c.refClass,
        question: `[seed] ${c.source}`,
        qkind: "binary",
        outcome: i < c.yes ? 1 : 0,
        ledgerId: `seed:${c.domain}:${c.refClass}:${i}`,
        seeded: true,
      });
    }
  }
  return out;
}

/** A one-line summary of what the corpus provides (for the CLI). */
export function seedSummary(): string[] {
  return SEED_CLASSES.map((c) => `${c.domain}/${c.refClass}: ${c.yes}/${c.n} (${Math.round((c.yes / c.n) * 100)}%) — ${c.source}`);
}

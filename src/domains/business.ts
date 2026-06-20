// Business / operations pack. Routing-focused: a business-outcome question gets
// its own per-domain calibration and surfaces the right UI knobs, while the
// forecaster panel reaches for the new structured tools directly — data_feed
// (SEC filings, company profile), time_series secfacts (fundamentals) and
// usaspending (federal contract demand), plus GDELT/Wikipedia attention. No
// custom decomposition or anchor; its leverage is correct routing + tool access.

import type { DomainPack, IntentMatch } from "./pack";

const BUSINESS_RE =
  /\b(revenue|earnings|profit|sales|market share|hiring|headcount|layoffs?|acquisition|acquire|merger|m&a|ipo|funding round|valuation|bankrupt\w*|expansion|launch(?:es|ed|ing)?|product launch|subscribers?|customers?|units? sold|guidance|backlog|contract award|government contract)\b/i;
const COMPANY_HINT = /\b(company|companies|firm|startup|corporation|inc\.?|corp\.?|llc|brand|business|retailer|manufacturer|vendor|supplier)\b/i;

export const businessPack: DomainPack = {
  id: "business",
  label: "Business / operations",
  llmHint: "company or sector business outcomes — revenue, hiring, contracts, market share, launches, M&A, bankruptcy",
  knobs: ["panelSize", "extremizeK", "decompose", "maxSubQuestions", "marketWeight"],

  matchIntent(mission: string): IntentMatch | null {
    // Require BOTH a business-outcome verb AND a company/firm cue, to avoid
    // claiming generic questions that merely mention "sales" or "launch". Weaker
    // business questions still route via the LLM classifier (llmHint).
    if (!BUSINESS_RE.test(mission) || !COMPANY_HINT.test(mission)) return null;
    return { pack: "business", confidence: 0.62, source: "deterministic" };
  },
};

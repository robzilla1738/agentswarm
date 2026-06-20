// The domain-pack registry. detectDomain runs deterministic matchers first
// (free, pure); only when ALL abstain does it fall back to one cheap LLM
// classifier — and even then only over packs that opt in via `llmHint`. A
// registry of deterministic-only packs (e.g. just sports) therefore makes ZERO
// extra LLM calls, which is what keeps the existing sports path byte-identical.

import type { DomainId } from "../types";
import { domainClassifierPrompt } from "../prompts";
import type { DomainCtx, DomainPack, IntentMatch } from "./pack";
import { sportsPack } from "./sports";
import { financePack } from "./finance";
import { macroPack, electionsPack } from "./macro";
import { constructionPack } from "./construction";
import { businessPack } from "./business";

/**
 * Registered packs. Order is only a tie-break; matchIntent confidences decide
 * the winner. Deterministic-only packs (sports) never enter the LLM fallback.
 */
export const PACKS: readonly DomainPack[] = [
  sportsPack,
  financePack,
  macroPack,
  electionsPack,
  constructionPack,
  businessPack,
];

export function packById(id: DomainId): DomainPack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** All packs that expose an LLM hint (eligible for the classifier fallback). */
function llmPacks(): DomainPack[] {
  return PACKS.filter((p) => p.llmHint);
}

/**
 * Pure, synchronous detection: the highest-confidence deterministic match that
 * clears 0.6 wins. Returns null when no pack claims the mission deterministically
 * (the caller may then try the LLM fallback). Safe to call from the UI/anywhere.
 */
export function detectDomainSync(mission: string): IntentMatch | null {
  const dets = PACKS
    .map((p) => p.matchIntent(mission))
    .filter((m): m is IntentMatch => !!m && m.source === "deterministic")
    .sort((a, b) => b.confidence - a.confidence);
  return dets[0] && dets[0].confidence >= 0.6 ? dets[0] : null;
}

/**
 * Full detection: deterministic first, then (only if all abstain and there are
 * LLM-eligible packs) one cheap classifier call. Returns null → the generic
 * panel+research path.
 */
export async function detectDomain(
  ctx: DomainCtx,
  opts: { llmFallback?: boolean } = {},
): Promise<IntentMatch | null> {
  const det = detectDomainSync(ctx.mission);
  if (det) return det;
  if (opts.llmFallback === false) return null;
  const candidates = llmPacks();
  if (!candidates.length) return null; // nothing LLM-classifiable → no call
  let id: DomainId | null = null;
  try {
    id = await classifyDomainLLM(ctx, candidates);
  } catch {
    return null; // classifier is best-effort
  }
  if (!id || !packById(id)) return null;
  return { pack: id, confidence: 0.5, source: "llm" };
}

/** One cheap LLM call mapping the mission to a candidate pack id (or null = generic). */
async function classifyDomainLLM(ctx: DomainCtx, candidates: DomainPack[]): Promise<DomainId | null> {
  const out = (await ctx.ask(domainClassifierPrompt(ctx.mission, candidates.map((p) => ({ id: p.id, label: p.label, hint: p.llmHint! }))), 64))
    .toLowerCase()
    .trim();
  if (!out) return null;
  for (const p of candidates) {
    // Accept the id appearing as a whole word anywhere in a terse reply.
    if (new RegExp(`\\b${p.id}\\b`).test(out)) return p.id;
  }
  return null;
}

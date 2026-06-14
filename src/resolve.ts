import * as fs from "fs";
import * as path from "path";
import { runAgent } from "./agent";
import { SwarmConfig } from "./config";
import { ToolSchema } from "./deepseek";
import {
  LedgerEntry,
  LedgerOutcome,
  LedgerResolved,
  dueForecasts,
  forecastsDir,
  isoToDays,
  loadLedger,
  resolveLedgerEntry,
  supersededIds,
} from "./forecast";
import { resolveFromPlatform } from "./datatools";
import { questionBlock } from "./prompts";
import { createSandbox } from "./sandbox";
import { ToolCtx, ToolDef, workerToolset } from "./tools";
import { RunMeta } from "./types";
import { clip, ensureDir, errMsg, oneLine, rid } from "./util";

/**
 * The resolution engine: closes the calibration loop by determining what
 * actually happened to past-due forecasts and scoring them.
 *
 * Resolution is a lookup with criteria, not a mission — so each due question
 * gets ONE cheap-tier mini-agent (the verifier pattern), not a swarm: a
 * 12-step web-tooled loop costs ~100× less than a run and needs no journal or
 * sandbox boot. Contested questions surface as "unclear" for the operator to
 * settle with `swarm resolve set`.
 */

export const SUBMIT_RESOLUTION_TOOL: ToolSchema = {
  name: "submit_resolution",
  description: "Deliver your resolution verdict for the forecast question.",
  parameters: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["yes", "no", "value", "option", "date", "never", "void", "unclear"],
        description:
          'binary questions: "yes" or "no". Numeric questions: "value" (fill value). mc questions: "option" (fill option with the realized one, verbatim from the list). Date questions: "date" (fill date with when it happened) or "never" (did not happen by the horizon). "void" only if the question stopped being meaningful. "unclear" when evidence conflicts or the answer is genuinely not yet determinable.',
      },
      value: { type: "number", description: "Numeric questions: the realized value, measured per the criteria" },
      option: { type: "string", description: "mc questions: the option that actually occurred, exactly as listed" },
      date: { type: "string", description: "Date questions: the ISO date (YYYY-MM-DD) the event first occurred" },
      evidence: {
        type: "string",
        description: "2-4 sentences: what actually happened, per which source, checked against the criteria",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "URLs of the sources that establish the outcome",
      },
    },
    required: ["outcome", "evidence", "confidence"],
  },
};

function resolutionSystem(entry: LedgerEntry, today: string): string {
  const q = entry.question;
  return `You are a resolution agent. A forecast was recorded on ${new Date(entry.t).toISOString().slice(0, 10)}; its resolution date has passed (today is ${today}). Determine what ACTUALLY happened.

${questionBlock(q)}

PROTOCOL
- Find out what happened: web_search (use freshness for recent events, deep:true for anything contested), fetch_url on authoritative sources, market_odds (resolved markets often state the outcome).
- Judge STRICTLY by the resolution criteria as written — not by the spirit of the topic. If the criteria name a source, check that source.
- ${
    q.kind === "binary"
      ? 'outcome "yes"/"no"'
      : q.kind === "mc"
        ? 'outcome "option" with the realized option verbatim from the list'
        : q.kind === "date"
          ? 'outcome "date" with the ISO date it first happened, or "never" if it did not happen by the horizon'
          : 'outcome "value" with the realized value'
  } only when the evidence is solid (confidence high or medium).
- Sources conflict, the answer is genuinely not yet determinable, or the criteria turn out ambiguous → outcome "unclear" with confidence low; a human operator settles those.
- "void" ONLY if the question's premise dissolved (e.g. the entity it concerns ceased to exist before the date).
- Spot-check depth over breadth; you have at most 12 tool steps.
- End with submit_resolution(...): evidence citing exactly what you verified, sources as URLs.`;
}

/** The web-only tool subset a resolution agent gets (no shell, no files). */
function resolutionTools(cfg: SwarmConfig): Record<string, ToolDef> {
  const all = workerToolset(cfg);
  return { web_search: all.web_search, fetch_url: all.fetch_url, market_odds: all.market_odds };
}

/** Minimal ToolCtx for run-less mini-agents — the web tools only touch cfg/signal/log. */
function miniCtx(cfg: SwarmConfig, agentId: string, mission: string, signal: AbortSignal, log?: LogFn): ToolCtx {
  const dir = forecastsDir();
  ensureDir(dir);
  const meta: RunMeta = {
    id: agentId,
    mission,
    createdAt: Date.now(),
    cwd: dir,
    sandbox: false,
    options: {
      model: cfg.model,
      conductorModel: cfg.conductorModel,
      maxWorkers: 1,
      maxStepsPerTask: 12,
      maxTasks: 1,
      maxTokens: cfg.maxTokensPerRun,
      verification: "off",
      thinking: cfg.thinking,
      reasoningEffort: cfg.reasoningEffort,
      safeMode: true,
      sandboxRuntime: "host",
    },
  };
  return {
    cfg,
    meta,
    runDirPath: dir,
    workdir: dir,
    sandbox: createSandbox("host", { runId: agentId, hostDir: dir, cfg }),
    agentId,
    signal,
    addNote: () => {},
    addArtifact: () => {},
    readBlackboard: () => "",
    log: (level, msg) => log?.(level, msg),
  };
}

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

export interface ResolveResult {
  resolved: (LedgerResolved & { question: string })[];
  skipped: { id: string; question: string; reason: string }[];
}

interface ResolutionVerdict {
  outcome: "yes" | "no" | "value" | "option" | "date" | "never" | "void" | "unclear";
  value?: number;
  option?: string;
  date?: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
}

const VERDICT_OUTCOMES = ["yes", "no", "value", "option", "date", "never", "void", "unclear"];

/**
 * Do two independent resolution verdicts establish the same outcome? Numeric
 * values agree within 1%, dates within a day; everything else must match
 * exactly. Resolution errors poison every parameter the flywheel learns, so
 * "roughly the same" is the most generosity allowed.
 */
function verdictsAgree(entry: LedgerEntry, a: ResolutionVerdict, b: ResolutionVerdict): boolean {
  if (a.outcome !== b.outcome) return false;
  const kind = entry.question.kind;
  if (kind === "numeric" && a.outcome === "value") {
    if (typeof a.value !== "number" || typeof b.value !== "number") return false;
    return Math.abs(a.value - b.value) <= Math.max(Math.abs(a.value), Math.abs(b.value)) * 0.01 + 1e-9;
  }
  if (kind === "mc" && a.outcome === "option") {
    return String(a.option ?? "").trim().toLowerCase() === String(b.option ?? "").trim().toLowerCase();
  }
  if (kind === "date" && a.outcome === "date") {
    const x = a.date ? isoToDays(a.date) : null;
    const y = b.date ? isoToDays(b.date) : null;
    return typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= 1;
  }
  return true; // yes/no/never/void agree by outcome equality alone
}

/**
 * Map a resolver verdict onto a scoreable ledger outcome, or explain why it
 * can't be scored. Pure and exported so the kind/outcome safety is testable
 * without driving a live resolution agent.
 *
 * Fail-closed on a kind/outcome mismatch: the verdict's outcome type must fit
 * the question kind, or it is routed to manual settlement rather than scored.
 * Without this a non-"yes" verdict on a binary question (e.g. the resolver
 * answering "never"/"value") fell through to the binary branch and scored as
 * NO — silently poisoning every parameter the flywheel fits on the record.
 */
export function resolveOutcome(
  entry: LedgerEntry,
  verdict: Pick<ResolutionVerdict, "outcome" | "value" | "option" | "date">
): { outcome: LedgerOutcome } | { skip: string } {
  const kind = entry.question.kind;
  const kindOk =
    verdict.outcome === "void" ||
    (kind === "binary" && (verdict.outcome === "yes" || verdict.outcome === "no")) ||
    (kind === "numeric" && verdict.outcome === "value") ||
    (kind === "mc" && verdict.outcome === "option") ||
    (kind === "date" && (verdict.outcome === "date" || verdict.outcome === "never"));
  if (!kindOk) {
    return {
      skip: `resolver returned a "${verdict.outcome}" verdict for a ${kind} question — settle manually with: swarm resolve set ${entry.id} <outcome>`,
    };
  }
  if (verdict.outcome === "void") return { outcome: "void" };
  if (kind === "numeric") {
    return typeof verdict.value === "number" ? { outcome: verdict.value } : { skip: "numeric outcome had no value" };
  }
  if (kind === "mc") {
    // The realized option must match the list exactly (case-insensitive) —
    // scoring against an option the panel never priced would be garbage.
    const opt = (entry.question.options ?? []).find(
      (o) => o.trim().toLowerCase() === String(verdict.option ?? "").trim().toLowerCase()
    );
    return opt
      ? { outcome: opt }
      : {
          skip: `verdict option ${JSON.stringify(verdict.option ?? "")} is not in the question's option list — settle manually with: swarm resolve set ${entry.id} <option>`,
        };
  }
  if (kind === "date") {
    if (verdict.outcome === "never") return { outcome: "never" };
    const days = verdict.date ? isoToDays(verdict.date) : null;
    return typeof days === "number" ? { outcome: days } : { skip: "date outcome had no parseable date" };
  }
  // binary — kindOk guarantees the outcome is "yes" or "no" here.
  return { outcome: verdict.outcome === "yes" ? 1 : 0 };
}

/** Audit trail: every machine resolution is reviewable after the fact. Best-effort. */
function writeAudit(id: string, payload: Record<string, unknown>): void {
  try {
    const auditDir = path.join(forecastsDir(), "audit");
    ensureDir(auditDir);
    fs.writeFileSync(path.join(auditDir, `${id}.json`), JSON.stringify({ id, t: Date.now(), ...payload }, null, 2), "utf8");
  } catch {
    /* audit is best-effort */
  }
}

/** One mini-agent pass over a single due forecast. Returns the parsed verdict (or null). */
async function resolveOne(
  cfg: SwarmConfig,
  entry: LedgerEntry,
  signal: AbortSignal,
  log?: LogFn
): Promise<ResolutionVerdict | null> {
  const agentId = rid("r");
  const today = new Date().toISOString().slice(0, 10);
  const toolCalls: { name: string; args: string }[] = [];
  const outcome = await runAgent({
    cfg,
    agentId,
    model: cfg.cheapModel || cfg.model,
    thinking: cfg.thinking,
    reasoningEffort: cfg.reasoningEffort,
    system: resolutionSystem(entry, today),
    kickoff: "Determine the outcome now, then call submit_resolution(...).",
    tools: resolutionTools(cfg),
    terminal: [SUBMIT_RESOLUTION_TOOL],
    maxSteps: 12,
    signal,
    ctx: miniCtx(cfg, agentId, entry.question.text, signal, log),
    hooks: {
      onToolCall: (_id, name, args) => toolCalls.push({ name, args: oneLine(JSON.stringify(args), 200) }),
      onLog: (level, msg) => log?.(level, msg),
    },
  });
  if (!outcome.terminal) return null;
  const a = outcome.terminal.args as Record<string, unknown>;
  const verdict: ResolutionVerdict = {
    outcome: VERDICT_OUTCOMES.includes(String(a.outcome))
      ? (String(a.outcome) as ResolutionVerdict["outcome"])
      : "unclear",
    value: Number.isFinite(Number(a.value)) ? Number(a.value) : undefined,
    option: a.option ? clip(String(a.option), 200) : undefined,
    date: a.date ? clip(String(a.date), 40) : undefined,
    evidence: clip(String(a.evidence ?? ""), 2000),
    confidence: ["high", "medium", "low"].includes(String(a.confidence))
      ? (String(a.confidence) as ResolutionVerdict["confidence"])
      : "low",
    sources: Array.isArray(a.sources)
      ? a.sources.map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 10)
      : [],
  };
  writeAudit(entry.id, { question: entry.question, verdict, steps: outcome.steps, toolCalls });
  return verdict;
}

/**
 * Resolve every past-due open forecast (or the given ids) with bounded
 * parallelism. Solid verdicts are scored and appended to the ledger;
 * unclear/low-confidence ones stay open with a skip note.
 */
export async function resolveDue(
  cfg: SwarmConfig,
  opts: { ids?: string[]; maxParallel?: number; signal?: AbortSignal; log?: LogFn } = {}
): Promise<ResolveResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const due = opts.ids?.length
    ? loadLedger().filter((e) => !e.resolution && opts.ids!.includes(e.id))
    : dueForecasts();
  const result: ResolveResult = { resolved: [], skipped: [] };
  if (!due.length) return result;

  const maxParallel = Math.min(Math.max(opts.maxParallel ?? 4, 1), 8);
  let next = 0;
  const worker = async () => {
    while (next < due.length && !signal.aborted) {
      const entry = due[next++];
      const qText = oneLine(entry.question.text, 100);
      opts.log?.("info", `resolving ${entry.id}: ${qText}`);
      // Tournament questions carry their source market — the platform's own
      // resolution is ground truth, far more reliable than a research agent.
      if (entry.origin) {
        try {
          const pr = await resolveFromPlatform(cfg, entry.origin, signal);
          if (pr) {
            writeAudit(entry.id, { question: entry.question, platform: entry.origin.platform, verdict: pr });
            const rec = resolveLedgerEntry(entry, pr.outcome, {
              evidence: pr.evidence,
              sources: [entry.origin.url],
              resolvedBy: "swarm",
            });
            result.resolved.push({ ...rec, question: qText });
            continue;
          }
          opts.log?.("info", `${entry.id}: ${entry.origin.platform} hasn't settled it yet — trying a resolution agent`);
        } catch (e) {
          opts.log?.("warn", `${entry.id}: platform resolution failed (${errMsg(e)}) — trying a resolution agent`);
        }
      }
      let verdict: ResolutionVerdict | null = null;
      try {
        verdict = await resolveOne(cfg, entry, signal, opts.log);
      } catch (e) {
        result.skipped.push({ id: entry.id, question: qText, reason: `agent error: ${errMsg(e)}` });
        continue;
      }
      if (!verdict) {
        result.skipped.push({ id: entry.id, question: qText, reason: "agent produced no verdict" });
        continue;
      }
      if (verdict.outcome === "unclear" || verdict.confidence === "low") {
        result.skipped.push({
          id: entry.id,
          question: qText,
          reason: `left open (${verdict.outcome}, confidence ${verdict.confidence}): ${oneLine(verdict.evidence, 160)} — settle manually with: swarm resolve set ${entry.id} <yes|no|void|value>`,
        });
        continue;
      }
      // Medium confidence buys a second opinion: an independent resolver must
      // agree before the outcome is scored. Disagreement surfaces for the
      // operator instead of poisoning the calibration record.
      if (verdict.confidence === "medium") {
        let second: ResolutionVerdict | null = null;
        try {
          second = await resolveOne(cfg, entry, signal, opts.log);
        } catch {
          /* the first verdict stands alone */
        }
        if (second && second.outcome !== "unclear") {
          if (!verdictsAgree(entry, verdict, second)) {
            writeAudit(entry.id, { question: entry.question, disagreement: { first: verdict, second } });
            result.skipped.push({
              id: entry.id,
              question: qText,
              reason: `independent resolvers disagreed ("${verdict.outcome}" vs "${second.outcome}") — settle manually with: swarm resolve set ${entry.id} <outcome>`,
            });
            continue;
          }
          verdict.sources = [...new Set([...verdict.sources, ...second.sources])].slice(0, 10);
          if (second.confidence === "high") verdict.confidence = "high";
        }
      }
      const mapped = resolveOutcome(entry, verdict);
      if ("skip" in mapped) {
        result.skipped.push({ id: entry.id, question: qText, reason: mapped.skip });
        continue;
      }
      const outcome = mapped.outcome;
      const rec = resolveLedgerEntry(entry, outcome, {
        evidence: verdict.evidence,
        sources: verdict.sources,
        resolvedBy: "swarm",
      });
      result.resolved.push({ ...rec, question: qText });
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxParallel, due.length) }, worker));
  return result;
}

// ---------------------------------------------------------------- watch (update triggers)

const SUBMIT_WATCH_TOOL: ToolSchema = {
  name: "submit_watch",
  description: "Report whether any update triggers for an open forecast have fired.",
  parameters: {
    type: "object",
    properties: {
      fired: { type: "boolean", description: "Did at least one trigger observably fire?" },
      summary: {
        type: "string",
        description: "Which triggers fired (with evidence and direction), or why none have",
      },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["fired", "summary"],
  },
};

export interface WatchAlert {
  id: string;
  question: string;
  fired: boolean;
  summary: string;
  sources: string[];
}

/**
 * Re-check the update triggers of open (not-yet-due) forecasts with one
 * mini-agent each. A fired trigger means the recorded probability is stale —
 * the operator should re-run the forecast.
 */
export async function watchOpenForecasts(
  cfg: SwarmConfig,
  opts: { signal?: AbortSignal; log?: LogFn; maxParallel?: number } = {}
): Promise<WatchAlert[]> {
  const signal = opts.signal ?? new AbortController().signal;
  const now = Date.now();
  const all = loadLedger();
  // A superseded forecast is no longer the live view of its question — its
  // newer link carries the watch (and re-watching it would loop re-forecasts).
  const superseded = supersededIds(all);
  const open = all.filter(
    (e) =>
      !e.resolution &&
      !superseded.has(e.id) &&
      e.triggers?.length &&
      Date.parse(`${e.question.resolutionDate}T23:59:59Z`) > now
  );
  const alerts: WatchAlert[] = [];
  if (!open.length) return alerts;
  const maxParallel = Math.min(Math.max(opts.maxParallel ?? 4, 1), 8);
  let next = 0;
  const worker = async () => {
    while (next < open.length && !signal.aborted) {
      const entry = open[next++];
      const agentId = rid("wch");
      const forecastDate = new Date(entry.t).toISOString().slice(0, 10);
      try {
        const outcome = await runAgent({
          cfg,
          agentId,
          model: cfg.cheapModel || cfg.model,
          thinking: cfg.thinking,
          reasoningEffort: cfg.reasoningEffort,
          system: `You are monitoring an open forecast for staleness. On ${forecastDate} a panel forecast this question and named the triggers below as the events that should move the forecast. Check whether any have OBSERVABLY fired since then (today is ${new Date().toISOString().slice(0, 10)}).

${questionBlock(entry.question)}

UPDATE TRIGGERS TO CHECK
${entry.triggers!.map((t) => `- ${t}`).join("\n")}

Use web_search (freshness: "month" or tighter) and fetch_url to check each plausible trigger. ≤10 tool steps. End with submit_watch(fired, summary, sources) — summary names which triggers fired with evidence and direction, or says clearly that none have.`,
          kickoff: "Check the triggers now, then call submit_watch(...).",
          tools: resolutionTools(cfg),
          terminal: [SUBMIT_WATCH_TOOL],
          maxSteps: 10,
          signal,
          ctx: miniCtx(cfg, agentId, entry.question.text, signal, opts.log),
          hooks: { onLog: (level, msg) => opts.log?.(level, msg) },
        });
        const a = (outcome.terminal?.args ?? {}) as Record<string, unknown>;
        alerts.push({
          id: entry.id,
          question: oneLine(entry.question.text, 100),
          fired: Boolean(a.fired),
          summary: clip(String(a.summary ?? "(no summary)"), 1200),
          sources: Array.isArray(a.sources) ? a.sources.map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 8) : [],
        });
      } catch (e) {
        opts.log?.("warn", `watch ${entry.id} failed: ${errMsg(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxParallel, open.length) }, worker));
  return alerts;
}

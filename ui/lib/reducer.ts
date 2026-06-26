import type {
  ActivityItem,
  AgentView,
  AggregateForecast,
  BlackboardNote,
  ConductorSay,
  Forecast,
  ForecastPanelist,
  ForecastQuestion,
  OperatorNote,
  RunMeta,
  RunStatus,
  ScenarioRow,
  SensitivityIndex,
  SimulationView,
  SubForecast,
  Task,
  Usage,
} from "./types";
import type { SwarmEvent } from "./types";
import { shortPath, summarizeToolError } from "./feed";

export interface ClientState {
  meta: RunMeta | null;
  status: RunStatus;
  statusReason: string;
  tasks: Map<string, Task>;
  taskOrder: string[];
  agents: Map<string, AgentView>;
  notes: BlackboardNote[];
  conductorLog: ConductorSay[];
  operatorNotes: OperatorNote[];
  activity: ActivityItem[];
  usage: Usage;
  cost: number;
  /** Sampled cumulative token spend over time (budget sparkline). */
  budgetSeries: { t: number; tokens: number; cost: number }[];
  /** Distinct web source URLs touched so far (fetches, search hits, cited sources) — live counter. */
  sourceUrls: Set<string>;
  /** Per-task slices of the same counter, for live badges on running cards. */
  sourcesByTask: Map<string, Set<string>>;
  /** Bumped on every plan.updated — the Plan tab refetches on change. */
  planUpdatedAt: number;
  /** Forecast runs: the sharpened question and (once computed) the mechanical aggregate. */
  question: ForecastQuestion | null;
  aggregate: AggregateForecast | null;
  forecastPanel: ForecastPanelist[];
  /** Decomposition: the framing brief, detected domain, and every sub-forecast keyed by id. */
  forecastBrief: string;
  forecastDomain: string | null;
  questions: ForecastQuestion[];
  subForecasts: Map<string, SubForecast>;
  /** Code (build) runs: the engine-owned plan, TDD spec, gate/review history, ensembles. Null until a code.* event arrives. */
  code: CodeState | null;
  finalSummary?: string;
  finalReportPath?: string;
  lastSeq: number;
  lastT: number;
}

export interface ProductSpecView {
  productName: string;
  oneLiner: string;
  features: { name: string; description: string; priority: "core" | "secondary" }[];
  screens: { name: string; purpose: string; elements: string[] }[];
  dataModel: { entity: string; fields: string[]; relations?: string }[];
  recommendedStack: { frontend?: string; backend?: string; database?: string; auth?: string; styling?: string; testing?: string; other?: string[]; rationale: string };
  uxDetails: string[];
  nonGoals: string[];
  sources: string[];
  grounded: boolean;
}

export interface CodeState {
  criteria: { id: string; text: string; met: boolean }[];
  /** The grounded product spec from the research phase (null when the build wasn't grounded). */
  productSpec: ProductSpecView | null;
  /** Scored best-of-N plan candidates (the winner is flagged). */
  planCandidates: { perspective: string; score: number; validPartition: boolean; coverage: number; moduleCount: number; winner: boolean }[];
  buildPlan: { modules: { id: string; files: string[]; purpose: string; deps?: string[]; hard?: boolean }[]; waves: string[][] | null } | null;
  map: { fileCount: number; symbolCount: number; truncated: boolean } | null;
  specSeeded: boolean;
  /** Conversational narration bubbles (plan / progress / result), derived from build events. */
  narration: { kind: "plan" | "progress" | "result"; text: string; phase?: string; t: number }[];
  /** The plan surfaced for operator approval (present while status is awaiting-approval). */
  proposed: { stack: string | null; criteria: { id: string; text: string }[]; modules: { id: string; purpose: string }[]; waves: string[][] | null } | null;
  /** The build arc (recon → build → integrate → harden …) as the engine sets each phase. */
  phases: { name: string; goal?: string; exit?: string; t: number }[];
  gates: { green: boolean; skipped: boolean; clean: boolean; summary: string }[];
  reviews: { clean: boolean; issues: string[]; round: number }[];
  /** Completeness / parity critic verdicts: whether the green tree delivers the FULL mission. */
  completeness: { complete: boolean; gaps: string[]; round: number }[];
  ensembles: { taskId: string; n: number; winner: number; merged: boolean; scores: { i: number; score: number; green: boolean }[] }[];
  /** Render/visual/functional parity pass outcomes (Phase 2). */
  visual: { clean: boolean; findings: string[]; deadControls: string[]; round: number; skipped?: string; screenshots: string[] }[];
  /** The design target ingested for a UI build (Phase 2), or null. */
  designSpec: { source: string; screens: number; hasReference: boolean } | null;
}

function emptyCode(): CodeState {
  return { criteria: [], productSpec: null, planCandidates: [], buildPlan: null, map: null, specSeeded: false, narration: [], proposed: null, phases: [], gates: [], reviews: [], completeness: [], ensembles: [], visual: [], designSpec: null };
}

const PRICING: Record<string, { inMiss: number; inHit: number; out: number }> = {
  "deepseek-v4-flash": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  "deepseek-v4-pro": { inMiss: 0.435, inHit: 0.003625, out: 0.87 },
  "deepseek-chat": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  "deepseek-reasoner": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
};

export function emptyState(): ClientState {
  return {
    meta: null,
    status: "planning",
    statusReason: "",
    tasks: new Map(),
    taskOrder: [],
    agents: new Map(),
    notes: [],
    conductorLog: [],
    operatorNotes: [],
    activity: [],
    usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
    cost: 0,
    budgetSeries: [],
    sourceUrls: new Set(),
    sourcesByTask: new Map(),
    planUpdatedAt: 0,
    question: null,
    aggregate: null,
    forecastPanel: [],
    forecastBrief: "",
    forecastDomain: null,
    questions: [],
    subForecasts: new Map(),
    code: null,
    lastSeq: 0,
    lastT: 0,
  };
}

/** Mirror of the server reducer's sampling: a point per ≥0.5%-of-cap jump. */
function pushBudgetPoint(s: ClientState, t: number): void {
  const tokens = s.usage.promptTokens + s.usage.completionTokens;
  const cap = s.meta?.options?.maxTokens ?? 0;
  const minStep = cap > 0 ? Math.max(2000, cap * 0.005) : 2000;
  const last = s.budgetSeries[s.budgetSeries.length - 1];
  if (last && tokens - last.tokens < minStep) {
    last.t = t;
    last.tokens = tokens;
    last.cost = s.cost;
    return;
  }
  s.budgetSeries.push({ t, tokens, cost: s.cost });
  if (s.budgetSeries.length > 600) {
    s.budgetSeries = s.budgetSeries.filter((_, i) => i % 2 === 0 || i === s.budgetSeries.length - 1);
  }
}

const MAX_ACTIVITY = 260;
const TAIL = 4000;

function clipTail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/**
 * Keep the singular `aggregate`/`forecastPanel` (what the headline gauge reads)
 * pointed at the primary — first — sub-forecast, regardless of the order its
 * per-question events arrive in.
 */
function syncPrimaryForecast(s: ClientState): void {
  const primaryId = s.questions[0]?.id ?? s.subForecasts.keys().next().value;
  const primary = primaryId ? s.subForecasts.get(primaryId) : undefined;
  if (primary) {
    s.aggregate = primary.aggregate;
    s.forecastPanel = primary.panel;
  }
}

export function applyEvent(s: ClientState, ev: SwarmEvent): ClientState {
  if (ev.seq <= s.lastSeq && ev.type !== "run.created") return s;
  s.lastSeq = Math.max(s.lastSeq, ev.seq);
  if (typeof ev.t === "number") s.lastT = Math.max(s.lastT, ev.t);

  // Hierarchical-team events (stamped teamId) belong to a sub-swarm: their
  // tasks/agents must not pollute the root board. Cost still rolls up, and
  // tool calls surface in the feed tagged with the owning team task.
  if (typeof ev.teamId === "string") {
    if (ev.type === "usage") {
      const u = ev.usage as Usage;
      accrueUsage(s, u);
      // ev.cost on team events is the CHILD executor's own cumulative — it
      // must never overwrite the run total (the next root usage event resyncs
      // s.cost to the engine's authoritative cumulative anyway).
      s.cost += priceUsage(ev.model as string | undefined, u);
      pushBudgetPoint(s, ev.t);
    } else if (ev.type === "tool.call") {
      trackWebTool(s, ev, ev.teamId);
      pushActivity(s, {
        id: `t${ev.seq}`, t: ev.t, agentId: ev.agentId as string, taskId: ev.teamId,
        kind: "tool", name: ev.name as string, text: summarizeArgs(ev.name as string, ev.args, s.meta?.cwd),
      });
    } else if (ev.type === "tool.result") {
      trackWebTool(s, ev, ev.teamId);
    } else if (ev.type === "note.added") {
      // Shared blackboard: team notes are swarm-wide facts (but they stay out
      // of the root activity feed, like the rest of a team's chatter).
      pushNote(s, ev, ev.teamId);
    }
    return s;
  }

  switch (ev.type) {
    case "run.created":
      s.meta = ev.meta as RunMeta;
      break;
    case "run.status":
      s.status = ev.status as RunStatus;
      if (ev.reason) s.statusReason = String(ev.reason);
      break;
    case "run.resumed": {
      // Tasks that were in flight when the engine died re-run from scratch;
      // agents the dead process owned can no longer be running.
      const resets = Array.isArray(ev.resets) ? (ev.resets as string[]) : [];
      for (const id of resets) {
        const t = s.tasks.get(id);
        if (t) {
          t.status = "pending";
          t.startedAt = undefined;
          t.endedAt = undefined;
          s.tasks.set(id, { ...t });
        }
      }
      for (const a of s.agents.values()) {
        if (a.status === "running") {
          a.status = "done";
          a.endedAt = ev.t;
          s.agents.set(a.id, { ...a });
        }
      }
      s.statusReason = "";
      break;
    }
    case "task.created": {
      const t = ev.task as Task;
      if (!s.tasks.has(t.id)) s.taskOrder.push(t.id);
      s.tasks.set(t.id, { ...t });
      pushActivity(s, {
        id: `c${ev.seq}`, t: ev.t, agentId: "", taskId: t.id, kind: "spawn",
        text: `${t.id} created · ${t.title}`,
      });
      break;
    }
    case "task.status": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.status = ev.status as Task["status"];
        if (typeof ev.attempt === "number") t.attempt = ev.attempt;
        if (ev.status === "running" && !t.startedAt) t.startedAt = ev.t;
        if (["done", "failed", "blocked"].includes(String(ev.status))) t.endedAt = ev.t;
        if (ev.reason) t.error = String(ev.reason);
        s.tasks.set(t.id, { ...t });
      }
      break;
    }
    case "task.report": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.report = ev.report as string;
        t.reportStatus = ev.status as "done" | "blocked";
        t.artifacts = (ev.artifacts as string[]) ?? t.artifacts;
        if (Array.isArray(ev.keyFacts)) t.keyFacts = ev.keyFacts as string[];
        if (Array.isArray(ev.openQuestions)) t.openQuestions = ev.openQuestions as string[];
        if (Array.isArray(ev.filesTouched)) t.filesTouched = ev.filesTouched as string[];
        if (Array.isArray(ev.sources)) {
          t.sources = ev.sources as Task["sources"];
          for (const src of t.sources ?? []) addSource(s, src.url, t.id);
        }
        s.tasks.set(t.id, { ...t });
        pushActivity(s, {
          id: `r${ev.seq}`, t: ev.t, agentId: "", taskId: t.id, kind: "report",
          text: `${t.id} reported (${ev.status})`,
        });
      }
      break;
    }
    case "verify.result": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.feedback = ev.feedback as string;
        s.tasks.set(t.id, { ...t });
      }
      break;
    }
    case "agent.spawned":
      s.agents.set(ev.agentId as string, {
        id: ev.agentId as string,
        taskId: ev.taskId as string,
        role: (ev.role as string) ?? "agent",
        model: (ev.model as string) ?? "",
        purpose: (ev.purpose as string) ?? "",
        status: "running",
        steps: 0,
        startedAt: ev.t,
        lastText: "",
        lastThink: "",
      });
      break;
    case "agent.delta": {
      const a = s.agents.get(ev.agentId as string);
      if (a) {
        if (ev.channel === "text") a.lastText = clipTail(a.lastText + (ev.text as string), TAIL);
        else a.lastThink = clipTail(a.lastThink + (ev.text as string), TAIL);
        s.agents.set(a.id, { ...a });
      }
      break;
    }
    case "agent.done": {
      const a = s.agents.get(ev.agentId as string);
      if (a) {
        a.status = "done";
        a.endedAt = ev.t;
        a.steps = (ev.steps as number) ?? a.steps;
        s.agents.set(a.id, { ...a });
      }
      break;
    }
    case "tool.call": {
      trackWebTool(s, ev, ev.taskId as string);
      const a = s.agents.get(ev.agentId as string);
      if (a) {
        a.lastTool = ev.name as string;
        a.steps++;
        s.agents.set(a.id, { ...a });
      }
      pushActivity(s, {
        id: `t${ev.seq}`, t: ev.t, agentId: ev.agentId as string, taskId: ev.taskId as string,
        kind: "tool", name: ev.name as string, text: summarizeArgs(ev.name as string, ev.args, s.meta?.cwd),
      });
      break;
    }
    case "tool.result":
      trackWebTool(s, ev, ev.taskId as string);
      pushActivity(s, {
        id: `x${ev.seq}`, t: ev.t, agentId: ev.agentId as string, taskId: ev.taskId as string,
        kind: "result", name: ev.name as string, ok: ev.ok as boolean,
        text: ev.ok ? String(ev.summary ?? "") : summarizeToolError(String(ev.summary ?? ""), s.meta?.cwd),
      });
      break;
    case "task.checkpoint": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.lastCheckpoint = ev.summary as string;
        s.tasks.set(t.id, { ...t });
      }
      break;
    }
    case "team.created": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.team = true;
        s.tasks.set(t.id, { ...t });
      }
      pushActivity(s, {
        id: `tm${ev.seq}`, t: ev.t, agentId: "", taskId: (ev.taskId as string) ?? "", kind: "spawn",
        text: `${ev.taskId} runs as a sub-swarm (${ev.maxWorkers ?? "?"} workers)`,
      });
      break;
    }
    case "note.added": {
      const note = pushNote(s, ev);
      pushActivity(s, {
        id: `n${ev.seq}`, t: ev.t, agentId: (ev.agentId as string) ?? "", taskId: (ev.taskId as string) ?? "",
        kind: "note", text: (note.key ? `[${note.key}] ` : "") + note.text,
      });
      break;
    }
    case "conductor.say":
      s.conductorLog.push({ t: ev.t, text: ev.text as string });
      if (s.conductorLog.length > 200) s.conductorLog.splice(0, s.conductorLog.length - 200);
      break;
    case "operator.note":
      s.operatorNotes.push({ t: ev.t, text: ev.text as string, consumed: false });
      break;
    case "operator.note.consumed": {
      const idx = s.operatorNotes.findIndex((n) => !n.consumed);
      if (idx >= 0) s.operatorNotes[idx].consumed = true;
      break;
    }
    case "usage": {
      const u = ev.usage as Usage;
      accrueUsage(s, u);
      if (typeof ev.cost === "number" && Number.isFinite(ev.cost)) {
        // The engine journals its cumulative cost (priced with the operator's
        // actual config) — prefer it over re-deriving from a baked-in table.
        s.cost = ev.cost;
      } else {
        s.cost += priceUsage(ev.model as string | undefined, u);
      }
      pushBudgetPoint(s, ev.t);
      break;
    }
    case "plan.updated":
      s.planUpdatedAt = ev.t;
      break;
    case "phase.set":
      // The build arc is only surfaced for code runs (the Build Console timeline).
      if (s.meta?.options?.mode === "code") {
        const c = (s.code ??= emptyCode());
        c.phases.push({
          name: String(ev.name ?? ""),
          goal: ev.goal ? String(ev.goal) : undefined,
          exit: ev.exit_criteria ? String(ev.exit_criteria) : undefined,
          t: ev.t,
        });
      }
      break;
    case "forecast.plan":
      if (Array.isArray(ev.questions)) s.questions = ev.questions as ForecastQuestion[];
      if (typeof ev.brief === "string") s.forecastBrief = ev.brief;
      if (typeof ev.domain === "string") s.forecastDomain = ev.domain;
      break;
    case "forecast.question":
      // Primary headline = the first sub-forecast; later sub-forecasts don't
      // overwrite it (they surface in the decomposition breakdown instead).
      if (!s.question) s.question = ev.question as ForecastQuestion;
      break;
    case "forecast.submitted": {
      const t = s.tasks.get(ev.taskId as string);
      if (t) {
        t.forecast = ev.forecast as Forecast;
        s.tasks.set(t.id, { ...t });
      }
      break;
    }
    case "forecast.aggregated": {
      const qid = typeof ev.questionId === "string" ? ev.questionId : s.questions[0]?.id ?? "sf1";
      const prev = s.subForecasts.get(qid);
      const question =
        (ev.question as ForecastQuestion | undefined) ??
        prev?.question ??
        s.questions.find((q) => q.id === qid) ??
        s.question ??
        ({ id: qid, text: "", kind: "binary", resolutionCriteria: "", resolutionDate: "" } as ForecastQuestion);
      s.subForecasts.set(qid, {
        questionId: qid,
        question,
        aggregate: ev.aggregate as AggregateForecast,
        panel: Array.isArray(ev.panel) ? (ev.panel as ForecastPanelist[]) : prev?.panel ?? [],
        ledgerId: typeof ev.ledgerId === "string" ? ev.ledgerId : prev?.ledgerId,
        simulation: prev?.simulation,
      });
      syncPrimaryForecast(s);
      break;
    }
    case "forecast.simulated": {
      const qid = typeof ev.questionId === "string" ? ev.questionId : s.questions[0]?.id ?? "sf1";
      const prev = s.subForecasts.get(qid);
      const sim: SimulationView = {
        weight: typeof ev.weight === "number" ? ev.weight : 0,
        dropped: Array.isArray(ev.dropped) ? (ev.dropped as string[]) : [],
        simulated: ev.simulated as AggregateForecast | undefined,
        scenarios: Array.isArray(ev.scenarios) ? (ev.scenarios as ScenarioRow[]) : [],
        sensitivity: Array.isArray(ev.sensitivity) ? (ev.sensitivity as SensitivityIndex[]) : [],
        coherence: (ev.coherence as SimulationView["coherence"]) ?? { divergence: 0, verdict: "ok" },
        drivers: Array.isArray(ev.drivers) ? (ev.drivers as SimulationView["drivers"]) : [],
      };
      const question =
        prev?.question ??
        s.questions.find((q) => q.id === qid) ??
        s.question ??
        ({ id: qid, text: "", kind: "binary", resolutionCriteria: "", resolutionDate: "" } as ForecastQuestion);
      s.subForecasts.set(qid, {
        questionId: qid,
        question,
        // The simulated headline blend lands on `aggregate`; keep it if present.
        aggregate: (ev.aggregate as AggregateForecast | undefined) ?? prev?.aggregate ?? null,
        panel: prev?.panel ?? [],
        ledgerId: prev?.ledgerId,
        simulation: sim,
      });
      syncPrimaryForecast(s);
      break;
    }
    case "code.criteria": {
      const c = (s.code ??= emptyCode());
      if (Array.isArray(ev.items)) c.criteria = ev.items as CodeState["criteria"];
      break;
    }
    case "code.research": {
      const c = (s.code ??= emptyCode());
      if (ev.spec) c.productSpec = ev.spec as ProductSpecView;
      break;
    }
    case "code.design.candidates": {
      const c = (s.code ??= emptyCode());
      if (Array.isArray(ev.scores)) c.planCandidates = ev.scores as CodeState["planCandidates"];
      break;
    }
    case "code.plan.proposed": {
      const c = (s.code ??= emptyCode());
      c.proposed = {
        stack: (ev.stack as string | null) ?? null,
        criteria: Array.isArray(ev.criteria) ? (ev.criteria as { id: string; text: string }[]).map((x) => ({ id: x.id, text: x.text })) : [],
        modules: Array.isArray(ev.modules) ? (ev.modules as { id: string; purpose: string }[]).map((m) => ({ id: m.id, purpose: m.purpose })) : [],
        waves: (ev.waves as string[][] | null) ?? null,
      };
      break;
    }
    case "code.narrate": {
      const c = (s.code ??= emptyCode());
      const kind = ev.kind === "plan" || ev.kind === "result" ? ev.kind : "progress";
      c.narration.push({ kind, text: String(ev.text ?? ""), phase: ev.phase ? String(ev.phase) : undefined, t: Number(ev.t) || 0 });
      break;
    }
    case "code.visual": {
      const c = (s.code ??= emptyCode());
      c.visual.push({
        clean: Boolean(ev.clean),
        findings: Array.isArray(ev.findings) ? (ev.findings as string[]) : [],
        deadControls: Array.isArray(ev.deadControls) ? (ev.deadControls as string[]) : [],
        round: Number(ev.round) || 0,
        skipped: ev.skipped ? String(ev.skipped) : undefined,
        screenshots: Array.isArray(ev.screenshots) ? (ev.screenshots as string[]) : [],
      });
      break;
    }
    case "code.design.spec": {
      const c = (s.code ??= emptyCode());
      c.designSpec = { source: String(ev.source ?? ""), screens: Number(ev.screens) || 0, hasReference: Boolean(ev.hasReference) };
      break;
    }
    case "code.design": {
      const c = (s.code ??= emptyCode());
      if (ev.plan) c.buildPlan = ev.plan as CodeState["buildPlan"];
      break;
    }
    case "code.map": {
      const c = (s.code ??= emptyCode());
      c.map = { fileCount: Number(ev.fileCount) || 0, symbolCount: Number(ev.symbolCount) || 0, truncated: Boolean(ev.truncated) };
      break;
    }
    case "code.spec": {
      const c = (s.code ??= emptyCode());
      c.specSeeded = true;
      break;
    }
    case "code.gate": {
      const c = (s.code ??= emptyCode());
      c.gates.push({ green: Boolean(ev.green), skipped: Boolean(ev.skipped), clean: Boolean(ev.clean), summary: String(ev.summary ?? "") });
      break;
    }
    case "code.review": {
      const c = (s.code ??= emptyCode());
      c.reviews.push({ clean: Boolean(ev.clean), issues: Array.isArray(ev.issues) ? (ev.issues as string[]) : [], round: Number(ev.round) || 0 });
      break;
    }
    case "code.completeness": {
      const c = (s.code ??= emptyCode());
      c.completeness.push({ complete: Boolean(ev.complete), gaps: Array.isArray(ev.gaps) ? (ev.gaps as string[]) : [], round: Number(ev.round) || 0 });
      break;
    }
    case "code.ensemble": {
      const c = (s.code ??= emptyCode());
      c.ensembles.push({
        taskId: String(ev.taskId ?? ""),
        n: Number(ev.n) || 0,
        winner: Number(ev.winner) || 0,
        merged: Boolean(ev.merged),
        scores: Array.isArray(ev.scores) ? (ev.scores as CodeState["ensembles"][number]["scores"]) : [],
      });
      break;
    }
    case "run.final":
      s.finalSummary = ev.summary as string;
      s.finalReportPath = ev.reportPath as string | undefined;
      break;
  }
  return s;
}

const WEB_TOOLS = new Set(["web_search", "web_search_scholar", "fetch_url", "crawl_site"]);

/** Record a distinct source URL (normalized: no hash, no trailing slash). */
function addSource(s: ClientState, raw: unknown, taskId?: string): void {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return;
  let url: string;
  try {
    const u = new URL(raw);
    u.hash = "";
    url = u.toString().replace(/\/$/, "");
  } catch {
    return; // not a URL
  }
  s.sourceUrls.add(url);
  if (!taskId) return;
  let set = s.sourcesByTask.get(taskId);
  if (!set) {
    set = new Set();
    s.sourcesByTask.set(taskId, set);
  }
  set.add(url);
  // Mirror onto the task so cards re-render with the live badge.
  const t = s.tasks.get(taskId);
  if (t && t.liveSourceCount !== set.size) {
    t.liveSourceCount = set.size;
    s.tasks.set(taskId, { ...t });
  }
}

/** Pull every URL out of free text (search-result summaries) into the source set.
 *  Keep the character class in sync with src/util.ts harvestUrls. */
function harvestUrls(s: ClientState, text: string, taskId?: string): void {
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`…]+/g)) addSource(s, m[0].replace(/[.,;:!?]+$/, ""), taskId);
}

/** Live source tracking for a web tool event (call args or result urls/summary). */
function trackWebTool(s: ClientState, ev: SwarmEvent, taskId: string): void {
  const name = ev.name as string;
  if (!WEB_TOOLS.has(name)) return;
  if (ev.type === "tool.call") {
    const args = ev.args as Record<string, unknown> | undefined;
    if (args && typeof args === "object") addSource(s, args.url, taskId);
    return;
  }
  if (!ev.ok) return;
  // Engine ≥0.8.1 journals the full URL list on tool.result; the regex over
  // the (200-char-clipped) summary is only a fallback for older journals.
  if (Array.isArray(ev.urls)) for (const u of ev.urls) addSource(s, u, taskId);
  else harvestUrls(s, String(ev.summary ?? ""), taskId);
}

function pushActivity(s: ClientState, item: ActivityItem): void {
  s.activity.push(item);
  if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
}

function accrueUsage(s: ClientState, u: Usage): void {
  s.usage = {
    promptTokens: s.usage.promptTokens + u.promptTokens,
    completionTokens: s.usage.completionTokens + u.completionTokens,
    cacheHitTokens: s.usage.cacheHitTokens + u.cacheHitTokens,
    cacheMissTokens: s.usage.cacheMissTokens + u.cacheMissTokens,
  };
}

/** Incremental cost of one usage event. Unknown models cost $0 — match the engine: never guess another provider's rates. */
function priceUsage(model: string | undefined, u: Usage): number {
  const price = PRICING[model ?? ""] ?? { inMiss: 0, inHit: 0, out: 0 };
  const miss = u.cacheMissTokens || Math.max(0, u.promptTokens - u.cacheHitTokens);
  return (miss * price.inMiss + u.cacheHitTokens * price.inHit + u.completionTokens * price.out) / 1e6;
}

function pushNote(s: ClientState, ev: SwarmEvent, teamId?: string): BlackboardNote {
  const note: BlackboardNote = {
    t: ev.t, taskId: ev.taskId as string | undefined, teamId, agentId: ev.agentId as string | undefined,
    key: ev.key as string | undefined, kind: ev.kind as string | undefined, text: ev.text as string,
    url: typeof ev.url === "string" ? ev.url : undefined,
  };
  if (note.url) addSource(s, note.url, note.teamId ?? note.taskId);
  s.notes.push(note);
  if (s.notes.length > 500) s.notes.splice(0, s.notes.length - 500);
  return note;
}

function summarizeArgs(name: string, args: unknown, cwd?: string): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (name) {
    case "shell":
      return String(a.command ?? "");
    case "read_file":
    case "write_file":
    case "replace_in_file":
    case "save_artifact":
      return shortPath(String(a.path ?? a.name ?? ""), cwd);
    case "web_search":
    case "market_odds":
      return String(a.query ?? "");
    case "time_series":
      return `${a.source ?? ""} ${a.series ?? ""}`.trim();
    case "fetch_url":
      return String(a.url ?? "");
    case "list_dir":
      return shortPath(String(a.path ?? "."), cwd);
    case "note":
      return String(a.text ?? "");
    case "spawn_tasks": {
      const tasks = Array.isArray(a.tasks) ? (a.tasks as { title?: string }[]) : [];
      return `${tasks.length} task(s): ` + tasks.map((t) => t.title).filter(Boolean).slice(0, 4).join(", ");
    }
    case "report":
      return String(a.status ?? "");
    default:
      return Object.values(a).map(String).join(" ").slice(0, 120);
  }
}

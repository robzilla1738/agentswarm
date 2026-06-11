import type {
  ActivityItem,
  AgentView,
  BlackboardNote,
  ConductorSay,
  OperatorNote,
  RunMeta,
  RunStatus,
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
  finalSummary?: string;
  finalReportPath?: string;
  lastSeq: number;
  lastT: number;
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
    lastSeq: 0,
    lastT: 0,
  };
}

const MAX_ACTIVITY = 260;
const TAIL = 4000;

function clipTail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
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
      s.usage = {
        promptTokens: s.usage.promptTokens + u.promptTokens,
        completionTokens: s.usage.completionTokens + u.completionTokens,
        cacheHitTokens: s.usage.cacheHitTokens + u.cacheHitTokens,
        cacheMissTokens: s.usage.cacheMissTokens + u.cacheMissTokens,
      };
      if (typeof ev.cost === "number" && Number.isFinite(ev.cost)) s.cost = ev.cost;
    } else if (ev.type === "tool.call") {
      pushActivity(s, {
        id: `t${ev.seq}`, t: ev.t, agentId: ev.agentId as string, taskId: ev.teamId,
        kind: "tool", name: ev.name as string, text: summarizeArgs(ev.name as string, ev.args, s.meta?.cwd),
      });
    } else if (ev.type === "note.added") {
      // Shared blackboard: team notes are swarm-wide facts.
      s.notes.push({
        t: ev.t, taskId: ev.taskId as string | undefined, agentId: ev.agentId as string | undefined,
        key: ev.key as string | undefined, kind: ev.kind as string | undefined, text: ev.text as string,
      });
      if (s.notes.length > 500) s.notes.splice(0, s.notes.length - 500);
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
      const note: BlackboardNote = {
        t: ev.t, taskId: ev.taskId as string | undefined, agentId: ev.agentId as string | undefined,
        key: ev.key as string | undefined, kind: ev.kind as string | undefined, text: ev.text as string,
      };
      s.notes.push(note);
      if (s.notes.length > 500) s.notes.splice(0, s.notes.length - 500);
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
      s.usage = {
        promptTokens: s.usage.promptTokens + u.promptTokens,
        completionTokens: s.usage.completionTokens + u.completionTokens,
        cacheHitTokens: s.usage.cacheHitTokens + u.cacheHitTokens,
        cacheMissTokens: s.usage.cacheMissTokens + u.cacheMissTokens,
      };
      if (typeof ev.cost === "number" && Number.isFinite(ev.cost)) {
        // The engine journals its cumulative cost (priced with the operator's
        // actual config) — prefer it over re-deriving from a baked-in table.
        s.cost = ev.cost;
      } else {
        // Match the engine's semantics: unknown models cost $0 — never guess
        // another provider's rates.
        const price = PRICING[(ev.model as string) ?? ""] ?? { inMiss: 0, inHit: 0, out: 0 };
        const miss = u.cacheMissTokens || Math.max(0, u.promptTokens - u.cacheHitTokens);
        s.cost += (miss * price.inMiss + u.cacheHitTokens * price.inHit + u.completionTokens * price.out) / 1e6;
      }
      break;
    }
    case "run.final":
      s.finalSummary = ev.summary as string;
      s.finalReportPath = ev.reportPath as string | undefined;
      break;
  }
  return s;
}

function pushActivity(s: ClientState, item: ActivityItem): void {
  s.activity.push(item);
  if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
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
      return String(a.query ?? "");
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

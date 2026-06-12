export type RunStatus =
  | "planning"
  | "running"
  | "synthesizing"
  | "done"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "blocked";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface Task {
  id: string;
  title: string;
  objective: string;
  role: string;
  deps: string[];
  verify: boolean;
  context?: string;
  status: TaskStatus;
  attempt: number;
  wave: number;
  report?: string;
  reportStatus?: "done" | "blocked";
  artifacts: string[];
  feedback?: string;
  error?: string;
  lastCheckpoint?: string;
  keyFacts?: string[];
  openQuestions?: string[];
  filesTouched?: string[];
  sources?: { url: string; title?: string; date?: string; note?: string }[];
  /** Client-derived: distinct source URLs this task has touched so far (live). */
  liveSourceCount?: number;
  modelTier?: "cheap" | "default" | "strong";
  team?: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  agentIds: string[];
}

export interface AgentView {
  id: string;
  taskId: string;
  role: string;
  model: string;
  purpose: string;
  status: "running" | "done";
  steps: number;
  startedAt: number;
  endedAt?: number;
  lastText: string;
  lastThink: string;
  lastTool?: string;
}

export interface BlackboardNote {
  t: number;
  taskId?: string;
  /** Set when a team agent posted it — task ids only disambiguate per team. */
  teamId?: string;
  agentId?: string;
  key?: string;
  /** finding | decision | conflict | open-question | handoff | claim */
  kind?: string;
  text: string;
  /** Source URL backing the note, when it came from the web. */
  url?: string;
}

export interface ConductorSay {
  t: number;
  text: string;
}

export interface OperatorNote {
  t: number;
  text: string;
  consumed: boolean;
}

export interface RunMeta {
  id: string;
  mission: string;
  createdAt: number;
  cwd: string;
  sandbox: boolean;
  options: {
    model: string;
    conductorModel: string;
    maxWorkers: number;
    maxStepsPerTask: number;
    maxTasks: number;
    maxTokens: number;
    verification: string;
    thinking: boolean;
    reasoningEffort: string;
    safeMode: boolean;
  };
}

export interface RunSummary {
  id: string;
  mission: string;
  status: RunStatus;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  tasks: {
    total: number;
    done: number;
    failed: number;
    running: number;
    pending: number;
    blocked: number;
  };
  agentsActive: number;
  usage: Usage;
  cost: number;
  sourceCount?: number;
  pid: number | null;
  finalSummary?: string;
}

export interface RunSnapshot {
  id: string;
  meta: RunMeta;
  status: RunStatus;
  statusReason: string;
  summary: RunSummary;
  tasks: Task[];
  agents: AgentView[];
  notes: BlackboardNote[];
  conductorLog: ConductorSay[];
  operatorNotes: OperatorNote[];
  usageByModel: Record<string, Usage>;
  cost: number;
  finalSummary?: string;
  finalReportPath?: string;
  live: boolean;
  lastSeq: number;
}

export interface SwarmEvent {
  seq: number;
  t: number;
  type: string;
  [k: string]: unknown;
}

export interface ActivityItem {
  id: string;
  t: number;
  agentId: string;
  taskId: string;
  kind: "tool" | "result" | "note" | "report" | "spawn" | "done";
  name?: string;
  ok?: boolean;
  text: string;
}

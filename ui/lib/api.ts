import type { CalibrationStats, LedgerEntry, RunSnapshot, RunSummary, SessionSnapshot, SessionSummary, SwarmEvent } from "./types";

/**
 * Resolve the hub base URL. When the UI is served by the hub itself, the API
 * is same-origin (""). In `next dev` (port 7780) we target the hub on 7777,
 * overridable via NEXT_PUBLIC_HUB.
 */
export function hubBase(): string {
  if (typeof window === "undefined") return "";
  const env = process.env.NEXT_PUBLIC_HUB;
  if (env) return env.replace(/\/+$/, "");
  const { protocol, hostname, port } = window.location;
  if (port === "7780") return `${protocol}//${hostname}:7777`;
  return "";
}

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(hubBase() + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(hubBase() + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    let msg = txt;
    try { msg = JSON.parse(txt).error || txt; } catch { /* keep txt */ }
    throw new Error(msg || `${res.status}`);
  }
  return res.json();
}

export interface ProviderView {
  id: string;
  label: string;
  keyRequired: boolean;
  keyUrl?: string;
  local: boolean;
  note?: string;
  keySet: boolean;
  keyMasked: string;
  baseUrl: string;
  defaultBaseUrl: string;
  defaultModel: string;
  knownModels: string[];
}

export interface PublicConfig {
  provider: string;
  providers: ProviderView[];
  apiKeySet: boolean;
  apiKeyMasked: string;
  tinyfishKeySet: boolean;
  tinyfishKeyMasked: string;
  searchBackend: string;
  crawlBackend: string;
  crawlResolved: string | null;
  firecrawlKeySet: boolean;
  firecrawlKeyMasked: string;
  contextdevKeySet: boolean;
  contextdevKeyMasked: string;
  deepcrawlKeySet: boolean;
  deepcrawlKeyMasked: string;
  deepcrawlBaseUrl: string;
  sandboxRuntime: string;
  sandboxResolved: string;
  sandboxImage: string;
  dockerUp: boolean;
  e2bKeySet: boolean;
  e2bKeyMasked: string;
  e2bTemplate: string;
  modalConfigured: boolean;
  vercelConfigured: boolean;
  vercelTeamId: string;
  vercelProjectId: string;
  baseUrl: string;
  model: string;
  conductorModel: string;
  maxWorkers: number;
  maxStepsPerTask: number;
  maxTasks: number;
  maxTokensPerRun: number;
  maxToolResultChars: number;
  verification: string;
  verifyMaxAttempts: number;
  thinking: boolean;
  reasoningEffort: string;
  safeMode: boolean;
  contextTokenLimit: number;
  contextWindows: Record<string, number>;
  cheapModel: string;
  strongModel: string;
  fredKeySet: boolean;
  fredKeyMasked: string;
  metaculusKeySet: boolean;
  metaculusKeyMasked: string;
  oddsKeySet: boolean;
  oddsKeyMasked: string;
  forecastPanelSize: number;
  forecastExtremizeK: number;
  forecastCoherenceProbe: boolean;
  forecastMarketWeight: number;
  forecastSportsMarketWeight: number;
  forecastDecompose: boolean;
  forecastMaxSubQuestions: number;
  forecastSimulate: boolean;
  knownModels: string[];
  pricing: Record<string, { inMiss: number; inHit: number; out: number }>;
}

export interface DomainDetection {
  domain: string;
  label: string;
  confidence: number;
  source: "deterministic" | "llm" | "none" | "empty";
  relevantKnobs: string[];
  alternatives: { domain: string; label: string }[];
}

export interface ForecastModelView {
  id: string;
  name: string;
  domain?: string;
  tunables: Record<string, unknown>;
  fitMode: "live" | "frozen";
  fitted?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  record: { n: number; resolved: number; brierMean?: number; vsMarket?: number };
}

export const api = {
  health: () => jget<{ ok: boolean; apiKey: boolean; version: string }>("/api/health"),
  getConfig: () => jget<PublicConfig>("/api/config"),
  setConfig: (patch: Record<string, unknown>) => jpost<PublicConfig>("/api/config", patch),
  models: () => jget<{ models: string[]; error?: string }>("/api/models"),
  validate: () => jget<{ status: "ok" | "invalid" | "unknown"; message?: string }>("/api/validate"),
  sandboxTest: (runtime?: string) =>
    jpost<{ kind: string; ok: boolean; detail: string }>("/api/sandbox/test", runtime ? { runtime } : {}),
  searchTest: () =>
    jpost<{ ok: boolean; engines: { engine: string; ok: boolean; detail: string }[] }>("/api/search/test", {}),
  crawlTest: () => jpost<{ ok: boolean; backend: string | null; detail: string }>("/api/crawl/test", {}),
  listDirs: (path?: string) =>
    jget<{ path: string; parent: string | null; home: string; dirs: { name: string; path: string }[] }>(
      `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`
    ),
  listRuns: () => jget<{ runs: RunSummary[] }>("/api/runs"),
  createRun: (body: { mission: string; sandbox?: boolean; cwd?: string; options?: Record<string, unknown> }) =>
    jpost<{ id: string }>("/api/runs", body),
  getRun: (id: string) => jget<RunSnapshot>(`/api/runs/${id}`),
  events: (id: string, since: number) =>
    jget<{ events: SwarmEvent[]; live: boolean }>(`/api/runs/${id}/events?since=${since}`),
  note: (id: string, text: string) => jpost<{ ok: boolean }>(`/api/runs/${id}/note`, { text }),
  cancel: (id: string) => jpost<{ ok: boolean }>(`/api/runs/${id}/cancel`, {}),
  resume: (id: string) => jpost<{ ok: boolean }>(`/api/runs/${id}/resume`, {}),
  deleteRun: async (id: string): Promise<void> => {
    const res = await fetch(hubBase() + `/api/runs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch { /* keep txt */ }
      throw new Error(msg || `${res.status}`);
    }
  },
  artifacts: (id: string) => jget<{ artifacts: { name: string; size: number }[] }>(`/api/runs/${id}/artifacts`),
  fetchPlan: async (id: string): Promise<string | null> => {
    const res = await fetch(hubBase() + `/api/runs/${id}/plan`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.text();
  },
  artifactUrl: (id: string, name: string) => hubBase() + `/api/runs/${id}/artifacts/${encodeURIComponent(name)}`,
  reportUrl: (id: string) => hubBase() + `/api/runs/${id}/report`,
  reportHtmlUrl: (id: string, opts?: { theme?: "light" | "dark"; print?: boolean }) => {
    const q = new URLSearchParams();
    if (opts?.theme) q.set("theme", opts.theme);
    if (opts?.print) q.set("print", "1");
    const qs = q.toString();
    return hubBase() + `/api/runs/${id}/report.html${qs ? `?${qs}` : ""}`;
  },
  streamUrl: (id: string) => hubBase() + `/api/runs/${id}/stream`,
  // ---- code-chat sessions ----
  listSessions: () => jget<{ sessions: SessionSummary[] }>("/api/sessions"),
  createSession: (body: { title?: string; message?: string; workspace?: string; options?: Record<string, unknown> }) =>
    jpost<{ id: string; firstTurnId?: string }>("/api/sessions", body),
  getSession: (id: string) => jget<SessionSnapshot>(`/api/sessions/${id}`),
  sessionMessage: (id: string, message: string) =>
    jpost<{ turnId: string }>(`/api/sessions/${id}/message`, { message }),
  // ---- live-turn control (steer / stop / approve the plan) ----
  sessionNote: (id: string, text: string) => jpost<{ ok: boolean }>(`/api/sessions/${id}/note`, { text }),
  sessionCancel: (id: string) => jpost<{ ok: boolean }>(`/api/sessions/${id}/cancel`, {}),
  sessionApprove: (id: string) => jpost<{ ok: boolean }>(`/api/sessions/${id}/approve`, {}),
  // ---- per-turn diff + revert ----
  turnDiff: async (id: string, turnId: string): Promise<string> => {
    const res = await fetch(hubBase() + `/api/sessions/${id}/turns/${turnId}/diff`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch { /* keep txt */ }
      throw new Error(msg || `${res.status}`);
    }
    return res.text();
  },
  revertTurn: (id: string, turnId: string) => jpost<{ ok: boolean }>(`/api/sessions/${id}/turns/${turnId}/revert`, {}),
  deleteSession: async (id: string): Promise<void> => {
    const res = await fetch(hubBase() + `/api/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch { /* keep txt */ }
      throw new Error(msg || `${res.status}`);
    }
  },
  forecasts: () => jget<{ forecasts: LedgerEntry[]; calibration: CalibrationStats }>("/api/forecasts"),
  resolveForecasts: (ids?: string[]) =>
    jpost<{
      resolved: { id: string; outcome: 0 | 1 | number | string | "void"; brier?: number; question: string }[];
      skipped: { id: string; question: string; reason: string }[];
    }>("/api/forecasts/resolve", ids?.length ? { ids } : {}),
  resolveManual: (id: string, outcome: "yes" | "no" | "void" | "never" | number | string) =>
    jpost<{ ok: boolean }>(`/api/forecasts/${id}/resolve`, { outcome }),
  detectDomain: (text: string) => jpost<DomainDetection>("/api/forecast/detect", { text }),
  forecastModels: () => jget<{ models: ForecastModelView[] }>("/api/forecast-models"),
  saveForecastModel: (m: Record<string, unknown>) => jpost<{ model: ForecastModelView }>("/api/forecast-models", m),
  deleteForecastModel: async (id: string): Promise<void> => {
    const res = await fetch(hubBase() + `/api/forecast-models/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${res.status}`);
  },
};

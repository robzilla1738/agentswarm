import type { RunSnapshot, RunSummary, SwarmEvent } from "./types";

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
  searchkitCmd: string;
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
  verification: string;
  thinking: boolean;
  reasoningEffort: string;
  safeMode: boolean;
  contextTokenLimit: number;
  knownModels: string[];
  pricing: Record<string, { inMiss: number; inHit: number; out: number }>;
}

export const api = {
  health: () => jget<{ ok: boolean; apiKey: boolean; version: string }>("/api/health"),
  getConfig: () => jget<PublicConfig>("/api/config"),
  setConfig: (patch: Record<string, unknown>) => jpost<PublicConfig>("/api/config", patch),
  models: () => jget<{ models: string[]; error?: string }>("/api/models"),
  validate: () => jget<{ status: "ok" | "invalid" | "unknown"; message?: string }>("/api/validate"),
  sandboxTest: (runtime?: string) =>
    jpost<{ kind: string; ok: boolean; detail: string }>("/api/sandbox/test", runtime ? { runtime } : {}),
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
  artifactUrl: (id: string, name: string) => hubBase() + `/api/runs/${id}/artifacts/${encodeURIComponent(name)}`,
  reportUrl: (id: string) => hubBase() + `/api/runs/${id}/report`,
  streamUrl: (id: string) => hubBase() + `/api/runs/${id}/stream`,
};

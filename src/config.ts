import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PROVIDERS, ProviderId, isProviderId } from "./providers";
import { ModelPrice, ReasoningEffort } from "./types";
import { ensureDir, readJson, writeJson } from "./util";

export interface ProviderCred {
  apiKey?: string;
  baseUrl?: string;
}

export interface SwarmConfig {
  /** Active model provider; resolves apiKey/baseUrl below. */
  provider: ProviderId;
  /** Per-provider credentials — switching providers never loses keys. */
  providers: Partial<Record<ProviderId, ProviderCred>>;
  /** Resolved at load time from `providers[provider]` (+ env overrides). */
  apiKey: string;
  baseUrl: string;
  model: string;
  conductorModel: string;
  maxWorkers: number;
  maxStepsPerTask: number;
  maxTasks: number;
  maxTokensPerRun: number;
  verification: "off" | "normal" | "strict";
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  safeMode: boolean;
  tinyfishApiKey: string;
  /** Web search backend: auto = SearchKit if installed → TinyFish → DuckDuckGo. */
  searchBackend: "auto" | "tinyfish" | "ddg";
  /** SearchKit CLI command (from github script-search; `pip install searchkit`). */
  searchkitCmd: string;
  /**
   * Where sandboxed runs execute. "auto" prefers configured cloud sandboxes
   * (E2B → Modal → Vercel), then a local container daemon, then the host.
   */
  sandboxRuntime: "auto" | "host" | "docker" | "e2b" | "modal" | "vercel";
  /** Container image for docker/modal sandboxes. */
  sandboxImage: string;
  e2bApiKey: string;
  e2bTemplate: string;
  modalTokenId: string;
  modalTokenSecret: string;
  vercelToken: string;
  vercelTeamId: string;
  vercelProjectId: string;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  /** Per-agent context size (est. tokens) that triggers compaction. */
  contextTokenLimit: number;
  maxToolResultChars: number;
  hubPort: number;
  uiPort: number;
  pricing: Record<string, ModelPrice>;
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  // $ per 1M tokens (June 2026, api-docs.deepseek.com/quick_start/pricing)
  "deepseek-v4-flash": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  "deepseek-v4-pro": { inMiss: 0.435, inHit: 0.003625, out: 0.87 },
  // Deprecated aliases (map to v4-flash modes until 2026-07-24)
  "deepseek-chat": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  "deepseek-reasoner": { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  // Approximate list prices for other providers — unknown models cost $0 in
  // the UI rather than guessing.
  "gpt-5.1": { inMiss: 1.25, inHit: 0.125, out: 10 },
  "gpt-5.1-mini": { inMiss: 0.25, inHit: 0.025, out: 2 },
  "claude-sonnet-4-6": { inMiss: 3, inHit: 0.3, out: 15 },
  "claude-haiku-4-5": { inMiss: 1, inHit: 0.1, out: 5 },
  "MiniMax-M2.1": { inMiss: 0.3, inHit: 0.03, out: 1.2 },
  "MiniMax-M2": { inMiss: 0.3, inHit: 0.03, out: 1.2 },
};

export const DEFAULTS: SwarmConfig = {
  provider: "deepseek",
  providers: {},
  apiKey: "",
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: "deepseek-v4-flash",
  conductorModel: "deepseek-v4-flash",
  maxWorkers: 6,
  maxStepsPerTask: 30,
  maxTasks: 48,
  maxTokensPerRun: 12_000_000,
  verification: "normal",
  thinking: true,
  reasoningEffort: "high",
  safeMode: true,
  tinyfishApiKey: "",
  searchBackend: "auto",
  searchkitCmd: "searchkit",
  sandboxRuntime: "auto",
  sandboxImage: "node:22-bookworm",
  e2bApiKey: "",
  e2bTemplate: "base",
  modalTokenId: "",
  modalTokenSecret: "",
  vercelToken: "",
  vercelTeamId: "",
  vercelProjectId: "",
  requestTimeoutMs: 900_000,
  idleTimeoutMs: 180_000,
  contextTokenLimit: 120_000,
  maxToolResultChars: 12_000,
  hubPort: 7777,
  uiPort: 7780,
  pricing: DEFAULT_PRICING,
};

export function home(): string {
  return process.env.AGENTSWARM_HOME || path.join(os.homedir(), ".agentswarm");
}

export function runsDir(): string {
  return path.join(home(), "runs");
}

export function runDir(id: string): string {
  return path.join(runsDir(), id);
}

export function configPath(): string {
  return path.join(home(), "config.json");
}

type RawConfig = Partial<SwarmConfig> & { providers?: Partial<Record<ProviderId, ProviderCred>> };

/**
 * Migrate a pre-provider config file in place: flat apiKey/baseUrl belonged
 * to DeepSeek (the only provider that existed).
 */
function migrate(file: RawConfig): RawConfig {
  const out = { ...file, providers: { ...(file.providers || {}) } };
  if ((file.apiKey || file.baseUrl) && !out.providers.deepseek) {
    out.providers.deepseek = {
      ...(file.apiKey ? { apiKey: file.apiKey } : {}),
      ...(file.baseUrl && file.baseUrl !== PROVIDERS.deepseek.baseUrl ? { baseUrl: file.baseUrl } : {}),
    };
  }
  return out;
}

export function loadConfig(): SwarmConfig {
  const file = migrate(readJson<RawConfig>(configPath(), {}));
  const provider: ProviderId = isProviderId(file.provider) ? file.provider : "deepseek";
  const info = PROVIDERS[provider];
  const cred = file.providers?.[provider] || {};

  const cfg: SwarmConfig = {
    ...DEFAULTS,
    ...file,
    provider,
    providers: file.providers || {},
    pricing: { ...DEFAULT_PRICING, ...(file.pricing || {}) },
    apiKey: cred.apiKey || "",
    baseUrl: cred.baseUrl || info.baseUrl,
  };
  // Env overrides: provider-specific key env, plus legacy DEEPSEEK_API_KEY.
  if (info.keyEnv && process.env[info.keyEnv]) cfg.apiKey = process.env[info.keyEnv]!;
  if (process.env.TINYFISH_API_KEY) cfg.tinyfishApiKey = process.env.TINYFISH_API_KEY;
  if (process.env.E2B_API_KEY) cfg.e2bApiKey = process.env.E2B_API_KEY;
  if (process.env.MODAL_TOKEN_ID) cfg.modalTokenId = process.env.MODAL_TOKEN_ID;
  if (process.env.MODAL_TOKEN_SECRET) cfg.modalTokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (process.env.VERCEL_SANDBOX_TOKEN) cfg.vercelToken = process.env.VERCEL_SANDBOX_TOKEN;
  if (process.env.SWARM_HUB_PORT) cfg.hubPort = Number(process.env.SWARM_HUB_PORT) || cfg.hubPort;
  return cfg;
}

export function saveConfig(patch: Partial<SwarmConfig> & { providers?: Partial<Record<ProviderId, ProviderCred>> }): SwarmConfig {
  ensureDir(home());
  const current = migrate(readJson<RawConfig>(configPath(), {}));
  const next: RawConfig = { ...current, ...patch };

  // Per-provider creds deep-merge so saving one provider's key keeps the rest.
  if (patch.providers) {
    next.providers = { ...(current.providers || {}) };
    for (const [id, cred] of Object.entries(patch.providers)) {
      if (!isProviderId(id) || !cred) continue;
      next.providers[id] = { ...(next.providers[id] || {}), ...cred };
    }
  }

  // Legacy flat fields (CLI `swarm config set apiKey/baseUrl`) target the
  // active provider rather than a dead top-level slot.
  const active: ProviderId = isProviderId(next.provider) ? next.provider : "deepseek";
  for (const k of ["apiKey", "baseUrl"] as const) {
    if (patch[k] !== undefined) {
      next.providers = next.providers || {};
      next.providers[active] = { ...(next.providers[active] || {}), [k]: patch[k] };
      delete (next as any)[k];
    }
  }

  writeJson(configPath(), next, 0o600);
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    /* best effort */
  }
  return loadConfig();
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 9) return key[0] + "…";
  return key.slice(0, 5) + "…" + key.slice(-4);
}

/** Settable via `swarm config set <key> <value>` and the UI settings page. */
export const SETTABLE_KEYS: (keyof SwarmConfig)[] = [
  "provider",
  "apiKey",
  "baseUrl",
  "model",
  "conductorModel",
  "maxWorkers",
  "maxStepsPerTask",
  "maxTasks",
  "maxTokensPerRun",
  "verification",
  "thinking",
  "reasoningEffort",
  "safeMode",
  "tinyfishApiKey",
  "searchBackend",
  "searchkitCmd",
  "sandboxRuntime",
  "sandboxImage",
  "e2bApiKey",
  "e2bTemplate",
  "modalTokenId",
  "modalTokenSecret",
  "vercelToken",
  "vercelTeamId",
  "vercelProjectId",
  "contextTokenLimit",
  "hubPort",
  "uiPort",
];

/** Allowed ranges for numeric settings (values are clamped, not rejected). */
const NUM_RANGES: Partial<Record<keyof SwarmConfig, [number, number]>> = {
  maxWorkers: [1, 32],
  maxStepsPerTask: [3, 200],
  maxTasks: [1, 1000],
  maxTokensPerRun: [50_000, 2_000_000_000],
  contextTokenLimit: [8_000, 900_000],
  hubPort: [0, 65535],
  uiPort: [0, 65535],
};

const ENUMS: Partial<Record<keyof SwarmConfig, string[]>> = {
  verification: ["off", "normal", "strict"],
  reasoningEffort: ["low", "medium", "high", "max"],
  searchBackend: ["auto", "tinyfish", "ddg"],
  sandboxRuntime: ["auto", "host", "docker", "e2b", "modal", "vercel"],
  provider: Object.keys(PROVIDERS),
};

/**
 * Validate + normalize one settable config value (from the CLI or the hub's
 * JSON body). Throws with a human message on invalid input — never lets NaN
 * or a bad enum reach config.json, where it would poison every later run.
 */
export function coerceConfigValue(key: keyof SwarmConfig, raw: unknown): unknown {
  const range = NUM_RANGES[key];
  if (range) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
  }
  if (key === "thinking" || key === "safeMode") {
    if (typeof raw === "boolean") return raw;
    return raw === "true" || raw === "1" || raw === "on";
  }
  const allowed = ENUMS[key];
  if (allowed) {
    const v = String(raw);
    if (!allowed.includes(v)) throw new Error(`${key} must be one of: ${allowed.join(" | ")}`);
    return v;
  }
  // Secrets, URLs, model names: strip stray whitespace/newlines from pastes.
  return String(raw).trim();
}

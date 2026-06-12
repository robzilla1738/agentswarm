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
  /** Tiered models for spawn specs (model:"cheap"/"strong"); "" = use `model`. */
  cheapModel: string;
  strongModel: string;
  maxWorkers: number;
  maxStepsPerTask: number;
  maxTasks: number;
  maxTokensPerRun: number;
  verification: "off" | "normal" | "strict";
  /** Max worker attempts per task (verification failures and errors trigger retries). */
  verifyMaxAttempts: number;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  safeMode: boolean;
  tinyfishApiKey: string;
  /** Web search engines: auto = DDG + Bing + TinyFish + context.dev (if keyed) merged; ddg = free engines only. */
  searchBackend: "auto" | "tinyfish" | "contextdev" | "ddg";
  firecrawlApiKey: string;
  contextdevApiKey: string;
  deepcrawlApiKey: string;
  /** Custom crawler endpoint (POST {base}/crawl). Required for the deepcrawl backend. */
  deepcrawlBaseUrl: string;
  /** Crawl/scrape backend for crawl_site + fetch_url upgrades: auto = first configured (Firecrawl → context.dev → deepcrawl). */
  crawlBackend: "auto" | "firecrawl" | "contextdev" | "deepcrawl" | "off";
  /**
   * Where isolated runs execute. Default "host": the run's private workspace
   * directory on this machine — works out of the box, no Docker or cloud
   * account needed. "auto" opts into auto-detection: configured cloud
   * sandboxes (E2B → Modal → Vercel), then a local container daemon, then
   * the host.
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
  /** Global cap on concurrent streaming model calls per provider endpoint. */
  maxConcurrentCalls: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  /** Per-agent context size (est. tokens) that triggers compaction. */
  contextTokenLimit: number;
  maxToolResultChars: number;
  hubPort: number;
  uiPort: number;
  pricing: Record<string, ModelPrice>;
  /**
   * Known model context windows (tokens). Caps the compaction/trim threshold
   * per model so a small-window model never overflows its prompt; edit
   * config.json to teach the engine about new models.
   */
  contextWindows: Record<string, number>;
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

export const DEFAULT_WINDOWS: Record<string, number> = {
  // tokens (June 2026 published limits; conservative where ranges exist)
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "gpt-5.1": 272_000,
  "gpt-5.1-mini": 272_000,
  "claude-opus-4-8": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "MiniMax-M2.1": 192_000,
  "MiniMax-M2": 192_000,
};

export const DEFAULTS: SwarmConfig = {
  provider: "deepseek",
  providers: {},
  apiKey: "",
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: "deepseek-v4-flash",
  conductorModel: "deepseek-v4-flash",
  cheapModel: "",
  strongModel: "",
  maxWorkers: 6,
  maxStepsPerTask: 30,
  maxTasks: 200,
  maxTokensPerRun: 12_000_000,
  verification: "normal",
  verifyMaxAttempts: 2,
  thinking: true,
  reasoningEffort: "high",
  safeMode: true,
  tinyfishApiKey: "",
  searchBackend: "auto",
  firecrawlApiKey: "",
  contextdevApiKey: "",
  deepcrawlApiKey: "",
  deepcrawlBaseUrl: "",
  crawlBackend: "auto",
  sandboxRuntime: "host",
  sandboxImage: "node:22-bookworm",
  e2bApiKey: "",
  e2bTemplate: "base",
  modalTokenId: "",
  modalTokenSecret: "",
  vercelToken: "",
  vercelTeamId: "",
  vercelProjectId: "",
  maxConcurrentCalls: 16,
  requestTimeoutMs: 900_000,
  idleTimeoutMs: 180_000,
  contextTokenLimit: 120_000,
  maxToolResultChars: 20_000,
  hubPort: 7777,
  uiPort: 7780,
  pricing: DEFAULT_PRICING,
  contextWindows: DEFAULT_WINDOWS,
};

/**
 * Effective compaction/trim threshold for a model: the configured limit,
 * hard-capped by the model's known context window (15% headroom for output
 * and estimation error). Models we don't know keep the configured limit.
 */
export function contextLimitFor(cfg: SwarmConfig, model: string): number {
  const win = cfg.contextWindows[model];
  return win ? Math.min(cfg.contextTokenLimit, Math.floor(win * 0.85)) : cfg.contextTokenLimit;
}

/**
 * Env vars that must never leak into agent shell commands when they execute
 * directly on the host: every provider key env plus the search/sandbox
 * credentials the engine itself understands.
 */
export const SECRET_ENV_KEYS: string[] = [
  ...new Set([
    ...Object.values(PROVIDERS)
      .map((p) => p.keyEnv)
      .filter((k): k is string => Boolean(k)),
    "TINYFISH_API_KEY",
    "FIRECRAWL_API_KEY",
    "CONTEXT_DEV_API_KEY",
    "DEEPCRAWL_API_KEY",
    "E2B_API_KEY",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "VERCEL_SANDBOX_TOKEN",
  ]),
];

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
    contextWindows: { ...DEFAULT_WINDOWS, ...(file.contextWindows || {}) },
    apiKey: cred.apiKey || "",
    baseUrl: cred.baseUrl || info.baseUrl,
  };
  // A cleared/hand-edited model must fall back, not brick every run with
  // model:"" requests. (cheapModel/strongModel legitimately clear to "" —
  // they mean "use `model`".)
  if (!cfg.model) cfg.model = info.defaultModel;
  if (!cfg.conductorModel) cfg.conductorModel = cfg.model;
  // Env overrides: provider-specific key env, plus legacy DEEPSEEK_API_KEY.
  if (info.keyEnv && process.env[info.keyEnv]) cfg.apiKey = process.env[info.keyEnv]!;
  if (process.env.TINYFISH_API_KEY) cfg.tinyfishApiKey = process.env.TINYFISH_API_KEY;
  if (process.env.FIRECRAWL_API_KEY) cfg.firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  if (process.env.CONTEXT_DEV_API_KEY) cfg.contextdevApiKey = process.env.CONTEXT_DEV_API_KEY;
  if (process.env.DEEPCRAWL_API_KEY) cfg.deepcrawlApiKey = process.env.DEEPCRAWL_API_KEY;
  if (process.env.DEEPCRAWL_BASE_URL) cfg.deepcrawlBaseUrl = process.env.DEEPCRAWL_BASE_URL;
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

/**
 * Config keys whose values must never print in cleartext — CLI output ends up
 * in terminal scrollback and pasted bug reports. `providers` holds nested
 * per-provider apiKeys, so it counts too. Single source of truth for the CLI
 * masking sites (the hub's publicConfig is a strict allowlist already).
 */
export function isSecretConfigKey(key: string): boolean {
  return /apikey|token|secret/i.test(key) || key === "providers";
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
  "cheapModel",
  "strongModel",
  "maxWorkers",
  "maxStepsPerTask",
  "maxTasks",
  "maxTokensPerRun",
  "verification",
  "verifyMaxAttempts",
  "thinking",
  "reasoningEffort",
  "safeMode",
  "tinyfishApiKey",
  "searchBackend",
  "firecrawlApiKey",
  "contextdevApiKey",
  "deepcrawlApiKey",
  "deepcrawlBaseUrl",
  "crawlBackend",
  "sandboxRuntime",
  "sandboxImage",
  "e2bApiKey",
  "e2bTemplate",
  "modalTokenId",
  "modalTokenSecret",
  "vercelToken",
  "vercelTeamId",
  "vercelProjectId",
  "maxConcurrentCalls",
  "contextTokenLimit",
  "hubPort",
  "uiPort",
];

/** Allowed ranges for numeric settings (values are clamped, not rejected). */
const NUM_RANGES: Partial<Record<keyof SwarmConfig, [number, number]>> = {
  maxWorkers: [1, 128],
  maxConcurrentCalls: [1, 256],
  maxStepsPerTask: [3, 200],
  maxTasks: [1, 1000],
  verifyMaxAttempts: [1, 5],
  maxTokensPerRun: [50_000, 2_000_000_000],
  contextTokenLimit: [8_000, 900_000],
  hubPort: [0, 65535],
  uiPort: [0, 65535],
};

const ENUMS: Partial<Record<keyof SwarmConfig, string[]>> = {
  verification: ["off", "normal", "strict"],
  reasoningEffort: ["low", "medium", "high", "max"],
  searchBackend: ["auto", "tinyfish", "contextdev", "ddg"],
  crawlBackend: ["auto", "firecrawl", "contextdev", "deepcrawl", "off"],
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

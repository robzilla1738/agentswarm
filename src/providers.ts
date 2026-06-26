import { ReasoningEffort } from "./types";

/**
 * Provider registry. Every provider speaks the OpenAI chat-completions
 * protocol (streaming + tool calls); the entries here capture the per-API
 * quirks so the rest of the engine stays provider-agnostic.
 */
export type ProviderId =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "xai"
  | "minimax"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "custom";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible API root (the part before /chat/completions). */
  baseUrl: string;
  /** Local servers (Ollama, LM Studio) run without a key. */
  keyRequired: boolean;
  /** Environment variable honored as a key override. */
  keyEnv?: string;
  /** Where the operator gets a key. */
  keyUrl?: string;
  /** DeepSeek-style `thinking` body field + reasoning_content echo on tool turns. */
  deepseekThinking: boolean;
  /** reasoning_effort values the API accepts; empty → omit the field. */
  efforts: ReasoningEffort[];
  /** OpenAI rejects max_tokens on reasoning models; needs max_completion_tokens. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** This provider's flagship models accept image inputs (multimodal). Drives visual-parity degradation. */
  vision?: boolean;
  defaultModel: string;
  /** Fallback suggestions when /models is unavailable. */
  knownModels: string[];
  local?: boolean;
  /**
   * Cap on concurrent requests to this provider, independent of the user's
   * `maxConcurrentCalls`. Local servers (one GPU) serve ~one request at a time,
   * so a wide swarm must not pile 16 calls onto them. Omitted → no extra cap.
   */
  maxConcurrency?: number;
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyRequired: true,
    keyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com",
    deepseekThinking: true,
    efforts: ["high", "max"],
    maxTokensParam: "max_tokens",
    defaultModel: "deepseek-v4-flash",
    knownModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
    note: "Cheapest frontier-grade swarm workers; prompt caching makes long runs very cheap.",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    deepseekThinking: false,
    efforts: ["low", "medium", "high"],
    maxTokensParam: "max_completion_tokens",
    vision: true,
    defaultModel: "gpt-5.1-mini",
    knownModels: ["gpt-5.1", "gpt-5.1-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyRequired: true,
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    vision: true,
    defaultModel: "claude-sonnet-4-6",
    knownModels: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    note: "Uses Anthropic's OpenAI-compatible endpoint.",
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyRequired: true,
    keyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    vision: true,
    defaultModel: "grok-4-fast",
    knownModels: ["grok-4", "grok-4-fast", "grok-3-mini"],
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    keyRequired: true,
    keyEnv: "MINIMAX_API_KEY",
    keyUrl: "https://platform.minimax.io",
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    defaultModel: "MiniMax-M2.1",
    knownModels: ["MiniMax-M2.1", "MiniMax-M2"],
    note: "Coding-plan / token-plan keys work here.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    defaultModel: "deepseek/deepseek-chat",
    knownModels: ["openrouter/auto", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6", "openai/gpt-5.1-mini"],
    note: "One key, every model. Use the full vendor/model id.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyRequired: false,
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    // Empty default → the engine auto-picks the first pulled model, so a fresh
    // Ollama with any model works without `swarm config set model`.
    defaultModel: "",
    knownModels: ["qwen3", "llama3.3", "deepseek-r1", "gpt-oss:20b"],
    local: true,
    maxConcurrency: 4,
    note: "Free + private. The models list shows what you have pulled.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    keyRequired: false,
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    defaultModel: "",
    knownModels: [],
    local: true,
    maxConcurrency: 4,
    note: "Start the LM Studio server and load a model — the engine auto-picks it.",
  },
  custom: {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "http://localhost:8000/v1",
    keyRequired: false,
    deepseekThinking: false,
    efforts: [],
    maxTokensParam: "max_tokens",
    defaultModel: "",
    knownModels: [],
    local: true,
    maxConcurrency: 4,
    note: "Any OpenAI-compatible /chat/completions server (vLLM, llama.cpp, …).",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PROVIDERS;
}

/**
 * Map the configured effort onto what the provider's API accepts.
 * Returns undefined when the provider has no effort knob (omit the field —
 * unknown body params are hard errors on several APIs).
 */
export function mapEffort(effort: ReasoningEffort | undefined, p: ProviderInfo): string | undefined {
  if (!effort || p.efforts.length === 0) return undefined;
  if (p.efforts.includes(effort)) return effort;
  const ladder: ReasoningEffort[] = ["low", "medium", "high", "max"];
  const want = ladder.indexOf(effort);
  // Nearest supported value, preferring the strongest at or below the ask.
  const supported = [...p.efforts].sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b));
  for (let i = supported.length - 1; i >= 0; i--) {
    if (ladder.indexOf(supported[i]) <= want) return supported[i];
  }
  return supported[0];
}

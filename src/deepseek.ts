import { SwarmConfig } from "./config";
import { PROVIDERS, ProviderInfo, mapEffort } from "./providers";
import { ReasoningEffort, Usage } from "./types";
import { errMsg, sleep } from "./util";

// ---------- message / tool shapes (OpenAI-compatible) ----------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** DeepSeek thinking mode: present on assistant turns; MUST be sent back on
   *  assistant messages that carry tool_calls, or the API returns 400. */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function providerOf(cfg: SwarmConfig): ProviderInfo {
  return PROVIDERS[cfg.provider] ?? PROVIDERS.deepseek;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatOpts {
  model: string;
  messages: ChatMsg[];
  tools?: ToolSchema[];
  /** "auto" (default), "none", or a specific function name to force. */
  toolChoice?: string;
  maxTokens?: number;
  thinking: boolean;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** "high" jumps the global call queue (conductor/orchestration calls). */
  priority?: "high" | "normal";
  onDelta?: (d: { text?: string; think?: string }) => void;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

export class ApiError extends Error {
  status: number;
  body: string;
  /** Parsed Retry-After (ms) when the server sent one with a 429. */
  retryAfterMs?: number;
  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`API ${status}: ${body.slice(0, 600)}`);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

function retryable(e: unknown): boolean {
  if (e instanceof CancelledError) return false;
  if (e instanceof ApiError) return e.status === 429 || e.status >= 500;
  // Network hiccups, idle timeouts, broken streams.
  return true;
}

function normalizeUsage(u: any): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

function sanitizeMessages(messages: ChatMsg[], thinking: boolean): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls;
        // DeepSeek thinking mode REQUIRES reasoning_content on tool-call turns
        // (400 otherwise). In non-thinking mode the field must be absent.
        if (thinking) out.reasoning_content = m.reasoning_content ?? "";
      }
      return out;
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content ?? "", tool_call_id: m.tool_call_id };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}

// ---------- global call gate (AIMD concurrency limiter, per endpoint) ----------

export interface GateState {
  ceiling: number;
  active: number;
  queued: number;
}

/**
 * Bounds concurrent streaming calls per provider endpoint so a 100-agent swarm
 * doesn't turn into a 429 storm. AIMD: a 429 halves the ceiling (min 2) and
 * imposes the server's Retry-After as a cool-down; sustained successes recover
 * it additively back toward the configured max. Two-tier FIFO: "high" priority
 * (conductor/orchestration) jumps ahead so queued workers can't starve the
 * brain of the swarm.
 */
export class CallGate {
  private max: number;
  private ceiling: number;
  private active = 0;
  private high: Array<() => void> = [];
  private low: Array<() => void> = [];
  private successes = 0;
  private cooldownUntil = 0;
  onState?: (s: GateState) => void;

  constructor(max: number) {
    this.max = Math.max(1, max);
    this.ceiling = this.max;
  }

  state(): GateState {
    return { ceiling: this.ceiling, active: this.active, queued: this.high.length + this.low.length };
  }

  configure(max: number): void {
    this.max = Math.max(1, max);
    if (this.ceiling > this.max) this.ceiling = this.max;
    this.pump();
  }

  async acquire(priority: "high" | "normal", signal?: AbortSignal): Promise<void> {
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) throw new CancelledError();
    if (this.active < this.ceiling) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const queue = priority === "high" ? this.high : this.low;
      const entry = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        reject(new CancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(entry);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  reportRateLimit(retryAfterMs?: number): void {
    this.ceiling = Math.max(1, Math.floor(this.ceiling / 2));
    this.successes = 0;
    if (retryAfterMs && retryAfterMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(retryAfterMs, 300_000));
    }
    this.onState?.(this.state());
  }

  reportSuccess(): void {
    if (this.ceiling >= this.max) return;
    if (++this.successes >= 10) {
      this.successes = 0;
      this.ceiling++;
      this.onState?.(this.state());
      this.pump();
    }
  }

  private pump(): void {
    while (this.active < this.ceiling) {
      const next = this.high.shift() ?? this.low.shift();
      if (!next) break;
      this.active++;
      next();
    }
  }
}

const gates = new Map<string, CallGate>();

export function gateFor(cfg: SwarmConfig): CallGate {
  const key = cfg.baseUrl;
  let g = gates.get(key);
  if (!g) {
    g = new CallGate(cfg.maxConcurrentCalls);
    gates.set(key, g);
  }
  g.configure(cfg.maxConcurrentCalls);
  return g;
}

/**
 * One streaming chat-completions call with retries, behind the global gate.
 * The retry backoff sleeps OUTSIDE the gate so a waiting call never holds a
 * concurrency slot.
 */
export async function chat(cfg: SwarmConfig, o: ChatOpts): Promise<ChatResult> {
  const gate = gateFor(cfg);
  let lastErr: unknown;
  const attempts = 4;
  for (let i = 0; i < attempts; i++) {
    await gate.acquire(o.priority ?? "normal", o.signal);
    try {
      const res = await chatOnce(cfg, o);
      gate.reportSuccess();
      return res;
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError && e.status === 429) gate.reportRateLimit(e.retryAfterMs);
      if (!retryable(e) || i === attempts - 1) throw e;
    } finally {
      gate.release();
    }
    const backoff = [1500, 5000, 15000][i] ?? 15000;
    await sleep(backoff + Math.random() * 1000);
    if (o.signal?.aborted) throw new CancelledError();
  }
  throw lastErr;
}

async function chatOnce(cfg: SwarmConfig, o: ChatOpts): Promise<ChatResult> {
  const provider = providerOf(cfg);
  if (!cfg.apiKey && provider.keyRequired) {
    throw new ApiError(
      401,
      `No ${provider.label} API key configured. Run \`swarm config set apiKey ...\` or open Settings in the UI.`
    );
  }
  if (o.signal?.aborted) throw new CancelledError();

  // DeepSeek's thinking protocol (the `thinking` body field + reasoning_content
  // echo) is provider-specific; unknown body params are hard 400s elsewhere.
  const dsThinking = provider.deepseekThinking;
  const body: Record<string, unknown> = {
    model: o.model,
    messages: sanitizeMessages(o.messages, o.thinking && dsThinking),
    stream: true,
    stream_options: { include_usage: true },
    [provider.maxTokensParam]: o.maxTokens ?? 16384,
  };
  if (dsThinking) body.thinking = { type: o.thinking ? "enabled" : "disabled" };
  const effort = o.thinking ? mapEffort(o.reasoningEffort, provider) : undefined;
  if (effort) body.reasoning_effort = effort;
  if (o.tools?.length) {
    body.tools = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (
      o.toolChoice === "none" ||
      o.toolChoice === "auto" ||
      o.toolChoice === "required" ||
      o.toolChoice === undefined
    ) {
      body.tool_choice = o.toolChoice ?? "auto";
    } else {
      body.tool_choice = { type: "function", function: { name: o.toolChoice } };
    }
  }

  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  o.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > cfg.idleTimeoutMs) ac.abort();
  }, 5000);
  const hardTimer = setTimeout(() => ac.abort(), cfg.requestTimeoutMs);

  try {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.provider === "openrouter") headers["x-title"] = "agentswarm";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiError(res.status, text, Number.isFinite(ra) && ra >= 0 ? ra * 1000 : undefined);
    }
    if (!res.body) throw new ApiError(0, "empty response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    let finishReason = "stop";
    let usage: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s.startsWith("data:")) return;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      // reasoning_content: DeepSeek / MiniMax. reasoning: OpenRouter / LM Studio.
      const think = typeof delta.reasoning_content === "string" && delta.reasoning_content
        ? delta.reasoning_content
        : typeof delta.reasoning === "string" && delta.reasoning
          ? delta.reasoning
          : "";
      if (think) {
        reasoning += think;
        o.onDelta?.({ think });
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        o.onDelta?.({ text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handleLine(buf);

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }))
      .filter((c) => c.function.name);

    if (!usage.promptTokens && !usage.completionTokens) {
      // Usage chunk missing — estimate so budgets still move.
      const inChars = o.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      const outChars = content.length + reasoning.length;
      usage = {
        promptTokens: Math.ceil(inChars / 3.5),
        completionTokens: Math.ceil(outChars / 3.5),
        cacheHitTokens: 0,
        cacheMissTokens: Math.ceil(inChars / 3.5),
      };
    }

    return { content, reasoning, toolCalls, finishReason, usage };
  } catch (e) {
    if (o.signal?.aborted) throw new CancelledError();
    throw e;
  } finally {
    clearInterval(idleTimer);
    clearTimeout(hardTimer);
    o.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export function isFatalAuthError(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 401 || e.status === 403;
  if (e instanceof Error) return /no \S+ api key/i.test(e.message);
  return false;
}

/**
 * Cheap auth preflight. Hits /models (no generation cost) and classifies the
 * result so callers can give the operator an instant, clear error instead of a
 * phantom run. Returns "ok" on success, "invalid" only on explicit 401/403,
 * and "unknown" for anything else (never block on transient/unsupported).
 */
export async function validateAuth(
  cfg: SwarmConfig
): Promise<{ status: "ok" | "invalid" | "unknown"; message?: string }> {
  const provider = providerOf(cfg);
  if (!cfg.apiKey && provider.keyRequired) {
    return { status: "invalid", message: `No ${provider.label} API key configured.` };
  }
  try {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) return { status: "ok" };
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return { status: "invalid", message: extractApiMessage(body) || "API key rejected (401)." };
    }
    return { status: "unknown", message: `HTTP ${res.status}` };
  } catch (e) {
    return { status: "unknown", message: errMsg(e) };
  }
}

function extractApiMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message || j?.message || "";
  } catch {
    return body.slice(0, 200);
  }
}

export async function listModels(cfg: SwarmConfig): Promise<string[]> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  const data: any = await res.json();
  return (data.data || []).map((m: any) => m.id).filter(Boolean);
}

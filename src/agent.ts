import { SwarmConfig } from "./config";
import { ChatMsg, ChatResult, ToolSchema, chat } from "./deepseek";
import { compactorPrompt, forcedFinal, NUDGE_USE_TOOLS, STEP_LIMIT_FINAL } from "./prompts";
import { ToolCtx, ToolDef } from "./tools";
import { ReasoningEffort, Usage, ZERO_USAGE, addUsage } from "./types";
import { clip, errMsg, safeJson, truncateMiddle } from "./util";

export interface AgentHooks {
  onDelta?: (channel: "text" | "think", text: string) => void;
  onMessage?: (content: string) => void;
  onToolCall?: (callId: string, name: string, args: unknown) => void;
  onToolResult?: (callId: string, name: string, ok: boolean, summary: string) => void;
  onUsage?: (model: string, usage: Usage) => void;
  onTranscript?: (messages: ChatMsg[]) => void;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface AgentParams {
  cfg: SwarmConfig;
  agentId: string;
  model: string;
  thinking: boolean;
  reasoningEffort?: ReasoningEffort;
  system: string;
  kickoff: string;
  tools: Record<string, ToolDef>;
  /** Terminal tools end the loop; their args are the agent's result. */
  terminal: ToolSchema[];
  maxSteps: number;
  maxTokensOut?: number;
  signal: AbortSignal;
  ctx: ToolCtx;
  hooks: AgentHooks;
  /**
   * Checked before every step. Returning a reason ends the loop early with one
   * forced terminal call (used for run-wide budget exhaustion / finish).
   */
  stop?: () => string | null;
}

export interface AgentOutcome {
  terminal: { name: string; args: any } | null;
  finalText: string;
  steps: number;
  usage: Usage;
}

/**
 * The agent loop: stream a completion, execute tool calls, feed results back,
 * until a terminal tool is called or the step budget runs out. Context is
 * compacted in place when it grows past the configured limit.
 */
export async function runAgent(p: AgentParams): Promise<AgentOutcome> {
  const { cfg, hooks } = p;
  let messages: ChatMsg[] = [
    { role: "system", content: p.system },
    { role: "user", content: p.kickoff },
  ];
  const terminalNames = new Set(p.terminal.map((t) => t.name));
  const allSchemas: ToolSchema[] = [
    ...Object.values(p.tools).map((t) => t.schema),
    ...p.terminal,
  ];
  let usage: Usage = { ...ZERO_USAGE };
  let lastText = "";
  let steps = 0;
  hooks.onTranscript?.(messages);

  const callModel = (opts?: { only?: string }): Promise<ChatResult> =>
    chat(cfg, {
      model: p.model,
      messages,
      tools: opts?.only
        ? allSchemas.filter((s) => s.name === opts.only)
        : allSchemas,
      toolChoice: opts?.only,
      thinking: p.thinking,
      reasoningEffort: p.thinking ? p.reasoningEffort : undefined,
      maxTokens: p.maxTokensOut,
      signal: p.signal,
      onDelta: (d) => {
        if (d.think) hooks.onDelta?.("think", d.think);
        if (d.text) hooks.onDelta?.("text", d.text);
      },
    });

  let stopReason: string | null = null;
  while (steps < p.maxSteps) {
    stopReason = p.stop?.() ?? null;
    if (stopReason) break;
    steps++;
    const res = await callModel();
    hooks.onUsage?.(p.model, res.usage);
    usage = addUsage(usage, res.usage);

    if (res.toolCalls.length === 0) {
      // The model replied with prose. Record it and nudge it back to tools.
      messages.push({ role: "assistant", content: res.content, reasoning_content: res.reasoning });
      if (res.content) {
        lastText = res.content;
        hooks.onMessage?.(res.content);
      }
      messages.push({ role: "user", content: NUDGE_USE_TOOLS });
      hooks.onTranscript?.(messages);
      continue;
    }

    messages.push({
      role: "assistant",
      content: res.content || null,
      reasoning_content: res.reasoning,
      tool_calls: res.toolCalls,
    });
    if (res.content) {
      lastText = res.content;
      hooks.onMessage?.(res.content);
    }

    for (const call of res.toolCalls) {
      const name = call.function.name;
      const parsed = safeJson<Record<string, unknown>>(call.function.arguments);
      const args = parsed ?? {};

      if (terminalNames.has(name)) {
        if (parsed === undefined && call.function.arguments.trim()) {
          // Unparseable terminal args — tell the model and let it retry.
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "ERROR: arguments were not valid JSON. Call the tool again with valid JSON.",
          });
          hooks.onTranscript?.(messages);
          continue;
        }
        hooks.onToolCall?.(call.id, name, redact(args));
        hooks.onTranscript?.(messages);
        return { terminal: { name, args }, finalText: lastText, steps, usage };
      }

      const tool = p.tools[name];
      hooks.onToolCall?.(call.id, name, redact(args));
      let result: string;
      let ok = true;
      if (!tool) {
        ok = false;
        result = `ERROR: unknown tool "${name}". Available: ${allSchemas.map((s) => s.name).join(", ")}`;
      } else if (parsed === undefined && call.function.arguments.trim()) {
        ok = false;
        result = "ERROR: arguments were not valid JSON.";
      } else {
        try {
          result = await tool.run(args, p.ctx);
        } catch (e) {
          ok = false;
          result = `ERROR: ${errMsg(e)}`;
        }
      }
      if (p.signal.aborted) throw new Error("cancelled");
      result = truncateMiddle(result, cfg.maxToolResultChars, "chars");
      hooks.onToolResult?.(call.id, name, ok, clip(result.replace(/\s+/g, " "), 200));
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    hooks.onTranscript?.(messages);

    if (estimateMessages(messages) > cfg.contextTokenLimit) {
      messages = await compact(p, messages);
      hooks.onTranscript?.(messages);
      hooks.onLog?.("info", `${p.agentId}: context compacted`);
    }
  }

  // Step budget exhausted (or stopped early) — force one final terminal call.
  messages.push({ role: "user", content: stopReason ? forcedFinal(stopReason) : STEP_LIMIT_FINAL });
  try {
    const res = await callModel({ only: p.terminal[0].name });
    hooks.onUsage?.(p.model, res.usage);
    usage = addUsage(usage, res.usage);
    const call = res.toolCalls.find((c) => terminalNames.has(c.function.name));
    if (call) {
      const args = safeJson<Record<string, unknown>>(call.function.arguments) ?? {};
      return { terminal: { name: call.function.name, args }, finalText: lastText, steps, usage };
    }
    if (res.content) lastText = res.content;
  } catch (e) {
    hooks.onLog?.("warn", `${p.agentId}: forced final call failed: ${errMsg(e)}`);
  }
  return { terminal: null, finalText: lastText, steps, usage };
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 600 ? clip(v, 600) : v;
  }
  return out;
}

function estimateMessages(messages: ChatMsg[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    chars += m.reasoning_content?.length ?? 0;
    if (m.tool_calls) {
      for (const c of m.tool_calls) chars += c.function.arguments.length + 40;
    }
  }
  return Math.ceil(chars / 3.5) + messages.length * 6;
}

async function compact(p: AgentParams, messages: ChatMsg[]): Promise<ChatMsg[]> {
  const KEEP_TAIL = 8;
  if (messages.length <= 2 + KEEP_TAIL + 2) return messages;
  let cut = messages.length - KEEP_TAIL;
  // Never start the tail on a tool result whose assistant turn was dropped.
  while (cut > 2 && messages[cut].role === "tool") cut--;
  if (cut <= 2) return messages;
  const middle = messages.slice(2, cut);
  const serialized = middle
    .map((m) => {
      const tools =
        m.tool_calls?.map((c) => ` [${c.function.name}(${clip(c.function.arguments, 300)})]`).join("") ?? "";
      const body = clip(m.content ?? "", m.role === "tool" ? 900 : 1500);
      return `${m.role.toUpperCase()}:${tools} ${body}`;
    })
    .join("\n");
  let summary: string;
  try {
    const res = await chat(p.cfg, {
      model: p.model,
      messages: [{ role: "user", content: compactorPrompt(truncateMiddle(serialized, 300_000, "chars")) }],
      thinking: false,
      maxTokens: 2048,
      signal: p.signal,
    });
    p.hooks.onUsage?.(p.model, res.usage);
    summary = res.content || "(compaction produced no summary)";
  } catch (e) {
    // Compaction is best-effort; fall back to hard truncation.
    summary = "(compaction failed: " + errMsg(e) + ") Earlier steps were dropped.";
  }
  return [
    messages[0],
    messages[1],
    {
      role: "user",
      content: `[Context was compacted to save space. Faithful summary of your earlier work:]\n${summary}\n[Continue from here. The most recent steps follow.]`,
    },
    ...messages.slice(cut),
  ];
}

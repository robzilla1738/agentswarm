// A scripted, OpenAI-compatible streaming endpoint that role-plays the swarm
// so the engine can be tested end-to-end with no real API key.
//
//   node test/mock-deepseek.js [port]
//
// It decides what to "say" from the tool set in each request:
//   spawn_tasks -> conductor   submit_final -> synthesizer
//   verdict     -> verifier    report       -> worker
const http = require("http");

const PORT = Number(process.argv[2]) || 0;
const AUTH_INVALID = process.env.MOCK_AUTH === "invalid";
// Alternate scripts: default | verify-retry | note-cancel | compact
const SCENARIO = process.env.MOCK_SCENARIO || "default";
let verdictCalls = 0;

function unauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error" } }));
}

function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function textChunk(s) {
  return { choices: [{ delta: { content: s } }] };
}
function thinkChunk(s) {
  return { choices: [{ delta: { reasoning_content: s } }] };
}
// Split tool-call arguments across two deltas to exercise accumulation.
function toolChunks(name, argsObj) {
  const args = JSON.stringify(argsObj);
  const mid = Math.floor(args.length / 2);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name, arguments: args.slice(0, mid) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] },
    { choices: [{ finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 800, completion_tokens: 120, prompt_cache_hit_tokens: 128 } },
  ];
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].content || "";
  return "";
}
function hasToolResult(messages) {
  return messages.some((m) => m.role === "tool");
}

const server = http.createServer((req, res) => {
  // Auth preflight endpoint.
  if (req.url.endsWith("/models")) {
    if (AUTH_INVALID) return unauthorized(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }));
    return;
  }
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  if (AUTH_INVALID) return unauthorized(res);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const tools = (parsed.tools || []).map((t) => t.function?.name);
    const names = new Set(tools);
    const messages = parsed.messages || [];

    // Conductor
    if (names.has("spawn_tasks")) {
      const update = lastUser(messages);
      if (update.includes("No tasks exist yet")) {
        if (SCENARIO === "verify-retry") {
          return sse(res, [
            textChunk("Spawning one verified task."),
            ...toolChunks("spawn_tasks", {
              tasks: [{ title: "Build summary", objective: "Summarize the topic. Done when written.", role: "writer", verify: true }],
            }),
          ]);
        }
        if (SCENARIO === "note-cancel") {
          return sse(res, [
            textChunk("Spawning two probes."),
            ...toolChunks("spawn_tasks", {
              tasks: [
                { title: "Quick probe", objective: "QUICKTASK: probe fast. Done when output captured.", role: "researcher" },
                { title: "Slow probe", objective: "SLOWTASK: probe slowly. Done when output captured.", role: "researcher" },
              ],
            }),
          ]);
        }
        if (SCENARIO === "compact") {
          return sse(res, [
            textChunk("Spawning one data-heavy task."),
            ...toolChunks("spawn_tasks", {
              tasks: [{ title: "Bulk reader", objective: "Read large outputs repeatedly. Done when reported.", role: "researcher" }],
            }),
          ]);
        }
        return sse(res, [
          thinkChunk("Decompose into two scouts and a synthesis step."),
          textChunk("Spawning the first wave."),
          ...toolChunks("spawn_tasks", {
            tasks: [
              { title: "Scout A", objective: "Find facts about A. Done when summarized.", role: "researcher" },
              { title: "Scout B", objective: "Find facts about B. Done when summarized.", role: "researcher" },
              { title: "Synthesize", objective: "Combine A and B into a brief. Done when written.", role: "writer", deps: ["T1", "T2"], verify: true },
            ],
          }),
        ]);
      }
      // note-cancel: never finish — the operator's cancel is the only exit.
      if (SCENARIO === "note-cancel") {
        return sse(res, [...toolChunks("wait", { reason: "monitoring the probes" })]);
      }
      // Single-task scenarios finish once T1 is done.
      if ((SCENARIO === "verify-retry" || SCENARIO === "compact") && /T1 \[done/.test(update)) {
        return sse(res, [...toolChunks("finish", { notes: "Task complete." })]);
      }
      // Default: finish only once the final dependent task (T3) is done;
      // otherwise wait so the swarm runs the full wave-2 synthesis task.
      if (SCENARIO === "default" && /T3 \[done/.test(update)) {
        return sse(res, [
          thinkChunk("All reports are in and look complete."),
          ...toolChunks("finish", { notes: "Combine the two scouts' findings; highlight the synthesis." }),
        ]);
      }
      return sse(res, [
        thinkChunk("Work is still in flight."),
        ...toolChunks("wait", { reason: "waiting on running tasks" }),
      ]);
    }

    // Synthesizer
    if (names.has("submit_final")) {
      return sse(res, [
        textChunk("Composing final report."),
        ...toolChunks("submit_final", {
          report_markdown: "# Mission Report\n\n**Outcome** — Success. Both scouts reported and the synthesis combined them.\n\n## Findings\n- A: ok\n- B: ok\n\n## Next steps\n- none\n",
          summary: "Both scouts completed and the synthesis combined their findings successfully.",
        }),
      ]);
    }

    // Verifier
    if (names.has("verdict")) {
      verdictCalls++;
      if (SCENARIO === "verify-retry" && verdictCalls === 1) {
        return sse(res, [
          thinkChunk("The report is missing required evidence."),
          ...toolChunks("verdict", { pass: false, feedback: "Missing a Sources section — add it and report again." }),
        ]);
      }
      return sse(res, [
        thinkChunk("Checking the claim against the report."),
        ...toolChunks("verdict", { pass: true, feedback: "Report matches the objective; evidence checks out." }),
      ]);
    }

    // Worker: run one real shell tool, then report on the next turn.
    if (names.has("report")) {
      const system = String((messages[0] && messages[0].content) || "");
      if (SCENARIO === "note-cancel" && !hasToolResult(messages)) {
        // Long-running shells give the operator time to steer and cancel.
        const secs = /SLOWTASK/.test(system) ? 15 : 2;
        return sse(res, [...toolChunks("shell", { command: `sleep ${secs} && echo probe-ok` })]);
      }
      if (SCENARIO === "compact") {
        const compacted = messages.some(
          (m) => typeof m.content === "string" && m.content.includes("Context was compacted")
        );
        const toolResults = messages.filter((m) => m.role === "tool").length;
        if (!compacted && toolResults < 8) {
          // ~15KB per result inflates the context until compaction triggers.
          return sse(res, [...toolChunks("shell", { command: "head -c 15000 /dev/zero | tr '\\0' x" })]);
        }
        return sse(res, [
          textChunk("Done."),
          ...toolChunks("report", { status: "done", report: "Read bulk outputs; context stayed manageable.", artifacts: [] }),
        ]);
      }
      if (hasToolResult(messages)) {
        return sse(res, [
          textChunk("Done."),
          ...toolChunks("report", {
            status: "done",
            report: "Completed the objective. Ran a shell check (echo) and verified output.",
            artifacts: [],
          }),
        ]);
      }
      return sse(res, [
        thinkChunk("Start by checking the environment."),
        ...toolChunks("shell", { command: "echo swarm-ok" }),
      ]);
    }

    // Fallback (compaction summary requests, etc.)
    return sse(res, [textChunk("ok"), { usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  // The runner reads this line to learn the port.
  console.log(`MOCK_PORT=${addr.port}`);
});

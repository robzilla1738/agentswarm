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
// Return 429 (Retry-After: 0) for the first N chat calls — limiter testing.
let rateLimitFirst = Number(process.env.MOCK_429_FIRST || "0");
let verdictCalls = 0;
const seenModels = new Set();

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
// Multiple tool calls in one assistant turn (e.g. update_plan + spawn_tasks).
function multiToolChunks(calls) {
  const chunks = calls.map((c, i) => ({
    choices: [{ delta: { tool_calls: [{ index: i, id: `call_m${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }],
  }));
  return [
    ...chunks,
    { choices: [{ finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 800, completion_tokens: 120, prompt_cache_hit_tokens: 128 } },
  ];
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
  if (rateLimitFirst > 0) {
    rateLimitFirst--;
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "synthetic rate limit", type: "rate_limit_error" } }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const tools = (parsed.tools || []).map((t) => t.function?.name);
    const names = new Set(tools);
    const messages = parsed.messages || [];
    if (parsed.model) seenModels.add(parsed.model);
    const sysContent = String((messages[0] && messages[0].content) || "");

    // Team-lead conductor (child swarm): its mission carries the TEAMOBJ marker.
    if (SCENARIO === "team" && names.has("spawn_tasks") && sysContent.includes("TEAMOBJ")) {
      const update = lastUser(messages);
      if (update.includes("No tasks exist yet")) {
        return sse(res, [...toolChunks("spawn_tasks", {
          tasks: [
            { title: "Part A", objective: "Do part A. Done when reported.", role: "researcher" },
            { title: "Part B", objective: "Do part B. Done when reported.", role: "researcher" },
          ],
        })]);
      }
      if (/T1 \[done/.test(update) && /T2 \[done/.test(update)) {
        return sse(res, [...toolChunks("finish", { notes: "Both parts complete." })]);
      }
      return sse(res, [...toolChunks("wait", { reason: "team in flight" })]);
    }
    // Team consolidation call (no tools, distinctive prompt).
    if (SCENARIO === "team" && !tools.length && lastUser(messages).includes("Consolidate your team's work")) {
      return sse(res, [textChunk("TEAM-CONSOLIDATED: parts A and B are complete with evidence."), { usage: { prompt_tokens: 50, completion_tokens: 20 } }]);
    }

    // Conductor
    if (names.has("spawn_tasks")) {
      if (SCENARIO === "conductor-fail") {
        // Non-retryable, non-auth error: exercises the executor's circuit breaker.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "synthetic conductor failure", type: "invalid_request_error" } }));
        return;
      }
      const update = lastUser(messages);
      // Prove (or disprove) that the engine seeded a mission ledger into the
      // conductor's history — phaseResume asserts it, phaseHappy asserts not.
      const ledgerMark = messages.some((m) => m.role === "user" && String(m.content || "").includes("MISSION LEDGER"))
        ? [textChunk("LEDGER-SEEN ")]
        : [];
      if (SCENARIO === "dep-chain") {
        if (update.includes("No tasks exist yet")) {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [
              { title: "Root task", objective: "ROOTFAIL: needs a missing prerequisite. Done when reported.", role: "researcher" },
              { title: "Mid task", objective: "Use T1 output. Done when reported.", role: "analyst", deps: ["T1"] },
              { title: "Leaf task", objective: "Use T2 output. Done when reported.", role: "writer", deps: ["T2"] },
            ],
          })]);
        }
        if (/T3 \[blocked/.test(update) || /All tasks have settled/.test(update)) {
          return sse(res, [...toolChunks("finish", { notes: "Chain blocked; finishing." })]);
        }
        return sse(res, [...toolChunks("wait", { reason: "watching the chain" })]);
      }
      if (SCENARIO === "diag") {
        if (update.includes("No tasks exist yet")) {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [{ title: "Doomed task", objective: "DIAGTASK: read the missing file. Done when reported.", role: "researcher" }],
          })]);
        }
        if (/T1 \[failed/.test(update) || /All tasks have settled/.test(update)) {
          return sse(res, [...toolChunks("finish", { notes: "Task failed; finishing." })]);
        }
        return sse(res, [...toolChunks("wait", { reason: "watching" })]);
      }
      if (SCENARIO === "strict-verify") {
        if (update.includes("No tasks exist yet")) {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [{ title: "Verified brief", objective: "STRICTTASK: write a brief. Done when reported.", role: "writer", verify: true }],
          })]);
        }
        if (/T1 \[done/.test(update)) {
          return sse(res, [...toolChunks("finish", { notes: "Verified task complete." })]);
        }
        return sse(res, [...toolChunks("wait", { reason: "waiting" })]);
      }
      if (SCENARIO === "citations") {
        if (update.includes("No tasks exist yet")) {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [
              { title: "Scout alpha", objective: "CITE-A: research alpha. Done when sourced.", role: "researcher" },
              { title: "Scout beta", objective: "CITE-B: research beta. Done when sourced.", role: "researcher" },
            ],
          })]);
        }
        if (/T1 \[done/.test(update) && /T2 \[done/.test(update)) {
          return sse(res, [...toolChunks("finish", { notes: "Cite the sources." })]);
        }
        return sse(res, [...toolChunks("wait", { reason: "scouts in flight" })]);
      }
      if (SCENARIO === "forecast") {
        if (update.includes("No tasks exist yet")) {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [
              { title: "Base rates", objective: "FC-RESEARCH: find base rates for the event. Done when sourced.", role: "researcher" },
              { title: "Panelist outside", objective: "Forecast the question. METHOD: outside-view", role: "forecaster", deps: ["T1"] },
              { title: "Panelist inside", objective: "Forecast the question. METHOD: inside-view", role: "forecaster", deps: ["T1"] },
              { title: "Panelist trend", objective: "Forecast the question. METHOD: trend", role: "forecaster", deps: ["T1"] },
            ],
          })]);
        }
        if (/T2 \[done/.test(update) && /T3 \[done/.test(update) && /T4 \[done/.test(update)) {
          return sse(res, [...toolChunks("finish", { notes: "Panel complete; aggregate mechanically." })]);
        }
        return sse(res, [...toolChunks("wait", { reason: "panel in flight" })]);
      }
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
        if (SCENARIO === "team") {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [{ title: "Subsystem", objective: "TEAMOBJ: complete parts A and B.", role: "generalist", team: true, team_max_workers: 2 }],
          })]);
        }
        if (SCENARIO === "model-tiers") {
          return sse(res, [...toolChunks("spawn_tasks", {
            tasks: [
              { title: "Cheap scout", objective: "Scout quickly. Done when reported.", role: "researcher", model: "cheap" },
              { title: "Strong lead", objective: "Lead deeply. Done when reported.", role: "analyst", model: "strong" },
            ],
          })]);
        }
        if (SCENARIO === "long-horizon") {
          return sse(res, [...multiToolChunks([
            { name: "update_plan", args: { markdown: "# Mission Plan\n\nPLAN-MARKER-V1: one task, then finish." } },
            { name: "spawn_tasks", args: { tasks: [{ title: "Do the thing", objective: "Do it. Done when reported.", role: "generalist" }] } },
          ])]);
        }
        if (SCENARIO === "blind-verify") {
          return sse(res, [
            textChunk("Spawning one verified writing task."),
            ...toolChunks("spawn_tasks", {
              tasks: [{ title: "Write brief", objective: "Write a short brief. Done when reported.", role: "writer", verify: true }],
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
      // Two-task scenarios finish when both settle.
      if (SCENARIO === "model-tiers" && /T1 \[done/.test(update) && /T2 \[done/.test(update)) {
        return sse(res, [...toolChunks("finish", { notes: "Both tiers reported." })]);
      }
      // Single-task scenarios finish once T1 is done.
      if ((SCENARIO === "verify-retry" || SCENARIO === "compact" || SCENARIO === "blind-verify" || SCENARIO === "team" || SCENARIO === "long-horizon") && /T1 \[done/.test(update)) {
        return sse(res, [...toolChunks("finish", { notes: "Task complete." })]);
      }
      // Default: finish only once the final dependent task (T3) is done;
      // otherwise wait so the swarm runs the full wave-2 synthesis task.
      if (SCENARIO === "default" && /T3 \[done/.test(update)) {
        return sse(res, [
          ...ledgerMark,
          thinkChunk("All reports are in and look complete."),
          ...toolChunks("finish", { notes: "Combine the two scouts' findings; highlight the synthesis." }),
        ]);
      }
      return sse(res, [
        ...ledgerMark,
        thinkChunk("Work is still in flight."),
        ...toolChunks("wait", { reason: "waiting on running tasks" }),
      ]);
    }

    // Forecaster panelist: submit immediately, probability keyed off the
    // METHOD label the conductor put in the objective.
    if (names.has("submit_forecast")) {
      const system = String((messages[0] && messages[0].content) || "");
      // Engine-run inverted-framing probe: answer in P(NO) space (25% NO →
      // the engine flips it to a 75% YES panelist). No sources: the probe
      // must not move the panel's evidence-overlap math.
      if (/INVERTED form/.test(system)) {
        return sse(res, [...toolChunks("submit_forecast", {
          probability: 25,
          prior: 30,
          method: "ignored-by-engine",
          rationale: "Arguing NO first: in 7 of 10 comparable cases the status quo held, but here the harness is scripted to emit.",
        })]);
      }
      const method = /METHOD: outside-view/.test(system) ? "outside-view" : /METHOD: inside-view/.test(system) ? "inside-view" : "trend";
      // The outside-view panelist's FIRST attempt is deliberately ungrounded
      // (no prior, no base_rates) — the engine's analytical gate must bounce
      // it back with feedback before any forecast.submitted is journaled.
      const gateRetry = /PREVIOUS ATTEMPT FAILED VERIFICATION/.test(system);
      if (method === "outside-view" && !gateRetry) {
        return sse(res, [...toolChunks("submit_forecast", {
          probability: 60,
          method,
          rationale: "The recent headlines feel like it is going to happen.",
        })]);
      }
      const prob = { "outside-view": 60, "inside-view": 70, trend: 80 }[method];
      const prior = { "outside-view": 55, "inside-view": 65, trend: 70 }[method];
      // Distinct sources per panelist: evidence overlap must compute to 0.
      const src = { "outside-view": "https://example.com/base-rates", "inside-view": "https://example.com/inside", trend: "https://example.com/trend" }[method];
      return sse(res, [...toolChunks("submit_forecast", {
        probability: prob,
        prior,
        method,
        rationale: `Anchored on the base rate (6 of 10 comparable cases), adjusted via ${method}.`,
        base_rates: ["similar events resolved YES in 6 of 10 comparable cases"],
        key_drivers: ["test harness behavior"],
        update_triggers: ["TRIGGER: the harness emits the event early"],
        sources: [{ url: src, title: `Evidence for ${method}` }],
      })]);
    }

    // Resolution mini-agent (swarm resolve): the event happened.
    if (names.has("submit_resolution")) {
      return sse(res, [...toolChunks("submit_resolution", {
        outcome: "yes",
        evidence: "The test harness recorded the event before the resolution date.",
        confidence: "high",
        sources: ["https://example.com/outcome"],
      })]);
    }

    // Synthesizer
    if (names.has("submit_final")) {
      if (SCENARIO === "forecast") {
        // Echo the engine-computed headline only if it was actually pinned
        // into the prompt — the e2e asserts both the echo and its value.
        // (Anchor on the ENSEMBLE line: task reports carry panelist P(YES)
        // figures of their own earlier in the prompt.)
        const m = /ENSEMBLE FORECAST[^:]*: P\(YES\) = (\d+)%/.exec(sysContent);
        return sse(res, [...toolChunks("submit_final", {
          report_markdown: m
            ? `# Forecast report\n\nFORECAST-HEADLINE: P(YES) = ${m[1]}%\n\n## Panel\nThree methods reported.\n`
            : "# Forecast report\n\nNO-AGGREGATE-IN-PROMPT\n",
          summary: "Forecast composed from the panel aggregate.",
        })]);
      }
      if (SCENARIO === "citations") {
        // Cite only if the engine actually threaded the numbered source list
        // (with both deduped URLs) into the synthesizer's prompt.
        const threaded =
          /SOURCES \(numbered/.test(sysContent) &&
          /example\.com\/alpha/.test(sysContent) &&
          /beta\.org\/report/.test(sysContent);
        return sse(res, [...toolChunks("submit_final", {
          report_markdown: threaded
            ? "# Research Report\n\n**Outcome** — Success. Alpha is fast [1]; beta disagrees on throughput [2].\n\n## Sources\n1. [Alpha Primer](https://example.com/alpha)\n2. [Beta Report](https://beta.org/report)\n"
            : "# Research Report\n\nNO-SOURCES-IN-PROMPT\n",
          summary: "Synthesized with citations.",
        })]);
      }
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
      if (SCENARIO === "blind-verify") {
        // Report whether the swarm's blackboard leaked into the verifier's context.
        const leaked = JSON.stringify(messages).includes("SECRET-NOTE-XYZ");
        return sse(res, [...toolChunks("verdict", { pass: true, feedback: leaked ? "LEAK" : "clean" })]);
      }
      if (SCENARIO === "strict-verify") {
        if (/cited no tool-gathered evidence/.test(lastUser(messages))) {
          // Second verifier pass: actually gather evidence, then pass.
          if (!hasToolResult(messages)) {
            return sse(res, [...toolChunks("shell", { command: "echo verify-evidence" })]);
          }
          return sse(res, [...toolChunks("verdict", { pass: true, feedback: "EVIDENCE-OK: verified with a real command." })]);
        }
        // First pass: rubber-stamp with zero tool calls.
        return sse(res, [...toolChunks("verdict", { pass: true, feedback: "NO-EVIDENCE: looks fine." })]);
      }
      if (SCENARIO === "verify-retry" && verdictCalls === 1) {
        return sse(res, [
          thinkChunk("The report is missing required evidence."),
          ...toolChunks("verdict", {
            pass: false,
            feedback: "Missing a Sources section — add it and report again.",
            issues: [{
              problem: "ISSUE-MARKER: the report has no Sources section",
              evidence: "report text contains no 'Sources' heading",
              fix: "add a Sources section listing the URLs used",
            }],
          }),
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
      if (SCENARIO === "forecast" && /FC-RESEARCH/.test(system)) {
        return sse(res, [...toolChunks("report", {
          status: "done",
          report: "Base rates researched: similar events resolve YES about 65% of the time.",
          sources: [{ url: "https://example.com/base-rates", title: "Base rates" }],
        })]);
      }
      if (SCENARIO === "verify-retry" && /ISSUE-MARKER/.test(system)) {
        // The retry prompt carried the verifier's structured issue verbatim.
        return sse(res, [...toolChunks("report", {
          status: "done",
          report: "saw-structured-feedback: added the Sources section exactly as the issue's fix instructed.",
        })]);
      }
      if (SCENARIO === "citations" && /CITE-A/.test(system)) {
        if (!hasToolResult(messages)) {
          // Post a sourced note first — exercises note(url=...).
          return sse(res, [...toolChunks("note", {
            text: "alpha handles 10k rps",
            key: "alpha-perf",
            url: "https://example.com/alpha",
          })]);
        }
        return sse(res, [...toolChunks("report", {
          status: "done",
          report: "Alpha researched: it is fast (10k rps per the primer).",
          sources: [{ url: "https://example.com/alpha?utm_source=tracker", title: "Alpha Primer", note: "performance numbers" }],
        })]);
      }
      if (SCENARIO === "citations" && /CITE-B/.test(system)) {
        return sse(res, [...toolChunks("report", {
          status: "done",
          report: "Beta researched: throughput claims conflict with alpha's primer.",
          sources: [
            { url: "https://example.com/alpha", title: "Alpha Primer" },
            { url: "https://beta.org/report", title: "Beta Report", date: "2026-01-15", note: "throughput counterclaim" },
          ],
        })]);
      }
      if (SCENARIO === "dep-chain" && /ROOTFAIL/.test(system)) {
        return sse(res, [...toolChunks("report", {
          status: "blocked",
          report: "BLOCKED-ROOT: the prerequisite dataset does not exist anywhere.",
        })]);
      }
      if (SCENARIO === "diag" && /DIAGTASK/.test(system)) {
        const last = lastUser(messages);
        // Refuse the wrap-up calls so the worker "ends without reporting" and
        // the engine must surface the last failing tool in its diagnostics.
        if (/step limit|Call the report tool now/i.test(last)) {
          return sse(res, [textChunk("cannot comply"), { usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
        }
        // read_file on a missing path THROWS (unlike a non-zero shell exit),
        // which is what marks a tool.result ok:false and feeds diagnostics.
        return sse(res, [...toolChunks("read_file", { path: "/nonexistent-swarm-e2e-diag.txt" })]);
      }
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
      if (SCENARIO === "blind-verify") {
        if (!hasToolResult(messages)) {
          // Post a distinctive note to the blackboard, then report next turn.
          return sse(res, [...toolChunks("note", { text: "SECRET-NOTE-XYZ planted by the worker", key: "probe" })]);
        }
        return sse(res, [
          ...toolChunks("report", {
            status: "done",
            report: "Wrote the brief as asked; content reviewed and complete.",
            artifacts: [],
            key_facts: ["the brief covers all three sections"],
          }),
        ]);
      }
      if (system.includes("PROGRESS CHECKPOINT FROM A PREVIOUS ATTEMPT")) {
        // The engine seeded this worker with a prior checkpoint — prove it.
        return sse(res, [
          textChunk("Resuming from checkpoint."),
          ...toolChunks("report", {
            status: "done",
            report: "resumed-from-checkpoint: verified prior progress and completed the remainder.",
            artifacts: [],
          }),
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

    // Tool-less helper calls: completeness critic / faithfulness check (strict mode).
    if (!tools.length) {
      const lu = lastUser(messages);
      if (/sharpening a forecasting question/.test(lu)) {
        return sse(res, [
          textChunk(JSON.stringify({
            text: "Will the test event happen by 2020-02-01?",
            kind: "binary",
            resolutionCriteria: "YES if the test harness records the event by the date",
            resolutionDate: "2020-02-01",
          })),
          { usage: { prompt_tokens: 40, completion_tokens: 30 } },
        ]);
      }
      if (/completeness critic/.test(lu)) {
        return sse(res, [textChunk("COMPLETE"), { usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
      }
      if (/faithfulness/.test(lu)) {
        return sse(res, [textChunk("OK"), { usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
      }
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

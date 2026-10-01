// work/mock-server-toolcall.mjs — stateful OpenAI-compatible mock for the
// grep/find/ls E2E (2026-10-01). Unlike the byte-fixed mock-server.mjs, this
// one drives a TOOL ROUND TRIP deterministically:
//   call 1 (no role:"tool" in history yet) → assistant toolCall `grep`
//            {pattern:"hello", path:"."}
//   call 2 (history contains the tool result) → final text answer
//            "ANSWER: tool-result-received"
// Both stream (SSE, OpenAI tool_calls deltas) and non-stream JSON are served.
// Every request is logged as one JSON line (n, stream, tool names declared in
// the request, full messages) so the E2E driver can prove: (a) the 5 tools
// were DECLARED in request 1, (b) the tool RESULT of the executed grep went
// back into the transcript of request 2.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT || 8407);
const LOG_FILE = process.env.MOCK_LOG || path.resolve(process.cwd(), "work/e2e-requests.log");
let callCount = 0;
const GFL_ARGS = JSON.stringify({ pattern: "hello", path: "." });

function chunk(delta, finishReason = null, extra = {}) {
  return JSON.stringify({
    id: "chatcmpl-gfl",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-1",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...extra,
  });
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;

  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model", owned_by: "mock", created: 1 }] }));
  }

  if (req.method === "POST" && req.url.includes("chat/completions")) {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* log raw anyway */ }
    callCount += 1;
    fs.appendFileSync(LOG_FILE, JSON.stringify({
      n: callCount,
      stream: parsed.stream === true,
      tools: (parsed.tools ?? []).map((t) => t?.function?.name ?? t?.name),
      messages: parsed.messages,
      raw: parsed.stream === undefined ? body : undefined,
    }) + "\n");

    const wantStream = parsed.stream === true;
    const hasToolResult = (parsed.messages ?? []).some((m) => m?.role === "tool");
    const isToolCall = !hasToolResult; // call 1 → toolCall, call 2 → final text

    if (!wantStream) {
      const message = isToolCall
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_gfl_1", type: "function", function: { name: "grep", arguments: GFL_ARGS } }] }
        : { role: "assistant", content: "ANSWER: tool-result-received" };
      const payload = JSON.stringify({
        id: "chatcmpl-gfl", object: "chat.completion", created: 1, model: "mock-1",
        choices: [{ index: 0, message, finish_reason: isToolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(payload);
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const lines = [`data: ${chunk({ role: "assistant" })}`];
    if (isToolCall) {
      lines.push(`data: ${chunk({ tool_calls: [{ index: 0, id: "call_gfl_1", type: "function", function: { name: "grep", arguments: GFL_ARGS } }] })}`);
      lines.push(`data: ${chunk({}, "tool_calls", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`);
    } else {
      lines.push(`data: ${chunk({ content: "ANSWER: tool-result-received" })}`);
      lines.push(`data: ${chunk({}, "stop", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`);
    }
    lines.push("data: [DONE]");
    res.end(lines.join("\n\n") + "\n\n");
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

fs.writeFileSync(LOG_FILE, "");
server.listen(PORT, "127.0.0.1", () => console.log(`toolcall mock listening on 127.0.0.1:${PORT}`));

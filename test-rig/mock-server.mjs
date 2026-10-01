// mock-server.mjs — MINIMAL LOCAL MOCK OpenAI-compatible LLM server (piece 5 of the validation rig)
//
// Purpose: single model "mock-1". Every chat completion returns the SAME fixed
// deterministic stream (reasoning deltas -> answer deltas -> final chunk with
// FIXED usage numbers), so two harness runs fed through this server receive
// byte-identical content. The isolated pi config points at this server as the
// ONLY provider -> interactive typing in pi never touches a real API.
//
// Every request is logged (method, path, request body, response payload bytes)
// to the file given by --log (default: work/requests.log) so we can PROVE both
// harness runs consume the same stream bytes.
//
// Usage: node mock-server.mjs [--log <file>] [--port <port>]
// Endpoints: GET  /v1/models              -> model list
//            POST /v1/chat/completions    -> fixed stream (SSE) or fixed JSON

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT || findArg("--port") || 8407);
const LOG_FILE = path.resolve(process.cwd(), findArg("--log") || "work/requests.log");

const MODEL = "mock-1";

fs.writeFileSync(LOG_FILE, ""); // truncate: each run restarts with an empty request log

// --- FIXED payload constants (NO Date.now(), NO random ids: bytes identical every run)
const CREATED = 1700000000; // fixed epoch literal
const ID = "chatcmpl-mock-0000";

const FIXED_USAGE = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 };

// SSE chunk payloads (each `data: {...}\n\n` line; content in {reasoning_content}
// first -> the harness's thinking phase, then {content} answer deltas).
const REASONING = "let me think step by step";
const ANSWER = "hello from the mock";

function chunkPayload(delta, extra = {}, finishReason = null) {
  return JSON.stringify({
    id: ID,
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...extra,
  });
}

function buildStreamBody() {
  const lines = [];
  lines.push(`data: ${chunkPayload({ role: "assistant" })}`);
  lines.push(`data: ${chunkPayload({ reasoning_content: REASONING })}`);
  lines.push(`data: ${chunkPayload({ content: ANSWER })}`);
  lines.push(`data: ${chunkPayload({}, { usage: FIXED_USAGE }, "stop")}`);
  lines.push("data: [DONE]");
  return lines.join("\n\n") + "\n\n";
}
const STREAM_BODY = buildStreamBody(); // computed once -> identical bytes every time

function buildJsonBody() {
  return JSON.stringify({
    id: ID,
    object: "chat.completion",
    created: CREATED,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", reasoning_content: REASONING, content: ANSWER },
        finish_reason: "stop",
      },
    ],
    usage: FIXED_USAGE,
  });
}
const JSON_BODY = buildJsonBody();

function findArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --- request log (JSONL: {ts, method, path, body, responsePayload, responseError?})
function logRequest(req, body, payload, error) {
  const rec = {
    ts: new Date().toISOString(), // legitimate variance -> excluded from equality assert
    method: req.method,
    path: req.url,
    body,
    responsePayload: payload || "",
    ...(error ? { error: String(error) } : {}),
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n");
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;

  const respond = (code, headers, payload) => {
    res.writeHead(code, headers);
    res.end(payload);
    logRequest(req, body, payload);
  };

  if (req.method === "GET" && req.url === "/v1/models") {
    const payload = JSON.stringify({
      object: "list",
      data: [{ id: MODEL, object: "model", owned_by: "mock", created: CREATED }],
    });
    return respond(200, { "content-type": "application/json" }, payload);
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* log raw body anyway */ }
    const wantStream = parsed.stream === true;
    return respond(
      200,
      wantStream
        ? { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
        : { "content-type": "application/json" },
      wantStream ? STREAM_BODY : JSON_BODY
    );
  }

  // anything else: tiny deterministic 404 so failures are visible in the log
  return respond(404, { "content-type": "application/json" }, "{\"error\":\"mock: not found\"}");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MOCK-READY port=${PORT} log=${LOG_FILE}`);
  console.log(`MOCK-STREAM-SHA256=${createHash("sha256").update(STREAM_BODY).digest("hex")}`);
});

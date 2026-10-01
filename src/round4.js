#!/usr/bin/env node
// Observation_only Round 4 entry (round-1 connection + map_folder_walk + read + fetch).
// Harness start = map_folder_walk on the working folder (default: cwd; must stay
// inside the project). Then the round-1 connection sends the LLM the working
// folder's map_folder.md path together with the user message, carrying the read
// tool AND the fetch tool (round-4 feature: a user-provided http(s) HTML link or a
// folder to list, same contract as read). When the LLM emits a read or fetch call,
// the harness validates it (pi's validator), executes it, and returns the result
// to the LLM; the LLM's next turn answers from that content. Never prints secrets.
//   node src/round4.js [--work-dir DIR] [--provider P] [--model M] [--api-key K] [message...]
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mapFolderWalk } from "./map_walk.js";
import { createClient } from "./client.js";
import { footerLine } from "./footer.js";
import { validateToolCall } from "./pi-ai.js";
import { createReadTool } from "./read_tool.js";
import { createFetchTool } from "./fetch_tool.js";

const MAX_TURNS = 12;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

const flags = new Set(["--work-dir", "--provider", "--model", "--api-key"]);
const overrides = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) {
    overrides[args[i].slice(2)] = args[++i];
  } else {
    positional.push(args[i]);
  }
}

let message = positional.join(" ");
if (!message && !process.stdin.isTTY) {
  message = (await readStdin()).trim();
}
if (!message) {
  console.error("usage: node src/round4.js [--work-dir DIR] [--provider P] [--model M] [--api-key K] [message...]  (or pipe a message via stdin)");
  process.exit(2);
}

// The working folder the harness walks; must stay inside the project dir.
const projectRoot = resolve(process.cwd());
const workDir = resolve(projectRoot, overrides["work-dir"] ?? ".");
const relCheck = relative(realpathSync(projectRoot), realpathSync(workDir));
if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
  process.stderr.write(`work dir outside the project: ${workDir}\n`);
  process.exit(1);
}

try {
  // Harness start: the map_folder_walk (round-2 feature) — the LLM's door.
  const { mapPath } = await mapFolderWalk(workDir);
  const mapRef = relative(projectRoot, mapPath).split(sep).join("/");
  process.stdout.write(`map_folder_walk: ${mapRef}\n`);

  const client = await createClient({
    provider: overrides.provider,
    model: overrides.model,
    apiKey: overrides.apiKey,
  });
  const model = { id: client.modelId, input: ["text"] };
  const readTool = await createReadTool(workDir); // read resolves relative to the working dir
  const fetchTool = await createFetchTool(workDir); // fetch: a user-provided HTML link or a folder, same contract as read
  const tools = [readTool, fetchTool];
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const systemPrompt =
    "Observation-only harness. You have two tools: read — use it to read a file's content; fetch — use it to fetch a user-provided http(s) HTML link or to list a folder. Answer from what they return.";
  const messages = [
    { role: "user", content: `Working folder map_folder.md: ${mapRef} — one line per file and per subfolder there, paths relative to the working folder.\n\n${message}`, timestamp: Date.now() },
  ];

  let reply = await client.run(messages, { systemPrompt, tools });
  let turns = 0;
  while (reply.content.some((block) => block.type === "toolCall") && turns < MAX_TURNS) {
    turns += 1;
    messages.push(reply); // the assistant message with its toolCall blocks goes back to the transcript
    for (const block of reply.content) {
      if (block.type !== "toolCall") continue;
      const tool = toolByName.get(block.name);
      if (!tool) {
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: `Tool ${block.name} not found` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }
      process.stdout.write(`${tool.name}: ${JSON.stringify(block.arguments?.url ?? block.arguments?.path ?? block.name)}\n`); // observable, not a secret
      const toolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
      try {
        const args = await validateToolCall(tools, toolCall); // pi's validator, pi's error format
        const result = await tool.execute(block.id, args, undefined, undefined, { cwd: workDir, model });
        process.stdout.write(`${tool.name} result: ${result.content.length} block(s)\n`);
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        // Same envelope as pi's createErrorToolResult: error text block, isError true.
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: error?.message ?? String(error) }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
    reply = await client.run(messages, { systemPrompt, tools });
  }
  if (reply.content.some((block) => block.type === "toolCall")) {
    process.stderr.write(`too many tool rounds (${MAX_TURNS})\n`);
    process.exit(1);
  }
  const text = (reply.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text) {
    process.stderr.write("no text in model reply\n");
    process.exit(1);
  }
  process.stdout.write(text.replace(/\n+$/, "") + "\n");
  process.stderr.write(footerLine(client) + "\n"); // round-7 footer: in/out tokens, ctx/max, model, tok/s
} catch (error) {
  process.stderr.write(`request failed: ${error?.message ?? error}\n`);
  process.exit(1);
}

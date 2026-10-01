#!/usr/bin/env node
// src/worker.js
// The spawned agent process of the subagent tool (Round 5). A fresh, short-lived
// node process playing the role of pi's subagent child (pi spawns
// `pi --mode json -p --no-session [--model <provider/id>] [--tools a,b]
// [--append-system-prompt <path>] "Task: <task>"`): it runs OUR OWN round-1
// connection (src/client.js) carrying read (round 3) and fetch (round 4) as its
// tools — the spawned agents carry read and fetch, inheriting them from the parent
// harness — with the agent's markdown body injected as the system prompt, and it
// streams one JSON event per stdout line, the same protocol pi's print mode uses
// ({"type":"message_end","message":<AssistantMessage>},
// {"type":"tool_result_end","message":<tool result>}). The parent re-assembles
// the LAST assistant text as the tool result; errors surface as a message_end with
// stopReason "error" + errorMessage (json mode: exit 0, detection is event-driven;
// pi's behavior), while config/usage errors exit non-zero with stderr. Progress
// diagnostics go to STDERR only — stdout is pure event lines. Never prints secrets.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "./client.js";
import { footerLine } from "./footer.js";
import { validateToolCall } from "./pi-ai.js";
import { createFetchTool } from "./fetch_tool.js";
import { createGrepTool } from "./grep_tool.js";
import { createFindTool } from "./find_tool.js";
import { createLsTool } from "./ls_tool.js";

const MAX_TURNS = 12;

const flags = new Set(["--work-dir", "--provider", "--model", "--tools", "--api-key", "--append-system-prompt"]);
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
const toolsArg = overrides.tools;
const promptPath = overrides["append-system-prompt"];
// "provider/id" shorthand -> keep BOTH parts: the provider, so the child never
// silently falls back to settings.defaultProvider when the parent set one, plus
// the model id; a bare model id stays unchanged (its provider arrives as
// `--provider` from the parent).
if (overrides.model?.includes("/")) {
  const slash = overrides.model.indexOf("/");
  overrides.provider = overrides.provider || overrides.model.slice(0, slash);
  overrides.model = overrides.model.slice(slash + 1);
}
const taskArg = positional.join(" ").replace(/^Task:\s*/, "").trim();

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function main() {
  if (!taskArg) {
    process.stderr.write("usage: node src/worker.js [--work-dir DIR] [--provider P] [--model provider/id] [--tools fetch] [--append-system-prompt PATH] \"Task: <task>\"\n");
    process.exit(1);
  }
  const workDir = resolve(overrides["work-dir"] ?? process.cwd());

  const client = await createClient({
    provider: overrides.provider,
    model: overrides.model,
    apiKey: overrides.apiKey,
  });
  const model = { id: client.modelId, input: ["text"] };

  // The harness's tool set the agent may carry: fetch (file reading — merged
  // from the round-3 read tool — + folder listing + http(s) links) + the
  // imported pi observation tools grep/find/ls (2026-10-01) — all scoped the
  // same way (workDir + dot-folder for fetch, workDir for the rest).
  const allTools = [await createFetchTool(workDir), await createGrepTool(workDir), await createFindTool(workDir), await createLsTool(workDir)];
  const tools = toolsArg ? allTools.filter((t) => toolsArg.split(",").map((s) => s.trim()).includes(t.name)) : allTools;
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  // The agent's system prompt (the markdown body, like pi's --append-system-prompt:
  // an existing path is read, otherwise the value IS the text).
  let systemPrompt = "";
  {
    let raw = promptPath;
    if (raw) {
      try {
        raw = readFileSync(raw, "utf8");
      } catch {
        // not a path -> the raw value IS the prompt text (pi's resource-loader rule)
      }
    }
    systemPrompt = raw ?? "";
  }

  emit({ type: "session", id: "obs-worker", model: `${client.providerId}/${client.modelId}`, tools: tools.map((t) => t.name) });

  const messages = [{ role: "user", content: taskArg, timestamp: Date.now() }];
  let reply = await client.run(messages, { systemPrompt, tools });
  let turns = 0;
  while (reply.content.some((block) => block.type === "toolCall") && turns < MAX_TURNS) {
    turns += 1;
    emit({ type: "message_end", message: reply });
    messages.push(reply);
    for (const block of reply.content) {
      if (block.type !== "toolCall") continue;
      const tool = toolByName.get(block.name);
      const toolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
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
        emit({ type: "tool_result_end", message: messages[messages.length - 1] });
        continue;
      }
      process.stderr.write(`${tool.name}: ${JSON.stringify(block.arguments?.url ?? block.arguments?.path ?? block.name)}\n`);
      try {
        const callArgs = await validateToolCall(tools, toolCall); // pi's validator, pi's error format
        const result = await tool.execute(block.id, callArgs, undefined, undefined, { cwd: workDir, model });
        process.stderr.write(`${tool.name} result: ${result.content.length} block(s)\n`);
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
      emit({ type: "tool_result_end", message: messages[messages.length - 1] });
    }
    try {
      reply = await client.run(messages, { systemPrompt, tools });
    } catch (error) {
      // LLM-level failure -> a message_end with stopReason "error", like pi's child:
      // json mode still exits 0; the PARENT detects the failure from the event.
      emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: error?.message ?? String(error) } });
      return;
    }
  }
  if (reply.content.some((block) => block.type === "toolCall")) {
    emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: `too many tool rounds (${MAX_TURNS})` } });
    return;
  }
  process.stderr.write(`${client.providerId}/${client.modelId} reply: ${reply.stopReason}\n`);
  emit({ type: "message_end", message: reply });
  process.stderr.write(footerLine(client) + "\n"); // round-7 footer: in/out tokens, ctx/max, model, tok/s
}

// ROOT-CAUSE GUARD against Node's "Detected unsettled top-level await" warning:
// emitted by the runtime (NOT via process.emitWarning, so not catchable with
// process.on("warning")) when the event loop drains while a top-level await in this
// module is pending. A ref'd no-op timer holds the loop for the whole `await main()`
// so it can never drain early and the warning can never fire; the finally clears it on
// the natural-exit path — the error path process.exit's unconditionally, so this can
// never strand the worker (its stderr is piped to the parent and rendered in the chart,
// so a warning here would pollute the prompt zone).
const keepAlive = setInterval(() => {}, 2 ** 30);
try {
  await main();
} catch (error) {
  // Config/auth/broken-spawn channel (exit non-zero + stderr), like pi.
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
} finally {
  clearInterval(keepAlive);
}

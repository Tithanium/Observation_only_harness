// src/session.js
// The harness's shared TURN DRIVER — the exact round-5 tool loop (fetch +
// subagent — the round-3 read tool was merged into fetch) used by BOTH the
// one-shot entry (src/round5.js) and the interactive session (src/interactive.js,
// rounds 10 + 11): one user message in, the LLM may call any of the two tools,
// each toolResult goes back into the transcript, and
// the loop ends at the first text-only reply or MAX_TURNS. Round 11 keeps the
// one-shot and the interactive session on THE SAME code path so they cannot drift.
// Abort (Ctrl+C in the interactive session) surfaces as an AbortError from the
// in-flight client round trip; the caller decides what to print. Never prints
// secrets.
import { createFetchTool } from "./fetch_tool.js";
import { createGrepTool } from "./grep_tool.js";
import { createFindTool } from "./find_tool.js";
import { createLsTool } from "./ls_tool.js";
import { createSubagentTool } from "./subagent_tool.js";
import { loadGlobalInstructions } from "./config.js";
import { discoverSkills, skillsPromptSection } from "./skills.js";
import { discoverAgents } from "./agents.js";
import { extensionToolsList } from "./extensions.js";

/** The tools section of the system prompt, pi's promptSections.tools style: one line
 *  per tool with its description — the model sees the FULL contract twice: these
 *  lines in the prompt AND the declared tool schemas in the request (driveTurn
 *  passes `tools: toolsMap.tools` → pi-ai's normalizeContext folds them into the
 *  head system message as `toolsAdded` → params.tools, pi's native function
 *  calling). The LLM is told the tools exist AND can actually call them. */
export function toolsPromptLines() {
  const extensionTools = extensionToolsList(); // ROUND 21: extension-registered tools (pi's registerTool) are ordinary tools in the same prompt
  const lines = [
    "You have five tools:",
    "- fetch — use it to read a file's content (a file path, optional offset/limit), to list a folder, or to fetch a user-provided http(s) HTML link, and answer from what it returns (local paths are scoped to the working folder and the harness dot-folder);",
    "- grep — use it to search file contents for a pattern (regex or literal, optional glob/context/ignoreCase; respects .gitignore; working-folder scoped);",
    "- find — use it to find files by glob pattern (e.g. '**/*.py'; respects .gitignore; working-folder scoped);",
    "- ls — use it to list a directory's contents (working-folder scoped);",
    "- subagent — use it to delegate a task to a subagent (spawned agents carry fetch, grep, find, ls).",
  ];
  for (const tool of extensionTools) lines.push(`- ${tool.name} — ${tool.promptSnippet ?? tool.description ?? tool.name};`);
  lines.push("To use a tool, emit a tool call with the declared name and JSON arguments; the harness executes it and provides the tool result back, and you answer from what that result contains.");
  return lines;
}

/** The agents section of the system prompt — pi-style XML (the <available_agents>
 *  analog of <available_skills>): one <agent> per DISCOVERED agent (name +
 *  description + tools — the dispatch criteria the model matches when it decides
 *  to delegate via the subagent tool). Missing agents dir / no discoverable
 *  agents → "" → no section, no error. Never prints agent bodies. */
export function agentsPromptSection(agents = discoverAgents()) {
  const list = agents?.agents ?? [];
  if (list.length === 0) return "";
  const escapeXml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const lines = [
    "",
    "The following agents are available for the subagent tool — delegate the subagent call to one of their names:",
    "",
    "<available_agents>",
  ];
  for (const agent of list) {
    lines.push(
      "  <agent>",
      `    <name>${escapeXml(agent.name)}</name>`,
      `    <description>${escapeXml(agent.description)}</description>`,
      `    <tools>${escapeXml((agent.tools ?? []).join(", "))}</tools>`,
      "  </agent>"
    );
  }
  lines.push("</available_agents>");
  return lines.join("\n");
}

export const MAX_TURNS = 12;

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/** The harness system prompt — same contract in both modes. Round 8: the GLOBAL
 *  instructions/memory from the DOT-FOLDER (<userDotDir()>/AGENTS.md — pi's
 *  ~/.pi/agent/AGENTS.md kind, env override OBSERVATION_ONLY_DIR honoured at call
 *  time) are appended when the file IS present; missing → the base prompt
 *  unchanged (no instructions, no error). ROUND 12: the SKILLS INDEX is appended
 *  too — same path as pi (progressive disclosure): one <skill> per discovered
 *  skill under <userSkillsDir()> with its frontmatter name + description (the
 *  dispatch criteria, XML <available_skills>), so the LLM can decide to load a
 *  skill's SKILL.md via the fetch tool; no skills discovered / malformed files →
 *  no section, no error. Never prints secrets. */
export function harnessSystemPrompt() {
  const base = "Observation-only harness. You help users by answering from what the harness tools return.\n" + toolsPromptLines().join("\n");
  const parts = [base];
  const instructions = loadGlobalInstructions();
  if (instructions !== undefined) {
    parts.push(`\n<global_instructions>\n${instructions.replace(/\n+$/, "")}\n</global_instructions>`);
  }
  const skills = skillsPromptSection(discoverSkills());
  if (skills) parts.push(skills);
  const agents = agentsPromptSection(discoverAgents());
  if (agents) parts.push(agents);
  return parts.join("\n");
}

/** The harness tools (fetch + subagent — the round-3 read tool was merged into
 *  fetch — plus the imported pi observation tools grep/find/ls, 2026-10-01) plus
 *  any extension-registered tools (pi's registerTool, ROUND 21), all bound to
 *  `workDir`; spawned subagents carry fetch + grep + find + ls. */
export async function buildHarnessTools(workDir) {
  const fetchTool = await createFetchTool(workDir);
  const subagentTool = await createSubagentTool(workDir);
  const grepTool = await createGrepTool(workDir);
  const findTool = await createFindTool(workDir);
  const lsTool = await createLsTool(workDir);
  const tools = [fetchTool, subagentTool, grepTool, findTool, lsTool, ...extensionToolsList()];
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  return { tools, toolByName };
}

/** The first message of an exchange IS the user's message. (The round-2 harness
 *  door — the map_folder.md / map_folder_full.md references — was REMOVED
 *  2026-10-01: the harness no longer writes folder maps at start, and the model
 *  explores the working folder with the harness's own ls/grep/find tools.) */
export function userContent(message) {
  return message;
}

/**
 * ONE user message through the harness. `messages` is the SHARED transcript (an
 * array, mutated): the user message is pushed in, every toolCall block and its
 * toolResult go back into it, so a later turn of the SAME array continues the
 * conversation — both the one-shot entry and every interactive turn run this exact
 * function. Resolves to `{ text, aborted }`. `output` receives only the
 * harness's own observation lines per tool call (tool name + argument + result
 * block count — never secrets); the model reply and the footer are the CALLER's
 * job, so the one-shot entry prints them on stdout/stderr exactly as round 5 did
 * and the interactive session prints them inside its loop.
 */
export async function driveTurn(client, messages, options) {
  const { workDir, systemPrompt, output = () => {} } = options;
  const onTool = options.onTool; // piece-3: the CHART's structured tool events — {kind:"call", name, args} then {kind:"result", name, blocks, text, isError, exitCode} — rendered by screen.toolEvent (pi's tool-execution blocks); line mode keeps the plain `output` lines below
  const onMessage = options.onMessage; // round 17: EVERY message of the turn (user, assistant with its thinking/text/toolCall blocks, toolResult) is handed to the session STORE as it enters the transcript — the interactive session's auto-save (pi: append after every message); undefined in the one-shot path — unchanged there
  // THE COMPACTION DRIVER (src/compaction.js — pi's auto-compaction ported):
  // undefined (the default — the injected suites, any caller that opts out) →
  // the loop runs EXACTLY as before. When present, pi's three automatic cases
  // hook the round trips below: CASE 1 — a round trip that THREW a context-
  // overflow error (handleRunError: compact + re-run the SAME client.run once —
  // pi's "remove the failed message, compact, retry the turn once"; a failed
  // round trip never entered the transcript, so the re-run IS the retry) and a
  // round trip that RETURNED a recoverable length stop (handleRecoverableLength
  // — same compact-and-rerun-once); CASE 2 + 3 — after the turn's final reply
  // (afterTurn: a successful response that exceeded the window, or the context
  // crossing contextWindow - reserveTokens → compact, keep the reply). The
  // driver reports through `output` in line mode; chart mode shows the compaction
  // as a [compaction] transcript row (the summary message).
  const compaction = options.compaction;
  compaction?.beginTurn();
  const toolsMap = options.toolsMap ?? (await buildHarnessTools(workDir));
  const model = { id: client.modelId, input: ["text"] };
  const userMessage = { role: "user", content: userContent(options.message), timestamp: Date.now() }; // the stored user message IS THE EXACT LLM PAYLOAD — the full text the round trip carried (pi stores the actual message the model received); the session file therefore holds EVERYTHING the LLM saw — normalizeMessage (session_store) wraps the string into a text block for the file
  messages.push(userMessage);
  onMessage?.(userMessage);
  const runOptions = { systemPrompt, signal: options.signal, onPartial: options.onPartial, tools: toolsMap.tools };
  async function runOnce() {
    try {
      return await client.run(messages, runOptions);
    } catch (error) {
      // pi's CASE 1 (overflow with retry): ONE compact-and-retry per turn
      // (the driver's flag); a non-overflow error — or the second overflow —
      // surfaces unchanged (handleRunError rethrows the original after the
      // failed recovery; AbortError passes through — the user interrupted).
      if (compaction && (await compaction.handleRunError(client, messages, error, options.signal))) {
        try {
          return await client.run(messages, runOptions);
        } catch (retryError) {
          // pi: the RETRIED turn overflowed again → recovery is over; the
          // error stands, with pi's exact "gave up" line (its second
          // _checkCompaction sees _overflowRecoveryAttempted already set).
          compaction.reportRecoveryGaveUp(client, retryError);
          throw retryError;
        }
      }
      throw error;
    }
  }
  async function runWithRecoverableLength() {
    let reply = await runOnce();
    // pi's CASE 1b: a length stop BELOW the intended output limit may be context
    // pressure — compact and re-run once (the truncated reply never entered the
    // transcript, so the re-run starts from the same point).
    if (compaction && (await compaction.handleRecoverableLength(client, messages, reply, options.signal))) {
      reply = await runOnce();
    }
    return reply;
  }
  let reply = await runWithRecoverableLength(); // round 10: the interactive session's Ctrl+C travels as the request signal (abort → AbortError → the caller prints "(interrupted)"); round 16: onPartial (the interactive chart's live stream — thinking italic / answer bold) travels the same way; round 17: the persisted messages travel via onMessage — all three undefined in the one-shot path — unchanged there; ROUND 18: `tools: toolsMap.tools` — THE tool-declaration fix: pi-ai's normalizeContext folds context.tools into the head system message's toolsAdded → buildParams emits params.tools (native function calling) → the model CAN produce a toolCall block the harness executes → the tool result goes back into the transcript. Before round 18 the tools were never declared ANYWHERE in the request: the model answered in prose, the harness saw no toolCall block — the observed "tool use fails" of the real LLM.

  let turns = 0;
  while (reply.content?.some((block) => block.type === "toolCall") && turns < MAX_TURNS) {
    turns += 1;
    messages.push(reply); // the assistant message with its toolCall blocks goes back to the transcript
    onMessage?.({
      role: "assistant",
      content: reply.content ?? [],
      timestamp: Date.now(),
      ...(reply.usage !== undefined ? { usage: reply.usage } : {}), // round 19: the round trip's provider-reported extras are stored (pi stores per-message usage)
      ...(reply.stopReason !== undefined ? { stopReason: reply.stopReason } : {}),
      ...(reply.responseId !== undefined ? { responseId: reply.responseId } : {}),
    });
    for (const block of reply.content) {
      if (block.type !== "toolCall") continue;
      const tool = toolsMap.toolByName.get(block.name);
      if (!tool) {
        const notFound = `Tool ${block.name} not found`;
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: notFound }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        });
        onMessage?.(messages[messages.length - 1]);
        onTool?.({ kind: "result", name: String(block.name), blocks: 1, text: notFound, isError: true }); // piece-3: the chart's tool-error block
        continue;
      }
      output(`${tool.name}: ${JSON.stringify(block.arguments?.agent ?? block.arguments?.url ?? block.arguments?.path ?? block.name)}`); // observable, not a secret
      onTool?.({ kind: "call", name: tool.name, args: block.arguments }); // piece-3: the chart's tool-ANNOUNCEMENT (pending block)
      try {
        // PIECE-4 (row 5/7): the tool's streaming partials (the subagent's child activity —
        // pi's tool_execution_update) travel to the chart as onTool {kind:"update"} events;
        // the onTool-less paths (one-shot, line mode) pass undefined — no-op there, unchanged.
        // THE turn's AbortSignal as the 3rd execute arg (pi's tool contract — tool-definition-wrapper.js: `execute(toolCallId, params, signal, onUpdate, ctx)`): ESC/Ctrl+C aborts the in-flight turn and the signal must reach the tool — the subagent arms its killProc on it (SIGTERM the spawned worker), the fetch tool listens on it for the whole fetch. Before this it was `undefined`: an ESC during a subagent/fetch changed NOTHING until the tool finished (the user-reported "escape does not stop the process"). One-shot/line paths pass an undefined options.signal — same as before there.
        const result = await tool.execute(block.id, block.arguments, options.signal, onTool ? (p) => onTool({ kind: "update", name: tool.name, details: p.details }) : undefined, {
          cwd: workDir,
          model,
          providerId: client.providerId,
          modelId: client.modelId,
        });
        output(`${tool.name} result: ${result.content.length} block(s)`);
        const toolText = (result.content ?? [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        onTool?.({
          kind: "result",
          name: tool.name,
          blocks: result.content.length,
          text: toolText,
          isError: false, // r2 (Fix 1): pi's executePreparedToolCall returns {result, isError:false} on RESOLVE — the extension's resolved result.isError is discarded; only THROWN errors set isError (the catch path below keeps isError: true). The subagent's own failure is carried by the details envelope (isFailedResult: exitCode/stopReason) → the ✗ icon + (no output)
          exitCode: result.exitCode,
          details: result.details, // PIECE-4 (row 7): the SubagentDetails envelope (results[0].messages/usage/model/stopReason) — the data pi's renderResult consumes
        }); // pieces-3: the chart's tool-result block (preview, truncated: full-output path, (exit N))
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: result.content,
          details: result.details,
          isError: result.isError ?? false,
          timestamp: Date.now(),
        });
        onMessage?.(messages[messages.length - 1]);
      } catch (error) {
        const errText = error?.message ?? String(error);
        messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: errText }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        });
        onMessage?.(messages[messages.length - 1]);
        onTool?.({ kind: "result", name: tool.name, blocks: 1, text: errText, isError: true, details: {} }); // piece-3: a THROWN tool → the chart's error block; PIECE-4 (row 7): no details envelope (the throw path has none)
      }
    }
    reply = await runWithRecoverableLength(); // round 16: every round trip's stream reaches the interactive chart live; round 18: every round trip carries the tool declarations (toolResult blocks must keep being understood — native function calling needs the tools present on FOLLOW-UP rounds too)
  }
  if (reply.content?.some((block) => block.type === "toolCall")) {
    throw new Error(`too many tool rounds (${MAX_TURNS})`);
  }
  // THE FINAL assistant message COMPLETES the transcript (pi's state.messages
  // ends with it — the next turn's round trip carries the whole exchange,
  // answer included). The old loop left it OUT of the live array (store only,
  // via onMessage): the model then never saw its own previous answers, and a
  // resumed session carried MORE context than the live one. With compaction,
  // the divergence also broke the store's positional firstKeptEntryId mapping
  // (one ghost entry per turn) — the live transcript and the store must hold
  // the SAME messages, the compaction entry being the only difference.
  messages.push(reply);
  onMessage?.({
    role: "assistant",
    content: reply.content ?? [],
    timestamp: Date.now(),
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}), // round 19: the final answer's provider-reported extras are stored too (pi stores per-message usage)
    ...(reply.stopReason !== undefined ? { stopReason: reply.stopReason } : {}),
    ...(reply.responseId !== undefined ? { responseId: reply.responseId } : {}),
  }); // the final assistant message (the turn's answer) — the FIRST assistant message flushes the deferred store file
  // pi's agent_end compaction check (CASE 2: a successful response exceeded the
  // window — compact, keep it; CASE 3: the threshold crossed — compact, keep it;
  // both without retry) + the footer's context-usage refresh. Runs AFTER the
  // final message is stored (pi: the compaction ENTRY is appended as the child
  // of the current leaf — the final assistant message — and the live array and
  // the store then hold the SAME messages, the compaction entry being the only
  // difference; the summary message is the entry's replay, not a stored one).
  await compaction?.afterTurn(client, messages, reply, options.signal);
  const text = (reply.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, aborted: false };
}

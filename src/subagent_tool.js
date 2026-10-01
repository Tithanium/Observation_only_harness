// src/subagent_tool.js
// Round 5 feature: the subagent tool — same contract as pi's subagent extension
// (examples/extensions/subagent/index.ts). INTENT (goal.md): "subagent generation
// whose spawned agents carry fetch." Same input form (agent name + task;
// single / parallel / chain), same agent-definition loading (agents dir search,
// frontmatter keys name/description/tools, markdown body = system prompt), same
// result envelope (SingleResult {agent, agentSource, task, exitCode, messages[],
// stderr, usage{turns,input,output,cacheRead,cacheWrite,cost,contextTokens},
// model, stopReason, errorMessage?, step?}) and the same error shapes (unknown
// agent → exitCode 1 "Unknown agent: …", failure → "Agent <stopReason>: …",
// chain → "Chain stopped at step N (<agent>): …", "Invalid parameters…",
// "Too many parallel tasks (N). Max is 8."). The spawned agent is OUR OWN worker
// (src/worker.js): a fresh node process running the round-1 connection with fetch
// as its tool; the child answers from what it returns and its final
// answer returns to the parent via the normal tool-result flow. Interactive
// project-agent confirmation is N/A (this harness has no UI; the project agents
// are the harness's own and run directly — workers never touch pi's agents dir).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { typeboxType } from "./pi-ai.js";
import { discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8; // pi's hard cap, same error message
const MAX_CONCURRENCY = 4; // pi's worker-pool concurrency
const PER_TASK_OUTPUT_CAP = 50 * 1024; // parallel mode only, like pi

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

/** Round 10: the LAST subagent's context — what the interactive session's ctrl+o
 *  expands: the instructions/context handed to the spawned worker(s) (agent name,
 *  source, tools, task, cwd and the agent's system prompt, recorded at dispatch,
 *  BEFORE the spawn — that object IS the spawned worker's context). Kept in THIS
 *  module, the subagent machinery's home, so the interactive session reads it
 *  without touching the spawing code; a setter is exported so the deterministic
 *  round-10 suite can seed it WITHOUT spawning (no network). Never prints
 *  secrets. */
let lastSubagentContext = null;

export function setLastSubagentContext(ctx) {
  lastSubagentContext = ctx;
}

export function getLastSubagentContext() {
  return lastSubagentContext;
}

/** The expand/collapse rendering of a recorded context; null when there is none
 *  (the ctrl+o no-op case). One block per spawned worker: the agent, its source,
 *  the task, the tools carried and the system prompt handed to the worker. */
export function subagentContextLines(ctx) {
  if (!ctx || !Array.isArray(ctx.entries) || ctx.entries.length === 0) return null;
  const lines = [`subagent context (${ctx.mode ?? "single"}, ${ctx.entries.length} agent${ctx.entries.length === 1 ? "" : "s"}${ctx.cwd ? `, cwd: ${ctx.cwd}` : ""}) — ctrl+o again collapses:`];
  for (const e of ctx.entries) {
    lines.push(`  ${e.agent}${e.source ? ` (${e.source})` : ""}`);
    lines.push(`  task: ${e.task ?? ""}`);
    if (e.tools?.length) lines.push(`  tools: ${e.tools.join(", ")}`);
    lines.push(`  system prompt handed to the spawned worker:`);
    lines.push((e.systemPrompt ?? "(none)").split("\n").map((l) => `    ${l}`).join("\n"));
  }
  return lines;
}

/** The harness's own project root (this module lives in <root>/src/). */
function projectRoot() {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/** Last assistant text block of the last assistant message, pi's getFinalOutput. */
function getFinalOutput(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result) {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result) {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output) {
  const byteLength = Buffer.byteLength(output, "utf-8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf-8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + `\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf-8")} bytes omitted. Full output preserved in tool details.]`; // pi's exact suffix (examples/extensions/subagent/index.ts)
}

/** Sanitize an agent name for use in the tmp prompt FILE NAME (2026-10-01
 *  read-only audit, §3): agent names come VERBATIM from an agent .md's
 *  frontmatter — a name carrying separators or `..` segments would escape the
 *  tmp dir via join(). Keep [A-Za-z0-9_-], replace everything else with `_`,
 *  cap at 64 chars, fall back to "agent" when empty. */
export function sanitizeAgentFileName(name) {
  const s = String(name ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s || "agent";
}

/** Write the agent's system prompt to a tmp file (mode 0600) like pi's
 *  writePromptToTempFile; both the file and its dir are removed afterwards. */
function writePromptToTempFile(agentName, content) {
  const dir = join(tmpdir(), `obs-subagent-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o600 });
  const filePath = join(dir, `prompt-${sanitizeAgentFileName(agentName)}.md`);
  writeFileSync(filePath, content, { mode: 0o600 });
  return { dir, filePath };
}

/**
 * Run one agent (one spawned worker process). Pi's runSingleAgent: spawn the
 * harness's OWN worker entry, parse its JSON event stream (message_end /
 * tool_result_end), accumulate messages + usage + model + stopReason, exitCode
 * from the process; unknown agent never spawns — exitCode 1 + pi's stderr line.
 */
async function runSingleAgent(cwd, dispatch, agents, agentName, task, taskCwd, step, signal, onUpdate, makeDetails) {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none"; // pi: quoted names only (byte-equal)
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { ...EMPTY_USAGE },
      step,
    };
  }

  const args = ["--work-dir", taskCwd ?? cwd];
  const model = agent.model ?? (dispatch.modelId ? `${dispatch.providerId}/${dispatch.modelId}` : dispatch.providerId);
  if (model) args.push("--model", model);
  // Forward the parent's provider explicitly: the child must NEVER silently fall
  // back to settings.defaultProvider when the parent has set one.
  if (!agent.model && dispatch.providerId) args.push("--provider", dispatch.providerId);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir = null;
  let tmpPromptPath = null;

  const currentResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { ...EMPTY_USAGE },
    model,
    step,
  };

  // pi's emitUpdate (examples/extensions/subagent/index.ts:324-330) — the streaming
  // partial to the parent: the final output so far (or "(running...)") + the details
  // envelope wrapping the SAME mutable currentResult (the parent's screen re-renders
  // the collapsed form from it while the bg stays pending — row 5).
  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }
    args.push(`Task: ${task}`);

    let wasAborted = false;
    const workerPath = join(projectRoot(), "src", "worker.js");
    const exitCode = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [workerPath, ...args], {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      emitUpdate(); // r2 (Fix 2): the initial child-start update — pi's json-mode child emits a `message_end` for the user prompt, which fires the FIRST emitUpdate on the still-empty currentResult (the pending block shows pi's 3-line skeleton: `✓ agent (source)` / `(no output)` / model-only usage). Our worker's first stdout line is a `session` event, so the equivalent moment is right here, right after the spawn: the SAME emitUpdate shape, makeDetails([currentResult]) with the initial empty result. No-op in parallel/chain (onUpdate undefined — row 14) and in the unknown-agent early return (no spawn).
      let buffer = "";
      const processLine = (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          currentResult.messages.push(msg);
          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate(); // pi: every child message_end (assistant accumulation above) → a partial
        }
        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message);
          emitUpdate(); // pi: every child tool_result_end → a partial
        }
      };
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath) {
      try {
        rmSync(tmpPromptPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        rmSync(tmpPromptDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Map-like concurrency limiter, pi's MAX_CONCURRENCY (4). */
async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The subagent tool definition (pi's name/description/parameters/execute
 *  contract, the fetch contract's envelope). `cwd` is the parent working
 *  dir subagent tokens resolve against, and the default work dir of the spawned
 *  workers. */
export async function createSubagentTool(cwd) {
  const Type = await typeboxType();
  const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  });
  const AgentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
    description: 'Which agent directories to use: "user" (~/.Observation_only/agents — the harness agents home), "project" (the project agents dir mirror), "both" (default: both, the project winning on a name collision)',
  });
  const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
    task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
    chain: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for sequential execution with {previous} placeholder" })),
    agentScope: Type.Optional(AgentScopeSchema),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  });

  return {
    name: "subagent",
    label: "subagent",
    description: "Delegate a task to a subagent with an isolated context: a fresh spawned process runs the harness's own round-1 connection carrying fetch, grep, find and ls, and returns its final answer. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Agents come from the agent dirs (user scope ~/.Observation_only/agents — the harness's own agents home — and the project agents dir mirror; agentScope \"both\" by default).",
    promptSnippet: "Delegate a task to a subagent (fetch, grep, find, ls)",
    promptGuidelines: ["Use subagent to spawn an agent that reads files (fetch), lists folders (ls), searches file contents (grep), finds files by glob (find), and fetches user-provided HTML links (fetch)."],
    parameters: SubagentParams,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    /** Execute a subagent call; a spawned worker runs OUR OWN round-1 connection
     *  with the observation tools (fetch + grep/find/ls) and its final answer is
     *  returned here, the normal flow. */
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope = params.agentScope ?? "both";
      const { agents, projectAgentsDir } = discoverAgents(agentScope);
      const dispatch = { providerId: ctx?.providerId ?? ctx?.model?.provider, modelId: ctx?.modelId ?? ctx?.model?.id, model: ctx?.model };
      const makeDetails = (mode) => (results) => ({ mode, agentScope, projectAgentsDir, results });

      const hasChain = Boolean(params.chain?.length);
      const hasTasks = Boolean(params.tasks?.length);
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return { content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }], details: makeDetails("single")([]) };
      }

      // Round 10: record what the spawned worker(s) are handed — the ctrl+o
      // context. Only agents that EXIST get spawned; an unknown agent never spawns
      // (returns exitCode 1 before any process), so its line is NOT recorded and
      // ctrl+o stays on the previous context (or no-op with none).
      const ctxEntry = (name, task, step) => {
        const a = agents.find((x) => x.name === name);
        if (!a) return null;
        return { agent: name, source: a.source, tools: a.tools, systemPrompt: a.systemPrompt, task, cwd: step?.cwd };
      };
      if (hasSingle && ctxEntry(params.agent, params.task)) {
        setLastSubagentContext({ at: Date.now(), mode: "single", entries: [ctxEntry(params.agent, params.task)] });
      } else if (hasChain) {
        setLastSubagentContext({ at: Date.now(), mode: "chain", entries: params.chain.map((t) => ctxEntry(t.agent, t.task, t)).filter(Boolean) });
      } else if (hasTasks) {
        setLastSubagentContext({ at: Date.now(), mode: "parallel", entries: params.tasks.map((t) => ctxEntry(t.agent, t.task, t)).filter(Boolean) });
      }

      if (params.chain && params.chain.length > 0) {
        const results = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const result = await runSingleAgent(cwd, dispatch, agents, step.agent, taskWithContext, step.cwd, i + 1, signal, undefined, undefined); // row 14 ADAPT-defer: chain streaming stays deferred
          results.push(result);
          if (isFailedResult(result)) {
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }], details: makeDetails("chain")(results), isError: true };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return { content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }], details: makeDetails("chain")(results) };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: makeDetails("parallel")([]) };
        }
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, (t) => runSingleAgent(cwd, dispatch, agents, t.agent, t.task, t.cwd, undefined, signal, undefined, undefined)); // row 14 ADAPT-defer: parallel streaming stays deferred
        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r));
          return `### [${r.agent}] ${isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed"}\n\n${output}`;
        });
        return { content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: makeDetails("parallel")(results) };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(cwd, dispatch, agents, params.agent, params.task, params.cwd, undefined, signal, onUpdate, makeDetails("single")); // row 5: single mode streams its partials (parallel/chain = row 14, deferred)
        if (isFailedResult(result)) {
          return { content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }], details: makeDetails("single")([result]), isError: true };
        }
        return { content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }], details: makeDetails("single")([result]) };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return { content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }], details: makeDetails("single")([]) };
    },
  };
}

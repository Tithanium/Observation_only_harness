// src/compaction.js
// PI'S CONTEXT COMPACTION, ported onto the harness's flat transcript (2026-10,
// the "context overflow" fix). Source of truth: pi v0.85+ dist/core/compaction/
// compaction.js + utils.js (pure compaction logic), dist/core/agent-session.js
// (_checkCompaction / _runAutoCompaction / compact / getContextUsage), pi-ai
// dist/utils/overflow.js (isContextOverflow / isRecoverableLength), pi-ai
// dist/compat.js (completeSimple — the standalone summarization call). Ported
// VERBATIM where the shape matches; adapted where the harness differs (below).
//
// ── HOW PI TRIGGERS AUTO-COMPACTION (agent-session.js, analyzed 2026-10) ─────
// Settings (DEFAULT_COMPACTION_SETTINGS, overridable in settings.json "compaction"):
//   enabled: true, reserveTokens: 16384, keepRecentTokens: 20000.
// _checkCompaction(assistantMessage) runs at TWO checkpoints: after EVERY agent
// run (agent_end) and BEFORE the next prompt submission (catches an aborted
// overflow). Guards: settings.enabled, non-aborted, SAME MODEL as the message
// (a stale overflow from a previously switched model must not trigger), and
// message timestamp > the latest compaction entry (a stale pre-compaction usage
// must not retrigger right after a compaction). Then THREE cases:
//   1. OVERFLOW WITH RETRY — isContextOverflow(error-pattern / silent
//      usage.input > window / length-stop zero-output) or isRecoverableLength
//      (stopReason "length" with output below the intended max) on a response
//      that did NOT complete: remove the failed assistant message, compact,
//      retry the turn ONCE (_overflowRecoveryAttempted). A second overflow
//      after the retry → give up with an explicit error.
//   2. OVERFLOW WITHOUT RETRY — a SUCCESSFUL response exceeded the window
//      (silent overflow): compact, keep the completed response.
//   3. THRESHOLD WITHOUT RETRY — contextTokens (the message's own
//      usage.totalTokens, or an estimate for error/zero-usage messages) >
//      contextWindow - reserveTokens: compact, keep the response.
// _runAutoCompaction(reason, willRetry): prepareCompaction → (extension hook) →
// compact() → sessionManager.appendCompaction → REBUILD the agent context from
// the entries (the compaction entry becomes a USER message
// COMPACTION_SUMMARY_PREFIX + summary + SUFFIX; only entries from
// firstKeptEntryId onward are kept) → compaction_end; willRetry → retry the
// interrupted turn once.
//
// ── HOW PI'S /compact WORKS (agent-session.js compact()) ─────────────────────
// Manual path (separate from _checkCompaction): abort the in-flight operation,
// compaction_start reason "manual", prepareCompaction, guards ("Already
// compacted" when the session ends at a compaction; "Nothing to compact
// (session too small)" when there is nothing to summarize), the SAME default
// summarizer (with optional custom instructions), appendCompaction, context
// rebuild, compaction_end. NO auto-retry. The user's transcript shows the
// summary message; the footer's ctx % goes "?" until the next LLM response.
//
// ── ADAPTATIONS TO THIS HARNESS ───────────────────────────────────────────────
// 1. The transcript is a FLAT in-memory messages array (user / assistant /
//    toolResult), not pi's entry tree. The cut-point math is identical over
//    array indices; "never cut at a tool result" is kept (a tool result must
//    follow its tool call). The previous compaction is recognized by the
//    summary message at index 0 (pi: the previous compaction ENTRY); its
//    <read-files> carry-over lives on the message's `compaction` marker (pi:
//    the entry's details).
// 2. After compaction the array is REPLACED IN PLACE (length = 0; push the
//    summary message + the kept slice) — pi's "agent.state.messages =
//    buildSessionContext().messages". The session STORE keeps pi's exact model
//    (a {type:"compaction"} entry with firstKeptEntryId; getMessages()
//    reconstructs the same compaction-aware context — session_store.js).
// 3. The summarization call: pi uses pi-ai completeSimple (cacheRetention
//    "none", retry via retryAssistantCall). The harness client mirrors it with
//    completeSummary (client.js) — one standalone round trip, no tools,
//    maxTokens = min(0.8 * reserveTokens, model.maxTokens) exactly like pi.
//    (Divergence: no transient-drop retry — the harness client has no retry
//    layer anywhere; a failed summary is reported, never half-persisted.)
// 4. File-ops extraction: the harness is OBSERVATION-ONLY — there are no
//    write/edit tools, so <modified-files> is always empty; `fetch` file reads
//    (url = local path) feed <read-files>, carried across recompactions like
//    pi's readFiles.
// 5. Overflow-retry: pi removes the failed assistant message from agent state
//    before compacting; here a FAILED round trip never enters the transcript
//    (client.run throws), so there is nothing to remove — compacting and
//    re-running the SAME client.run IS the "retry the turn once".
// Never prints secrets.

/** pi's COMPACTION_SUMMARY_PREFIX (dist/core/messages.js) — the compacked
 *  history is replayed to the LLM as a USER message carrying the summary. */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
/** pi's COMPACTION_SUMMARY_SUFFIX. */
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** pi's DEFAULT_COMPACTION_SETTINGS (dist/core/compaction/compaction.js). */
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** The effective settings: the dot-folder settings.json "compaction" object
 *  merged over pi's defaults (pi: settingsManager.getCompactionSettings). */
export function getCompactionSettings(settings = {}) {
  const c = settings?.compaction ?? {};
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: typeof c.reserveTokens === "number" ? c.reserveTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: typeof c.keepRecentTokens === "number" ? c.keepRecentTokens : DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}

// ============================================================================
// Token calculation (pi's compaction.js — verbatim semantics)
// ============================================================================
/** pi's calculateContextTokens: native totalTokens when available, else the
 *  component sum. */
export function calculateContextTokens(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg) {
  if (msg.role === "assistant" && "usage" in msg) {
    if (msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage && calculateContextTokens(msg.usage) > 0) {
      return msg.usage;
    }
  }
  return undefined;
}

function getLastAssistantUsageInfo(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

/** pi's estimateContextTokens: the LAST valid assistant usage (the provider's
 *  context size at that round trip) + a chars/4 estimate of the messages after
 *  it. */
export function estimateContextTokens(messages) {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

/** pi's shouldCompact — the threshold rule (the callers gate on settings.enabled). */
export function shouldCompact(contextTokens, contextWindow, settings) {
  return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === "text" && block.text) chars += block.text.length;
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** pi's estimateTokens (chars/4, conservative overestimate). The harness
 *  transcript roles: user / assistant (text + thinking + toolCall) / toolResult
 *  (+ the compaction summary, which is a user message → its text counts). */
export function estimateTokens(message) {
  let chars = 0;
  switch (message?.role) {
    case "user":
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    case "assistant": {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text") chars += block.text.length;
        else if (block?.type === "thinking") chars += block.thinking.length;
        else if (block?.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult":
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    default:
      return 0;
  }
}

// ============================================================================
// Context-overflow detection (pi-ai dist/utils/overflow.js — ported patterns)
// ============================================================================
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/** pi-ai's isContextOverflow — error patterns, silent overflow (usage.input +
 *  cacheRead > window on a successful stop), and the length-stop zero-output
 *  "context filled" signal. */
export function isContextOverflow(message, contextWindow) {
  if (message.stopReason === "error" && message.errorMessage) {
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage));
    if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage))) return true;
  }
  if (contextWindow && message.stopReason === "stop" && message.usage) {
    const inputTokens = message.usage.input + (message.usage.cacheRead ?? 0);
    if (inputTokens > contextWindow) return true;
  }
  if (contextWindow && message.stopReason === "length" && message.usage?.output === 0) {
    const inputTokens = message.usage.input + (message.usage.cacheRead ?? 0);
    if (inputTokens >= contextWindow * 0.99) return true;
  }
  return false;
}

/** The harness client THROWS provider stream errors (client.js _send) — detect
 *  overflow on the thrown error the way pi detects it on the error assistant
 *  message (stopReason "error" + errorMessage patterns). */
export function isContextOverflowError(error, contextWindow) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return false;
  return isContextOverflow(
    { stopReason: "error", errorMessage: error?.message ?? String(error), provider: error?.provider, model: error?.model },
    contextWindow,
  );
}

/** pi-ai's isRecoverableLength — a length stop that ended BELOW the intended
 *  output limit may be context pressure: one bounded compact-and-retry applies. */
export function isRecoverableLength(message, desiredMaxOutput) {
  return message?.stopReason === "length" && desiredMaxOutput > 0 && message.usage?.output !== undefined && message.usage.output < desiredMaxOutput;
}

// ============================================================================
// The compaction summary message (pi's createCompactionSummaryMessage, adapted:
// the flat transcript replays it as a plain USER message — the same LLM payload
// pi's convertToLlm produces for role "compactionSummary")
// ============================================================================
/** Create the summary message that REPLACES the compacted history at the head
 *  of the transcript. `details` ({readFiles, modifiedFiles}) rides on the
 *  `compaction` marker — the harness analog of the session ENTRY's details,
 *  carried into the next compaction's <read-files> like pi does. */
export function createCompactionSummaryMessage(summary, tokensBefore, details) {
  return {
    role: "user",
    content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX }],
    timestamp: Date.now(),
    compaction: { tokensBefore, details: details ?? { readFiles: [], modifiedFiles: [] } },
  };
}

/** Recognize the head summary message (the marker, with the payload prefix as
 *  fallback — a resumed transcript rebuilt from the store carries both). */
export function isCompactionSummaryMessage(m) {
  if (m?.role !== "user") return false;
  if (m.compaction !== undefined) return true;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const text = blocks.find((b) => b?.type === "text")?.text ?? (typeof m.content === "string" ? m.content : "");
  return text.startsWith(COMPACTION_SUMMARY_PREFIX);
}

/** The raw summary text of a head summary message (prefix/suffix stripped). */
export function summaryTextOf(m) {
  const blocks = Array.isArray(m.content) ? m.content : [];
  const text = blocks.find((b) => b?.type === "text")?.text ?? (typeof m.content === "string" ? m.content : "");
  return text
    .replace(new RegExp(`^${escapeRegex(COMPACTION_SUMMARY_PREFIX)}`), "")
    .replace(new RegExp(`${escapeRegex(COMPACTION_SUMMARY_SUFFIX)}$`), "")
    .trim();
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Cut point detection (pi's findCutPoint / findValidCutPoints /
// findTurnStartIndex — verbatim algorithm over the flat array)
// ============================================================================
function isCutPointMessage(message) {
  return message?.role === "user" || message?.role === "assistant"; // never a toolResult
}
function isTurnStartMessage(message) {
  return message?.role === "user";
}

/** Find the cut point that keeps approximately `keepRecentTokens` of the
 *  NEWEST messages: walk backwards accumulating estimated sizes, stop at the
 *  budget, cut at the closest valid cut point at or after it (pi's rule:
 *  prefer keeping the preceding assistant tool call over dropping trailing
 *  tool results alone). A cut on a mid-turn assistant message splits the turn:
 *  its prefix (from the turn's user message) gets its own prefix summary. */
export function findCutPoint(messages, startIndex, endIndex, keepRecentTokens) {
  const cutPoints = [];
  for (let i = startIndex; i < endIndex; i++) {
    if (isCutPointMessage(messages[i])) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const messageTokens = estimateTokens(messages[i]);
    if (messageTokens === 0) continue;
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }
  const startsTurn = isTurnStartMessage(messages[cutIndex]);
  let turnStartIndex = -1;
  if (!startsTurn) {
    for (let i = cutIndex; i >= startIndex; i--) {
      if (isTurnStartMessage(messages[i])) {
        turnStartIndex = i;
        break;
      }
    }
  }
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !startsTurn && turnStartIndex !== -1 };
}

// ============================================================================
// File-ops extraction (pi's utils.js — observation-only: `fetch` file reads
// feed <read-files>; there are NO write/edit tools here)
// ============================================================================
function extractFileOpsFromMessage(message, fileOps) {
  if (message?.role !== "assistant") return;
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type !== "toolCall" || block.name !== "fetch") continue;
    const target = block.arguments?.url;
    if (typeof target !== "string" || /^https?:\/\//i.test(target)) continue; // links are not files
    fileOps.read.add(target);
  }
}

// ============================================================================
// Message serialization (pi's utils.js serializeConversation — verbatim for the
// harness's roles; tool results truncated to 2000 chars for the summarizer)
// ============================================================================
const TOOL_RESULT_MAX_CHARS = 2000;
function truncateForSummary(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}
function contentTextOf(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}
export function serializeConversation(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentTextOf(msg.content);
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const thinkingParts = [];
      const toolCalls = [];
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block?.type === "thinking") thinkingParts.push(block.thinking);
        else if (block?.type === "toolCall") {
          const argsStr = Object.entries(block.arguments ?? {})
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if ((Array.isArray(msg.content) ? msg.content : []).some((block) => block?.type === "text")) {
        parts.push(`[Assistant]: ${contentTextOf(msg.content)}`);
      }
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentTextOf(msg.content);
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// Summarization prompts (pi's compaction.js — VERBATIM)
// ============================================================================
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
[Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the kept recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** pi's getSummarizationFailure — a length stop contains PARTIAL text and must
 *  not become a session checkpoint; an error has no usable output. */
export function getSummarizationFailure(response, label) {
  if (response.stopReason === "error") return `${label} failed: ${response.errorMessage || "Unknown error"}`;
  if (response.stopReason === "length") return `${label} failed: generation hit the token cap and the summary is incomplete`;
  return undefined;
}

function combineUsage(first, second) {
  const out = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    const a = first?.[key];
    const b = second?.[key];
    if (typeof a === "number" || typeof b === "number") out[key] = (a ?? 0) + (b ?? 0);
  }
  if (first?.cost !== undefined || second?.cost !== undefined) out.cost = (first?.cost ?? 0) + (second?.cost ?? 0);
  return out;
}

// ============================================================================
// Preparation (pi's prepareCompaction — adapted to the flat transcript)
// ============================================================================
/** Prepare a compaction of `messages` (the LIVE transcript). Returns undefined
 *  when there is nothing to compact (pi's guards): the session is empty, or it
 *  ends exactly at a compaction (nothing after the head summary), or the cut
 *  leaves no messages to summarize. */
export function prepareCompaction(messages, settings) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  let previousSummary;
  let previousReadFiles = [];
  let boundaryStart = 0;
  if (isCompactionSummaryMessage(messages[0])) {
    previousSummary = summaryTextOf(messages[0]);
    previousReadFiles = Array.isArray(messages[0].compaction?.details?.readFiles) ? messages[0].compaction.details.readFiles : [];
    boundaryStart = 1;
  }
  const boundaryEnd = messages.length;
  if (boundaryEnd === boundaryStart) return undefined; // pi: last entry is a compaction → "Already compacted"
  const tokensBefore = estimateContextTokens(messages).tokens;
  const cutPoint = findCutPoint(messages, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntryIndex = cutPoint.firstKeptEntryIndex;
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = messages.slice(boundaryStart, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn ? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex) : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
  // File ops: carried-over read files (pi: the previous compaction's details) +
  // the fetch file reads in the messages being compacted away.
  const fileOps = { read: new Set(previousReadFiles) };
  for (const msg of messagesToSummarize) extractFileOpsFromMessage(msg, fileOps);
  for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
  const readFiles = [...fileOps.read].sort();
  return {
    firstKeptEntryIndex,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    settings,
    details: { readFiles, modifiedFiles: [] },
  };
}

// ============================================================================
// The compaction itself (pi's compact() — same two-phase summarization, same
// split-turn merge, same <read-files> appendix)
// ============================================================================
/** Generate or update the conversation summary. `summarize` is the caller's
 *  standalone round trip (client.completeSummary): ({promptText, systemPrompt,
 *  maxTokens, signal}) → {text, usage, stopReason, errorMessage}. */
async function generateSummary(currentMessages, { summarize, model, reserveTokens, customInstructions, previousSummary, signal }) {
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model?.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  const conversationText = serializeConversation(currentMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;
  const response = await summarize({ promptText, systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, maxTokens, signal });
  const failure = getSummarizationFailure(response, "Summarization");
  if (failure) throw new Error(failure);
  return { text: response.text, usage: response.usage };
}

async function generateTurnPrefixSummary(messages, { summarize, model, reserveTokens, signal }) {
  const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), model?.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  const promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const response = await summarize({ promptText, systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, maxTokens, signal });
  const failure = getSummarizationFailure(response, "Turn prefix summarization");
  if (failure) throw new Error(failure);
  return { text: response.text, usage: response.usage };
}

/** Run the summarization for a prepared compaction. Returns {summary,
 *  tokensBefore, usage, details}. Throws on failure (nothing is persisted on
 *  a failure — pi's rule: a partial summary must never become a checkpoint). */
export async function compact(preparation, { summarize, model, customInstructions, signal }) {
  let summary;
  let summaryUsage;
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    let historyText = preparation.previousSummary ?? "No prior history.";
    let historyUsage;
    if (preparation.messagesToSummarize.length > 0) {
      const historyResult = await generateSummary(preparation.messagesToSummarize, {
        summarize,
        model,
        reserveTokens: preparation.settings.reserveTokens,
        customInstructions,
        previousSummary: preparation.previousSummary,
        signal,
      });
      historyText = historyResult.text;
      historyUsage = historyResult.usage;
    }
    const turnPrefixResult = await generateTurnPrefixSummary(preparation.turnPrefixMessages, {
      summarize,
      model,
      reserveTokens: preparation.settings.reserveTokens,
      signal,
    });
    // pi's merge
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
    summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
  } else {
    const result = await generateSummary(preparation.messagesToSummarize, {
      summarize,
      model,
      reserveTokens: preparation.settings.reserveTokens,
      customInstructions,
      previousSummary: preparation.previousSummary,
      signal,
    });
    summary = result.text;
    summaryUsage = result.usage;
  }
  summary += formatFileOperations(preparation.details.readFiles, preparation.details.modifiedFiles);
  // firstKeptIndex rides on the result (the apply() caller slices the live
  // transcript at it — pi keeps it on the preparation, which the driver does
  // not thread through the extension-hook seam).
  return { summary, firstKeptIndex: preparation.firstKeptEntryIndex, tokensBefore: preparation.tokensBefore, usage: summaryUsage, details: preparation.details };
}

/** pi's formatFileOperations — the <read-files>/<modified-files> appendix. */
export function formatFileOperations(readFiles, modifiedFiles) {
  const sections = [];
  if (readFiles?.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles?.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Context usage for the footer (pi's agent-session.js getContextUsage —
// post-compaction the last usage reflects the OLD context; unknown → "?")
// ============================================================================
/** The context usage of the LIVE transcript: null percent right after a
 *  compaction (no post-compaction assistant usage yet — the footer shows
 *  `?/<window>`), otherwise the pi-style estimate (last valid assistant usage
 *  + trailing chars/4). */
export function getContextUsage(messages, model, lastCompactionAt) {
  if (!model) return undefined;
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow <= 0) return undefined;
  if (lastCompactionAt) {
    let hasPostCompactionUsage = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant" && m.timestamp > lastCompactionAt && m.stopReason !== "aborted" && m.stopReason !== "error") {
        if (m.usage && calculateContextTokens(m.usage) > 0) {
          hasPostCompactionUsage = true;
          break;
        }
      }
    }
    if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
  }
  const estimate = estimateContextTokens(messages);
  return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

// ============================================================================
// The driver — the session-scoped compaction state machine (pi's
// AgentSession compaction members: _overflowRecoveryAttempted per run,
// auto/manual paths, the context-usage state). Created once per interactive
// session (and once per one-shot run); the CURRENT client/messages/store are
 // passed in at call time (they are re-assigned by /model, /reload, /new,
// /resume, /tree — the closures follow the session's live bindings).
// ============================================================================
export function createCompactionDriver({ getMessages, getStore, settings, output = () => {}, screen = null }) {
  let lastCompactionAt = undefined; // Date.now() of the latest applied compaction (footer "?" state)
  let overflowRetried = false; // pi's _overflowRecoveryAttempted — ONE compact-and-retry per turn

  const enabled = () => getCompactionSettings(settings()).enabled;

  function report(line) {
    // Line mode prints the observation line; chart mode shows it IN the
    // transcript (the summary message renders as a [compaction] row — the
    // interactive session's screenEntriesFor), so no separate print there.
    if (!screen) output(line);
  }

  function fmtTokens(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "?";
    if (n < 1000) return String(Math.round(n));
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
  }

  /** The footer's context-usage state — published ONLY once a compaction has
   *  happened in this session (pi's footer reads session.getContextUsage() in
   *  a compacted session — right after a compaction the percent is null →
   *  `?/<window>` until the next response; before ANY compaction the harness
   *  keeps its historical session-cumulative ctx display, byte-identical). */
  function publishContextUsage(client) {
    if (!client) return;
    client.contextUsage = lastCompactionAt ? getContextUsage(getMessages(), client.model, lastCompactionAt) : undefined;
  }

  /** The summarization round trip — the caller client's completeSummary
   *  (client.js): standalone, no tools, maxTokens + cacheRetention "none",
   *  its usage folded into the session-cumulative totals (pi's footer sums
   *  compaction-entry usage into the session totals). */
  function summarize(client, { promptText, systemPrompt, maxTokens, signal }) {
    return client
      .completeSummary({ systemPrompt, messages: [{ role: "user", content: promptText, timestamp: Date.now() }], maxTokens, signal })
      .then((reply) => ({
        text: (reply?.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(""),
        usage: reply?.usage,
        stopReason: reply?.stopReason,
        errorMessage: reply?.errorMessage,
      }));
  }

  /** The store entry id of the message that will be kept first (pi's
   *  firstKeptEntryId): the in-memory kept slice ↔ the store's context entry
   *  ids are 1:1 (every transcript message is appended to the store as it
   *  enters; the head summary is the exception — it is the compaction ENTRY,
   *  not a message entry). */
  function firstKeptEntryId(messages, firstKeptIndex) {
    const store = getStore?.();
    if (!store?.getContextEntryIds) return undefined;
    const ids = store.getContextEntryIds();
    const base = isCompactionSummaryMessage(messages[0]) ? 1 : 0;
    return ids[firstKeptIndex - base];
  }

  /** Apply a compaction result IN PLACE (pi's agent.state.messages rebuild) +
   *  persist the compaction entry + update the footer state. `firstKeptId` is
   *  the store entry id of the first kept message — computed by the CALLER on
   *  the PRE-mutation transcript (the id mapping is positional over the live
   *  array). */
  function apply(client, messages, result, reason, willRetry, firstKeptId) {
    const kept = messages.slice(result.firstKeptIndex);
    const summaryMessage = createCompactionSummaryMessage(result.summary, result.tokensBefore, result.details);
    messages.length = 0;
    messages.push(summaryMessage, ...kept);
    lastCompactionAt = Date.now();
    getStore?.()?.appendCompaction?.(result.summary, firstKeptId, result.tokensBefore, result.details, result.usage);
    const after = estimateContextTokens(messages).tokens;
    client.contextUsage = getContextUsage(messages, client.model, lastCompactionAt); // pi: "?" until the next response
    report(`context compacted (${reason}${willRetry ? ", retrying turn" : ""}): ${fmtTokens(result.tokensBefore)} → ${fmtTokens(after)} tokens`);
  }

  /** The shared auto path (pi's _runAutoCompaction). Returns the result or
   *  null (nothing to compact / failed after reporting). */
  async function runAuto(client, messages, reason, willRetry, signal) {
    const cfg = getCompactionSettings(settings());
    if (!cfg.enabled) return null;
    const preparation = prepareCompaction(messages, cfg);
    if (!preparation) return null;
    try {
      const result = await compact(preparation, {
        summarize: (opts) => summarize(client, opts),
        model: client.model,
        signal,
      });
      apply(client, messages, result, reason, willRetry, firstKeptEntryId(messages, preparation.firstKeptEntryIndex));
      return result;
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error; // the user interrupted — surface it
      report(`compaction failed (${reason}): ${error?.message ?? error}`);
      return null;
    }
  }

  return {
    /** A turn is starting (driveTurn): reset the once-per-turn recovery flag. */
    beginTurn() {
      overflowRetried = false;
    },

    /** CASE 1 — a round trip THREW a context-overflow error: compact and let
     *  driveTurn re-run the SAME client.run once (pi: remove the failed
     *  message — it never entered the transcript here — compact, retry the
     *  turn once). Returns true when the retry should happen. */
    async handleRunError(client, messages, error, signal) {
      if (!enabled() || overflowRetried) return false;
      const contextWindow = client.model?.contextWindow ?? 0;
      if (!isContextOverflowError(error, contextWindow)) return false;
      overflowRetried = true;
      const done = await runAuto(client, messages, "overflow", true, signal);
      if (!done) {
        // pi: recovery failed after one attempt → the original error stands
        report("context overflow recovery failed after one compact-and-retry attempt — try reducing context or switching to a larger-context model");
        throw error;
      }
      return true;
    },

    /** CASE 1b — a round trip RETURNED a recoverable length stop (truncated
     *  below the intended output limit): compact, re-run once. */
    async handleRecoverableLength(client, messages, reply, signal) {
      if (!enabled() || overflowRetried) return false;
      if (!isRecoverableLength(reply, client.model?.maxTokens ?? 0)) return false;
      overflowRetried = true;
      const done = await runAuto(client, messages, "overflow", true, signal);
      return Boolean(done);
    },

    /** pi's SECOND-overflow give-up line: the retried turn overflowed AGAIN
     *  after the one compact-and-retry — recovery is over, the error stands
     *  (agent-session.js: "Context overflow recovery failed after one
     *  compact-and-retry attempt. Try reducing context or switching to a
     *  larger-context model."). */
    reportRecoveryGaveUp(client, error) {
      if (isContextOverflowError(error, client?.model?.contextWindow ?? 0)) {
        report("context overflow recovery failed after one compact-and-retry attempt — try reducing context or switching to a larger-context model");
      }
    },

    /** After the turn's final reply (pi's agent_end check): CASE 2 (a
     *  successful response exceeded the window — compact, keep it) or CASE 3
     *  (the threshold was crossed — compact, keep it). Never retries. Also
     *  refreshes the footer's context usage (apply() re-publishes after a
     *  compaction with the post-compaction "?" state). */
    async afterTurn(client, messages, reply, signal) {
      publishContextUsage(client);
      if (!enabled() || !client?.model) return;
      const contextWindow = client.model.contextWindow ?? 0;
      if (!contextWindow) return;
      // pi's same-model guard: a message from a different model (a mid-session
      // /model switch) must not trigger overflow compaction for the new model.
      const sameModel = !reply?.provider || reply.provider === client.providerId;
      if (sameModel && isContextOverflow(reply, contextWindow)) {
        await runAuto(client, messages, "overflow", false, signal);
      } else {
        const direct = reply?.usage ? calculateContextTokens(reply.usage) : 0;
        const contextTokens = reply?.stopReason === "error" || direct === 0 ? estimateContextTokens(messages).tokens : direct;
        if (shouldCompact(contextTokens, contextWindow, getCompactionSettings(settings()))) {
          await runAuto(client, messages, "threshold", false, signal);
        }
      }
      publishContextUsage(client);
    },

    /** Re-publish the footer's context-usage state on the CURRENT client
     *  (after /model / /reload a NEW client object holds the session; after
     *  /resume / /tree the transcript reloaded from the store). */
    refreshContextUsage(client) {
      publishContextUsage(client);
    },

    /** PI'S /compact — the manual path: same summarizer, optional custom
     *  instructions, no auto-retry. Returns { result, tokensAfter } or throws
     *  with pi's guard messages ("Already compacted" / "Nothing to compact
     *  (session too small)" / the summarization failure). */
    async compactManual(client, customInstructions) {
      const messages = getMessages();
      if (!Array.isArray(messages) || messages.length === 0) throw new Error("Nothing to compact (session too small)");
      const cfg = getCompactionSettings(settings());
      const preparation = prepareCompaction(messages, cfg);
      if (!preparation) {
        if (isCompactionSummaryMessage(messages[0]) && messages.length === 1) throw new Error("Already compacted");
        throw new Error("Nothing to compact (session too small)");
      }
      const controller = new AbortController();
      const result = await compact(preparation, {
        summarize: (opts) => summarize(client, { ...opts, signal: controller.signal }),
        model: client.model,
        customInstructions,
        signal: controller.signal,
      });
      apply(client, messages, result, "manual", false, firstKeptEntryId(messages, preparation.firstKeptEntryIndex));
      return { result, tokensAfter: estimateContextTokens(messages).tokens };
    },

    /** /new — a fresh transcript: forget the compaction state. */
    resetState() {
      lastCompactionAt = undefined;
      overflowRetried = false;
    },

    /** /resume / /tree — the transcript reloaded from the store: restore the
     *  compaction boundary from the branch (pi: the latest compaction ENTRY on
     *  the active path). */
    adoptStore(store) {
      lastCompactionAt = undefined;
      try {
        const branch = store?.getBranch?.() ?? [];
        for (let i = branch.length - 1; i >= 0; i--) {
          if (branch[i]?.type === "compaction") {
            const t = new Date(branch[i].timestamp ?? 0).getTime();
            if (Number.isFinite(t)) lastCompactionAt = t;
            break;
          }
        }
      } catch {
        /* a broken store leaves no boundary — the footer shows the estimate */
      }
      overflowRetried = false;
    },
  };
}

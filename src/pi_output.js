// src/pi_output.js
// PIECE-3: the pi-parity OUTPUT TIER for the chart — pi's theme colors
// (theme/dark.json encoded like pi's theme.js truecolor: \x1b[38;2;r;g;bm), the
// tool-output truncation pi's truncate.js applies (2000 lines / 50 KB, head-kept
// for tools, full output spilled to a real temp file), and the shared tool-block
// row builders for the tool-execution blocks (pi's tool-execution.js: pending →
// success/error background flip, bold tool name + args, ≤10-line gray preview,
// "… (N more lines, to expand)" dim hint, "Output truncated. Full output:
// <path>"). Ported from pi 0.86.1 sources; the harness renders the SAME bytes pi
// renders for the same situation. Never prints secrets.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

/** The pi theme colors the chart's DIAGNOSTIC rows use — exact ANSI truecolor
 *  encodings of pi's dark.json theme via pi's theme.js (`\x1b[38;2;r;g;bm`). */
export const COLOR = {
  text: "\x1b[38;2;212;212;212m", // text #d4d4d4 — the chart's plain text rows
  error: "\x1b[38;2;204;102;102m", // error #cc6666 — "Error: …" rows and (exit N)
  warning: "\x1b[38;2;255;255;0m", // warning #ffff00 — the truncation line
  success: "\x1b[38;2;181;189;104m", // success #b5bd68 — success accents
  dim: "\x1b[38;2;102;102;102m", // dim #666666 — "(interrupted)" / "… (N more lines, to expand)" hints (pi's theme.dim)
  muted: "\x1b[38;2;128;128;128m", // muted #808080 — tool-output gray (pi's toolOutputColor)
  fgReset: "\x1b[39m", // terminal-colors.js reset-only-foreground
  toolPendingBg: "\x1b[48;2;40;40;50m", // toolPendingBg #282832 — a tool call announced
  toolSuccessBg: "\x1b[48;2;40;50;40m", // toolSuccessBg #283228 — a tool result landed cleanly
  toolErrorBg: "\x1b[48;2;60;40;40m", // toolErrorBg #3c2828 — a tool failed
  bgReset: "\x1b[49m", // terminal-colors.js reset-only-background
};

/** The pi DARK-THEME MARKDOWN + THINKING palette the model answer uses (pi's
 *  Markdown component styles, theme/dark.json + markdown.js): the default answer
 *  text is the theme 'text' color — NOT bold (the answer is upright plain text;
 *  bold belongs to **inline** emphasis only); thinking is the 'thinkingText'
 *  gray in ITALIC (assistant-message.js's thinking Markdown: color thinkingText,
 *  italic); inline code is 'mdCode' (accent), fenced code blocks 'mdCodeBlock'
 *  (green), headings 'mdHeading', list bullets 'mdListBullet' and quotes
 *  'mdQuote' (gray). outputPad=1: every answer line is indented ONE space, and a
 *  blank line precedes each thinking/answer block (the assistant-message
 *  Spacer). */
export const MD_HEADING = "\x1b[38;2;240;198;116m"; // dark.json mdHeading #f0c674
/** mdCode (accent #8abeb7) — inline `code`. */
export const MD_CODE = "\x1b[38;2;138;190;183m";
export const MD_CODE_BLOCK = "\x1b[38;2;181;189;104m"; // dark.json mdCodeBlock green #b5bd68
/** mdQuote / thinkingText gray — blockquotes and the thinking phase. */
export const MD_QUOTE = "\x1b[38;2;128;128;128m";
export const THINKING_COLOR = "\x1b[38;2;128;128;128m"; // assistant-message.js thinkingText #808080
/** The markdown light em/strong/i/code inline styles. */
export const DESC_ON = "\x1b[3m";
export const DESC_OFF = "\x1b[23m";
/** Style ONE bare text line like pi's Markdown (block styles per line, inline
 *  **strong** / *em* / `code` on the fly). Pure — no terminal state leaks. */
export function styleAnswerLine(line, inFence) {
  const s = String(line ?? "");
  if (inFence) return `${MD_CODE_BLOCK}${s}${COLOR.fgReset}`;
  if (/^ {0,3}(#{1,6})\s+/.test(s)) return `${MD_HEADING}${s}${COLOR.fgReset}`; // heading → mdHeading
  if (/^ {0,3}>/.test(s)) return `${MD_QUOTE}${s}${COLOR.fgReset}`; // blockquote → mdQuote
  const bullet = /^ {0,3}([-*+•])(\s+.*)$/.exec(s);
  if (bullet) return `${MD_CODE}${bullet[1]}${COLOR.fgReset}${s.slice(bullet[1].length)}`; // list marker → mdListBullet (accent), text follows plain
  return (
    s
      .replace(/\*\*([^*]+)\*\*/g, "\x1b[1m$1\x1b[22m") // **strong** → bold
      .replace(/`([^`]+)`/g, `${MD_CODE}$1${COLOR.fgReset}`) // `code` → mdCode
      .replace(/\*([^*]+)\*/g, `${DESC_ON}$1${DESC_OFF}`) // *em* → italic
  );
}
/** Wrap a STYLED terminal line at `cols` cells WITHOUT splitting an ANSI code
 *  (the inline styles sit inside the text — a cell-based chunker must keep each
 *  escape run whole; pi's wrapTextWithAnsi). Returns the wrapped styled pieces. */
export function wrapStyled(s, cols) {
  const c = Math.max(1, cols);
  const pieces = [];
  let cur = "";
  let cells = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      const e = s.indexOf("m", i);
      if (e < 0) {
        cur += s.slice(i);
        break;
      }
      cur += s.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (cells + 1 > c && cur) {
      pieces.push(cur);
      cur = "";
      cells = 0;
    }
    cur += s[i];
    cells += 1;
    i += 1;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** The tool-result PREVIEW cap on the chart — how many output lines a block shows
 *  before the "… (N more lines, to expand)" hint (pi's tool-execution toggle). */
export const TOOL_PREVIEW_MAX_LINES = 10;
/** pi's truncate.js limits — applied to tool output before it reaches the chart. */
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

/** pi's truncate.js formatSize: "123B" / "50.0KB" / "1.5MB". */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLinesForCounting(content) {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** pi's truncate.js truncateHead — keep the FIRST lines/bytes that fit, never
 *  partial lines; a first line alone above the byte limit returns empty content
 *  flagged firstLineExceedsLimit (the caller still shows it via the full-output
 *  path). */
export function truncateHead(content, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, firstLineExceedsLimit: false };
  }
  const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
  if (firstLineBytes > maxBytes) {
    return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, firstLineExceedsLimit: true };
  }
  const kept = [];
  let bytes = 0;
  let truncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lb = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + lb > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(lines[i]);
    bytes += lb;
  }
  if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";
  return { content: kept.join("\n"), truncated: true, truncatedBy, totalLines, totalBytes, firstLineExceedsLimit: false };
}

/** The full tool output, spilled to a REAL temp file (visible path the user can
 *  open) — the target of the "Output truncated. Full output: <path>" line. */
let spillSeq = 0;
export function spillFullOutput(text, name) {
  const safe = String(name ?? "tool").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40) || "tool";
  const file = join(tmpdir(), `observation-only-${safe}-${process.pid}-${++spillSeq}.txt`);
  writeFileSync(file, String(text ?? ""), "utf8");
  return file;
}

/** The agent name of a SUBAGENT call — its round-16 one-line vocabulary (`subagent:
 *  <agent>` keeps the agent's name, not the whole spec). The plain tools no longer
 *  use the compact form: their args render pi's structured JSON (structuredArgs). */
export function compactArgs(args) {
  if (args && typeof args === "object") {
    const v = args.agent ?? args.url ?? args.path;
    if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
    return JSON.stringify(args);
  }
  return typeof args === "string" && args ? args : "";
}

/** pi's args in the tool-execution block: `JSON.stringify(args, null, 2)` — the
 *  pretty-printed structured form (tool-execution.js formatToolExecution): a
 *  one-key args object renders as pretty multi-line JSON with the value quoted
 *  (
 *  {
 *    "path": "ten.txt"
 *  }), never the compact `read ten.txt`. */
export function structuredArgs(args) {
  if (args == null) return "";
  const s = JSON.stringify(args, null, 2);
  return typeof s === "string" ? s : "";
}

/** Split ONE plain text row into rows of at most `cols` columns — pi's Text wraps
 *  long lines to the block width (single row when it fits). */
function wrapCell(line, cols) {
  const c = Math.max(1, cols);
  const out = [];
  for (let i = 0; i < String(line).length; i += c) out.push(String(line).slice(i, i + c));
  return out;
}

/** The args rows of the tool-execution block (pi's formatToolExecution: a blank
 *  row after the title, then the pretty JSON, each line its own styled row). */
export function toolArgsRows(e, cols) {
  const rows = [];
  if (e.argsText) {
    rows.push(toolBlockRow("", e, cols));
    for (const l of e.argsText.split("\n")) {
      for (const wl of wrapCell(l, cols)) rows.push(toolBlockRow(`${COLOR.text}${wl}${COLOR.fgReset}`, e, cols));
    }
  }
  return rows;
}

/** The visible length of an ANSI-styled row (everything the chart strips only
 *  counts content cells when padding the full-width background box). */
export function visibleLen(s) {
  // the harness's own codes are all \x1b[<digits>m truecolor/attribute resets
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** ONE tool-execution block row: a FULL-WIDTH background box (pi's Box) — the
 *  content + content-width padding on the block's bg color, reset once. */
export function toolBlockRow(content, e, cols) {
  const bg = e.state === "error" ? COLOR.toolErrorBg : e.state === "success" ? COLOR.toolSuccessBg : COLOR.toolPendingBg;
  return `${bg}${content}${bgResetPad(content, cols)}${COLOR.bgReset}`;
}
function bgResetPad(content, cols) {
  return " ".repeat(Math.max(0, cols - visibleLen(content)));
}

/** The tool-execution block rows (pi's ToolExecutionComponent), fully painted:
 *  `state` = "pending" | "success" | "error" → the block's full-width bg box; the
 *  title row BOLD tool name (+ the subagent result count), the args in pi's
 *  structured JSON rows (JSON.stringify(args, null, 2), see toolArgsRows), the
 *  ≤10-line gray preview, the dim "… (N more lines, to expand)" hint, the
 *  warning-yellow "Output truncated. Full output: <path>" line, the error-red
 *  "(exit N)" (the harness has no bash tool today — pi's bash-execution exit
 *  color, wired for a future one). The SUBAGENT block does NOT use this generic
 *  form: rows 4/6/8/9 replace it with pi's subagent-extension renderers below. */
export function toolBlockRows(e, cols) {
  const rows = [];
  // PIECE-4 (the critic's chart tell): the title is the BARE tool name — no
  // ` (N block(s))` suffix (pi's tool title has no count anywhere; the countTag was
  // removed). The subagent block KEEPS its round-16 collapsed `(N block(s))`
  // one-line vocabulary — the class-2 note recorded it as spec-conformant.
  rows.push(toolBlockRow(`\x1b[1m${e.titlePrefix}${e.name}\x1b[22m${COLOR.text}${COLOR.fgReset}`, e, cols));
  rows.push(...toolArgsRows(e, cols));
  for (const l of e.preview) rows.push(toolBlockRow(`${COLOR.muted}${l}${COLOR.fgReset}`, e, cols));
  // PIECE-4 (the critic's chart tell): the expand hint carries THE KEY — pi's BYTE
  // EXACT shape (tool-execution.js:93-105): `theme.fg("muted", "..", ...)
  // (${n} more lines,")` + a PLAIN space + `keyHint("app.tools.expand", "to
  // expand")` (`keybinding-hints.js`: theme.fg("dim", keyText) + theme.fg("muted",
  // " to expand")) + `theme.fg("muted", ")")`. The harness's expand key IS
  // ctrl+o (the chart header's `[ctrl+o] expand/collapse …`).
  if (e.hiddenLines > 0)
    rows.push(toolBlockRow(`${COLOR.muted}... (${e.hiddenLines} more lines,${COLOR.fgReset} ${COLOR.dim}ctrl+o${COLOR.fgReset}${COLOR.muted} to expand${COLOR.fgReset}${COLOR.muted})${COLOR.fgReset}`, e, cols));
  if (e.truncatedPath) rows.push(toolBlockRow(`${COLOR.warning}Output truncated. Full output: ${e.truncatedPath}${COLOR.fgReset}`, e, cols));
  if (e.exitCode != null) rows.push(toolBlockRow(`${COLOR.error}(exit ${e.exitCode})${COLOR.fgReset}`, e, cols));
  return rows;
}

/**
 * PIECE-4 — the SUBAGENT block rows (rows 4/6/8/9 of the piece-4 analysis):
 * a verbatim port of pi's subagent EXTENSION renderers
 * (examples/extensions/subagent/index.ts): renderCall single-mode (el:754-763),
 * renderResult collapsed (el:827-848) + expanded (el:799-825), getDisplayItems
 * (el:206-217), formatUsageStats (el:45-58) + formatTokens (el:35-40),
 * formatToolCall (el:71-120), COLLAPSED_ITEM_COUNT (el:35). The ONLY adaptation
 * (row 9): the expanded final output's Markdown goes through obs's validated
 * answer styler (styleAnswerLine/wrapStyled) — the pi-tui Markdown engine is
 * absent here. Every row is emitted through toolBlockRow so it inherits the
 * block's state bg (pi's Box bg over the whole block; row 17 = decision (a):
 * the shared full-width box structure of the validated read/fetch blocks is
 * kept — no Spacer-above / top-bottom padding rows / left pad).
 */
export const COLLAPSED_ITEM_COUNT = 10; // pi's constant (el:35)

/** pi's theme.fg — `\x1b[38;2;r;g;bm` + text + `\x1b[39m` — with dark.json's
 *  color names mapped onto the codes above (toolTitle=text #d4d4d4, toolOutput=
 *  muted=gray #808080, dim=dimGray #666666, accent #8abeb7 = MD_CODE, warning
 *  #ffff00, error #cc6666, success=green #b5bd68). */
const SUBAGENT_FG = {
  toolTitle: COLOR.text,
  accent: MD_CODE,
  muted: COLOR.muted,
  toolOutput: COLOR.muted,
  dim: COLOR.dim,
  warning: COLOR.warning,
  error: COLOR.error,
  success: COLOR.success,
};
function subagentFg(color, text) {
  return `${SUBAGENT_FG[color] ?? ""}${text}${COLOR.fgReset}`;
}

/** pi's formatTokens (el:35-40) — verbatim. */
function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** pi's formatUsageStats (el:45-58) — verbatim (zero fields omitted): "N turns
 *  ↑in ↓out Rcr Wcw $cost ctx:N model". */
export function formatUsageStats(usage, model) {
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

/** pi's formatToolCall (el:71-120) — verbatim (the obs child's `fetch` has no
 *  pi branch and falls to the default — accent name + dim JSON ≤50 — which IS
 *  pi's own behavior for unknown tool names, row 12). */
export function formatToolCall(toolName, args, themeFg) {
  const shortenPath = (p) => {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  switch (toolName) {
    case "bash": {
      const command = args.command || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = args.file_path || args.path || "...";
      const filePath = shortenPath(rawPath);
      const offset = args.offset;
      const limit = args.limit;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = args.file_path || args.path || "...";
      const filePath = shortenPath(rawPath);
      const content = args.content || "";
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = args.file_path || args.path || "...";
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = args.path || ".";
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = args.pattern || "*";
      const rawPath = args.path || ".";
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = args.pattern || "";
      const rawPath = args.path || ".";
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

/** pi's getFinalOutput (el:196-205) — the last assistant text block of the last
 *  assistant message. */
function getFinalOutput(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/** pi's isFailedResult (el:219-221). */
function isFailedResult(result) {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** pi's getDisplayItems (el:206-217) — the child transcript's display items:
 *  text blocks + toolCall blocks of the assistant messages only. */
function getDisplayItems(messages) {
  const items = [];
  for (const msg of messages ?? []) {
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

/** The subagent block's CALL rows — pi's renderCall single-mode (el:754-763)
 *  verbatim: bold `subagent ` (toolTitle) + accent agent + muted ` [scope]`,
 *  then line 2: 2-space indent + dim task preview (≤60 chars, `...` after).
 *  `scope` = args.agentScope ?? "user" (pi's renderCall, el:724). */
export function subagentCallRows(e, cols) {
  const args = e.args ?? {};
  const scope = args.agentScope ?? "user";
  const agentName = args.agent || "...";
  const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
  let text =
    subagentFg("toolTitle", `\x1b[1msubagent \x1b[22m`) + // theme.fg("toolTitle", theme.bold("subagent "))
    subagentFg("accent", agentName) +
    subagentFg("muted", ` [${scope}]`);
  const lines = [text, `  ${subagentFg("dim", preview)}`];
  const rows = [];
  for (const l of lines) {
    for (const wl of wrapStyled(l, cols)) rows.push(toolBlockRow(wl, e, cols));
  }
  return rows;
}

/** The subagent block's RESULT rows — pi's renderResult single-mode, collapsed
 *  (el:827-848) or expanded (el:799-825), from `e.subagentDetails` (final) or
 *  `e.subagentPartial` (streaming — same rows, the bg stays pending). Rows go
 *  through toolBlockRow so they inherit the state bg. */
export function subagentResultRows(e, cols, { expanded } = {}) {
  const details = e.subagentDetails ?? e.subagentPartial;
  const r = details?.results?.[0];
  if (!r) return [];
  const isError = isFailedResult(r);
  const icon = isError ? subagentFg("error", "✗") : subagentFg("success", "✓");
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);

  const renderDisplayItems = (items, limit) => {
    // pi's renderDisplayItems (el:772-785) — verbatim
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0) text += `${subagentFg("muted", `... ${skipped} earlier items`)}\n`;
    for (const item of toShow) {
      if (item.type === "text") {
        const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
        text += `${subagentFg("toolOutput", preview)}\n`;
      } else {
        text += `${subagentFg("muted", "→ ") + formatToolCall(item.name, item.args, subagentFg)}\n`;
      }
    }
    return text.trimEnd();
  };

  if (!expanded) {
    // pi's collapsed result (el:827-848) — verbatim
    let text = `${icon} ${subagentFg("toolTitle", `\x1b[1m${r.agent}\x1b[22m`)}` + subagentFg("muted", ` (${r.agentSource})`);
    if (isError && r.stopReason) text += ` ${subagentFg("error", `[${r.stopReason}]`)}`;
    if (isError && r.errorMessage) text += `\n${subagentFg("error", `Error: ${r.errorMessage}`)}`;
    else if (displayItems.length === 0) text += `\n${subagentFg("muted", "(no output)")}`;
    else {
      text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
      if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${subagentFg("muted", "(Ctrl+O to expand)")}`;
    }
    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) text += `\n${subagentFg("dim", usageStr)}`;
    const rows = [];
    for (const l of text.split("\n")) {
      for (const wl of wrapStyled(l, cols)) rows.push(toolBlockRow(wl, e, cols));
    }
    return rows;
  }

  // pi's expanded result (el:799-825) — a Container inside the same box:
  // header, [Error], Spacer, ─── Task ─── + dim task, Spacer, ─── Output ───,
  // → toolCall lines, Spacer + Markdown final output, Spacer + dim usage.
  const parts = [];
  let header = `${icon} ${subagentFg("toolTitle", `\x1b[1m${r.agent}\x1b[22m`)}` + subagentFg("muted", ` (${r.agentSource})`);
  if (isError && r.stopReason) header += ` ${subagentFg("error", `[${r.stopReason}]`)}`;
  parts.push(header);
  if (isError && r.errorMessage) parts.push(subagentFg("error", `Error: ${r.errorMessage}`));
  parts.push(""); // Spacer(1) — a blank bg row
  parts.push(subagentFg("muted", "─── Task ───"));
  parts.push(subagentFg("dim", r.task));
  parts.push("");
  parts.push(subagentFg("muted", "─── Output ───"));
  if (displayItems.length === 0 && !finalOutput) {
    parts.push(subagentFg("muted", "(no output)"));
  } else {
    for (const item of displayItems) {
      if (item.type === "toolCall") parts.push(subagentFg("muted", "→ ") + formatToolCall(item.name, item.args, subagentFg));
    }
    if (finalOutput) {
      parts.push("");
      parts.push({ MARKDOWN: finalOutput.trim() }); // row 9 adaptation: obs's validated answer styler
    }
  }
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) {
    parts.push("");
    parts.push(subagentFg("dim", usageStr));
  }
  const rows = [];
  let inFence = false;
  for (const part of parts) {
    if (part && part.MARKDOWN != null) {
      for (const l of String(part.MARKDOWN).split("\n")) {
        const opens = /^\s*```/.test(l);
        const styled = inFence || opens ? `${MD_CODE_BLOCK}${l}${COLOR.fgReset}` : styleAnswerLine(l, false);
        inFence = opens ? !inFence : inFence;
        for (const piece of wrapStyled(styled, cols)) rows.push(toolBlockRow(piece, e, cols));
      }
    } else if (part === "") {
      rows.push(toolBlockRow("", e, cols)); // Spacer(1): pi renders a BLANK full-width bg row
    } else {
      for (const wl of wrapStyled(part, cols)) rows.push(toolBlockRow(wl, e, cols));
    }
  }
  return rows;
}

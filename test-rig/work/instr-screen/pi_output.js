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
import { tmpdir } from "node:os";
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
 *  color, wired for a future one). */
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

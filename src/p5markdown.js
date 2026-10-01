// src/p5markdown.js — PIECE 5 (A2 + element rows): the pi-tui Markdown engine
// ported VERBATIM into the harness's flat row model.
// Source: pi 0.86.1, `@earendil-works/pi-tui/dist` (under
// `…\@earendil-works\pi-coding-agent\node_modules\@earendil-works\pi-tui`):
//   • `components/markdown.js`:
//       - STRICT_STRIKETHROUGH_REGEX + StrictStrikethroughTokenizer (:5-21)
//         VERBATIM (A9 — the strict `~~` inline tokenizer);
//       - trimPartialClosingFences (:123-139) VERBATIM (A19 — the streaming
//         partial-fence anti-flicker trim);
//       - the parser setup (:140-178) — `new Marked()` + the strict tokenizer;
//         the LaTeX extensions (LATEX_MARKDOWN_EXTENSIONS + tokenize*Latex) are
//         EXCLUDED per DROP row A27 (not in the piece-5 feature list; the mock
//         contains no `$`); the `latex`/`latexBlock` render cases are dropped
//         with them;
//       - the `Markdown` class (:179-820) VERBATIM: render (:179-247 — the
//         marked lexer, trimPartialClosingFences, per-token render,
//         wrapTextWithAnsi, leftMargin paddingX + pad-to-width, paddingY),
//         applyDefaultStyle/getDefaultStylePrefix/getStylePrefix
//         (:258-327), renderToken (:329-480 — heading/paragraph/code/list/
//         table/blockquote/hr/html/space), renderInlineTokens (:482-575 —
//         strong/em/codespan/link/del/…), renderList (:588-645),
//         getLongestWordWidth/wrapCellText/renderTable (:646-820).
//   • `utils.js` — the wrap family the engine uses:
//       - extractAnsiCode (:360-399), parseOsc8Hyperlink/formatOsc8Hyperlink/
//         formatOsc8Close/getActiveOsc8Close (:401-443), AnsiCodeTracker
//         (:445-660), updateTrackerFromText + getActiveBackgroundAnsi
//         (:662-690) — the SGR-48;2 background scan the scrollbar cell
//         replacement reuses (spec row B5);
//       - visibleWidth (:208-250, the ANSI-strip / tab-normalize / width-cache
//         form), isPrintableAscii + WIDTH_CACHE_SIZE + widthCache (:126-145,
//         its private deps), cjkBreakRegex (:54);
//       - splitIntoTokensWithAnsi (:693-768), wrapTextWithAnsi (:770-809),
//         wrapSingleLine (:791-859), breakLongWord (:875-943),
//         applyBackgroundToLine (:945-961).
//   • `terminal-image.js`:
//       - isImageLine (:138-146), hyperlink (:518-521) VERBATIM;
//       - getCapabilities — ADAPTED to the win32 branch only (the absent
//         widget is the TUI capability-detection tree): on this machine pi's
//         own code path returns `{ images: null, trueColor: true,
//         hyperlinks: false }` (terminal-image.js:80-83, win32 ⇒ trueColor;
//         the OSC-8 half of the `link` case is dead code here and kept
//         verbatim per spec row A8).
// Import rewiring (the ONLY adaptation, per spec row A2):
//   • `graphemeSegmenter` (pi-tui utils.js:3 shared Intl.Segmenter) → this
//     harness's vendored `GRAPHEMES` (src/visible_width.js — the SAME shared
//     instance expression, already pi-verbatim and already the one the box /
//     slicePromptRows / cursor use);
//   • `graphemeWidth` / `visibleWidth`-core → src/visible_width.js
//     (pi-verbatim vendored);
//   • `marked` → the harness's own `marked@18.0.11` (pi-tui's exact pin —
//     spec §4 dependency note).
// Dependency: `marked@18.0.11` (pi-tui's exact pinned dep, absent before).
import { Marked, Tokenizer } from "marked";
import { GRAPHEMES, graphemeWidth } from "./visible_width.js";

// ---------------------------------------------------------------------------
// utils.js — width cache + printable-ASCII fast path (visibleWidth's private deps)
// ---------------------------------------------------------------------------
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map();
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}
/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str, pos) {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];
  // CSI sequence: ESC [ ... m/G/K/H/J
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j])) j++;
    if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }
  // OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
  // Used for hyperlinks (OSC 8), window titles, etc.
  if (next === "]") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  // APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
  // Used for cursor marker and application-specific commands
  if (next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  return null;
}
/**
 * Calculate the visible width of a string in terminal columns.
 */
function visibleWidth(str) {
  if (str.length === 0) {
    return 0;
  }
  // Fast path: pure ASCII printable
  if (isPrintableAscii(str)) {
    return str.length;
  }
  // Check cache
  const cached = widthCache.get(str);
  if (cached !== undefined) {
    return cached;
  }
  // Normalize: tabs to 3 spaces, strip ANSI escape codes
  let clean = str;
  if (str.includes("\t")) {
    clean = clean.replace(/\t/g, "   ");
  }
  if (clean.includes("\x1b")) {
    // Strip supported ANSI/OSC/APC escape sequences in one pass.
    // This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
    // and APC sequences like CURSOR_MARKER.
    let stripped = "";
    let i = 0;
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += clean[i];
      i++;
    }
    clean = stripped;
  }
  // Calculate width
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(clean)) {
    width += graphemeWidth(segment);
  }
  // Cache result
  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value;
    if (firstKey !== undefined) {
      widthCache.delete(firstKey);
    }
  }
  widthCache.set(str, width);
  return width;
}

// ---------------------------------------------------------------------------
// utils.js — OSC 8 hyperlink parsing (AnsiCodeTracker's private deps)
// ---------------------------------------------------------------------------
function parseOsc8Hyperlink(ansiCode) {
  if (!ansiCode.startsWith("\x1b]8;")) {
    return undefined;
  }
  const terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
  const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
  const separatorIndex = body.indexOf(";");
  if (separatorIndex === -1) {
    return undefined;
  }
  const params = body.slice(0, separatorIndex);
  const url = body.slice(separatorIndex + 1);
  if (!url) {
    return null;
  }
  return { params, url, terminator };
}
function formatOsc8Hyperlink(hyperlink) {
  return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}
function formatOsc8Close(terminator) {
  return `\x1b]8;;${terminator}`;
}
function getActiveOsc8Close(prefix) {
  if (!prefix.includes("\x1b]8;")) {
    return "";
  }
  let activeHyperlink = null;
  let i = 0;
  while (i < prefix.length) {
    const ansi = extractAnsiCode(prefix, i);
    if (ansi) {
      const hyperlink = parseOsc8Hyperlink(ansi.code);
      if (hyperlink !== undefined) {
        activeHyperlink = hyperlink;
      }
      i += ansi.length;
    } else {
      i++;
    }
  }
  return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}
/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
  // Track individual attributes separately so we can reset them specifically
  bold = false;
  dim = false;
  italic = false;
  underline = false;
  blink = false;
  inverse = false;
  hidden = false;
  strikethrough = false;
  fgColor = null; // Stores the full code like "31" or "38;5;240"
  bgColor = null; // Stores the full code like "41" or "48;5;240"
  activeHyperlink = null;
  process(ansiCode) {
    // OSC 8 hyperlink: \x1b]8;;<url>\x1b\\ (open) or \x1b]8;;\x1b\\ (close).
    // Preserve the original terminator because some terminals only make BEL-terminated
    // links clickable. OAuth login URLs use BEL, so reopening wrapped lines with ST
    // made only the first physical line clickable in those terminals.
    const hyperlink = parseOsc8Hyperlink(ansiCode);
    if (hyperlink !== undefined) {
      this.activeHyperlink = hyperlink;
      return;
    }
    if (!ansiCode.endsWith("m")) {
      return;
    }
    // Extract the parameters between \x1b[ and m
    const match = ansiCode.match(/\x1b\[([\d;]*)m/);
    if (!match) return;
    const params = match[1];
    if (params === "" || params === "0") {
      // Full reset
      this.reset();
      return;
    }
    // Parse parameters (can be semicolon-separated)
    const parts = params.split(";");
    let i = 0;
    while (i < parts.length) {
      const code = Number.parseInt(parts[i], 10);
      // Handle 256-color and RGB codes which consume multiple parameters
      if (code === 38 || code === 48) {
        // 38;5;N (256 color fg) or 38;2;R;G;B (RGB fg)
        // 48;5;N (256 color bg) or 48;2;R;G;B (RGB bg)
        if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
          // 256 color: 38;5;N or 48;5;N
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
          if (code === 38) {
            this.fgColor = colorCode;
          } else {
            this.bgColor = colorCode;
          }
          i += 3;
          continue;
        } else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
          // RGB color: 38;2;R;G;B or 48;2;R;G;B
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
          if (code === 38) {
            this.fgColor = colorCode;
          } else {
            this.bgColor = colorCode;
          }
          i += 5;
          continue;
        }
      }
      // Standard SGR codes
      switch (code) {
        case 0:
          this.reset();
          break;
        case 1:
          this.bold = true;
          break;
        case 2:
          this.dim = true;
          break;
        case 3:
          this.italic = true;
          break;
        case 4:
          this.underline = true;
          break;
        case 5:
          this.blink = true;
          break;
        case 7:
          this.inverse = true;
          break;
        case 8:
          this.hidden = true;
          break;
        case 9:
          this.strikethrough = true;
          break;
        case 21:
          this.bold = false;
          break; // Some terminals
        case 22:
          this.bold = false;
          this.dim = false;
          break;
        case 23:
          this.italic = false;
          break;
        case 24:
          this.underline = false;
          break;
        case 25:
          this.blink = false;
          break;
        case 27:
          this.inverse = false;
          break;
        case 28:
          this.hidden = false;
          break;
        case 29:
          this.strikethrough = false;
          break;
        case 39:
          this.fgColor = null;
          break; // Default fg
        case 49:
          this.bgColor = null;
          break; // Default bg
        default:
          // Standard foreground colors 30-37, 90-97
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            this.fgColor = String(code);
          }
          // Standard background colors 40-47, 100-107
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
            this.bgColor = String(code);
          }
          break;
      }
      i++;
    }
  }
  reset() {
    this.bold = false;
    this.dim = false;
    this.italic = false;
    this.underline = false;
    this.blink = false;
    this.inverse = false;
    this.hidden = false;
    this.strikethrough = false;
    this.fgColor = null;
    this.bgColor = null;
    // SGR reset does not affect OSC 8 hyperlink state
  }
  /** Clear all state for reuse. */
  clear() {
    this.reset();
    this.activeHyperlink = null;
  }
  getActiveCodes() {
    const codes = [];
    if (this.bold) codes.push("1");
    if (this.dim) codes.push("2");
    if (this.italic) codes.push("3");
    if (this.underline) codes.push("4");
    if (this.blink) codes.push("5");
    if (this.inverse) codes.push("7");
    if (this.hidden) codes.push("8");
    if (this.strikethrough) codes.push("9");
    if (this.fgColor) codes.push(this.fgColor);
    if (this.bgColor) codes.push(this.bgColor);
    let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
    if (this.activeHyperlink) {
      result += formatOsc8Hyperlink(this.activeHyperlink);
    }
    return result;
  }
  getActiveBackgroundCode() {
    return this.bgColor ? `\x1b[${this.bgColor}m` : "";
  }
  hasActiveCodes() {
    return (
      this.bold ||
      this.dim ||
      this.italic ||
      this.underline ||
      this.blink ||
      this.inverse ||
      this.hidden ||
      this.strikethrough ||
      this.fgColor !== null ||
      this.bgColor !== null ||
      this.activeHyperlink !== null
    );
  }
  /**
   * Get reset codes for attributes that need to be turned off at line end.
   * Underline must be closed to prevent bleeding into padding.
   * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
   * Returns empty string if no attributes need closing.
   */
  getLineEndReset() {
    let result = "";
    if (this.underline) {
      result += "\x1b[24m"; // Underline off only
    }
    if (this.activeHyperlink) {
      result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
    }
    return result;
  }
}
function updateTrackerFromText(text, tracker) {
  let i = 0;
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      tracker.process(ansiResult.code);
      i += ansiResult.length;
    } else {
      i++;
    }
  }
}
/** Return only the background color active at the end of an ANSI-styled string. */
export function getActiveBackgroundAnsi(text) {
  const tracker = new AnsiCodeTracker();
  updateTrackerFromText(text, tracker);
  return tracker.getActiveBackgroundCode();
}

// ---------------------------------------------------------------------------
// utils.js — the ANSI-aware word-wrap family (the engine's wrapTextWithAnsi)
// ---------------------------------------------------------------------------
// pi-tui utils.js:54 VERBATIM — the CJK break opportunity.
const cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text) {
  const tokens = [];
  let current = "";
  let pendingAnsi = ""; // ANSI codes waiting to be attached to next visible content
  let currentKind = null;
  let i = 0;
  const flushCurrent = () => {
    if (!current) {
      return;
    }
    tokens.push(current);
    current = "";
    currentKind = null;
  };
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      // Hold ANSI codes separately - they'll be attached to the next visible char
      pendingAnsi += ansiResult.code;
      i += ansiResult.length;
      continue;
    }
    let end = i;
    while (end < text.length && !extractAnsiCode(text, end)) {
      end++;
    }
    for (const { segment } of GRAPHEMES.segment(text.slice(i, end))) {
      const segmentIsSpace = segment === " ";
      if (!segmentIsSpace && cjkBreakRegex.test(segment)) {
        flushCurrent();
        const token = pendingAnsi + segment;
        pendingAnsi = "";
        tokens.push(token);
        continue;
      }
      const segmentKind = segmentIsSpace ? "space" : "word";
      if (current && currentKind !== segmentKind) {
        flushCurrent();
      }
      // Attach any pending ANSI codes to this visible character
      if (pendingAnsi) {
        current += pendingAnsi;
        pendingAnsi = "";
      }
      currentKind = segmentKind;
      current += segment;
    }
    i = end;
  }
  // Handle any remaining pending ANSI codes (attach to last token)
  if (pendingAnsi) {
    if (current) {
      current += pendingAnsi;
    } else if (tokens.length > 0) {
      tokens[tokens.length - 1] += pendingAnsi;
    } else {
      current = pendingAnsi;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
export function wrapTextWithAnsi(text, width) {
  if (!text) {
    return [""];
  }
  // Handle newlines by processing each line separately
  // Track ANSI state across lines so styles carry over after literal newlines
  const inputLines = text.split(/\r\n|\r|\n/);
  const result = [];
  const tracker = new AnsiCodeTracker();
  for (const inputLine of inputLines) {
    // Prepend active ANSI codes from previous lines (except for first line)
    const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
    const wrappedLines = wrapSingleLine(prefix + inputLine, width);
    for (const wrappedLine of wrappedLines) {
      result.push(wrappedLine);
    }
    // Update tracker with codes from this line for next iteration
    updateTrackerFromText(inputLine, tracker);
  }
  return result.length > 0 ? result : [""];
}
function wrapSingleLine(line, width) {
  if (!line) {
    return [""];
  }
  const visibleLength = visibleWidth(line);
  if (visibleLength <= width) {
    return [line];
  }
  const wrapped = [];
  const tracker = new AnsiCodeTracker();
  const tokens = splitIntoTokensWithAnsi(line);
  let currentLine = "";
  let currentVisibleLength = 0;
  for (const token of tokens) {
    const tokenVisibleLength = visibleWidth(token);
    const isWhitespace = token.trim() === "";
    // Token itself is too long - break it character by character
    if (tokenVisibleLength > width && !isWhitespace) {
      if (currentLine) {
        // Add specific reset for underline only (preserves background)
        const lineEndReset = tracker.getLineEndReset();
        if (lineEndReset) {
          currentLine += lineEndReset;
        }
        wrapped.push(currentLine);
        currentLine = "";
        currentVisibleLength = 0;
      }
      // Break long token - breakLongWord handles its own resets
      const broken = breakLongWord(token, width, tracker);
      for (let i = 0; i < broken.length - 1; i++) {
        wrapped.push(broken[i]);
      }
      currentLine = broken[broken.length - 1];
      currentVisibleLength = visibleWidth(currentLine);
      continue;
    }
    // Check if adding this token would exceed width
    const totalNeeded = currentVisibleLength + tokenVisibleLength;
    if (totalNeeded > width && currentVisibleLength > 0) {
      // Trim trailing whitespace, then add underline reset (not full reset, to preserve background)
      let lineToWrap = currentLine.trimEnd();
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) {
        lineToWrap += lineEndReset;
      }
      wrapped.push(lineToWrap);
      if (isWhitespace) {
        // Don't start new line with whitespace
        currentLine = tracker.getActiveCodes();
        currentVisibleLength = 0;
      } else {
        currentLine = tracker.getActiveCodes() + token;
        currentVisibleLength = tokenVisibleLength;
      }
    } else {
      // Add to current line
      currentLine += token;
      currentVisibleLength += tokenVisibleLength;
    }
    updateTrackerFromText(token, tracker);
  }
  if (currentLine) {
    // No reset at end of final line - let caller handle it
    wrapped.push(currentLine);
  }
  // Trailing whitespace can cause lines to exceed the requested width
  return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}
function breakLongWord(word, width, tracker) {
  const lines = [];
  let currentLine = tracker.getActiveCodes();
  let currentWidth = 0;
  // First, separate ANSI codes from visible content
  // We need to handle ANSI codes specially since they're not graphemes
  let i = 0;
  const segments = [];
  while (i < word.length) {
    const ansiResult = extractAnsiCode(word, i);
    if (ansiResult) {
      segments.push({ type: "ansi", value: ansiResult.code });
      i += ansiResult.length;
    } else {
      // Find the next ANSI code or end of string
      let end = i;
      while (end < word.length) {
        const nextAnsi = extractAnsiCode(word, end);
        if (nextAnsi) break;
        end++;
      }
      // Segment this non-ANSI portion into graphemes
      const textPortion = word.slice(i, end);
      for (const seg of GRAPHEMES.segment(textPortion)) {
        segments.push({ type: "grapheme", value: seg.segment });
      }
      i = end;
    }
  }
  // Now process segments
  for (const seg of segments) {
    if (seg.type === "ansi") {
      currentLine += seg.value;
      tracker.process(seg.value);
      continue;
    }
    const grapheme = seg.value;
    // Skip empty graphemes to avoid issues with string-width calculation
    if (!grapheme) continue;
    const graphemeWidth_ = visibleWidth(grapheme);
    if (currentWidth + graphemeWidth_ > width) {
      // Add specific reset for underline only (preserves background)
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) {
        currentLine += lineEndReset;
      }
      lines.push(currentLine);
      currentLine = tracker.getActiveCodes();
      currentWidth = 0;
    }
    currentLine += grapheme;
    currentWidth += graphemeWidth_;
  }
  if (currentLine) {
    // No reset at end of final segment - caller handles continuation
    lines.push(currentLine);
  }
  return lines.length > 0 ? lines : [""];
}
/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line, width, bgFn) {
  // Calculate padding needed
  const visibleLen = visibleWidth(line);
  const paddingNeeded = Math.max(0, width - visibleLen);
  const padding = " ".repeat(paddingNeeded);
  // Apply background to content + padding
  const withPadding = line + padding;
  return bgFn(withPadding);
}

// ---------------------------------------------------------------------------
// terminal-image.js — isImageLine + hyperlink VERBATIM; getCapabilities reduced
// to the win32 branch (see header).
// ---------------------------------------------------------------------------
const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
function isImageLine(line) {
  // Fast path: sequence at line start (single-row images)
  if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
    return true;
  }
  // Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
  return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}
/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
function hyperlink(text, url) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
/** Win32 capability branch (terminal-image.js:80-83 VERBATIM result): Windows
 *  consoles support truecolor; hyperlinks stay off unless positively detected.
 *  The harness runs win32-only, so this IS the branch pi executes here. */
function getCapabilities() {
  return { images: null, trueColor: true, hyperlinks: false };
}

// ---------------------------------------------------------------------------
// components/markdown.js — the strict ~~ tokenizer (A9)
// ---------------------------------------------------------------------------
const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
class StrictStrikethroughTokenizer extends Tokenizer {
  del(src) {
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) {
      return undefined;
    }
    const text = match[2];
    return {
      type: "del",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  }
}

// ---------------------------------------------------------------------------
// components/markdown.js — trimPartialClosingFences (A19)
// ---------------------------------------------------------------------------
function trimPartialClosingFences(tokens) {
  const token = tokens[tokens.length - 1];
  if (token?.type === "list") {
    trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
    return;
  }
  if (token?.type === "blockquote") {
    trimPartialClosingFences(token.tokens ?? []);
    return;
  }
  if (token?.type !== "code") {
    return;
  }
  // Trim streamed partial closing fences so code blocks do not shrink/flicker
  // when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
  const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
  const lastLine = token.raw.split("\n").pop();
  if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
    return;
  }
  token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}
// Parser setup (markdown.js:170-177): the strict ~~ tokenizer. The LaTeX
// extensions are DROPPED (A27) — no `markdownParser.use({ extensions: [...] })`.
const markdownParser = new Marked();
markdownParser.setOptions({
  tokenizer: new StrictStrikethroughTokenizer(),
});

// ---------------------------------------------------------------------------
// components/markdown.js — the Markdown class (A2), LaTeX cases removed (A27)
// ---------------------------------------------------------------------------
export class Markdown {
  text;
  paddingX; // Left/right padding
  paddingY; // Top/bottom padding
  defaultTextStyle;
  theme;
  options;
  defaultStylePrefix;
  // Cache for rendered output
  cachedText;
  cachedWidth;
  cachedLines;
  constructor(text, paddingX, paddingY, theme, defaultTextStyle, options) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.defaultTextStyle = defaultTextStyle;
    this.options = options ? { ...options } : {};
  }
  setText(text) {
    this.text = text;
    this.invalidate();
  }
  invalidate() {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
  render(width) {
    // Check cache
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // Calculate available width for content (subtract horizontal padding)
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const text = this.options.transform?.(this.text, contentWidth) ?? this.text;
    // Don't render anything if there's no actual text
    if (!text || text.trim() === "") {
      const result = [];
      // Update cache
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = result;
      return result;
    }
    // Replace tabs with 3 spaces for consistent rendering
    const normalizedText = text.replace(/\t/g, "   ");
    // Parse markdown to HTML-like tokens
    const tokens = markdownParser.lexer(normalizedText);
    trimPartialClosingFences(tokens);
    // Convert tokens to styled terminal output
    const renderedLines = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const nextToken = tokens[i + 1];
      const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
      for (const tokenLine of tokenLines) {
        renderedLines.push(tokenLine);
      }
    }
    // Wrap lines (NO padding, NO background yet)
    const wrappedLines = [];
    for (const line of renderedLines) {
      if (isImageLine(line)) {
        wrappedLines.push(line);
      } else {
        for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
          wrappedLines.push(wrappedLine);
        }
      }
    }
    // Add margins and background to each wrapped line
    const leftMargin = " ".repeat(this.paddingX);
    const rightMargin = " ".repeat(this.paddingX);
    const bgFn = this.defaultTextStyle?.bgColor;
    const contentLines = [];
    for (const line of wrappedLines) {
      if (isImageLine(line)) {
        contentLines.push(line);
        continue;
      }
      const lineWithMargins = leftMargin + line + rightMargin;
      if (bgFn) {
        contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
      } else {
        // No background - just pad to width
        const visibleLen = visibleWidth(lineWithMargins);
        const paddingNeeded = Math.max(0, width - visibleLen);
        contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
      }
    }
    // Add top/bottom padding (empty lines)
    const emptyLine = " ".repeat(width);
    const emptyLines = [];
    for (let i = 0; i < this.paddingY; i++) {
      const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
      emptyLines.push(line);
    }
    // Combine top padding, content, and bottom padding
    const result = emptyLines.concat(contentLines, emptyLines);
    // Update cache
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result.length > 0 ? result : [""];
  }
  /**
   * Apply default text style to a string.
   * This is the base styling applied to all text content.
   * NOTE: Background color is NOT applied here - it's applied at the padding stage
   * to ensure it extends to the full line width.
   */
  applyDefaultStyle(text) {
    if (!this.defaultTextStyle) {
      return text;
    }
    let styled = text;
    // Apply foreground color (NOT background - that's applied at padding stage)
    if (this.defaultTextStyle.color) {
      styled = this.defaultTextStyle.color(styled);
    }
    // Apply text decorations using this.theme
    if (this.defaultTextStyle.bold) {
      styled = this.theme.bold(styled);
    }
    if (this.defaultTextStyle.italic) {
      styled = this.theme.italic(styled);
    }
    if (this.defaultTextStyle.strikethrough) {
      styled = this.theme.strikethrough(styled);
    }
    if (this.defaultTextStyle.underline) {
      styled = this.theme.underline(styled);
    }
    return styled;
  }
  getDefaultStylePrefix() {
    if (!this.defaultTextStyle) {
      return "";
    }
    if (this.defaultStylePrefix !== undefined) {
      return this.defaultStylePrefix;
    }
    const sentinel = "\u0000";
    let styled = sentinel;
    if (this.defaultTextStyle.color) {
      styled = this.defaultTextStyle.color(styled);
    }
    if (this.defaultTextStyle.bold) {
      styled = this.theme.bold(styled);
    }
    if (this.defaultTextStyle.italic) {
      styled = this.theme.italic(styled);
    }
    if (this.defaultTextStyle.strikethrough) {
      styled = this.theme.strikethrough(styled);
    }
    if (this.defaultTextStyle.underline) {
      styled = this.theme.underline(styled);
    }
    const sentinelIndex = styled.indexOf(sentinel);
    this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
    return this.defaultStylePrefix;
  }
  getStylePrefix(styleFn) {
    const sentinel = "\u0000";
    const styled = styleFn(sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
  }
  getDefaultInlineStyleContext() {
    return {
      applyText: (text) => this.applyDefaultStyle(text),
      stylePrefix: this.getDefaultStylePrefix(),
    };
  }
  renderToken(token, width, nextTokenType, styleContext) {
    const lines = [];
    switch (token.type) {
      case "heading": {
        const headingLevel = token.depth;
        const headingPrefix = `${"#".repeat(headingLevel)} `;
        // Build a heading-specific style context so inline tokens (codespan, bold, etc.)
        // restore heading styling after their own ANSI resets instead of falling back to
        // the default text style.
        let headingStyleFn;
        if (headingLevel === 1) {
          headingStyleFn = (text) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
        } else {
          headingStyleFn = (text) => this.theme.heading(this.theme.bold(text));
        }
        const headingStyleContext = {
          applyText: headingStyleFn,
          stylePrefix: this.getStylePrefix(headingStyleFn),
        };
        const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
        const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
        lines.push(styledHeading);
        if (nextTokenType && nextTokenType !== "space") {
          lines.push(""); // Add spacing after headings (unless space token follows)
        }
        break;
      }
      case "paragraph": {
        const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
        lines.push(paragraphText);
        // Don't add spacing if next token is space or list
        if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
          lines.push("");
        }
        break;
      }
      case "text":
        lines.push(this.renderInlineTokens([token], styleContext));
        break;
      case "code": {
        const indent = this.theme.codeBlockIndent ?? "  ";
        lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
        if (this.theme.highlightCode) {
          const highlightedLines = this.theme.highlightCode(token.text, token.lang);
          for (const hlLine of highlightedLines) {
            lines.push(`${indent}${hlLine}`);
          }
        } else {
          // Split code by newlines and style each line
          const codeLines = token.text.split("\n");
          for (const codeLine of codeLines) {
            lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
          }
        }
        lines.push(this.theme.codeBlockBorder("```"));
        if (nextTokenType && nextTokenType !== "space") {
          lines.push(""); // Add spacing after code blocks (unless space token follows)
        }
        break;
      }
      case "list": {
        const listLines = this.renderList(token, 0, width, styleContext);
        lines.push(...listLines);
        // Don't add spacing after lists if a space token follows
        // (the space token will handle it)
        break;
      }
      case "table": {
        const tableLines = this.renderTable(token, width, nextTokenType, styleContext);
        lines.push(...tableLines);
        break;
      }
      case "blockquote": {
        const quoteStyle = (text) => this.theme.quote(this.theme.italic(text));
        const quoteStylePrefix = this.getStylePrefix(quoteStyle);
        const applyQuoteStyle = (line) => {
          if (!quoteStylePrefix) {
            return quoteStyle(line);
          }
          const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
          return quoteStyle(lineWithReappliedStyle);
        };
        // Calculate available width for quote content (subtract border "│ " = 2 chars)
        const quoteContentWidth = Math.max(1, width - 2);
        // Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
        // children with renderToken() instead of renderInlineTokens().
        // Default message style should not apply inside blockquotes.
        const quoteInlineStyleContext = {
          applyText: (text) => text,
          stylePrefix: quoteStylePrefix,
        };
        const quoteTokens = token.tokens || [];
        const renderedQuoteLines = [];
        for (let i = 0; i < quoteTokens.length; i++) {
          const quoteToken = quoteTokens[i];
          const nextQuoteToken = quoteTokens[i + 1];
          renderedQuoteLines.push(...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext));
        }
        // Avoid rendering an extra empty quote line before the outer blockquote spacing.
        while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
          renderedQuoteLines.pop();
        }
        for (const quoteLine of renderedQuoteLines) {
          const styledLine = applyQuoteStyle(quoteLine);
          const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
          for (const wrappedLine of wrappedLines) {
            lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
          }
        }
        if (nextTokenType && nextTokenType !== "space") {
          lines.push(""); // Add spacing after blockquotes (unless space token follows)
        }
        break;
      }
      case "hr":
        lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
        if (nextTokenType && nextTokenType !== "space") {
          lines.push(""); // Add spacing after horizontal rules (unless space token follows)
        }
        break;
      case "html":
        // Render HTML as plain text (escaped for terminal)
        if ("raw" in token && typeof token.raw === "string") {
          lines.push(this.applyDefaultStyle(token.raw.trim()));
        }
        break;
      case "space":
        // Space tokens represent blank lines in markdown
        lines.push("");
        break;
      default:
        // Handle any other token types as plain text
        if ("text" in token && typeof token.text === "string") {
          lines.push(token.text);
        }
    }
    return lines;
  }
  renderInlineTokens(tokens, styleContext) {
    let result = "";
    const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
    const { applyText, stylePrefix } = resolvedStyleContext;
    const applyTextWithNewlines = (text) => {
      const segments = text.split("\n");
      return segments.map((segment) => applyText(segment)).join("\n");
    };
    for (const token of tokens) {
      switch (token.type) {
        case "escape":
          result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
          break;
        case "text":
          // Text tokens in list items can have nested tokens for inline formatting
          if (token.tokens && token.tokens.length > 0) {
            result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
          } else {
            result += applyTextWithNewlines(token.text);
          }
          break;
        case "paragraph":
          // Paragraph tokens contain nested inline tokens
          result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          break;
        case "strong": {
          const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.bold(boldContent) + stylePrefix;
          break;
        }
        case "em": {
          const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.italic(italicContent) + stylePrefix;
          break;
        }
        case "codespan":
          result += this.theme.code(token.text) + stylePrefix;
          break;
        case "link": {
          const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          const styledLink = this.theme.link(this.theme.underline(linkText));
          if (getCapabilities().hyperlinks) {
            // OSC 8: render as a clickable hyperlink. The URL is not printed inline,
            // so we always show only the link text regardless of whether it matches href.
            result += hyperlink(styledLink, token.href) + stylePrefix;
          } else {
            // Fallback: print URL in parentheses when text differs from href.
            // Compare raw token.text (not styled) against href for the equality check.
            // For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
            // but href="mailto:foo@bar.com").
            const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
            if (token.text === token.href || token.text === hrefForComparison) {
              result += styledLink + stylePrefix;
            } else {
              result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
            }
          }
          break;
        }
        case "br":
          result += "\n";
          break;
        case "del": {
          const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.strikethrough(delContent) + stylePrefix;
          break;
        }
        case "html":
          // Render inline HTML as plain text
          if ("raw" in token && typeof token.raw === "string") {
            result += applyTextWithNewlines(token.raw);
          }
          break;
        default:
          // Handle any other inline token types as plain text
          if ("text" in token && typeof token.text === "string") {
            result += applyTextWithNewlines(token.text);
          }
      }
    }
    while (stylePrefix && result.endsWith(stylePrefix)) {
      result = result.slice(0, -stylePrefix.length);
    }
    return result;
  }
  getOrderedListMarker(item) {
    const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
    return match ? `${match[1]} ` : undefined;
  }
  getUnorderedListMarker(item) {
    const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
    return match ? `${match[1]} ` : undefined;
  }
  /**
   * Render a list with proper nesting support
   */
  renderList(token, depth, width, styleContext) {
    const lines = [];
    const indent = "    ".repeat(depth);
    // Use the list's start property (defaults to 1 for ordered lists)
    const startNumber = typeof token.start === "number" ? token.start : 1;
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const isLastItem = i === token.items.length - 1;
      const bullet = token.ordered
        ? this.options.preserveOrderedListMarkers
          ? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
          : `${startNumber + i}. `
        : this.options.preserveOrderedListMarkers
          ? (this.getUnorderedListMarker(item) ?? "- ")
          : "- ";
      const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
      const marker = bullet + taskMarker;
      const firstPrefix = indent + this.theme.listBullet(marker);
      const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
      const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
      let renderedAnyLine = false;
      for (const itemToken of item.tokens) {
        if (itemToken.type === "list") {
          lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
          renderedAnyLine = true;
          continue;
        }
        const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
        for (const line of itemLines) {
          for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
            const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
            lines.push(linePrefix + wrappedLine);
            renderedAnyLine = true;
          }
        }
      }
      if (!renderedAnyLine) {
        lines.push(firstPrefix);
      }
      if (token.loose && !isLastItem) {
        lines.push("");
      }
    }
    return lines;
  }
  /**
   * Get the visible width of the longest word in a string.
   */
  getLongestWordWidth(text, maxWidth) {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    let longest = 0;
    for (const word of words) {
      longest = Math.max(longest, visibleWidth(word));
    }
    if (maxWidth === undefined) {
      return longest;
    }
    return Math.min(longest, maxWidth);
  }
  /**
   * Wrap a table cell to fit into a column.
   *
   * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
   * consistently with the rest of the renderer.
   */
  wrapCellText(text, maxWidth, stylePrefix = "") {
    const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
    return lines.map((line, index) => {
      // Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
      const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
      return `${line}${styleReset}${stylePrefix}`;
    });
  }
  /**
   * Render a table with width-aware cell wrapping.
   * Cells that don't fit are wrapped to multiple lines.
   */
  renderTable(token, availableWidth, nextTokenType, styleContext) {
    const lines = [];
    const numCols = token.header.length;
    if (numCols === 0) {
      return lines;
    }
    // Calculate border overhead: "│ " + (n-1) * " │ " + " │"
    // = 2 + (n-1) * 3 + 2 = 3n + 1
    const borderOverhead = 3 * numCols + 1;
    const availableForCells = availableWidth - borderOverhead;
    if (availableForCells < numCols) {
      // Too narrow to render a stable table. Fall back to raw markdown.
      const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
      if (nextTokenType && nextTokenType !== "space") {
        fallbackLines.push("");
      }
      return fallbackLines;
    }
    const maxUnbrokenWordWidth = 30;
    // Calculate natural column widths (what each column needs without constraints)
    const naturalWidths = [];
    const minWordWidths = [];
    for (let i = 0; i < numCols; i++) {
      const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
      naturalWidths[i] = visibleWidth(headerText);
      minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
    }
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
        naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
        minWordWidths[i] = Math.max(minWordWidths[i] || 1, this.getLongestWordWidth(cellText, maxUnbrokenWordWidth));
      }
    }
    let minColumnWidths = minWordWidths;
    let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
    if (minCellsWidth > availableForCells) {
      minColumnWidths = new Array(numCols).fill(1);
      const remaining = availableForCells - numCols;
      if (remaining > 0) {
        const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
        const growth = minWordWidths.map((width) => {
          const weight = Math.max(0, width - 1);
          return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
        });
        for (let i = 0; i < numCols; i++) {
          minColumnWidths[i] += growth[i] ?? 0;
        }
        const allocated = growth.reduce((total, width) => total + width, 0);
        let leftover = remaining - allocated;
        for (let i = 0; leftover > 0 && i < numCols; i++) {
          minColumnWidths[i]++;
          leftover--;
        }
      }
      minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
    }
    // Calculate column widths that fit within available width
    const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
    let columnWidths;
    if (totalNaturalWidth <= availableWidth) {
      // Everything fits naturally
      columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
    } else {
      // Need to shrink columns to fit
      const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
        return total + Math.max(0, width - minColumnWidths[index]);
      }, 0);
      const extraWidth = Math.max(0, availableForCells - minCellsWidth);
      columnWidths = minColumnWidths.map((minWidth, index) => {
        const naturalWidth = naturalWidths[index];
        const minWidthDelta = Math.max(0, naturalWidth - minWidth);
        let grow = 0;
        if (totalGrowPotential > 0) {
          grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
        }
        return minWidth + grow;
      });
      // Adjust for rounding errors - distribute remaining space
      const allocated = columnWidths.reduce((a, b) => a + b, 0);
      let remaining = availableForCells - allocated;
      while (remaining > 0) {
        let grew = false;
        for (let i = 0; i < numCols && remaining > 0; i++) {
          if (columnWidths[i] < naturalWidths[i]) {
            columnWidths[i]++;
            remaining--;
            grew = true;
          }
        }
        if (!grew) {
          break;
        }
      }
    }
    // Render top border
    const topBorderCells = columnWidths.map((w) => "─".repeat(w));
    lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);
    // Render header with wrapping
    const headerCellLines = token.header.map((cell, i) => {
      const text = this.renderInlineTokens(cell.tokens || [], styleContext);
      return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
    });
    const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));
    for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
      const rowParts = headerCellLines.map((cellLines, colIdx) => {
        const text = cellLines[lineIdx] || "";
        const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
        return this.theme.bold(padded);
      });
      lines.push(`│ ${rowParts.join(" │ ")} │`);
    }
    // Render separator
    const separatorCells = columnWidths.map((w) => "─".repeat(w));
    const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
    lines.push(separatorLine);
    // Render rows with wrapping
    for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
      const row = token.rows[rowIndex];
      const rowCellLines = row.map((cell, i) => {
        const text = this.renderInlineTokens(cell.tokens || [], styleContext);
        return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
      });
      const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));
      for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
        const rowParts = rowCellLines.map((cellLines, colIdx) => {
          const text = cellLines[lineIdx] || "";
          return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
        });
        lines.push(`│ ${rowParts.join(" │ ")} │`);
      }
      if (rowIndex < token.rows.length - 1) {
        lines.push(separatorLine);
      }
    }
    // Render bottom border
    const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
    lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);
    if (nextTokenType && nextTokenType !== "space") {
      lines.push(""); // Add spacing after table
    }
    return lines;
  }
}

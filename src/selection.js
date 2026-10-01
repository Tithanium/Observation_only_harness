// src/selection.js — TEXT SELECTION (the goal's select/copy of LLM answers and
// results, mouse drag like pi). PI'S MECHANISM, ported from pi 0.86.1
// `@earendil-works/pi-tui/dist/tui-alt-screen.js` + `dist/utils.js` (the running
// harness at C:\Users\connessn\AppData\Roaming\npm\node_modules\@earendil-works\
// pi-coding-agent\node_modules\@earendil-works\pi-tui\dist).
//
// WHY THIS EXISTS: pi's fullscreen TUI owns the alternate screen — the terminal
// emulator's native selection is unusable there (the screen is repainted
// in place, there is no stable scrollback to select). pi therefore implements
// its OWN mouse selection, documented at pi-tui/README.md:709: "Dragging with
// the primary mouse button selects text and, unless TuiAltScreenOptions.copyOnSelect
// is false, copies it to the clipboard with OSC 52; holding the drag at a scroll
// view's top or bottom edge auto-scrolls and extends the selection into
// off-screen content." and tui.md:326: "primary-button drags select text".
// This module is the SAME mechanism, adapted to this harness's single-scrollview
// chart (screen.js): one transcript document, viewport rows 1..T, pinned dock
// below — so pi's layout/scrollview coordinate mapping collapses to
// "content row + column" directly (pi's getScrollSelectionPoint,
// tui-alt-screen.js:898-915, minus the layout box math).
//
// BEHAVIOR (pi parity, tui-alt-screen.js):
//   • LEFT press on a viewport row → ANCHOR at the pointer (character
//     granularity); a DOUBLE-CLICK (≤500 ms, same row + same word) selects the
//     WHOLE WORD (Intl.Segmenter word granularity, `-`/`/` joiners —
//     tui-alt-screen.js:36-37,953-987); a TRIPLE-CLICK selects the WHOLE LINE
//     (:1051-1052,1067). While a word/line granularity is active, the drag
//     EXTENDS in word/line units from the initial range (:1064-1078).
//   • DRAG (SGR button bit 32) → the focus follows the pointer
//     (:1161-1168); the pointer at the viewport's TOP/BOTTOM row auto-scrolls
//     every 50 ms and keeps extending into off-screen content
//     (:1080-1102,1116-1127).
//   • RELEASE (:1134-1155): a pure click (press + release at ONE point, no
//     drag) is a CLICK — the selection is cleared and the click is handed back
//     to the caller (the harness's frozen click = jump to latest,
//     interactive.js); a real drag → the text is COPIED to the clipboard with
//     OSC 52 (`copyOnSelect` defaults true — :103,1152-1153) and a transient
//     "Copied!" flash is shown (:1236-1245,1425-1437).
//   • RENDER (screen.js's paint, after the scrollbar/jump-label overlays — pi's
//     doRender order: overlays → applySelection → flashes, :1456-1461): the
//     selected cell range of every visible row is wrapped in REVERSE VIDEO
//     (`\x1b[7m` … `\x1b[27m`) with the row's existing SGR codes RE-EMITTED
//     inside the region so the colors survive the inversion (:1314-1328).
//   • TEXT EXTRACTION (:1186-1206): per line — grapheme-aware slice of the
//     column range (sliceByColumn, strict) → stripTerminalSequences (ANSI/OSC/
//     APC removed) → trimEnd → joined with "\n".
//
// The cell-width math reuses src/visible_width.js — PI'S REAL graphemeWidth +
// the SHARED GRAPHEMES segmenter (utils.js:3,148-250 verbatim there). Never
// prints secrets.
import { GRAPHEMES, graphemeWidth, visibleWidth } from "./visible_width.js";

/** pi-tui utils.js:4 VERBATIM — the SHARED word segmenter (the DOUBLE-CLICK
 *  word range runs through it; pi NEVER creates a per-call Intl.Segmenter). */
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** tui-alt-screen.js:34-37 VERBATIM — mirror common terminal word-selection
 *  behavior by keeping paths and kebab-case tokens whole. */
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);
/** tui-alt-screen.js:32 VERBATIM — the double/triple-click window. */
const DOUBLE_CLICK_INTERVAL_MS = 500;
/** tui-alt-screen.js:1101 VERBATIM — the auto-scroll tick cadence. */
const SELECTION_AUTO_SCROLL_MS = 50;

/** pi-tui utils.js:360-399 VERBATIM (the same copy screen.js:124-163 vendors
 *  for its overlay cuts) — the 0-cell ANSI-run scanner every column-aware walk
 *  below uses: an SGR/OSC/APC run is consumed WHOLE (0 columns), so a slice can
 *  never land inside one. */
function extractAnsiCode(str, pos) {
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

/** pi-tui utils.js:259-275 VERBATIM — remove ANSI, OSC, and APC control
 *  sequences while preserving visible text (the clipboard text is the PLAIN
 *  transcript, never escape codes). */
export function stripTerminalSequences(str) {
  if (!str.includes("\x1b")) return str;
  let result = "";
  let i = 0;
  while (i < str.length) {
    const ansi = extractAnsiCode(str, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += str[i];
    i++;
  }
  return result;
}

/** pi-tui utils.js:276-303 VERBATIM — the terminal-cell range occupied by the
 *  grapheme at a visible column (the selection's START edge snaps to a grapheme
 *  start, pi tui-alt-screen.js:1118; its non-boundary END edge extends to the
 *  grapheme end, :1121). Wide graphemes (emoji/CJK, graphemeWidth 2) never
 *  split. */
export function getGraphemeCellRange(line, column) {
  let currentCol = 0;
  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
    for (const { segment } of GRAPHEMES.segment(line.slice(i, textEnd))) {
      const width = graphemeWidth(segment);
      if (width > 0 && column >= currentCol && column < currentCol + width) {
        return { start: currentCol, end: currentCol + width };
      }
      currentCol += width;
    }
    i = textEnd;
  }
  return undefined;
}

/** pi-tui utils.js:1093-1137 VERBATIM (sliceByColumn = sliceWithWidth().text) —
 *  the grapheme-aware column slice: SGR runs are 0 cells (kept whole, emitted
 *  into the result only when they fall inside the range — `pendingAnsi`), text
 *  is counted per grapheme through the SHARED GRAPHEMES/graphemeWidth, and
 *  `strict` refuses to straddle the end column (a wide char never splits). */
export function sliceByColumn(line, startCol, length, strict = false) {
  if (length <= 0) return "";
  const endCol = startCol + length;
  let result = "";
  let currentCol = 0;
  let i = 0;
  let pendingAnsi = "";
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      if (currentCol >= startCol && currentCol < endCol) result += ansi.code;
      else if (currentCol < startCol) pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
    for (const { segment } of GRAPHEMES.segment(line.slice(i, textEnd))) {
      const w = graphemeWidth(segment);
      const inRange = currentCol >= startCol && currentCol < endCol;
      const fits = !strict || currentCol + w <= endCol;
      if (inRange && fits) {
        if (pendingAnsi) {
          result += pendingAnsi;
          pendingAnsi = "";
        }
        result += segment;
      }
      currentCol += w;
      if (currentCol >= endCol) break;
    }
    i = textEnd;
    if (currentCol >= endCol) break;
  }
  return result;
}

/** tui-alt-screen.js:953-987 VERBATIM (the scrollView lookup collapsed to the
 *  passed `line` — this harness has ONE scrollview: the transcript). The
 *  DOUBLE-CLICK word range: the plain (ANSI-stripped) line is segmented with
 *  the shared WORDS segmenter; word-like segments (isWordLike) join across
 *  `-`/`/` joiners (kebab-case tokens and paths stay whole). `end.boundary`
 *  marks the range end EXCLUSIVE (getSelectionColumns, :1121). */
export function getWordSelection(point, line) {
  const plain = stripTerminalSequences(line);
  const segments = [];
  let start = 0;
  for (const segment of WORDS.segment(plain)) {
    const end = start + visibleWidth(segment.segment);
    const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
    segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
    start = end;
  }
  const clickedSegmentIndex = segments.findIndex((s) => point.col >= s.start && point.col < s.end);
  if (clickedSegmentIndex < 0) return undefined;
  const canJoin = (l, r) => l.selectable && r.selectable && (l.joiner || r.joiner);
  let selectionStart = segments[clickedSegmentIndex].start;
  let selectionEnd = segments[clickedSegmentIndex].end;
  for (let i = clickedSegmentIndex; i > 0 && canJoin(segments[i - 1], segments[i]); i--) selectionStart = segments[i - 1].start;
  for (let i = clickedSegmentIndex; i < segments.length - 1 && canJoin(segments[i], segments[i + 1]); i++) selectionEnd = segments[i + 1].end;
  return { start: { ...point, col: selectionStart }, end: { ...point, col: selectionEnd, boundary: true } };
}

/** tui-alt-screen.js:990-995 VERBATIM (same collapse) — the TRIPLE-CLICK line
 *  range: column 0 to the line's full visible width, end EXCLUSIVE. */
export function getLineSelection(point, line) {
  return {
    start: { ...point, col: 0 },
    end: { ...point, col: visibleWidth(stripTerminalSequences(line)), boundary: true },
  };
}

/** tui-alt-screen.js:1112-1125 VERBATIM — the per-row column window of a
 *  selection: on the start row the window OPENS at the grapheme START of
 *  start.col (a press between the two cells of a wide char selects it whole);
 *  on the end row it CLOSes at end.col when the end is a boundary (word/line
 *  range — exclusive) else at the grapheme END of end.col (a character drag
 *  includes the grapheme under the pointer, :1121). */
export function getSelectionColumns(line, row, selection, minColumn = 0, maxColumn = visibleWidth(line)) {
  const lineWidth = visibleWidth(line);
  let start = Math.max(0, minColumn);
  let end = Math.min(lineWidth, maxColumn);
  if (row === selection.start.row) {
    start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
  }
  if (row === selection.end.row) {
    end = selection.end.boundary
      ? Math.min(selection.end.col, lineWidth)
      : (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
  }
  return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
}

/** tui-alt-screen.js:1314-1328 VERBATIM — the REVERSE-VIDEO wrap of one
 *  selected slice: open `\x1b[7m`, re-emit every SGR run (`…m`) INSIDE the
 *  region (so the row's colors keep applying under the inversion — a plain
 *  invert would drop the fg/bg), close `\x1b[27m`. */
export function applySelectionHighlight(text) {
  let result = "\x1b[7m";
  let index = 0;
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (!ansi) {
      result += text[index];
      index += 1;
      continue;
    }
    result += ansi.code;
    if (ansi.code.endsWith("m")) result += "\x1b[7m";
    index += ansi.length;
  }
  return `${result}\x1b[27m`;
}

/** tui-alt-screen.js:1238-1244 — pi's copyTextToClipboard FALLBACK: the OSC 52
 *  clipboard escape (base64 UTF-8, `c` = clipboard). pi prefers an injected
 *  native clipboard when the host provides one (copySelection, :1230-1236) —
 *  this harness injects none, so the OSC 52 write IS the parity path (Windows
 *  Terminal implements OSC 52; the harness never claims success it cannot
 *  verify — same as pi's bare-OSC-52 branch, which flashes "Copied!"
 *  fire-and-forget, :1243-1245). */
export function copyViaOsc52(write, text) {
  write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}

/** The selection state machine (pi's TuiAltScreen selection fields +
 *  handlers, tui-alt-screen.js:76-81,675-683,688-699,1030-1206), collapsed to
 *  this chart's single scrollview. `engine` is the screen.js closure:
 *    contentRows()     → the FULL transcript row list (ANSI, screen.js content())
 *    viewportTop()     → the EFFECTIVE scrollTop (the view() slice start)
 *    viewportHeight()  → the viewport row count (viewHeight())
 *    cols()            → terminal columns
 *    scrollbarVisible()→ the bar column is painted right now (the overflow gate)
 *    scrollByLines(n)  → the harness's ScrollView.scrollBy (returns remaining)
 *    render()          → paint()
 *    write(s)          → the terminal writer
 *  Returns:
 *    press(x, y)  → true when the press LANDED on a viewport row (the gesture
 *                   is owned; the pump must NOT fall through to jump-to-latest)
 *    drag(x, y)   → the motion handler (no-op without an active press — pi
 *                   :1162, an unhandled motion never jumps)
 *    release(x,y) → "click" (a pure click — the pump re-fires jump-to-latest),
 *                   "select" (a drag — the copy ran), or null (no press)
 *    hasSelection(), selectionText()  → the active range / its plain text
 *    applyTo(rows, top) → `rows` (the paint's `next` viewport rows, overlays
 *                   already applied) with the reverse-video highlight — pi's
 *                   applySelection, :1329-1376, no-layout branch
 *    clear(), dispose() → reset / reset + stop the auto-scroll timer
 */
export function createSelection(engine) {
  let anchor = null; // {row, col} content coordinates
  let focus = null; // {row, col, boundary?}
  let granularity = "character"; // "character" | "word" | "line"
  let initialRange = null; // the double/triple-click range the drag extends from
  let lastClick = null; // the click-count clock (row + word range + timestamp)
  let pressActive = false;
  let dragged = false;
  let dragPointer = null; // the last drag (x, y) — the auto-scroll re-targets it
  let autoScrollDirection = 0; // -1 top edge / +1 bottom edge / 0 stopped
  let autoScrollTimer = null;

  /** The viewport's content columns — the bar column (rightmost, painted by
   *  screen.js) is chrome, never selectable (documented deviation from pi's
   *  box-width clamp, tui-alt-screen.js:909: pi's scrollbar cell replaces the
   *  last CONTENT cell, so its range would copy the track glyph). */
  function contentWidth() {
    return Math.max(1, engine.cols() - (engine.scrollbarVisible() ? 1 : 0));
  }
  /** Pointer (x, y terminal cells, 0-based) → content point. `clamp` = the
   *  drag/auto-scroll path (pi's getScrollSelectionPoint clamps the pointer
   *  into the visible range, :903-909); a PRESS outside the viewport returns
   *  null (the dock rows belong to the caller's click handling). */
  function pointAt(x, y, clamp = false) {
    const T = engine.viewportHeight();
    const yy = clamp ? Math.max(0, Math.min(T - 1, y)) : y;
    if (!clamp && (yy < 0 || yy >= T)) return null;
    return {
      row: engine.viewportTop() + yy,
      col: Math.max(0, Math.min(contentWidth() - 1, x)),
    };
  }
  function lineAt(row) {
    return engine.contentRows()[row] ?? "";
  }
  function stopAutoScroll() {
    if (autoScrollTimer) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = null;
    }
    autoScrollDirection = 0;
    dragPointer = null;
  }
  function clear() {
    // pi's clearTextSelection (:688-699), the scrollView field dropped
    stopAutoScroll();
    pressActive = false;
    anchor = null;
    focus = null;
    granularity = "character";
    initialRange = null;
    lastClick = null;
    dragged = false;
  }
  /** tui-alt-screen.js:1030-1046 VERBATIM (the scrollView comparison dropped —
   *  one scrollview). */
  function clickCount(point, word) {
    const now = Date.now();
    const previous = lastClick;
    const count = word &&
      previous &&
      now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
      previous.row === point.row &&
      previous.wordStart === word.start.col &&
      previous.wordEnd === word.end.col
      ? (previous.count % 3) + 1
      : 1;
    lastClick = word
      ? { timestamp: now, count, row: point.row, wordStart: word.start.col, wordEnd: word.end.col }
      : undefined;
    return count;
  }
  /** tui-alt-screen.js:1064-1078 VERBATIM — a word/line-granularity drag keeps
   *  the INITIAL click range fixed and extends in whole word/line units
   *  (a word-double-click drag grows word by word, never character by
   *  character). */
  function updateSelectionFocus(point) {
    if (granularity === "character" || !initialRange) {
      focus = point;
      return;
    }
    const range = granularity === "word" ? getWordSelection(point, lineAt(point.row)) : getLineSelection(point, lineAt(point.row));
    if (!range) return;
    const initial = initialRange;
    const targetBeforeInitial =
      range.start.row < initial.start.row || (range.start.row === initial.start.row && range.start.col < initial.start.col);
    if (targetBeforeInitial) {
      anchor = initial.end;
      focus = range.start;
    } else {
      anchor = initial.start;
      focus = range.end;
    }
  }
  /** tui-alt-screen.js:1080-1102 (the layout box math collapsed: the viewport
   *  IS terminal rows 0..T-1) — the pointer at the TOP row scrolls up, at the
   *  BOTTOM row scrolls down, every 50 ms; the drag keeps extending into the
   *  newly revealed rows. */
  function updateSelectionAutoScroll(x, y) {
    const T = engine.viewportHeight();
    dragPointer = { x, y };
    autoScrollDirection = y <= 0 ? -1 : y >= T - 1 ? 1 : 0;
    if (autoScrollDirection === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimer) return;
    autoScrollTimer = setInterval(autoScrollStep, SELECTION_AUTO_SCROLL_MS);
    if (autoScrollTimer.unref) autoScrollTimer.unref();
  }
  function autoScrollStep() {
    // tui-alt-screen.js:1116-1127 VERBATIM (scrollBy returns the remaining
    // delta — 0 movement at the content edge stops the timer, :1120-1122)
    const pointer = dragPointer;
    const direction = autoScrollDirection;
    if (!pointer || direction === 0 || !anchor) {
      stopAutoScroll();
      return;
    }
    const remaining = engine.scrollByLines(direction);
    if (remaining === direction) {
      stopAutoScroll();
      return;
    }
    const point = pointAt(pointer.x, pointer.y, true);
    if (point) updateSelectionFocus(point);
    engine.render();
  }
  /** tui-alt-screen.js:1112-1125 bounds check (:1105-1110) — same point = no
   *  selection (a press without a drag), anchor/focus ordered start→end. */
  function getSelectionBounds() {
    if (!anchor || !focus) return undefined;
    if (anchor.row === focus.row && anchor.col === focus.col) return undefined;
    const anchorBeforeFocus =
      anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col);
    return anchorBeforeFocus ? { start: anchor, end: focus } : { start: focus, end: anchor };
  }
  /** tui-alt-screen.js:1186-1206 VERBATIM (the scrollContentLines lookup is
   *  this chart's contentRows) — the PLAIN selected text: per row the
   *  grapheme-safe column slice, ANSI stripped, trailing whitespace trimmed,
   *  rows joined with "\n". */
  function selectionText() {
    const selection = getSelectionBounds();
    if (!selection) return undefined;
    const sourceLines = engine.contentRows();
    const lines = [];
    for (let row = selection.start.row; row <= selection.end.row; row++) {
      const line = sourceLines[row] ?? "";
      const columns = getSelectionColumns(line, row, selection);
      lines.push(stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
    }
    const text = lines.join("\n");
    return text.length === 0 ? undefined : text;
  }
  function press(x, y) {
    // tui-alt-screen.js:1156-1178 (the overlay/scrollbar dispatch happens in
    // the pump BEFORE this — the bar column and the picker/dialog are gated
    // there, pi's precedence :739-750)
    const point = pointAt(x, y);
    if (!point) return false;
    stopAutoScroll();
    pressActive = true;
    const word = getWordSelection(point, lineAt(point.row));
    const clickCountHere = clickCount(point, word);
    const range = clickCountHere === 2 ? word : clickCountHere === 3 ? getLineSelection(point, lineAt(point.row)) : undefined;
    granularity = range ? (clickCountHere === 2 ? "word" : "line") : "character";
    initialRange = range;
    anchor = range?.start ?? point;
    focus = range?.end ?? point;
    dragged = false;
    engine.render();
    return true;
  }
  function drag(x, y) {
    // tui-alt-screen.js:1161-1168 VERBATIM
    if (!pressActive || !anchor) return false;
    const point = pointAt(x, y, true);
    if (!point) return false;
    dragged = true;
    lastClick = undefined;
    updateSelectionFocus(point);
    updateSelectionAutoScroll(x, y);
    engine.render();
    return true;
  }
  function release(x, y) {
    // tui-alt-screen.js:1134-1155 (the OSC 8 url click is absent here — the
    // chart renders no links)
    if (!pressActive) return null;
    pressActive = false;
    stopAutoScroll();
    if (!anchor) return null;
    updateSelectionFocus(pointAt(x, y, true));
    const isClick = !dragged && anchor.row === focus.row && anchor.col === focus.col;
    if (isClick) {
      // pi: a pure click on content dispatches the CLICK to the UI and clears
      // the selection (:1143-1150) — the harness's frozen click is the
      // jump-to-latest, so the gesture is handed back to the pump.
      clear();
      engine.render();
      return "click";
    }
    // :1152-1153 — copyOnSelect defaults true (pi :103)
    const text = selectionText();
    if (text) {
      engine.onCopy(text);
      engine.onFlash?.("Copied!");
    }
    engine.render();
    return "select";
  }
  /** tui-alt-screen.js:1329-1376 (no-layout branch) — the reverse-video
   *  highlight of the visible rows `rows` (content rows `top`..`top+rows.length`
   *  -1). Runs AFTER screen.js's scrollbar/jump-label overlays (pi's doRender
   *  order :1456-1461), so the bar cell is untouched: the column window stops
   *  at the content width. */
  function applyTo(rows, top) {
    const selection = getSelectionBounds();
    if (!selection) return rows;
    const maxColumn = contentWidth();
    return rows.map((line, i) => {
      const row = top + i;
      if (row < selection.start.row || row > selection.end.row) return line;
      const lineWidth = visibleWidth(line);
      const columns = getSelectionColumns(line, row, selection, 0, maxColumn);
      if (columns.end <= columns.start) return line;
      const before = sliceByColumn(line, 0, columns.start, true);
      const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
      const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
      return `${before}${applySelectionHighlight(selected)}${after}`;
    });
  }
  return {
    press,
    drag,
    release,
    clear,
    dispose: clear,
    hasSelection: () => getSelectionBounds() !== undefined,
    selectionText,
    applyTo,
  };
}

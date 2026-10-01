#!/usr/bin/env node
// src/interactive.js
// Rounds 10 + 11: the INTERACTIVE session. Launching Observation_only with no
// message on a terminal must NOT print a usage message — it IS the harness:
// the map_folder_walk line, a banner (model, work dir, footer), a prompt for the
// next line, multi-turn interaction through the SAME driveTurn as the one-shot
// path (read + fetch + subagent), the footer after every turn, and the "/"
// commands (evaluated subset) + keyboard shortcuts. One-shot mode (message
// argument or piped stdin) is untouched. Round 10's keyboard shortcuts (the
// HOTKEYS table in src/commands.js): enter submits; up/down recalls history;
// left/right move the cursor; ctrl+o (pi's app.tools.expand) EXPANDS/COLLAPSES
// the last subagent's context (the instructions/context handed to the spawned
// worker, recorded in src/subagent_tool.js; no context → harmless no-op); ctrl+c
// cancels the request in flight (first) and quits (when idle); ctrl+d quits on
// an empty line. ROUND 17: the session STORE (src/session_store.js) — every
// turn's messages (user, assistant with thinking/text/toolCall blocks,
// toolResult, model changes) are auto-saved to
// ~/.Observation_only/sessions/<encoded-work-dir>/; /resume (pi's resume picker
// ported: the current work dir's saved sessions — type to search, ↑/↓ navigate,
// enter resumes the chosen session at its active leaf, esc cancels) and /tree
// (pi's session-tree navigator ported: the conversation as a branch tree with
// the active leaf marked with `• `, ↑/↓ navigate, enter selects — a user
// message branches from its parent with its text placed in the editor, an
// assistant/tool entry continues from that point, esc cancels). The reader
// accepts injected input/output streams so the round-10 suite drives every
// shortcut deterministically on a simulated TTY without a live LLM. Never
// prints secrets.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createClient } from "./client.js";
import { loadProviders } from "./config.js"; // /model selector: the dot-folder models.json providers are the available-models list (pi's model registry)
import { footerLine } from "./footer.js";
import { driveTurn, harnessSystemPrompt, isAbortError, toolsPromptLines } from "./session.js";
import { getLastSubagentContext, subagentContextLines } from "./subagent_tool.js";
import { handleCommand, slashProposalLines, userDotDir } from "./commands.js";
import { discoverSkills } from "./skills.js";
import { discoverAgents } from "./agents.js";
import { extensionCommandsList } from "./extensions.js";
import { COLOR, MD_CODE, MD_HEADING } from "./pi_output.js";
import { fuzzyFilter } from "./fuzzy.js";

/** STEP 3/4/4b shared picker state — the SLASH-DIALOG SELECTION and the KEY-SLOT
 *  latch (both live at module scope: the keypress chain inside createLineReader AND
 *  the key-driven picker both touch the raw shift while real keys arrive):
 *  `dialogOpen` == slash dialog open, `dialogSel` == the selected COMMAND row
 *  index into `slashRows` (slides past the header/hint rows), `slashRows` == the
 *  ACTIVE candidate list the Tab branch completes from (the LIVE filtered list when
 *  one stands — readline has already run HISTORY on the line by keypress time, so
 *  arrows/Tab act on the SNAPSHOT, pi: editor.js:600-604 + autocomplete.js:294-301). */
let dialogOpen = false;
let slashRows = null;
let dialogSel = 0;
let pickerActive = false;
import { drainExtensionPendingSends, extensionHandlerUi, loadExtensions } from "./extensions.js"; // round 20: the dot-folder extensions/ autoload — run at session start, /reload re-runs it (pi's /reload reloads extensions too); round 21: handlers also receive ctx.ui and their pi.sendUserMessage calls queue here

/** The chart entries of the RELOADED conversation (round 17): user messages keep
 *  their between-underscores rendering, thinking stays ITALIC, the answer BOLD —
 *  /new /resume /tree hand these to screen.replaceTranscript. */
function screenEntriesFor(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.type === "thinking" && b.thinking) out.push({ kind: "thinking", text: b.thinking });
      else if (b?.type === "text" && b.text) out.push(m.role === "user" ? { kind: "user", text: b.text } : { kind: "answer", text: b.text });
    }
    if (m.role === "toolResult") out.push({ kind: "plain", text: `toolResult: ${m.toolName ?? "tool"}` });
  }
  return out;
}
import { createSessionStore, listSessions, loadSessionStore } from "./session_store.js";
import { createScreen } from "./screen.js";
import { createWorkingIndicator } from "./working.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** A readline whose next line can be awaited one at a time (the loop asks, the
 *  SIGINT handler keeps working while a turn is in flight). A line received with
 *  no waiter — a piped burst (readline emits every line of one chunk in a single
 *  tick) or type-ahead typed while the model is working — is QUEUED, not
 *  dropped, and handed to the next ask; Ctrl+D / EOF resolves null — both
 *  documented in /hotkeys. `onKeyPress` receives the
 *  decoded keys (round 10: only ctrl+o is acted on — it never touches the
 *  line, and with no subagent context it is a harmless no-op). */
function createLineReader({ input, output, onKeyPress, screen }) {
  const rawInput = input; // the ORIGINAL stream — PIECE-3 (F1/F1b): the BYTE-LEVEL PUMP reads it, strips the mouse packets, dispatches the gestures and forwards ONLY clean bytes; the session keeps the raw `input` for its `input === process.stdin` OS-signal guard
  const isTerminal = Boolean(input.isTTY && output.isTTY);
  // ROUND 22 (PIECE-1): with the CHART the typing line is rendered PI-STYLE (see
  // the PI_TYPING_FRAME block below) — node's readline echo would fight it, so the
  // interface gets a MUTED output (it still decodes keys and emits keypress; the
  // chart's own renderer owns the line bytes). Injected/non-TTY streams never take
  // this path (the round-10/16 suites keep the deterministic readline echo).
  const terminalOut = isTerminal && screen ? Object.create(output, { write: { value: () => true } }) : output;
  // PIECE-3 (F1/F1b): the INPUT FILTER — chart mode (a real TTY with the screen)
  // INTERPOSES a PassThrough between the raw input and readline: every complete
  // SGR mouse packet `\x1b[<b;x;yM/m` is STRIPPED before readline ever sees it
  // (the `0;1;1M`-style residue that used to land in rl.line and get painted by
  // the typing frame is now IMPOSSIBLE), one gesture dispatches ONCE (a click =
  // one scrollToEnd; a wheel notch = one scroll — the paint gate makes a
  // duplicate zero-byte), and a trailing lone \x1b is HELD 60 ms: a continued
  // escape sequence reprocesses as a sequence, an uncontinued one fires
  // app.interrupt (pi's escape) and is forwarded alone (readline swallows it
  // silently). The keypress events surface on the FILTERED stream — every
  // picker/keypress consumer must use `reader.input`, never the raw stream.
  const pump = isTerminal && screen;
  const filtered = pump ? new PassThrough() : null;
  if (filtered) {
    Object.defineProperty(filtered, "isTTY", { value: true, enumerable: true }); // readline's TTY decode path (keypress events) keys on isTTY — the PassThrough presents as the terminal it fronts
    filtered.setRawMode = (v) => rawInput.setRawMode?.(v); // node's readline manages the TERMINAL's raw mode THROUGH the filter (a PassThrough has none of its own)
  }
  const readerInput = filtered ?? input;
  const rl = createInterface({ input: readerInput, output: terminalOut, terminal: isTerminal });
  let firstTypedFrame = true; // ARCHITECT STEP 2 (row ownership + resize): the FRAME-GATE flag is READER-SCOPE — the caller's resize handler re-gates it after a full-screen resize (a block-scoped flag used to throw `firstTypedFrame is not defined` in _refreshSize); rearmPromptGate() (the return below) exposes ONLY the re-gate — the frames keep owning the gate on every other path
  let boxWasActive = false; // ARCHITECT STEP 2 (criterion 2, the multi-line prompt) + STEP 1b (the ghost-row fix): the BOX latch — a WRAPPED prompt (len >= the terminal width) paints through screen.writePromptBox() (the FULL-DOCK repaint — the box GROWS UP, the bars shift, no spilled glyphs), and the FIRST post-collapse single-line frame routes through the SAME repaint so a shorter prompt can never strand an old box row (pi clears every changed row, tui-alt-screen.js:1481-1488)
  if (isTerminal) {
    // The keypress events are emitted on the INPUT stream (the interface does not
    // forward raw keys); the acted-on keys: ctrl+o/alt+o (round 10: pi's
    // app.tools.expand — it never touches the typed line) and — ROUND 18 — a
    // PLAIN "/" typed as the FIRST character: the SLASH-COMMAND PROPOSAL, pi's
    // editor menu the moment "/" opens a command (the readline interface
    // registered its listener BEFORE ours, so rl.line already holds the typed "/"
    // when we run — rl.line === "/" exactly means the line was EMPTY and the "/"
    // just started it; a "/" mid-line ("a/") never triggers; reading continues
    // normally and enter still runs the command).
    // ROUND 22 (PIECE-1) + PIECE-1 PASS-2: the PI-STYLE TYPING FRAMES (chart mode
    // only — a real TTY with the screen: pi-types with the sync burst + a `\r`/gate
    // + the reverse-video block cursor + LITERAL padding FILLING the whole 100-col
    // line + the parked cursor `\x1b[<row>;<park>H` — the template extracted
    // byte-by-byte from pi's raw capture, test-rig/work/pi-typing-reference.txt;
    // the pads 94/94/93/91/92 and the park formula were CALIBRATED against that
    // capture, NOT guessed). The frame bytes: the frame that OPENS a fresh prompt
    // line gates `\x1b[m\x1b[<row>;1H` (pi's post-paint reset — the row-17 'hello'
    // AND the row-25 'hi' captures BOTH open so), every further frame of the same
    // line is a bare `\r` (the previous frame parked the cursor ON the prompt
    // line). ONE frame PER TYPED CHUNK — pi renders once per input chunk
    // ('hello' = 1 frame, '<home>P' = 1 frame), so the renders are COALESCED over
    // the synchronous keypress burst of the chunk.
    // (firstTypedFrame is DECLARED AT READER SCOPE above — the frames still gate it on
    // every path; only a resize re-arms it from the caller, never the frame logic)
    const PI_LINE_CELLS = 100; // pi's typing line FILLS the whole 100-col row: 'n'=1+1+98, 'hello'=5+1+94, 'PhelXlo!'=8+1+91 — the block is an EXTRA cell while the cursor sits at the end (pad = 100 − len − 1), an in-line cell otherwise (pad = 100 − len)
    let renderScheduled = false; // one setImmediate render per synchronous keypress burst = the pi-style ONE FRAME PER CHUNK
    const piTypingFrame = () => {
      if (!screen) return;
      // ARCHITECT STEP 2 (criterion 2): the WRAPPED prompt (len >= the REAL column
      // width — pi's editor starts wrapping when the line reaches the editor width,
      // the box GROWS UP over the transcript) paints through screen.writePromptBox()
      // (the FULL-DOCK repaint — writePromptBox redraws the bars + the writing rows at
      // the box height); the boxWasActive latch (STEP 1b) keeps the first
      // post-collapse single-line frame on the same repaint path — a shorter prompt
      // must repaint the whole dock, never strand an old box row.
      const W = Math.max(40, output.columns ?? 100);
      const len = rl.line.length;
      const cursor = rl.cursor;
      if (len >= W) {
        boxWasActive = true; // the BOX path OWNS the full dock (a subsequent single-line frame must repaint it too — pi clears every changed row)
        screen.setPromptLine(rl.line, cursor);
        screen.writePromptBox();
        firstTypedFrame = true; // the next keystroke re-gates `\x1b[m\x1b[<row>;1H` after a resize/box repaint
        return;
      }
      if (boxWasActive) {
        boxWasActive = false; // STEP 1b: the BOX COLLAPSED — the first single-line frame goes through the SAME full-dock repaint (the old box row + the shifted top bar must erase; the calibrated frame bytes below stay the single-line path)
        screen.setPromptLine(rl.line, cursor);
        screen.writePromptBox();
        firstTypedFrame = true;
      }
      const r = screen.writingRow(); // the WRITING LINE row (INTERIOR — pi's prompt row in this 100x30 pty: 17 for hello; ROW_POS normalization forgives the row number, the SHAPE is the bar)
      const pad = Math.max(0, PI_LINE_CELLS - len - (cursor >= len ? 1 : 0)); // pi's SAME literal pads: 94 (hello@end), 94 (Phello), 93 (PhelXlo), 91 (PhelXlo!), 92 (PhelXlo)
      const at = cursor >= len ? " " : rl.line[cursor];
      const park = 200 - len + (cursor < len ? 1 : 0); // pi's parked cursor column: 195 (hello), 195 (Phello), 194 (PhelXlo), 192 (PhelXlo!), 193 (PhelXlo)
      const body = firstTypedFrame ? `\x1b[m\x1b[${r};1H` : "\r"; // the OPEN frame gates `\x1b[m\x1b[<row>;1H`, every further frame is a bare `\r`
      try {
        const f = `\x1b[?2026h\x1b[?2026l${body}${rl.line.slice(0, cursor)}\x1b[7m${at}\x1b[27m${rl.line.slice(cursor + (cursor < len ? 1 : 0))}${pad > 0 ? " ".repeat(pad) : ""}\x1b[${r};${park}H`;
        output.write(f);
      } catch {
        /* a closed stream must never take a turn down */
      }
      firstTypedFrame = false;
    };
    /** STEP 3 + the 2026-09-28 fuzzy fix: the slash dialog's ACTIVE rows — the
     *  slashProposalLines list narrowed to the typed prefix, sorted by pi's FUZZY
     *  match (src/fuzzy.js, ported from pi-tui/dist/fuzzy.js — autocomplete.js:206-239
     *  filters by the COMMAND NAME; the old includes() kept REGISTRATION order →
     *  "/t" completed to the FIRST `/quit` row; fuzzy ranks `/tree` first — the
     *  "select only the first" complaint). The rows ARE the proposal list: [0] = the
     *  header, the tail = the hint, the COMMAND rows between (pi renders the
     *  autocomplete rows under the editor). A line that left "/" or ZERO matches
     *  → null → the menu CLOSES (pi cancels the menu on zero matches,
     *  editor.js:1978-1979). */
    const slashDialogLines = () => {
      const all = slashProposalLines();
      if (!(rl.line ?? "").startsWith("/")) return null; // the line LEFT "/" → the menu CLOSES (backspace past the slash / readline history)
      const q = rl.line.slice(1).toLowerCase();
      if (!q) return all; // a bare "/" → the FULL proposal
      const matched = fuzzyFilter(all.slice(1, all.length - 1), q, (l) => l.trim().split(/\s+/)[0]); // the FIRST WORD = the command TOKEN (a tab-appended space is token-split away)
      if (matched.length === 0) return null; // zero matches → the MENU CLOSES (pi editor.js:1978-1979)
      return [all[0], ...matched, all[all.length - 1]];
    };
    const closeSlashDialog = () => {
      dialogOpen = false;
      slashRows = null;
      dialogSel = 0;
      if (screen) screen.setDialog(null); // the band closes in the same frame — the dock drops to its natural height
    };
    /** STEP 3/4b: the dialog band + the `> ` SELECTION — the marker rides the ACTIVE
     *  COMMAND row (rows[1 + dialogSel]; the header/hint never carry it). */
    const markSlashRows = (rows) =>
      Array.isArray(rows) ? rows.map((l, i) => (i > 0 && i < rows.length - 1 && i - 1 === dialogSel ? `> ${l}` : l)) : rows;
    /** STEP 3: open / narrow / CLOSE the slash dialog from the CURRENT line — the
     *  typed "/" opens the FULL list, every further key NARROWS (fuzzy-sorted), a
     *  line that left "/" or zero matches CLOSES; an unchanged menu re-paints the
     *  same band (a zero-extra-byte no-op in practice). Line mode (no screen) keeps
     *  the round-18 plain print. */
    const updateSlashDialog = () => {
      if (!screen) {
        // STEP 5d: pi's FILTER in line mode too (the round-18 print was the FULL
        // proposal on EVERY key; pi's editor re-filters on each keystroke,
        // autocomplete.js:203-207 + fuzzyFilter) — the SAME slashDialogLines the
        // chart narrows with: a bare "/" still prints the FULL proposal
        // (byte-identical to round 18), every further key prints ONLY the fuzzy
        // matches, and ZERO matches / a line that left "/" prints NOTHING (pi
        // cancels the menu, editor.js:1978-1979).
        const rows = slashDialogLines();
        if (rows) for (const l of rows) out(l);
        return;
      }
      const rows = slashDialogLines();
      if (rows === null) {
        closeSlashDialog();
        return;
      }
      dialogOpen = true;
      slashRows = rows; // the SNAPSHOT the arrows/Tab complete from (readline already ran HISTORY on the line by keypress time — arrows never re-filter the mutated line, pi editor.js:600-604)
      dialogSel = Math.min(dialogSel, Math.max(0, rows.length - 3)); // clamp the selection into the CURRENT list
      screen.setDialog(markSlashRows(rows));
    };
    const scheduleTypingFrame = () => {
      if (renderScheduled) return; // one render per chunk = pi's one frame per chunk
      renderScheduled = true;
      setImmediate(() => {
        renderScheduled = false;
        piTypingFrame();
      });
    };
    readerInput.on("keypress", (str, key) => {
      if (pickerActive) return; // STEP 4: the PICKER owns the keys while open — its OWN keypress listener (pickByKeys) handles search/arrows/enter/esc; the chain below (commit / typing frame / slash menu / scroll) STEPS ASIDE — probe-verified: ZERO typing frames while a pick is open
      if (screen) {
        // ROUND 22 (PIECE-1): enter = the pi-style COMMIT — the line BLANKS with
        // the reverse block + 98 blanks and the cursor parks at column 200, then the
        // turn runs (the 'line' event); every OTHER key renders the coalesced
        // keystroke frame (pi's input.js line) BEFORE the shortcut handling below.
        if (key?.name === "return") {
          if (dialogOpen) closeSlashDialog(); // STEP 3: ENTER applies + closes the slash menu (pi editor.js:610-618) — the dock drops in the same frame, then the turn runs
          try {
            const r = screen.writingRow();
            const blanks = " ".repeat(98); // pi's commit BLANKS the line: the reverse block + 98 blanks (99 cells) + the cursor parked at column 200 — pi's raw capture's commit frame, byte-exact
            output.write("\x1b[?2026h\x1b[?2026l\x1b[7m\r \x1b[27m" + blanks + "\x1b[" + r + ";200H");
          } catch {
            /* a closed stream must never take a turn down */
          }
          firstTypedFrame = true; // the NEXT keystroke = the fresh-prompt gate frame (`\x1b[m\x1b[<row>;1H` — pi's 'hi' prompt)
          return; // the interface emits 'line' next — the turn (pi's commit flow)
        }
        scheduleTypingFrame();
      }
      if (key?.name === "o" && (key.ctrl || key.alt || key.meta)) onKeyPress?.("expand-subagent"); // ctrl+o (round 10: pi's app.tools.expand) AND alt+o (round 16: THIS harness's expand key — a real terminal's alt+o is the ESC-'o' byte pair, which readline reports as key.meta; injected tests use key.alt) — neither ever touches the typed line
      // ROUND 19: the TRANSCRIPT SCROLL keys, pi's tui.altScreen.* fullscreen
      // keys: pageUp/pageDown (also ctrl+pageUp/ctrl+pageDown) scroll the
      // TRANSCRIPT by a page, home scrolls to the top, end scrolls to the latest:
      else if (key?.name === "pageup") onKeyPress?.("scroll-up"); // pi's tui.altScreen.pageUp (pageUp, ctrl+pageUp) — the readline line is single-line, so the page scrolls the chart's transcript
      else if (key?.name === "pagedown") onKeyPress?.("scroll-down"); // pi's tui.altScreen.pageDown (pageDown, ctrl+pageDown)
      else if (key?.name === "home") onKeyPress?.("scroll-top"); // pi's tui.altScreen.top (home) — while still moving the readline cursor to the line start
      else if (key?.name === "end") onKeyPress?.("scroll-end"); // pi's tui.altScreen.bottom (end) — while still moving the readline cursor to the line end
      // STEP 4b: the TAB key — with the slash dialog open it APPLIES the SELECTED row
      // (`/name ` + a space + close; the CURRENT filtered list when one stands — the
      // SNAPSHOT only when readline's arrow/history already mutated the line; pi
      // autocomplete.js:294-301 turns the selected item into `/name ` in the editor).
      // A BARE tab with NO dialog emits ZERO bytes AND pulls the tab readline
      // inserted back out of the line (a phantom \t must never reach a frame).
      else if (key?.name === "tab") {
        const rows = slashDialogLines() ?? slashRows;
        if (rows && rows.length > 2) {
          const k = Math.min(dialogSel, Math.max(0, rows.length - 3));
          const tok = String(rows[1 + k] ?? "").trim().split(/\s+/)[0]; // the COMMAND TOKEN (the rows render `/name` padded — a tab-appended space is token-split away)
          rl.line = `${tok} `; // `/name ` + a space + close (pi autocomplete.js:294-301)
          rl.cursor = rl.line.length;
          closeSlashDialog();
          return; // tab applied + closed — the next typing frame paints the completed line
        }
        if (rl.line[rl.cursor - 1] === "\t") {
          rl.line = rl.line.slice(0, rl.cursor - 1) + rl.line.slice(rl.cursor);
          rl.cursor = Math.max(0, rl.cursor - 1);
        }
        return; // BARE tab → ZERO bytes + the inserted tab pulled back out
      }
      else if (key?.name === "escape") {
        if (dialogOpen) closeSlashDialog(); // STEP 3: ESC closes the slash menu (pi editor.js:600-604)
        else fireEscape(); // ROUND 19: pi's app.interrupt — ESCAPE ABORTS the in-flight answer (the turn's AbortController → "(interrupted)"); idle escape is ignored (the pickers' own escape handler still cancels them)
      }
      // ROUND 18 + STEP 3: the "/" that STARTS an empty line → the SLASH MENU (pi
      // editor.js:2036-2039 re-filters per keystroke) — chart mode opens it in the
      // DIALOG BAND under the prompt box (screen.setDialog; the typed "/" stays in
      // the line, enter still dispatches); line mode keeps the plain proposal print.
      else if (str === "/" && !key?.ctrl && !key?.alt && !key?.meta && !key?.shift && rl.line === "/") updateSlashDialog();
      else if (dialogOpen && (key?.name === "up" || key?.name === "down")) {
        const n = Math.max(0, (slashRows?.length ?? 0) - 2); // the COMMAND slots (rows[1..len-2] — header + hint excluded)
        if (n > 0) {
          dialogSel = ((dialogSel + (key?.name === "down" ? 1 : -1)) % n + n) % n;
          if (screen) screen.setDialog(markSlashRows(slashRows));
        }
        return; // the arrow MOVED the `> ` selection — the next typing frame paints the line
      }
      else if (dialogOpen) updateSlashDialog(); // STEP 3: an open menu NARROWS on every other key (typing / backspace; a line that left "/" or zero matches closes — pi editor.js:1978-1979)
    });
    // PIECE-3 (F1/F1b): the BYTE-LEVEL PUMP — in chart mode it is the ONLY reader of
    // the raw stream: every complete SGR mouse packet `\x1b[<b;x;yM/m` is STRIPPED
    // (NEVER forwarded — residue becomes impossible), one gesture dispatches once (a
    // press M AND its release m both jump — the scroll paint gate makes the
    // duplicate zero-byte; a wheel notch scrolls a page), an incomplete trailing
    // escape head (`\x1b`, `\x1b[`, `\x1b[<64;` …) is HELD 60 ms — a continued
    // sequence reprocesses as a sequence, an uncontinued lone `\x1b` fires
    // app.interrupt (pi's escape, the held key is forwarded alone — readline
    // swallows it silently), a dead longer head is dropped (a dying partial emits
    // nothing, like pi). Ctrl+C is decoded at the BYTE level too (with a
    // PassThrough input node's readline no longer surfaces \x03 as interface
    // 'SIGINT') — the session's deduped onSigInt runs via onKeyPress("ctrl-c");
    // the \x03 byte is forwarded (harmless) so readline's own key handling still
    // sees it.
    let lastEsc = 0; // escape may surface on BOTH the raw bytes AND the readline keypress track — the clock dedupes one action per press
    function fireEscape() {
      const now = Date.now();
      if (now - lastEsc < 60) return;
      lastEsc = now;
      onKeyPress?.("escape");
    }
    let partialHead = ""; // an incomplete trailing escape/packet head held across chunks
    let headTimer = null;
    function dispatchMouse(mpack) {
      const code = Number(mpack[1]);
      if (code === 64 || code === 65) {
        if (mpack[4] === "M") onKeyPress?.(code === 64 ? "wheel-up" : "wheel-down"); // the press edge only
        return;
      }
      onKeyPress?.("mouse-click"); // any other button — press AND release both jump (the paint gate makes the duplicate zero-byte)
    }
    function pumpBytes(s) {
      let clean = "";
      let i = 0;
      const n = s.length;
      while (i < n) {
        if (s.charCodeAt(i) !== 27) {
          clean += s[i];
          i += 1;
          continue;
        }
        const rest = s.slice(i);
        const mpack = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (mpack) {
          dispatchMouse(mpack);
          i += mpack[0].length;
          continue; // STRIPPED — readline never sees the packet
        }
        const isPlainArrow = rest[1] === "[" && (rest[2] === "A" || rest[2] === "B");
        if (isPlainArrow) {
          if (!pickerActive && !dialogOpen) {
            i += 3;
            continue; // STEP 4b: a PLAIN up/down with NO picker/dialog → the SOFT-WRAP strip (an idle arrow never reaches readline — history never spills into the line); with the slash dialog OR a picker open, the line below FORWARDS it (pi: tui.select.up/down → the list / the `> ` selection, editor.js:600-604)
          }
          clean += "\x1b[" + rest[2];
          i += 3;
          continue; // pickerActive || dialogOpen → the arrow is FORWARDED whole (readline decodes it to the 'up'/'down' keypress BOTH consumers read)
        }
        if (rest.length === 1 || /^\x1b(?:\[(?:\<[0-9;]*|[0-9;]*)?|O)?$/.test(rest)) {
          partialHead = rest; // a lone \x1b OR a possible escape head at the tail → HOLD it for the next chunk
          i = n;
          break;
        }
        if (rest[1] === "[") {
          let j = 2;
          while (j < rest.length && !/[A-Za-z~]/.test(rest[j])) j += 1;
          if (j >= rest.length) {
            partialHead = rest; // a mid-sequence head without its terminator → HOLD
            i = n;
            break;
          }
          clean += rest.slice(0, j + 1); // a complete escape sequence (\x1b[1~, \x1b[11;5D …) → forward it whole
          i += j + 1;
        } else {
          clean += rest.slice(0, 2); // \x1b + one more char (alt+key) → forward
          i += 2;
        }
      }
      if (partialHead) {
        if (headTimer) {
          clearTimeout(headTimer);
          headTimer = null;
        }
        headTimer = setTimeout(() => {
          headTimer = null;
          const h = partialHead;
          partialHead = "";
          if (h === "\x1b") {
            if (pump) filtered.write("\x1b"); // nothing continued the \x1b → forward the lone escape (readline swallows it silently — the pickers' own keypress escape would otherwise never fire)
            fireEscape(); // …and it IS the escape key (pi's app.interrupt)
          }
          // a longer dead head (a split packet / sequence that never completed) is DROPPED — it emits nothing, like pi
        }, 60);
        headTimer.unref?.();
      }
      if (pump && clean) filtered.write(clean); // chart mode: ONLY clean bytes reach readline
      if (s.includes("\x03")) onKeyPress?.("ctrl-c"); // Ctrl+C at the byte level → the session's deduped onSigInt (F3: clean quit / F6: orderly cancel, no `^C` rows)
    }
    rawInput.on("data", (chunk) => {
      let s = String(chunk);
      if (partialHead) {
        s = partialHead + s; // a held head CONTINUED here — reprocess as one byte run (a split packet \x1b | [<64;5;5M still matches)
        partialHead = "";
      }
      pumpBytes(s);
    });
  }
  let waiter = null;
  const queued = []; // lines that arrived with NO waiter pending (round-11 piped-burst fix: keep them, don't let readline's one-tick burst vanish)
  let closed = false;
  rl.on("line", (line) => {
    const w = waiter;
    waiter = null;
    if (w) w(line);
    else queued.push(line); // no waiter → QUEUE (a dropped line silently vanishes, e.g. `/hotkeys` in a piped burst)
  });
  rl.on("close", () => {
    closed = true;
    const w = waiter;
    waiter = null;
    if (w) w(null); // EOF with a pending ask and nothing queued → null
  });
  return {
    rl,
    /** Next line (a queued burst line first), or null on EOF. Prints the prompt (once per ask). */
    ask() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(null); // stream ended with nothing queued → EOF
      return new Promise((resolve) => {
        waiter = resolve;
        rl.prompt();
      });
    },
    close() {
      rl.close();
    },
    /** round 17: drop any readline lines observed while a picker owned the keys
     *  (the keypress handler acted on them — the queued remnant must never leak
     *  into the NEXT turn's ask). */
    drainQueued() {
      queued.length = 0;
    },
    /** PIECE-3 (F1/F1b): the EFFECTIVE input stream — the filtered PassThrough in
     *  chart mode (keypress events + isTTY surface HERE, never the raw stream), the
     *  raw input otherwise (line mode — byte-identical rounds 10/11). */
    input: readerInput,
    /** ARCHITECT STEP 2 + 1b (resize): a resize handler in the caller re-gates the
     *  FRESH-PROMPT frame (`\x1b[m\x1b[<row>;1H`) after a full-screen resize — the
     *  gate flag is READER-SCOPE (block-scoped it threw `firstTypedFrame is not
     *  defined` in _refreshSize); the frames keep owning the gate on every other path. */
    rearmPromptGate() {
      firstTypedFrame = true;
    },
  };
}

// ============================================================================
// Round 17: the PICKERS — /resume (pi's session selector ported) and /tree (pi's
// tree selector ported) share ONE mechanism: the list renders through `out` (the
// interactive line printer — deterministic in the injected suites), keys/search
// come from the input stream. PURE UI — the session store logic lives in
// src/session_store.js. Never prints secrets.

function contentText(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

function entryLabel(e) {
  if (e.type === "model_change") return `model: ${e.provider ?? "?"}/${e.modelId ?? "?"}`;
  if (e.type !== "message") return String(e.type);
  const m = e.message;
  const t = (contentText(m?.content) || "").replace(/\s+/g, " ").trim();
  if (m?.role === "user") return `user: "${t}"`;
  if (m?.role === "assistant") return t ? `assistant: "${t.slice(0, 48)}${t.length > 48 ? "…" : ""}"` : `assistant: (tool call)`;
  if (m?.role === "toolResult") return `tool: ${m.toolName ?? "?"}`;
  return `${m?.role ?? "?"}: "${t.slice(0, 48)}"`;
}

/** The conversation rendered as its BRANCH TREE (pi's tree-selector ported):
 *  connector glyphs (├─ / └─ with │ runs), one row per entry, the ACTIVE LEAF
 *  marked with `\`• ``, user/assistant/tool labels. Deterministic — the rows are
 *  the picker's browse lines AND the suite's inspection surface. */
export function renderTreeLines(store) {
  const entries = store.getEntries();
  if (entries.length === 0) return [];
  const children = new Map();
  for (const e of entries) {
    const key = e.parentId ?? "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(e);
  }
  const leafId = store.leafId();
  const roots = children.get("")?.length ? children.get("") : [entries[0]];
  const rows = [];
  const walk = (list, prefix) => {
    list.forEach((e, i) => {
      const last = i === list.length - 1;
      const row = `${e.id === leafId ? "• " : "  "}${prefix}${last ? "└─ " : "├─ "}${entryLabel(e)}`; // `• ` marks the ACTIVE LEAF
      rows.push(row);
      const kids = children.get(e.id);
      if (kids?.length) walk(kids, prefix + (last ? "   " : "│  "));
    });
  };
  walk(roots, "");
  return rows;
}

/** The picker engine. `items` is the browse list ({ id, line } — for /tree the
 *  lines already carry the `• ` active-leaf marker); `out` renders; keys/search
 *  come from the input. Returns { promise, cancel }: the promise resolves to the
 *  picked item or null (esc / Ctrl+C / empty line / EOF); cancel() forces null
 *  (Ctrl+C on the interface surfaces as SIGINT — the session defers to the
 *  picker, which cannot leave the loop hanging). */
function runPicker({ reader, input, out, title, items, screen, startIndex = 0, initialQuery = "" }) {
  const state = { cancelled: false };
  const promise = (pickerActive = true, input.isTTY ? pickByKeys(input, out, title, items, state, screen, startIndex, initialQuery) : pickByLines(reader, out, title, items, state, initialQuery)); // STEP 4: the PICKER OWNS the keys while open — the latch steps the reader chain aside (no commit/typing frames) and the pump FORWARDS ↑/↓ (tabs flow); released when the pick settles
  const wrapped = promise.finally(() => { pickerActive = false; });
  return { promise: wrapped, cancel: () => (state.cancelled = true) };
}

/** Key-driven picker (real terminal AND injected TTYs — the injected suite emits
 *  keypress on the input stream, exact round-10/16 pattern): type to search,
 *  ↑/↓ move, enter selects, esc / Ctrl+C cancels. STEP 4 (CHART mode, screen):
 *  the picker renders in the DIALOG BAND under the prompt box (windowed inside
 *  maxDialogRows, the `> ` cursor row always in view, the LIVE search query in
 *  the title) and OWNS the keys while open (pickerActive — the reader chain
 *  steps aside, zero typing frames); enter fills the selection, esc closes;
 *  nothing enters the chat. Line mode keeps the plain out(title) list. */
function pickByKeys(input, out, title, items, state, screen, startIndex = 0, initialQuery = "") {
  return new Promise((resolve) => {
    const done = (v) => {
      state.cancelled = true;
      if (screen) screen.setDialog(null); // STEP 4: the dialog band closes in the same frame the pick settles
      input.removeListener("keypress", on);
      resolve(v);
    };
    const on = (str, key) => {
      if (state.cancelled) return done(null); // cancel() forces null — a real terminal's escape surfaces as cancel() BEFORE the forwarded \x1b reaches the picker's own keypress (STEP 4: the chart's pump fires app.interrupt and forwards the lone escape; the pick must RESOLVE null here, never hang)
      const name = key?.name ?? (typeof str === "string" && (str === "\r" || str === "\n") ? "return" : null);
      if (name === "escape" || (key?.ctrl && (key?.name === "c" || key?.name === "g"))) return done(null);
      const f = !state.query ? items : items.filter((it) => it.line.toLowerCase().includes(state.query));
      if (name === "up") {
        if (f.length) state.index = (state.index - 1 + f.length) % f.length;
        render();
        return;
      }
      if (name === "down") {
        if (f.length) state.index = (state.index + 1) % f.length;
        render();
        return;
      }
      if (name === "return") return done(f[state.index] ?? null);
      if (name === "backspace") {
        state.query = state.query.slice(0, -1);
        state.index = 0;
        render();
        return;
      }
      if (str && key && !key.ctrl && !key.meta && state.query !== undefined) {
        state.query += str;
        state.index = 0;
        render();
      }
    };
    const render = () => {
      const f = !state.query ? items : items.filter((it) => it.line.toLowerCase().includes(state.query));
      if (screen) {
        // STEP 4: the picker renders in the SAME dialog band as the slash menu — the
        // windowed view keeps the `> ` cursor row ALWAYS visible (pi's select keeps
        // the cursor in the viewport); the live search query rides the title.
        if (f.length === 0) {
          screen.setDialog([]); // no match → the band closes (the strip between the bars returns)
          return;
        }
        const cap = Math.max(3, screen.maxDialogRows?.() ?? 8);
        const vis = Math.max(1, cap - 1); // the title row + vis entries
        const start = Math.min(Math.max(0, state.index - Math.floor((vis - 1) / 2)), Math.max(0, f.length - vis));
        const view = [];
        for (let i = 0; i < vis && start + i < f.length; i++) view.push(`${start + i === state.index ? "> " : "  "}${f[start + i].line}`);
        screen.setDialog([`${title}${state.query ? ` — "${state.query}"` : ""}`, ...view]);
        return;
      }
      out(title);
      if (f.length === 0) {
        out("(no match)");
        return;
      }
      for (let i = 0; i < f.length; i++) out(`${i === state.index ? "> " : "  "}${f[i].line}`);
    };
    state.query = initialQuery; // initialQuery: pi's selector opens with a typed search term (a /model argument that matched nothing)
    state.index = Math.min(startIndex, Math.max(0, items.length - 1)); // startIndex: the picker pre-highlights an entry (pi's model selector opens with the ACTIVE model selected)
    render();
    input.on("keypress", on);
  });
}

/** Line-driven picker (non-TTY / injected non-TTY in the suites): the list renders
 *  numbered, a NUMBER line selects, a text line searches, an EMPTY line cancels.
 *  Same resume/branch semantics, same deterministic surface. */
async function pickByLines(reader, out, title, items, state, initialQuery = "") {
  let filtered = initialQuery ? items.filter((it) => it.line.toLowerCase().includes(initialQuery)) : [...items];
  const renderList = () => {
    out(title);
    for (let i = 0; i < filtered.length; i++) out(`${i + 1}. ${filtered[i].line}`);
    out("type to search · a number selects · empty line cancels");
  };
  renderList();
  for (;;) {
    if (state.cancelled) return null;
    const line = await reader.ask();
    if (line === null) return null;
    const t = String(line).trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= filtered.length) return filtered[n - 1];
    }
    const q = t.toLowerCase();
    filtered = items.filter((it) => it.line.toLowerCase().includes(q));
    renderList();
    if (filtered.length === 0) out(`(no match for "${t}")`);
  }
}

/** The interactive session. `mapRef` must be the map_folder_walk reference the
 *  caller computed and `client` an already-connected client; `toolsMap` an
 *  already-built tool map (read + fetch + subagent) or nothing (built on the
 *  first turn). Runs until /quit /exit, Ctrl+C (idle) or Ctrl+D. Resolves to the
 *  number of turns run. */
export async function runInteractiveSession(opts) {
  await loadExtensions(); // ROUND 20: extensions autoload BEFORE the first line — the dot-folder's extensions/ .ts files register their commands (src/extensions.js); a missing/empty extensions dir is a no-op. ROUND 21: every load imports FRESH module copies (the module URL key carries a per-load nonce, pi's clearExtensionCache) — CHANGED extension code IS picked up on /reload, no restart needed.
  // Round 16: the GRAPHICAL CHART (src/screen.js) — entered ONLY when the caller
  // decided the interactive input+output are REAL TTYs (round5.js computes that
  // exact gate). Injected-stream/non-TTY runs never pass it → the deterministic
  // LINE mode below is byte-identical to rounds 10/11.
  const screen = opts.screen ? (typeof opts.screen === "object" ? opts.screen : createScreen({ output: opts.output ?? process.stdout })) : null;
  const out = screen ? (s) => screen.out(s) : (opts.out ?? ((s) => process.stdout.write(s + "\n")));
  const { mapRef, workDir, overrides } = opts;
  const fullMapRef = opts.fullMapRef ?? "map_folder_full.md"; // (round-10/11 suites pass a bare mapRef; the real launch always ships both)
  const systemPrompt = opts.systemPrompt ?? harnessSystemPrompt();
  const drive = opts.driveTurn ?? driveTurn; // injected driveTurn lets the round-10 suite feed canned turns (no live LLM); the real path IS the shared driveTurn
  let messages = [];
  const toolsMap = opts.toolsMap;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  let client = opts.client;
  let active = null; // the in-flight turn's AbortController (Ctrl+C → abort)
  let subagentExpanded = false; // ctrl+o toggles the last subagent's context
  let store =
    opts.store ?? // ROUND 17: the session STORE — a FRESH session at launch (deferred header: the file appears at the FIRST assistant message); a later /resume replaces it with the chosen saved session (its appends keep going to ITS file), /new replaces it with a fresh one; the turn's messages reach it through driveTurn's onMessage below; ROUND 19: a FRESH store opens with the HEAD entry — the session file's payload root (content "", the harness system sections + the DECLARED tool schemas — pi's first jsonl line: role system with sections/toolsAdded)
    (() => {
      const s = createSessionStore({ workDir });
      s.appendHead?.({ sections: { tools: toolsPromptLines().join("\n") }, toolsAdded: toolsMap?.tools ?? [] });
      return s;
    })();
  let picker = null; // an ACTIVE /resume or /tree choice (Ctrl+C cancels it instead of quitting)
  let lastSigInt = 0; // dedupe one action per physical Ctrl+C press (a real terminal may surface the signal on both the input stream AND the interface)
  const reader = createLineReader({
    input,
    output,
    screen, // ROUND 22 (PIECE-1): the chart renders the typing line PI-STYLE (sync burst frames + block cursor + 88-cell padding + parks) instead of readline's echo
    onKeyPress: (key) => {
      if (key === "ctrl-c") {
        onSigInt(); // PIECE-3 (F3/F6): chart mode decodes Ctrl+C at the byte level (the filter; with a PassThrough input node's readline no longer surfaces interface 'SIGINT') — the deduped onSigInt: abort the turn / cancel the picker / clean quit
        return;
      }
      if (key === "slash-proposal") {
        for (const l of slashProposalLines()) out(l); // ROUND 18: the "/" proposal — pi's slash menu printed the moment "/" starts a line; the line itself stays as typed
        return;
      }
      if (key === "escape") {
        // ROUND 19: pi's app.interrupt — ESCAPE ABORTS the in-flight answer (the
        // turn's AbortController; the aborted round trip surfaces as AbortError →
        // "(interrupted)"). When idle it cancels an ACTIVE /resume /tree pick
        // (piece-3: the chart's pump owns the escape — readline swallows the lone
        // \x1b it forwards, so the session cancels the picker here; the picker's
        // own keypress escape still fires on the injected/non-chart paths, the
        // cancel is idempotent). PIECE-3 (F2): idle escape is SILENT — pi emits
        // NOTHING for an unhandled escape (the narration line was removed).
        if (active) active.abort();
        else if (picker) picker.cancel();
        return;
      }
      if (key === "wheel-up" || key === "wheel-down" || key === "mouse-click") {
        // ROUND 19: the MOUSE (pi's fullscreen TUI): wheel up/down scroll the
        // chart's transcript by pi's wheelScrollLines (3); a click jumps to the
        // latest + follow (pi's clickable "jump to latest (end)" row). Line mode
        // ignores the mouse.
        if (screen) {
          if (key === "wheel-up") screen.scrollByLines(-3);
          else if (key === "wheel-down") screen.scrollByLines(3);
          else screen.scrollToEnd();
        }
        return;
      }
      if (key === "scroll-up" || key === "scroll-down" || key === "scroll-top" || key === "scroll-end") {
        // ROUND 19: the scroll keys (pageUp/pageDown/home/end) move the CHART's
        // transcript viewport (pi's ScrollView + tui.altScreen.*): page up/down,
        // home = top, end = latest + follow. Line mode ignores them (readline's own
        // home/end line editing still runs).
        if (screen) {
          if (key === "scroll-up") screen.scrollByLines(-screen.viewHeight()); // pi's tui.altScreen.pageUp
          else if (key === "scroll-down") screen.scrollByLines(screen.viewHeight()); // pi's tui.altScreen.pageDown
          else if (key === "scroll-top") screen.scrollToStart(); // pi's tui.altScreen.top
          else screen.scrollToEnd(); // pi's tui.altScreen.bottom
        }
        return;
      }
      if (key !== "expand-subagent") return;
      if (screen) {
        screen.toggleSubagent(); // round 16: alt+o (and ctrl+o) expand/collapse the LAST SUBAGENT WORK block in the chart (collapsed by default); no block → harmless no-op
        return;
      }
      const ctx = getLastSubagentContext();
      if (!ctx) return; // no subagent context → harmless no-op, the line stays as typed
      subagentExpanded = !subagentExpanded;
      if (subagentExpanded) {
        for (const l of subagentContextLines(ctx)) out(l);
      } else {
        out("(subagent context collapsed)");
      }
    },
  });

  // Round 16: the chart — the startup header (banner, the loaded-resource
  // sections, the ✓ New session started marker), the SCROLLABLE transcript as the
  // MAIN part of the screen (ROUND 19: pi's chat-viewport — the viewport rows
  // 1..R-4, the user's WRITING SPACE between TWO HORIZONTAL `─` bars at the
  // bottom (bar row R-3, writing line R-2, bar row R-1), the FOOTER pinned at
  // the BOTTOM line (row R); pageUp/pageDown scroll the transcript, home = top,
  // end = latest, and the user prompt sits on pi's userMessageBg in the
  // transcript). Line mode keeps the exact round-10/11 banner below.
  if (screen) {
    screen.enter(); // the alternate screen — the chart owns the terminal; the footer never moves
    screen.addHeader(`\x1b[1m${MD_CODE}Observation_only\x1b[39m\x1b[22m${COLOR.dim} v${version} — observation-only harness, pi-style interaction · pi itself never modified${COLOR.fgReset}`); // STEP 5c: pi's startup template header (interactive-mode.js:697-698): bold ACCENT APP_NAME + dim version
    screen.addHeader(`${COLOR.dim}map_folder_walk: ${mapRef}${COLOR.fgReset}`);
    screen.addHeader(`${COLOR.dim}map_folder_full: ${fullMapRef}${COLOR.fgReset}`);
    screen.addHeader(`${COLOR.dim}work dir: ${workDir}${COLOR.fgReset}`);
    screen.addHeader(`${COLOR.dim}model: ${client.providerId}/${client.modelId}${COLOR.fgReset}`);
    screen.addHeader(`[esc] interrupt the current answer · [ctrl+c] interrupt · [ctrl+d] quit`); // ROUND 19: the ESCAPE/INTERRUPT LEGEND of the startup header (pi's app.interrupt — the goal's escape/interrupt legend; pageUp/pageDown scroll the transcript, wheel scrolls, click jumps to the latest — pi's fullscreen TUI behavior)
    screen.addHeader(`[page up/down] scroll the transcript · [home] top · [end] latest · [wheel] scroll · [click] jump to latest`);
    screen.addHeader(`[ctrl+o] expand/collapse the last subagent (pi: app.tools.expand)`);
    // STEP 5c: the LOADED-RESOURCES template — pi's startup presentation (interactive-mode.js:1261-1367):
    // [Context] = the context FILES (systemPromptSource + appends + agents files), body = the pi dim
    // compact list (`  a, b`); [Skills] / [Extensions] sections are added ONLY when non-empty — pi
    // omits empty sections (`skills.length > 0`, `extensions.length > 0`), so the empty [Skills] /
    // [Prompts] / [Themes] placeholders are GONE (there are no prompt templates / themes either);
    // the fake `[Prompt conflicts]` row was never a real diagnostic — removed (pi prints conflict
    // sections only when diagnostics exist, interactive-mode.js:1375-1408).
    const contextFiles = [`map_folder.md`, `map_folder_full.md`];
    if (existsSync(join(userDotDir(), "AGENTS.md"))) contextFiles.push("AGENTS.md"); // the dot-folder global instructions (session.js:74)
    if (discoverAgents("both").agents.length > 0) contextFiles.push("agents/"); // the agent definition files
    screen.addHeader(`${MD_HEADING}[Context]${COLOR.fgReset}`);
    screen.addHeader(`${COLOR.dim}  ${contextFiles.join(", ")}${COLOR.fgReset}`);
    const startupSkills = discoverSkills(); // ~/.Observation_only/skills (SKILL.md discovery, src/skills.js)
    if (startupSkills.length > 0) {
      screen.addHeader(`${MD_HEADING}[Skills]${COLOR.fgReset}`);
      screen.addHeader(`${COLOR.dim}  ${startupSkills.map((s) => s.name).sort((a, b) => a.localeCompare(b)).join(", ")}${COLOR.fgReset}`);
    }
    const startupExtensions = extensionCommandsList(); // the dot-folder extensions' REGISTERED commands (src/extensions.js)
    if (startupExtensions.length > 0) {
      screen.addHeader(`${MD_HEADING}[Extensions]${COLOR.fgReset}`);
      screen.addHeader(`${COLOR.dim}  ${startupExtensions.map((e) => e.name).sort((a, b) => a.localeCompare(b)).join(", ")}${COLOR.fgReset}`);
    }
    screen.addHeader(`✓ New session started`);
    screen.setFooter(footerLine(client)); // the footer status line — at the BOTTOM of the screen, repainted there every paint
    output.on?.("resize", () => { reader.rearmPromptGate?.(); screen.resize(); }); // ARCHITECT STEP 2 + 1b: a full-screen resize re-gates the fresh-prompt frame (the prompt refresh after a size change must not inherit the old row) and the screen FORCE-FULL-clears + repaints (screen.resize — the footer stays pinned)
    client.indicator = createWorkingIndicator({ isTTY: false, stream: output }); // round 16: in the chart the LIVE STREAM IS the working indicator — the round-9 spinner would fight the repaint; every piped/injected path keeps its exact byte behavior
  } else {
    out(`map_folder_walk: ${mapRef}`);
    out(`map_folder_full: ${fullMapRef}`);
    out(`Observation_only ${version} — observation-only harness, pi-style interaction · pi itself never modified`);
    out(`work dir: ${workDir}`);
    out(`model: ${client.providerId}/${client.modelId}`);
    out(footerLine(client));
    out(`type /help for commands + shortcuts · /quit to exit`);
  }

  // Ctrl+C: cancel the request in flight; when idle, quit (pi's app.clear →
  // app.exit family — the applied subset; the whole list is in /hotkeys). Shared by
  // the raw input stream AND the interface: both may surface a real terminal's
  // Ctrl+C, one action per press.
  const onSigInt = () => {
    const now = Date.now();
    if (now - lastSigInt < 100) return;
    lastSigInt = now;
    if (active) {
      active.abort();
      return;
    }
    if (picker) {
      picker.cancel(); // round 17: Ctrl+C cancels an ACTIVE /resume or /tree pick (its keypress handler resolves null) — the session stays
      return;
    }
    reader.close(); // PIECE-3 (F3): pi swallows an idle Ctrl+C and exits CLEANLY — the `^C` row is gone, the next ask resolves null → `bye` + exit 0
  };
  reader.rl.on("SIGINT", onSigInt); // the interface-level Ctrl+C; a real terminal may also surface the signal on the input stream too — the clock dedupes one action per press
  if (input === process.stdin) process.stdin.on("SIGINT", onSigInt); // the raw input stream's control stream

  // ROUND 24 — the EXTENSION UI SURFACE (ctx.ui), the CHART only. pi's
  // /ALAN_connector proposes the model below the prompt (ctx.ui.custom — the
  // scrollable picker in the DIALOG BAND: ↑/↓ navigate, Enter confirms, Esc
  // cancels) and parks the run's one-line summary UNDER THE EDITOR afterwards
  // (ctx.ui.setWidget placement:"belowEditor") — hasUI:false (line mode) keeps
  // pi's HEADLESS behavior (probe default + console.log) so the deterministic
  // suites stay byte-identical. claimPicker/releasePicker hook the session's
  // picker slot (Ctrl+C/Esc cancels the pick; the reader chain steps aside),
  // the widget band reuses the dialog band (the rows between the bottom bar and
  // the footer — exactly pi's belowEditor rows).
  const widgets = []; // the belowEditor widget band (setWidget id → its lines, insertion order)
  const uiSurface = screen
    ? {
        screen,
        input: reader.input, // the keypress-emitter stream (the pump's filtered PassThrough in chart mode)
        out,
        cols: () => output.columns ?? 100,
        claimPicker(settle) {
          picker = { cancel: () => settle(undefined) };
          pickerActive = true; // the owned keys step the reader chain aside (frames / slash menu / scroll) — the component's OWN handleInput acts on them
        },
        releasePicker() {
          picker = null;
          pickerActive = false;
        },
        ask: (title, def) =>
          new Promise((resolve) => {
            if (!title) return reader.ask().then((v) => resolve(v ?? ""));
            picker = { cancel: () => resolve(String(def ?? "")) };
            pickerActive = true; // the input prompt owns the keys while the line is read (no typing frames / slash menu during ctx.ui.input)
            screen.setDialog([String(title)]); // the prompt rides the belowEditor band
            reader.ask().then((v) => {
              screen.setDialog(null);
              picker = null;
              pickerActive = false;
              resolve(v ?? "");
            });
          }),
        setWidget(id, lines, options = {}) {
          const band = (ld) => (ld == null ? null : Array.isArray(ld) ? ld.map((l) => String(l)) : [String(ld)]);
          const next = band(lines);
          const i = widgets.findIndex((w) => w[0] === id);
          if (next === null) {
            if (i >= 0) widgets.splice(i, 1);
          } else if (i >= 0) {
            widgets[i] = [id, next];
          } else {
            widgets.push([id, next]);
          }
          screen.setDialog(widgets.length ? widgets.flatMap((w) => w[1]) : null); // the summary STAYS under the editor (pi: belowEditor, replaced on the next setWidget(id))
        },
      }
    : null;
  const ui = extensionHandlerUi(uiSurface); // the ctx.ui handed to /ALAN_connector, /git_it, … (hasUI:true in the chart, no-ops in line mode)

  let turns = 0;
  for (;;) {
    const line = await reader.ask();
    if (screen) screen.repaint(); // ROUND 19: readline's prompt refresh clears from the prompt row DOWN (\x1b[0J) — that wipes the BOTTOM bar and the FOOTER every prompt; the repaint (paint always rewrites the pinneD rows) brings them back before the user's next input
    if (line === null) break; // Ctrl+D / EOF → quit
    if (!line.trim()) continue;
    const cmdCtx = { providerId: client.providerId, modelId: client.modelId, workDir, mapRef, fullMapRef, ui, hasUI: Boolean(uiSurface), model: undefined, thinkingLevel: undefined }; // the handler ctx of extension commands too (round 20: pi's command handler (args, ctx); round 21: ctx.ui — git_it.ts and alan-connector.ts call ctx.ui.notify; ROUND 24: hasUI:true in the chart — /ALAN_connector then proposes the model (ctx.ui.custom) and parks the summary under the editor (ctx.ui.setWidget); line mode keeps hasUI:false → pi's headless probe-default + console.log)
    const cmd = handleCommand(line, cmdCtx);

    if (cmd.action !== "turn") {
      // A command: print its lines, then act (quit / new / model / reload / resume / tree).
      for (const l of cmd.lines ?? []) out(l);
      if (cmd.action === "quit") break;
      if (cmd.action === "new") {
        messages.length = 0;
        store = createSessionStore({ workDir }); // round 17: a FRESH session file (deferred — written at the next first assistant message)
        store.appendHead?.({ sections: { tools: toolsPromptLines().join("\n") }, toolsAdded: toolsMap?.tools ?? [] }); // round 19: the new session opens with the same payload root (sections + declared tool schemas)
        if (screen) screen.replaceTranscript([]); // round 17: the chart forgets the previous conversation — the main area refills from the next turn
        out("new session — transcript reset");
      }
      if (cmd.action === "resume") {
        // Round 17: pi's resume picker — the CURRENT work dir's saved sessions.
        const saved = listSessions(workDir);
        if (saved.length === 0) {
          out("/resume: no sessions for this work dir");
          continue;
        }
        const items = saved.map((s) => ({ id: s.file, line: s.preview ? `${s.name} — ${s.preview}` : s.name }));
        picker = runPicker({ reader, input: reader.input, out, title: `resume — ${saved.length} saved session(s) · type to search ↑/↓ · enter resumes, esc cancels:`, items, screen }); // piece-3: the picker listens on the EFFECTIVE input (the filter in chart mode — keypress events never surface on the raw stream); STEP 4: chart mode renders the pick in the DIALOG BAND under the prompt box
        const picked = await picker.promise;
        picker = null;
        reader.drainQueued();
        if (!picked) {
          out("resume cancelled");
          continue;
        }
        const descriptor = saved.find((s) => s.file === picked.id);
        try {
          store = loadSessionStore(descriptor.file); // the transcript RELOADS from the file, the conversation continues at its ACTIVE LEAF (same file keeps receiving appends)
          messages = store.getMessages();
          if (screen) screen.replaceTranscript(screenEntriesFor(messages)); // round 17: the chart shows the RESUMED conversation in the main area (banner + footer stay)
          out(`resumed ${basename(descriptor.name)} — continuing at the active leaf (${messages.length} message(s) in context)`);
        } catch (error) {
          if (screen) screen.error(`resume failed: ${error?.message ?? error}`); // piece-3 (class 5): "Error: …" in the error color, like pi
          else out(`resume failed: ${error?.message ?? error}`);
        }
        continue;
      }
      if (cmd.action === "tree") {
        // Round 17: pi's session-tree navigator — the conversation as a branch tree.
        const rows = renderTreeLines(store);
        if (rows.length === 0) {
          out("tree: no entries yet");
          continue;
        }
        const items = store.getEntries().map((e, i) => ({ id: e.id, line: rows[i] ?? entryLabel(e) }));
        picker = runPicker({ reader, input: reader.input, out, title: "tree — the conversation branches · • marks the active leaf (↑/↓ · enter selects, esc cancels):", items, screen });
        const picked = await picker.promise;
        picker = null;
        reader.drainQueued();
        if (!picked) {
          out("tree cancelled");
          continue;
        }
        const entry = store.getEntry(picked.id);
        if (!entry) continue;
        if (entry.type === "message" && entry.message?.role === "user") {
          store.branch(entry.parentId); // a USER message branches from its PARENT; its text lands in the editor
          const text = contentText(entry.message.content);
          messages = store.getMessages();
          if (screen) screen.replaceTranscript(screenEntriesFor(messages)); // round 17: the chart shows the BRANCH point's conversation (new leaf = the branch point)
          out(`editor: ${text}`);
          if (input.isTTY) {
            // TERMINAL/pi-faithful placement: pi puts the selected entry's text INTO the
            // input line with the cursor at the end — the next Enter SUBMITS it as the
            // message (the branch above already moved the leaf to the user entry's PARENT).
            // The deterministic non-TTY LINE mode keeps the `editor: <text>` print only.
            reader.rl.line = text;
            reader.rl.cursor = text.length;
            reader.rearmPromptGate?.(); // STEP 4: the selection's text fills the WRITING line — the next typing frame re-gates the fresh-prompt `\x1b[m\x1b[<row>;1H`
            reader.rl._refreshLine?.();
          }
        } else {
          store.branch(entry.id); // assistant / tool → continue from THAT entry
          messages = store.getMessages();
          if (screen) screen.replaceTranscript(screenEntriesFor(messages)); // round 17: the chart shows the branch point's conversation (main area refreshed, footer stays)
          out(`tree: continued at ${entry.type === "message" ? entry.message.role : entry.type}`);
        }
        continue;
      }
      if (cmd.action === "model") {
        // pi's /model (showModelSelector): an argument → EXACT provider/model match →
        // switch (status "Model: <id>"); a MISS — and a bare /model — → the model
        // SELECTOR opens with the term pre-typed and the ACTIVE model highlighted;
        // type to search, ↑/↓ move, enter selects (switches), esc cancels. Available
        // models = the dot-folder models.json providers (pi: the model registry's
        // list); line mode runs the numbered picker (a number selects, empty line
        // cancels).
        if (cmd.model) {
          let provider = overrides.provider;
          let model = cmd.model;
          const slash = cmd.model.indexOf("/");
          if (slash > 0) {
            provider = cmd.model.slice(0, slash);
            model = cmd.model.slice(slash + 1);
          }
          try {
            client = await createClient({ provider, model, apiKey: overrides.apiKey });
            if (screen) client.indicator = createWorkingIndicator({ isTTY: false, stream: output });
            store.appendModelChange(client.providerId, client.modelId); // round 17: the switch is recorded in the session file
            // pi's /model (handleModelCommand): after setModel → footer.invalidate() —
            // the FOOTER re-renders with the new model name, the switch adds NO
            // transcript line (pi's showStatus "Model: <id>" is a transient status;
            // the model itself lives in the footer). Chart → setFooter re-render;
            // line mode → the same footer line every turn prints.
            if (screen) screen.setFooter(footerLine(client));
            else out(footerLine(client));
            continue; // pi: exact match → switch + footer, no selector
          } catch (error) {
            if (screen) screen.error(`model switch failed: ${error?.message ?? error}`); // piece-3 (class 5): the chart renders the failure like pi — "Error: …" in the error color
            else out(`model switch failed: ${error?.message ?? error}`);
            // pi: NO exact match → the selector opens with the term as the search input
          }
        }
        const providers = loadProviders();
        const items = [];
        for (const [providerId, cfg] of Object.entries(providers)) {
          for (const m of cfg?.models ?? []) {
            items.push({ id: `${providerId}/${m.id}`, line: `${providerId}/${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ""}` });
          }
        }
        if (items.length === 0) {
          out("/model: no models found in models.json — /ALAN_connector writes the providers");
          continue;
        }
        const activeId = `${client.providerId}/${client.modelId ?? ""}`;
        const startIndex = Math.max(0, items.findIndex((it) => it.id === activeId));
        picker = runPicker({ reader, input: reader.input, out, title: `model — pick provider/model · type to search ↑/↓ · enter selects, esc cancels:`, items, screen, startIndex, initialQuery: cmd.model ?? "" });
        const picked = await picker.promise;
        picker = null;
        reader.drainQueued();
        if (!picked) {
          out("model cancelled");
          continue;
        }
        const sep = picked.id.indexOf("/");
        try {
          client = await createClient({ provider: picked.id.slice(0, sep), model: picked.id.slice(sep + 1), apiKey: overrides.apiKey });
          if (screen) client.indicator = createWorkingIndicator({ isTTY: false, stream: output });
          store.appendModelChange(client.providerId, client.modelId); // round 17: the switch is recorded in the session file
          // pi's showModelSelector's selectModel: setModel → footer.invalidate() — the
          // FOOTER re-renders with the picked model, nothing enters the transcript;
          // the banner header's model row is NOT reprinted (pi keeps its startup
          // header untouched — the footer carries the live model). Line mode prints
          // the refreshed footer line, exactly like the turns.
          if (screen) screen.setFooter(footerLine(client));
          else out(footerLine(client));
        } catch (error) {
          if (screen) screen.error(`model switch failed: ${error?.message ?? error}`);
          else out(`model switch failed: ${error?.message ?? error}`);
        }
      }
      if (cmd.action === "reload") {
        try {
          client = await createClient({ provider: overrides.provider, model: overrides.model, apiKey: overrides.apiKey });
          if (screen) client.indicator = createWorkingIndicator({ isTTY: false, stream: output });
          store.appendModelChange(client.providerId, client.modelId); // round 17: the reload's model is recorded too (pi: the active model lives in the session)
          const exts = await loadExtensions(); // round 20: pi's /reload reloads extensions; round 21: the import URL key carries a per-load nonce → FRESH module copies every time, changed extension code re-runs (pi's clearExtensionCache)
          if (exts.length > 0) out(`extensions reloaded: ${exts.map((e) => "/" + e.name).join(", ")}`);
          out(`reloaded settings.json + models.json — model: ${client.providerId}/${client.modelId}`);
        } catch (error) {
          if (screen) screen.error(`reload failed: ${error?.message ?? error}`); // piece-3 (class 5): "Error: …" in the error color, like pi
          else out(`reload failed: ${error?.message ?? error}`);
        }
      }
      if (cmd.action === "extension") {
        // ROUND 20: an autoloaded extension command — the handler (args, ctx)
        // runs with the same ctx as handleCommand (pi: `await command.handler(args,
        // ctx)`); a returned string (or string[]) is printed, an error surfaces
        // as a line, never a crash.
        let result;
        let extError;
        try {
          result = await cmd.extension.handler(cmd.arg, cmdCtx);
        } catch (error) {
          extError = error;
        }
        if (typeof result === "string") out(result);
        else if (Array.isArray(result)) for (const l of result) out(l);
        if (extError) {
          if (screen) screen.error(`extension command /${cmd.extension.name} failed: ${extError?.message ?? extError}`); // piece-3 (class 5): "Error: …" in the error color, like pi
          else out(`extension command /${cmd.extension.name} failed: ${extError?.message ?? extError}`);
        }
        // ROUND 25 (the /ALAN_connector double-run fix): the extension picker's
        // confirming Enter ALSO reaches readline — the pump forwards plain \r even
        // while pickerActive (the component's handleInput confirms; readline commits
        // the STILL-BUFFERED "/ALAN_connector" line into queued[] since no ask()
        // is pending mid-handler). /resume /tree /model all drain right after their
        // pickers — this branch never did, so the stale line popped on the NEXT ask
        // and re-ran the whole command a second time (probe + write + backup x2).
        // One drain after the handler settles is the same convention, covering both
        // confirm and cancel paths (Esc/Ctrl+C commits nothing).
        reader.drainQueued();
        // ROUND 22 (git_it PIECE-3): THE DELIVERY GAP — pi.sendUserMessage /
        // sendMessage queued by the handler is NOT discarded anymore. pi delivers
        // a send to the running session as a NEW USER TURN (the text enters the
        // transcript and the model answers it, like a typed line), so each queued
        // send is driven through THE SAME drive path as a normal line — the
        // handler's RETURN stays the printed line (pi: the command reply is
        // shown first, then each followUp lands as the next turn; a thrown
        // handler's already-queued sends land too, they were dispatched before
        // the throw).
        for (const send of drainExtensionPendingSends()) {
          const followText =
            send.kind === "sendUserMessage"
              ? typeof send.content === "string"
                ? send.content
                : ""
              : Array.isArray(send.message?.content)
                ? send.message.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n")
                : "";
          if (!followText) continue;
          const controller = new AbortController();
          active = controller;
          try {
            if (screen) {
              screen.beginTurn();
              screen.addUserPrompt(followText);
            }
            const { text: followReply } = await drive(client, messages, {
              mapRef,
              fullMapRef,
              workDir,
              systemPrompt,
              toolsMap,
              signal: controller.signal,
              message: followText,
              onPartial: screen ? (partial) => screen.updateStream(partial) : undefined,
              output: screen ? undefined : (s) => out(s),
              onTool: screen ? (ev) => screen.toolEvent(ev) : undefined, // piece-3: the chart's STRUCTURED tool events (pi's tool-execution blocks); line mode keeps the plain `read: …` lines
              onMessage: (m) => store.appendMessage(m),
            });
            if (screen) {
              screen.setFooter(footerLine(client));
              screen.endTurn();
            } else {
              if (followReply) out(followReply);
              out(footerLine(client));
            }
          } catch (error) {
            if (screen) {
              screen.setFooter(footerLine(client));
              screen.endTurn();
            }
            if (screen) (isAbortError(error) ? screen.status("(interrupted)") : screen.error(`request failed: ${error?.message ?? error}`)); // piece-3 (class 5): "(interrupted)" in dim, the failure in "Error: …" — pi's colors; line mode stays byte-identical
            else out(isAbortError(error) ? "(interrupted)" : `request failed: ${error?.message ?? error}`);
          } finally {
            active = null;
          }
          turns += 1;
        }
      }
      continue;
    }

    // A normal line → one turn through THE SAME driveTurn as the one-shot entry.
    const controller = new AbortController();
    active = controller;
    try {
      if (screen) {
        screen.beginTurn(); // round 16: a fresh live view — the answer streams into it ON THE GO
        screen.addUserPrompt(line); // the user prompt between TWO lines of underscores (one above, one below)
      }
      const { text } = await drive(client, messages, {
        mapRef,
        fullMapRef,
        workDir,
        systemPrompt,
        toolsMap,
        signal: controller.signal, // round 10: Ctrl+C aborts the in-flight request
        message: line, // post-round-12: the typed line IS the turn's message — without it the model answered "undefined"
        onPartial: screen ? (partial) => screen.updateStream(partial) : undefined, // round 16: every streamed partial assistant message is painted live — thinking in ITALIC, the final answer upright and BOLD
        output: screen ? undefined : (s) => out(s),
        onTool: screen ? (ev) => screen.toolEvent(ev) : undefined, // piece-3: the chart's STRUCTURED tool events (pi's tool-execution blocks — announcement + result with the truncation/full-output line); line mode keeps the plain `read: …` observation lines
        onMessage: (m) => store.appendMessage(m), // round 17: EVERY message of the turn (user → assistant → toolResults → the final answer) auto-saves to the session store — append-after-every-turn
      });
      if (screen) {
        // Round 16: in the chart the answer IS the live view (already painted bold
        // in the main area) — never double-printed; the footer refreshes pinned at
        // the BOTTOM line.
        screen.setFooter(footerLine(client)); // round-7 footer after EACH turn, session-cumulative
        screen.endTurn();
      } else {
        if (text) out(text); // round 11: the driveTurn RETURN — the model's own answer (out appends the newline); printed before the footer, ONLY when text exists, exactly like the one-shot path
        out(footerLine(client)); // round-7 footer after EACH turn, session-cumulative
      }
    } catch (error) {
      if (screen) {
        screen.setFooter(footerLine(client));
        screen.endTurn();
      }
      if (screen) (isAbortError(error) ? screen.status("(interrupted)") : screen.error(`request failed: ${error?.message ?? error}`)); // piece-3 (class 5): "(interrupted)" dim, failures "Error: …" red — pi's colors; LINE mode stays byte-identical (`request failed:` substring unchanged)
      else out(isAbortError(error) ? "(interrupted)" : `request failed: ${error?.message ?? error}`);
    } finally {
      active = null;
    }
    turns += 1;
  }
  out("bye");
  if (screen) screen.exit(); // leave the alternate screen — the caller's terminal content is restored
  reader.close();
  return turns;
}

# bug/UX resolution — long-prompt editing artifact in the writing area

Context: `Observation_harness` is a byte-parity reimplementation of the real pi-coding-agent interactive TUI (installed pi **0.86.1**, pi-tui **0.86.1** — from `@earendil-works\pi-coding-agent\package.json` / `…\pi-tui\package.json`). Every claim about real pi below is quoted from that installed source; anything not found is marked **UNVERIFIED**.

---

## 1. The user-reported symptom (quoted)

> "typing a longer line then correcting it: the upper lines do not move, but the upper line is 'copy pasted' on the lower line"

i.e. a stale / ghost *wrapped* prompt row: after a long prompt overflows the writing area and then shrinks (erasing), the tail of the old long line remains on the row below, looking like the upper line was "copy-pasted" onto the lower line.

---

## 2. What we investigated

**Repro.** `test-rig\work\box-repro.cjs` spawns the harness in a pty at `--cols 80 --rows 30` (`box-repro.cjs`), types `"n"`, submits, types `"aaaa"`, submits, then types `#`.repeat(90) (wraps at 80 cols) and 3 backspaces (milestones: `boxrepro\milestones.jsonl` steps 4–5). This is exactly the reported gesture: long line, then correction.

**Capture decode.** `decode3.cjs` decodes `boxrepro\raw.bin` → `test-rig\work\decode3-out.txt`. The wrapped-typing frames (SEG @7297 and @7746) show a **FLAT single-run** between the two bars: `\x1b[26;1H` + top `─` bar, then **the FULL 90-char text in ONE `TEXT(90)` run** + `\x1b[7m` + `" "` + `\x1b[27m` + a space pad (`TEXT(69)`; second frame `TEXT(87)`/`TEXT(72)`), then the bottom `─` bar, the footer, `\x1b[K`, park `\x1b[28;1H`. **No `\x1b[27;1H` / `\x1b[28;1H` CUPs and no `\x1b[K` between the bars in the captured stream.** (Path note: the task-cited path `boxrepro\decode3-out.txt` does not exist; the real output is `test-rig\work\decode3-out.txt`, produced by `decode3.cjs` from `boxrepro\raw.bin`.)

**The invented multi-row "box".** The harness's own answer was a multi-row writing box that grows *upward* between two pinned `─` bars: `src\screen.js` `promptWrapCount()` (`screen.js:166` — box height, grows once `promptLine.length + 1 ≥ cols`), `writingTopRow()` (`screen.js:171` — top writing row moves up one row per wrapped line), `renderPromptArea()` (`screen.js:176–194` — a per-row loop emitting `\x1b[${writingTopRow() + i};1H${rowText}\x1b[K` for every writing row), `writePromptBox()` (`screen.js:417` — repaints the whole dock), plus `src\interactive.js` `piTypingFrame` (`interactive.js:131`) with the `if (len >= W)` box branch (`interactive.js:144–151`) and the `rearmPromptGate()` crash fix (`interactive.js:394–396`, the `ReferenceError: firstTypedFrame is not defined` full-screen crash, wired to resize at `interactive.js:679`).

**Claimed ↑/↓ wrapped-row navigation** (from the investigation brief) — **NOT FOUND** in the current `src\interactive.js`: the only `name === "up"` / `name === "down"` handlers are the *picker's* list navigation (`interactive.js:485–493`). No wrapped-row box-navigation code exists in the current source. **UNVERIFIED / not present.**

---

## 3. THE KEY FINDING (verified against pi source)

### 3a. The claims about `Input` are TRUE **of the `Input` component** — and are quoted here from `…\pi-tui\dist\components\input.js`:

- (a) Docstring — `input.js:10`: `* Input component - single-line text input with horizontal scrolling`
- (b) — `input.js:343–345`: `render(width) {` / `const availableWidth = width - visibleWidth(this.prompt);`
- (c) — fits vs scroll — `input.js:363–369`: `const totalWidth = visibleWidth(this.value);` / `if (totalWidth < availableWidth) { // Everything fits (leave room for cursor at end)` / `visibleText = this.value;` / `else {` / `// Need horizontal scrolling`; window computed with `renderedStartColumn` and sliced with `input.js:389–390`: `visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);` and `const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);` — the cursor is kept in view by the `startCol` rules (`input.js:371–388`: startCol = 0 near start / `totalWidth - scrollWidth` near end / `cursorCol - halfWidth` mid).
- (d) — one flat line string — `input.js:408`: `const cursorChar = ` + "```" + `\x1b[7m${atCursor}\x1b[27m` + "```" + `; // ESC[7m = reverse video, ESC[27m = normal` and `input.js:413–414`: `const line = this.prompt + textWithCursor + padding;` / `return [line];` — prompt + `before + \x1b[7m…\x1b[27m + after + padding`, returned as a **one-element array**.
- (e) — exactly one line — `input.js:414` `return [line];` → the component occupies exactly **1 terminal row**.
- (f) — flat-string editing — `cursorLeft` (`input.js:127–135`) and `cursorRight` (`input.js:137–145`) move `this.cursor` inside the flat `this.value` (`this.value.slice(0, this.cursor)` / `this.value.slice(this.cursor)`, grapheme-adjusted); `handleBackspace` (`input.js:211–221`) edits `this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor); this.cursor -= graphemeLength;` — **no row math anywhere**.

### 3b. **BUT the premise "real pi does NOT wrap the prompt; pi's editor is `Input`" is REFUTED by this installed pi.** The interactive-mode prompt is the multi-line **`Editor`**, which *wraps*:

- `dist\modes\interactive\interactive-mode.js:355–362`: `this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, { paddingX: editorPaddingX, autocompleteMaxVisible, embedWorkingStatus: true });` … `this.editor = this.defaultEditor; this.editorContainer = new Container(); this.editorContainer.addChild(this.editor);`
- `dist\modes\interactive\components\custom-editor.js:5`: `export class CustomEditor extends Editor {`
- The editor lives in the pinned bottom **dock** — `dist\modes\interactive\chat-viewport.js:12–24` (`VStack` dock containing `… { component: options.editor, shrink: 1, minSize: 3 }, … { component: options.footer, … }`) under the transcript `ScrollView` (`chat-viewport.js:4–11`).
- The long line **wraps into multiple visual rows** — `…\pi-tui\dist\components\editor.js:845–846`: `// Line needs wrapping - use word-aware wrapping` / `const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);` (see also `editor.js:82–88` `wordWrapLine` and the visual-line map `editor.js:1528–1551`, which wraps once `lineVisWidth > width`).
- The **top and bottom `─` bars are the Editor's own methods** — `editor.js:383–385`: `renderTopBorder(width, hiddenLineCount) { const border = hiddenLineCount > 0 ? createScrollBorder("↑", hiddenLineCount, width) : "─".repeat(width);` and `editor.js:387–389` the same with `"↓"`.
- `render(width)` pushes **one array element per visual row** — `editor.js:391` `render(width) {`, `editor.js:394–395` `contentWidth = width - paddingX * 2;`, `editor.js:403–404` `const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));`, `editor.js:426` `result.push(this.renderTopBorder(width, this.scrollOffset));`, the per-line loop `editor.js:429–471` («`result.push(...)`» per visual line, each padded to `contentWidth`), `editor.js:471` `result.push(this.renderBottomBorder(width, linesBelow));`. Vertical scrolling (`scrollOffset`, `editor.js:410–418`), cursor via `\x1b[7m…` (`editor.js:455` / end-of-line `\x1b[7m \x1b[0m`, `editor.js:463`), ↑/↓ move across **visual** lines (`editor.js:744–760`, `moveToVisualLine` `editor.js:1235–1258`), backspace across the logical line (`editor.js:1151`, line-merge `editor.js:1194–1198`).

> **Explicit answer to the question "Is the box between the two bars handled by another function?"** — **If the question means real pi: NO separate function.** In pi there is no "writePromptBox"-style helper; the box **is** `Editor.render()` itself: one `render` call produces `[top ─ bar] + one entry per wrapped visual line + [bottom ─ bar]` and tallies the rows (each padded to `contentWidth`). `Input.render` (which *does* do the single-line + horizontal-scroll logic of 3a) is pi's **SelectList search** input — the only `new Input(` in the bundle is inside the SelectList (`dist\bundle\chunks\chunk-CMRUVXTE.js`); it never draws `─` bars. So the harness's multi-row box was actually pi-faithful; the single-line/Input premise behind the "design answer" in the brief is **REFUTED** by this source and must be treated as **UNVERIFIED/INCORRECT** for the prompt in pi 0.86.1.

The TUI children-render loop is verified at `…\pi-tui\dist\tui.js:115–121` (Container.render): `const childLines = child.render(width);` / `mouseChildren.push({ component: child, height: childLines.length });` / `for (const line of childLines) lines.push(line);` — a component's `lines` array is its terminal rows (1 element = 1 row; `Input` = 1 row, `Editor` = border+rows+border). The full-screen frame writes **every row with `\x1b[2K` erase** and **crashes with a written crash-log if any line's `visibleWidth(line) > width`** (`dist\bundle\chunks\chunk-CMRUVXTE.js` altscreen renderer). pi guarantees every rendered row fits the width — soft-wrap is structurally impossible in pi.

---

## 4. Root cause of the artifact

At 80 cols the harness's wrapped-typing frame is written as **one flat run longer than the row** (mode’s own flat frame assembly: `interactive.js:155–163` — `\x1b[<row>;1H` + text + `\x1b[7m…\x1b[27m` + pad, or the box path `interactive.js:144–151` → `screen.writePromptBox()`). A >80-cell flat run **soft-wraps in the real terminal**: cells 81..N land on the row below. When the line shrinks (backspace), the shorter run and its `\x1b[K` (erase-to-end-of-line) only cover the *first* row; the tail cells the terminal pushed to the lower row are **not erased** → "the upper line is copy-pasted on the lower line". (Verify the observed stream: between the `\x1b[26;1H` top bar and the bottom bar the decode shows `TEXT(90)` + block + `TEXT(69)` / `TEXT(87)` + block + `TEXT(72)` as **flat runs with zero `\x1b[27;1H`/`\x1b[28;1H` CUPs and zero `\x1b[K` between the bars** — `test-rig\work\decode3-out.txt`, SEG @7297 / @7746).

**Why pi never hits this** (verified): each visual row is its **own 1-row-wide rendered line** (padded to `contentWidth`, `editor.js:394–395, 446–471`), every row written with `\x1b[2K`, and a line wider than the terminal is a **hard crash guard** (`chunk-CMRUVXTE.js` altscreen renderer). There is never an over-width write and every shrink re-renders the row fresh.

**Capture caveat (UNVERIFIED mechanism):** ConPTY normalizes/merges pty writes, so the *bytes in `raw.bin` are only partially trustworthy* — the flat single-run shape (and the absence of the box's per-row CUPs) is a verified **observation**, but the exact merging mechanism is the harness team's stated explanation and was **not independently verified**. That is why the design verdict here is taken from pi's **render source**, not from pty bytes.

---

## 5. Ground truth (added 2026-09-21, post-agent verification) — the box is CORRECT as-is

**A direct buffer-stream probe of `createScreen` (no ConPTY, no readline — `test-rig\work\box-render-probe.cjs`) proves the CURRENT harness already emits the pi-faithful per-row box writes.** Captured bytes at 80×30, `#`.repeat(90) then corrections:

- `90#` (box, 2 writing rows): `\x1b[26;1H`+top bar+`\x1b[K` · `\x1b[29;1H`+bottom bar+`\x1b[K` · footer · **`\x1b[27;1H`+80#+`\x1b[K` · `\x1b[28;1H`+10#+`\x1b[7m␠\x1b[27m`+`\x1b[K`** · park `\x1b[28;1H`
- `87#` **both rows rewritten** with `\x1b[K` (correction leaves no stale tail on row 28)
- `80#` box still 2 rows (80 + block) — every row re-emitted;
- `79#` collapse: `\x1b[26;1H\x1b[K` erases the vacated top-bar row, top bar returns to 27, single writing row, `\x1b[K` everywhere.

**Conclusion: the "flat single-run" in `raw.bin` was a ConPTY capture artifact** (same fusion that produced the stray `6l` text token and the color-before-CUP reordering). The wire bytes the harness emits are per-row with explicit CUPs + `\x1b[K` — a real terminal can never leave a stale wrapped row. The writing path (`interactive.js:144-151` `len >= W` → `screen.writePromptBox()` → `paint()` → `renderPromptArea()`) is confirmed live in current source. **No single-line/Input rewrite is needed — the multi-row `Editor` box IS pi's real model (§3b) and it is already correct at the byte level.** The remaining judge is the human window test (§6 checklist).

---

## 6. Checklist the fix must satisfy (user's acceptance bar, verbatim)

> (1) a long prompt fills many lines bordered upper and lower with ─; (2) arrow keys work; (3) erasing one-by-one (backspace) works across the whole prompt; (4) the bottom bar never moves; (5) works at any screen size.

**How pi satisfies each (verified in source):**
- **(1)** Long logical line → many visual rows: `editor.js:845–846` word-wrap (`wordWrapLine`, `editor.js:82–88`); the `─` borders are `renderTopBorder`/`renderBottomBorder` (`editor.js:383–389`).
- **(2)** Arrow keys: ↑/↓ move across **visual** rows with column snapping (`editor.js:744–760–763`, `moveToVisualLine` `editor.js:1235–1258`); ←/→ move grapheme-wise in the logical line; page scroll `editor.js:1645–1651`.
- **(3)** Backspace across the whole prompt: `editor.js:1151` `handleBackspace()`; line-start backspace merges with the previous line (`editor.js:1194–1198`); every row is re-rendered with `\x1b[2K` per row.
- **(4)** Bottom bar never moves: the editor is in the pinned dock (`chat-viewport.js:12–24`, editor `minSize: 3`); the box grows *upward* (top border carries `↑N` when scrolled, `editor.js:383–385`); transcript `ScrollView` above (`chat-viewport.js:4–11`), footer last; bottom border pushed last in render (`editor.js:471`).
- **(5)** Any screen size: layout derives from `width`/`rows` at render time (`editor.js:394–399, 403–404`; `contentWidth = width - paddingX*2`), re-wrap per render; over-width lines are a hard crash guard (`chunk-CMRUVXTE.js` altscreen renderer), so a row can never spill onto another.

---

## 7. Open questions / risks

- **Cursor while horizontally scrolling (Input model).** `Input` keeps the cursor visible by resetting `renderedStartColumn` each render (`input.js:362, 389–390`), reserving 1 column when the cursor is at the end (`input.js:370` — `const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;`). The harness's pad/park formulas (`interactive.js:155–163`) must track that, and the "single-line frame = byte-identical at 100 cols" guarantee must be re-proven there.
- **Resize behavior.** pi re-wraps and clamps `scrollOffset` per render (`editor.js:410–418`); a single-row model has no wrap to redo, but the resize path (`screen.js` `resize()` → `rearmPromptGate()`, `interactive.js:679`) must still force a full repaint so the scrolled window and any pad are re-derived.
- **(1) vs the Input model:** criterion (1) says "fills many lines" — pi meets it by wrapping; a single-writing-row writing area does not. Decide: adopt the Editor box (pi 0.86.1's real behavior) or re-interpret (1). **This is the main unresolved risk; the task's §3 premise ("pi = Input") could not be verified — it is contradicted by `interactive-mode.js:355–362` + `editor.js:383–471`.**
- **ConPTY capture trust (UNVERIFIED):** per §4, pty bytes were merged (`decode3-out.txt`); future calibration must be source-derived, and the 100-col suite only proves the *single-line* path.

---

## Verification appendix — claims and their source lines

**Verified (quoted above):** `input.js:10, 127–145, 211–221, 343–345, 362–371, 383–390, 408, 413–414`; `tui.js:115–121`; `editor.js:82–88, 383–389, 391–404, 410–418, 426, 429–471, 744–763, 845–846, 1151, 1194–1198, 1235–1258, 1528–1551`; `interactive-mode.js:355–362`; `custom-editor.js:5`; `chat-viewport.js:4–24`; `chunk-CMRUVXTE.js` (altscreen `\x1b[2K` per row + `visibleWidth(line) > width` crash guard); harness `screen.js:166, 171, 176–194, 200, 417`, `interactive.js:131, 144–151, 155–163, 183–187, 394–396, 485–493, 679`; repro `box-repro.cjs` (`--cols 80 --rows 30`, 90 `#` + 3 backspaces), `boxrepro\milestones.jsonl`, `decode3.cjs` → `test-rig\work\decode3-out.txt` (flat runs at SEG @7297/@7746, no per-row CUPs between bars).

**Claims that could NOT be verified / found:** (i) "real pi prompt = single-line `Input`, no wrap" — **REFUTED** (it is the wrapping `Editor`, `interactive-mode.js:355–362`, `editor.js:845–846`); (ii) "↑/↓ wrapped-row box navigation in `interactive.js`" — **not present** in current source; (iii) "ConPTY write-merging mechanism" — observed flat runs verified, the merging **mechanism UNVERIFIED**.

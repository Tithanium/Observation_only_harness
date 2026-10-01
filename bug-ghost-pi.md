# Ghost prompt line in the Observation_only clone vs real pi — root cause

All citations read from the installed sources on this machine (real pi: `@earendil-works\pi-tui` + `@earendil-works\pi-coding-agent` under npm; clone: `C:\Users\connessn\Observation_only\src`). No claims from memory.

---

## §1 How pi prevents ghosts

### 1a. The full-screen renderer erases a line BEFORE every draw, per row, per frame

The pi-tui altscreen renderer (this machine has **unbundled dist**, not the `chunk-CMRUVXTE.js` bundle; the write loop lives in `dist\tui-alt-screen.js`) writes, on every frame, **every row whose content string differs from the previous frame**, and every such write is prefixed by a full-line erase `\x1b[2K`:

`...\pi-tui\dist\tui-alt-screen.js:1481-1488`:
```js
        for (let row = 0; row < height; row++) {
            if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
                continue;
            buffer += `\x1b[${row + 1};1H${clearRowsBeforeKittyImages ? "" : "\x1b[2K"}${preparedKittyScreen.lines[row] ?? ""}`;
        }
```

Key consequences:

- A row that **previously held text but now holds nothing** (`screen[row]` is `""` or `undefined`, so `screen[row] !== previousScreen[row]`) is still visited → `\x1b[<row+1>;1H\x1b[2K` + empty content → the old glyphs are erased. Stale rows are structurally impossible.
- A full redraw (first frame, or width/height change) additionally does `\x1b[2J` (`tui-alt-screen.js:1470-1474` — `const fullRedraw = …; buffer += `${clearImages}\x1b[2J`;`), so a size-changing layout is wiped wholesale before redraw.
- The diff is **string comparison on full-width rows** — it can't "skip" a row that visually shrank, because the strings differ.

### 1b. The editor renders a fixed structure: top bar, one row per wrapped visual line (each padded), bottom bar — and shrinks upstream

`pi-tui\dist\components\editor.js` `render(width)`:
- `editor.js:426` — `result.push(this.renderTopBorder(width, this.scrollOffset));`
- `editor.js:432` — `for (const layoutLine of visibleLines) {` (one iteration per **wrapped visual row**, from `layoutText` at `editor.js:812`)
- `editor.js:467` — `result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);` — every wrapped row is **padded to the full content width**, so a shrunk line yields a *different* padded string → the diff at §1a redraws it.
- `editor.js:471` — `result.push(this.renderBottomBorder(width, linesBelow));`

The Container just stacks child renders line by line (`pi-tui\dist\tui.js:117-122`):
```js
        for (const child of this.children) {
            const childLines = child.render(width);
            mouseChildren.push({ component: child, height: childLines.length });
            for (const line of childLines) {
                lines.push(line);
            }
        }
```
The editor is wired as a child via `interactive-mode.js:355-360` (`this.defaultEditor = new CustomEditor(...)`, `this.editor = this.defaultEditor`) + `interactive-mode.js:361-362` (`this.editorContainer = new Container(); this.editorContainer.addChild(this.editor);`); `CustomEditor extends Editor` at `dist\modes\interactive\components\custom-editor.js:5`.

**Why a shrinking wrapped prompt can never leave a stale row in pi:** the editor simply returns *fewer* rows (one less wrapped row) → the composed `screen` array no longer contains that row's old text; the row is now occupied by a different string (shifted bar/line) or left `""`. The §1a loop sees the string change and rewrites the row as `\x1b[2K` + new content (or `\x1b[2K` alone). There is no code path that writes partial content to a row without erasing it first — the erase is attached to every single redraw write.

---

## §2 The clone's gap — the asymmetric typing path

The clone's box logic is a **two-path fork inside `piTypingFrame`** (`src\interactive.js:144-163`):

```js
      if (len >= W) {                              // interactive.js:144
        ...
        screen.writePromptBox();                   // interactive.js:151 — FULL dock repaint
        firstTypedFrame = false;
        return;
      }
      const rawPark = ...                          // interactive.js:155
      const pad = ...                              // interactive.js:156
      ...                                          // interactive.js:159  body = gate or "\r"
      const f = `\x1b[?2026h\x1b[?2026l${body}${rl.line.slice(0, cursor)}\x1b[7m${at}\x1b[27m${rl.line.slice(cursor + (cursor < len ? 1 : 0))}${pad > 0 ? " ".repeat(pad) : ""}\x1b[${r};${park}H`;
      output.write(f);                             // interactive.js:162 — writes ONLY row R-2
```

- **Box path** (`interactive.js:144-153`, reached when `len >= W`): `screen.writePromptBox()` → `screen.js:417-421` → sets `painted = painted.slice(0, viewHeight())`, `forcePrompt = true`, `paint()` → `screen.js:423-467` rewrites the **entire bottom dock**: top bar at `writingTopRow()-1` (`screen.js:451`), bottom bar `R-1`, footer `R`, the whole prompt box via `renderPromptArea()` (`screen.js:176-195`, each box row written as `\x1b[<row>;1H<text>\x1b[K`), and re-parks the cursor (`screen.js:463`). Every row ends in `\x1b[K`.
- **Single-line path** (`interactive.js:155-163`, `len < W`): writes **exactly one row** — `writingRow()` (`screen.js:200`, always `R-2`) — `\x1b[<R-2>;1H` + text + block + pad + park. It writes **no top bar, no erase of any row above R-2, and no `paint()` at all**.

`promptWrapCount` / `writingTopRow` are *derived from the current line length only* (`screen.js:166`, `screen.js:171`) — nothing records that the box was previously 2 rows.

### The exact stranded-row scenario (80 cols, R rows; box rows R-3 / R-2 after collapse analysis with R=30 → rows 27/28, top bar 26, bottom bar 29, footer 30)

1. 90-char prompt → `promptWrapCount() = 2` → `writingTopRow() = R-3` → the box path paints: top bar at row `R-4` (=26), box row `R-3` (=27, chars 1–80), box row `R-2` (=28, tail), bottom bar `R-1` (=29), footer `R` (=30).
2. Backspace to 79 chars → `len < W` → the **single-line path** fires and writes **only row `R-2`** (=28) with the 79-char line.
3. Left over on screen, never erased between this keystroke and the next full `paint()`:
   - row `R-3` (=27): the old **80 full chars of the wrapped prompt** — this is the "upper line stays in place / copy-pasted" ghost;
   - row `R-4` (=26): the old **top `─` bar** stranded one row above where it should be (it belongs at `R-3` once the box collapses).
4. Subsequent single-line keystrokes keep going through `interactive.js:155-163` (bare `\r` + row R-2), and the commit path blanks only R-2 (`interactive.js:184-193`) — **nothing repairs rows 26–27 until a later `paint()`** (next turn's `screen.repaint()`, a scroll, or a resize). While the user keeps editing a <80-char line, the ghost persists; if they type back over 80 chars the box path returns and happens to scrub it.

The asymmetry is the bug: the box path re-renders the whole dock on *every* keystroke (so a *growing* prompt can never ghost), but the single-line path assumes the dock is already correct — an assumption that only holds if the box was never active before. It neither erases `writingTopRow()-1` … `writingRow()-1` nor restores the top bar at the new `writingTopRow()-1`, so the **collapse 2 → 1** transition strands both rows.

(Side note: `screen.js:418` shows the intended general rule — "grow up / shrink back" — `painted = painted.slice(0, viewHeight())` + full repaint; the bug is that the *typing* code only routes through it when `len >= W`, never when the *previous* state was a box.)

---

## §3 Recommended fix — do NOT implement here, just document

Make the clone's collapse transition symmetric by tracking whether the prompt box was previously active: keep a boolean (e.g. in the reader's scope, next to `firstTypedFrame`) set true each time the `len >= W` branch runs and on `writePromptBox`/`writePromptBox` commit, and in the single-line typing path, if that flag is set and `len < W`, call `screen.writePromptBox()` (the existing, already-correct full-dock repaint: it slices `painted`, forces `renderPromptArea`, repaints top bar at the new `writingTopRow()-1` = `R-3`, bottom bar `R-1`, footer `R`, and re-parks) before/inside the single-line write, then clear the flag — i.e. "if the box previously had more than 1 writing row, re-render the whole bottom dock instead of the bare single-row frame"; alternatively (simpler, more invasive) route *every* typing frame through `writePromptBox` and accept a per-keystroke dock repaint. The minimal-trigger variant is byte-safe for the pty suite: `runner.mjs --quick` runs at 100 cols with short lines, so `len >= W` never fires, the box flag never gets set, the collapse branch never triggers, and every calibrated single-line frame byte is untouched — the change only ever fires in the state (box active → collapse) that is exactly the state that currently ghosts. Whatever is chosen must ship together with a regression check in the suite: at 80 cols, type 90 chars, backspace to 70, and assert the emitted bytes erase rows `R-3`/`R-4` (or simply assert no 80-char residue and a top bar rewritten at `R-3`).

---

## Verification notes

- Real pi on this machine is the **unbundled** dist (`dist\tui-alt-screen.js`, `dist\tui.js`, `dist\components\editor.js`) — `dist\bundle\chunks\chunk-CMRUVXTE.js` does not exist; the quoted write loop was read from `tui-alt-screen.js:1481-1488`.
- Clone behavior traced from source only; no run performed (investigation task). The ghost mechanism matches the user-visible symptom described in the task.

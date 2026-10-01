# RENDER_PARITY_AUDIT.md — PIECE 0 (inventory + backup + audit — NO rendering code modified)

**BACKUP (deliverable 1, re-verified 2026-09-29):** `C:\Users\connessn\Observation_only_backup\backup_20260929_202516`
- Tree: entire `C:\Users\connessn\Observation_only` **excluding `node_modules` and `dev_rounds`** (and stray `ptyrun.log`).
- Re-verification (this audit): **304 files in the backup = 304 of the 305 live-tree files**; the single file present in the live tree but absent from the backup is this audit document itself (`RENDER_PARITY_AUDIT.md`, created by a prior piece — the backup predates it). All **34 non-backup files under `src\`** verified **SHA-256 hash-identical** to the backup (0 mismatches). Backup is valid; `src\` untouched.

**Reference (absolute, unmodified):** pi harness at
`C:\Users\connessn\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`
with its vendored `node_modules\@earendil-works\pi-tui\dist\` widget library. Every pi citation below was re-opened and verified against these files in this audit.

---

## ACTUAL TOOL SET (the corrected premise)

The observation harness is **NOT read-only**. From `src/session.js`:
- `buildHarnessTools` (`session.js:100-108`) registers: **`read`** (`src/read_tool.js`), **`fetch`** (`src/fetch_tool.js`), **`subagent`** (`src/subagent_tool.js:276`, spawns `src/worker.js` with read+fetch), **plus extension-registered tools** (`...extensionToolsList()`, `session.js:104` — pi's `registerTool` API, `src/extensions.js`).
- `toolsPromptLines` (`session.js:25-36`) declares exactly those in the system prompt ("You have exactly three tools:" + one line per extension tool).
- Both entries drive the same loop: one-shot `round5.js` and interactive `interactive.js:648` → `driveTurn` (`session.js:130`), `MAX_TURNS = 12` (`session.js:67`).

Harness-level FEATURES that exist (a divergence may NOT be justified by claiming these missing):
extension commands (`extensions.js`, `/reload`, autoload, staged commit + cache-bust) · extension UI surface `ctx.ui` (`extensionHandlerUi` `extensions.js:213`, `runExtensionCustom` `extensions.js:289` — custom component in the dialog band, `setWidget` belowEditor, `input`) · agents (`agents.js` → subagent dispatch) · skills (`skills.js`, loaded via `read`) · session store with auto-save + `/resume` `/new` `/tree` (`session_store.js`) · **cost tracking** (`client.js:27`) · **cacheRead/cacheWrite tracking** (`client.js:25-26`) · working-spinner code (`working.js` = pi-tui `loader.js` port).

FEATURES GENUINELY ABSENT (the ONLY valid divergence justifications — verified by source + grep):
- the **pi-tui widget engine** (Editor/Markdown/SelectList/Box/Container/VStack/layout engine/TuiAltScreen renderer — `src` imports no pi-tui; extension components run on a duck-typed shim, `extensions.js:213-289`)
- **bash / edit / write / grep / find** tools
- **compaction** (pi `/compact` — `core/slash-commands.js:23`; no `compact*` in `src`)
- **experimental-features flag** (no `experimental*` in `src`)
- **session naming** (pi `/name` — `core/slash-commands.js:13` `name: "Set session display name"`; no `/name` in `commands.js:40-50`)
- **thinking-level feature** (pi `/thinking` — `core/slash-commands.js:6`; no `thinkingLevel` in `src`)
- **extension footer statuses** (harness `ctx.ui.setStatus` is a NO-OP stub — `extensions.js:215`, `extensions.js:251` — no registry to render)
- OSC 9;4 terminal progress, image (kitty) protocol, IME hardware-cursor marker, retry

**Rule enforced (the ONLY valid divergence justification):**
> A difference is **VALID** ONLY when the pi code uses a tool/feature that does **not exist** in this
> harness (per the two lists above, applied against the ACTUAL set). Any difference that is *not*
> caused by such a missing feature is **INVALID** — those are the rows pieces 1–6 must fix by
> copying pi verbatim.

**Replacement policy (governing pieces 1–6 — NOT executed in this piece):** copy the pi counterpart
verbatim, add ONLY the missing-feature adaptation. This audit identifies those exact copy targets.

**Judgment tags:** `=IDENTICAL` port (bytes/behavior match pi) · `VALID` (difference caused by a
genuinely missing pi tool/feature; the missing feature is named) · `INVALID-<KIND>` (difference with
NO missing-tool justification — a divergence to fix).

Line numbers cited are exact (verified by read/grep in this audit). Pi files abbreviated:
`i-mode` = `dist/modes/interactive/interactive-mode.js` · `e` = `pi-tui/dist/components/editor.js` ·
`sv` = `pi-tui/dist/components/scroll-view.js` · `lay` = `pi-tui/dist/layout.js` ·
`cf` = `dist/modes/interactive/components/footer.js` · `te` = `dist/modes/interactive/components/tool-execution.js` ·
`am` = `dist/modes/interactive/components/assistant-message.js` · `um` = `dist/modes/interactive/components/user-message.js` ·
`si` = `dist/modes/interactive/components/status-indicator.js` · `ld` = `pi-tui/dist/components/loader.js` ·
`term` = `pi-tui/dist/terminal.js` · `tui` = `pi-tui/dist/tui.js` · `tr` = `dist/modes/interactive/tui-renderer.js` ·
`cv` = `dist/modes/interactive/chat-viewport.js` · `md` = `pi-tui/dist/components/markdown.js` · `u` = `pi-tui/dist/utils.js`.

---

# REGION 1 — prompt area between the two `─` bars (input → layout → paint)

### Step 1 — observation functions (pipeline order)

| # | observation (file:line) | role in pipeline |
|---|---|---|
| 1 | `interactive.js` `createLineReader` :88 | raw input source: byte pump + PassThrough filter + readline interface; the writing space's interactive half |
| 2 | `interactive.js` `pumpBytes` :349 | raw-stream tap: SGR-mouse strip, escape-hold (60 ms), clean bytes to readline |
| 3 | `interactive.js` `dispatchMouse` :341 | SGR decode → `wheel-up/down`, `mouse-click` gestures |
| 4 | `interactive.js` `piTypingFrame` :145 (frame bytes :176) | one frame per input chunk: `\x1b[?2026h/l` sync, block cursor `\x1b[7m`, literal pads, parked cursor `\x1b[<row>;<park>H`; wrapped prompts → `writePromptBox` |
| 5 | `interactive.js` `scheduleTypingFrame` :240 | debounce → one frame per synchronous keypress burst |
| 6 | `interactive.js` `slashDialogLines` :193 | slash proposal rows narrowed by typed prefix (fuzzy-ranked) |
| 7 | `interactive.js` `closeSlashDialog` :202 | band closes in the same frame |
| 8 | `interactive.js` `markSlashRows` :210 | rows → band render (selection marker) |
| 9 | `interactive.js` `updateSlashDialog` :217 | per-keystroke narrowing; empty/`/`-left → close |
| 10 | `fuzzy.js` `fuzzyMatch` :17 / `fuzzyFilter` :87 | pi-tui fuzzy ranking for the slash band |
| 11 | `screen.js` `terminalTitle` :56-58 | **OSC-0 title writer** `\x1b]0;Observation_only - <basename>\x07` (pi's `setTitle` form, `term:414-416`); written by `enter()` ONLY when `options.title` set (:837) — the interactive path never passes one (see R3, INVALID-TITLE) |
| 12 | `screen.js` `wrapText` :106 | plain-text row split for transcript rows |
| 13 | `visible_width.js` `GRAPHEMES` :35 / `graphemeWidth` :66 / `visibleWidth` :125 | pi's shared `Intl.Segmenter` (`u:3`) + cell-width port (`u:148-206` via `rgiEmojiRegex` `u:41` + `eastAsianWidth` `u:1`) |
| 14 | `screen.js` `slicePromptRows` :163 | grapheme-boundary chunker with code-unit `start` per chunk (pi `wordWrapLine` port, incl. the >W sub-grapheme re-wrap `e:125-140`) |
| 15 | `screen.js` `promptChunks` :298 / `promptWrappedCount` :303 / `promptWrapCount` :309 | single chunk cache per (line, width); cap `max(5, floor(rows·0.3))` (pi `e:404`) |
| 16 | `screen.js` `syncPromptScroll` :319 | cursor visual-line `cRow` + scroll-offset clamp (pi `e:406-418`) |
| 17 | `screen.js` `hiddenAbove` :343 / `hiddenBelow` :346 | hidden-row counts for the bar indicators |
| 18 | `screen.js` `borderBar` :352 | `─` bar with centered ` ↑ N more ` / ` ↓ N more ` (pi `createScrollBorder` label, `e:185`) |
| 19 | `screen.js` `barLine` :728 | plain full-width `─` in borderMuted `#505050` (dark.json:13/:26) |
| 20 | `screen.js` `writingTopRow` :362 / `writingRow` :465 / `footerRows` :261 / `dialogHeight` :255 | dock geometry (box grows up; bars/footer pinned) |
| 21 | `screen.js` `viewHeight` :281 | transcript viewport height (`writingTopRow() - 2`) |
| 22 | `screen.js` `renderPromptArea` :369 | the box: wrapped rows + cursor block (chunk-local) + per-row `\x1b[K` |
| 23 | `screen.js` `renderDialogLine` :455 | the dim one-row dialog band cell |
| 24 | `screen.js` `writePromptBox` :745 | full-dock repaint for wrapped prompts / dialog open-close |
| 25 | `screen.js` `paint` :750 | per-row diff paint: viewport rows + pinned top bar (:780) + bottom bar (:787) + dialog band (:788) + footer rows (:789-791) |
| 26 | `screen.js` `resize` :1055 (+ `interactive.js` :786 `output.on("resize")` handler) | force FULL repaint on window resize (`\x1b[2J` + re-emit) |
| 27 | `screen.js` `setPromptLine` :1066 | shared writing-line state (line + cursor index) |
| 28 | `screen.js` `setDialog` :1076 | band content (slash menu / pickers / widget summaries); no-op on identical content |

### Step 2 — exact pi counterparts

| # | pi counterpart (file + function + line) |
|---|---|
| 1 | `e` `handleInput` :546 (+ `addNewLine` :1106, `handleBackspace` :1151, `submitValue` :1136, `shouldSubmitOnBackslashEnter` :1124), `i-mode` keybinding wiring (`app.clear`/`onCtrlD`/`onSubmit`, `i-mode:646-648`) |
| 2–3 | `tui-alt-screen.js` mouse decode (wheel/click) → `e` `handleMouse` :485-543 (click maps to cursor via visual line map :512) |
| 4–5 | `e` `render` :391 — pi renders once per input chunk; cursor bytes :441-455 (see R3) |
| 6–10 | slash menu = editor autocomplete: `i-mode` `BUILTIN_SLASH_COMMANDS` map :421-426, `CombinedAutocompleteProvider` :497, `setupAutocompleteProvider` :499-512 (`setAutocompleteProvider` :510/:512); rows appended BELOW the bottom border in `e` `render` :474-482; fuzzy = `pi-tui/dist/fuzzy.js` |
| 11 | `i-mode` `updateTerminalTitle` :749-757 (OSC 0 via `term` `setTitle` :414-416); called from `resetExtensionUI` :1792→:1813 (startup), `session_info_changed` :2656-2659, model switch :1538 |
| 12 | `pi-tui` `Text` wrap inside `e`/chat components |
| 13 | `u` :3 (segmenter), :148 (`graphemeWidth`), :208 (`visibleWidth`), :41 (`rgiEmojiRegex`) |
| 14 | `e` `wordWrapLine` :82-164 (force-break :117-123, sub-grapheme re-wrap :125-140), called from `layoutText` :812 |
| 15 | `e` `render` :401 (`layoutLines`), :404 (`maxVisibleLines`) |
| 16 | `e` `render` :406-408 (`cursorLineIndex`), :410-418 (scroll clamp) |
| 17 | `e` `renderTopBorder` :383-386 / `renderBottomBorder` :387-390 (pass `scrollOffset`/`linesBelow`) |
| 18 | `e` `createScrollBorder` :183-200 (label :185 ` ${direction} ${hiddenLineCount} more `; narrow-width fallback :193-199 is UNREACHABLE in obs because `cols()` clamps to ≥20, `screen.js:263`) |
| 19 | `e` :384/:388 `"─".repeat(width)` + `borderColor` = `borderMuted` (`theme.js:978`; dark.json:13 `#505050`) |
| 20 | `cv` dock :12-18 (`pendingMessages` :13, `status` :14, `editor` :16, `widgetsBelow` :17, `footer` :18) + `lay` size pass; transcript grows :23 |
| 21 | `cv` :22-26 root VStack (transcript `grow:1`, dock `basis:"auto"`) |
| 22 | `e` `render` :426 (top border), :432-468 (rows + cursor), :471 (bottom border) |
| 23 | `e` autocomplete band :474-482 (rows below the bottom border) |
| 24 | `e` `render` :391-484 (whole unit) + `cv` :12-18 dock pinning |
| 25 | `tui` render loop (per-row diff) + `tui-alt-screen.js:20-21` synchronized output |
| 26 | `tui` resize → `requestRender` → `e` `render` re-layout at new width |
| 27–28 | `e` `setTextInternal` :369-375 + cursor plumbing `e:856-874` (`hasCursorInChunk`/`adjustedCursorPos`) |

### Step 3 — per-pair justification

**Why the box exists at all (VALID):** pi's writing space is the **pi-tui EditorComponent + widget
layout engine** (`e` + `cv` + `lay`) — that engine does not exist in this harness (verified: no
pi-tui imports in `src`; extension components run on a shim). The harness's readline-box is the
mandated ONE-adaptation substitution. All box/bar/band machinery in `# 1-28` traces to that single
missing feature. `=IDENTICAL` at byte level for: the `─` bars in `#505050` (obs :83 = dark.json
borderMuted), the ` ↑ N more ` indicator shape (obs :352-356 = `e:183-197`), the wrap/cap/clamp
formulas (obs :298-341 = `e:401-418`), the per-row `\x1b[K` writes and the `\x1b[?2026h/l` sync burst
(obs :176 = `tui-alt-screen.js:20-21`). **VALID** for the readline/band substitutions
`# 1-5, 6-10, 23, 27-28` (EditorComponent + autocomplete component missing) and the `# 11` title
writer's session-name half (session naming missing — the unwired state itself is R3's INVALID-TITLE).

**INVALID divergences in this region:**

| # | divergence | pi truth | why INVALID |
|---|---|---|---|
| 22 (`renderPromptArea`) | **DUPLICATED `if (!found)` block** — outer `if (!found) {` at `screen.js:405` wraps ONLY a comment and a nested second `if (!found) {` at `:422` whose body (:439-441) is the only real code | pi has exactly ONE empty-after fallback (`e:452-456`) | Dead duplicated condition with no missing-tool cause — **INVALID-DUP** |

---

# REGION 2 — footer below the lower `─` bar (data → meters → row assembly → paint)

### Step 1 — observation functions

| # | observation (file:line) | role |
|---|---|---|
| 1 | `client.js` `createUsageTotals` :18 / `addUsageToTotals` :21 | session-cumulative usage: input/output/**cacheRead/cacheWrite (:25-26) / cost (:27)** /totalTokens — pi's `usage-totals.js` port |
| 2 | `footer.js` `formatTokens` :41 | `12.3k`-style counts (pi `cf:20-29` verbatim) |
| 3 | `footer.js` `estimateTokens` :52 | chars/4 (pi compaction estimate; meter fallback) |
| 4 | `footer.js` `createTokenRateMeter` :81 (+ `outputTokens` :58, `contentChars` :65) | tok/s: ≥300 ms windows, usage-delta preferred, EMA 0.3, round-trip final ≥1 s (pi-tps-live token-rate method) |
| 5 | `footer.js` `sanitizeStatusText` :164 | `[\r\n\t]`→space, collapse, trim (pi `cf:10-15` verbatim) |
| 6 | `footer.js` `visibleWidth` :172 / `truncateStyled` :193 | ANSI-aware width/truncate (pi-tui `visibleWidth`/`truncateToWidth` port) |
| 7 | `footer.js` `formatCwdForFooter` :222 | home→`~` folding (pi `cf:31-44` port) |
| 8 | `footer.js` `gitBranch` :234 (+ cache :248) | `git symbolic-ref --quiet --short HEAD`, 1.5 s timeout (pi `footerData.getGitBranch`) |
| 9 | `footer.js` `renderFooter` :269-332 | THE footer BLOCK: line 1 cwd+branch (+ ⚡ speed right-aligned), line 2 stats-left + model-right; colors :252-256 (dim `#666666`, error `#cc6666`, warning `#ffff00`) |
| 10 | `footer.js` `footerLine` :344 | client → footer spec (cumulative totals by default, `perTurn` opt-in) |
| 11 | `screen.js` `footerRows` :261 | footer block height feeds the dock geometry |
| 12 | `screen.js` `setFooter` :1035 | live footer spec → re-rendered at `cols()` every paint |
| 13 | `screen.js` `paint` footer rows :789-791 | pinned at the bottom `footerRows()` rows, always rewritten |
| 14 | `interactive.js` setFooter sites: :785 (startup) · :987/:989 (`/model <arg>` direct switch) · :1029 (`/model` picker) · :1117/:1125 (follow-message turn, success/catch) · :1164/:1172 (turn, success/catch) — and one-shot `round5.js:159` / `index.js:46` (stderr) | refresh after every model switch / turn |

### Step 2 — exact pi counterparts

| # | pi counterpart |
|---|---|
| 1 | `cf` render usage loop :79-97 (over session entries) + `core/usage-totals.js` `createUsageTotals`/`addUsageToTotals` |
| 2 | `cf:20-29` `formatTokens` |
| 3 | pi compaction estimateTokens (chars/4) |
| 4 | **pi-tps-live** — the registered pi package that renders the ⚡ tok/s footer element (machine-verified fact, global AGENTS.md §Pi "pi-tps-live"; NOT part of native `cf`) |
| 5 | `cf:10-15` `sanitizeStatusText` |
| 6 | `pi-tui` `visibleWidth`/`truncateToWidth` (imported at `cf:2`) |
| 7 | `cf:31-44` `formatCwdForFooter` |
| 8 | `cf:109-112` `footerData.getGitBranch()` |
| 9 | `cf` `FooterComponent.render` :75-221 (class :47) |
| 10 | `i-mode` footer source: `new FooterComponent` :364, `footer.invalidate()` :2617 (every event), :2746 (message_end), :3533 (model switch) |
| 11–12 | `cv:18` dock item `{ component: options.footer, shrink:1, minSize:0 }` + `lay` size pass; footer pinned bottom |
| 13 | `tui` render loop painting the dock bottom rows |
| 14 | `i-mode` `cycleModel` :3525-3543 (`footer.invalidate()` :3533, `Switched to …` status :3536) + per-turn `message_end` :2746 |

### Step 3 — element-by-element verdict (re-rendered `cf:75-221` against `footer.js:269-332`)

| pi footer element (cf line) | observation | verdict |
|---|---|---|
| dim cwd, home→`~` (:107, pwdLine :210) | ✓ :273, :276, :325 | =IDENTICAL |
| ` (branch)` (:109-112) | ✓ :274-275 (`gitBranch` :234) | =IDENTICAL |
| **` • sessionName`** (:111-113) | **omitted** | **VALID** — session naming is absent (pi `/name`, `core/slash-commands.js:13`; no such command in `commands.js:40-50`) |
| ⚡ `x.x tok/s` right-aligned on line 1 | ✓ :277-285 | =IDENTICAL vs **pi-tps-live** (the registered pi package owning that element; native `cf` emits no speed) |
| `↑input` (:118) | ✓ :288 | =IDENTICAL |
| `↓output` (:120) | ✓ :289 | =IDENTICAL |
| `R{cacheRead}` (:122) | ✓ :290 | =IDENTICAL |
| `W{cacheWrite}` (:124) | ✓ :291 | =IDENTICAL |
| **`CH{hitRate}%`** (:125-126) | **omitted** | **INVALID-FOOTER-DATA** — the inputs exist: `totals.cacheRead/cacheWrite` (`client.js:25-26`) + last usage (`client.js:161`); pure render omission, no missing tool |
| **`$X.XXX` cost** (:129-134, incl. ` (sub)` :133) | **omitted** | **INVALID-FOOTER-DATA** — cost IS accumulated (`client.js:27` `totals.cost += usage.cost?.total`); shown whenever the provider reports cost > 0 in pi, silently absent here |
| ctx `P%/W` (:138-151; colors :142-150) | ✓ :292-298 (>90 % error, >70 % warning — same thresholds) | =IDENTICAL |
| **`(auto)`** suffix on ctx (:138 `autoIndicator`) | **omitted** | **VALID** — auto-compaction absent (pi `/compact`, `core/slash-commands.js:23`) |
| **`?/W`** percent-null variant (:139-140) | obs emits `0.0%/W` fallback (:296) | **VALID** — the `?` state is only reachable post-compaction (feature absent) |
| **`• xp`** (:152-153) | **omitted** | **VALID** — experimental-features flag absent (no `experimental*` in `src`) |
| model right-aligned, min 2 padding (:157, :182-204) | ✓ :305, :308-321 (`minPadding = 2` :309) | =IDENTICAL (note: pi drops the `(provider)` prefix when too wide :177-180; obs truncates the model name instead :316 — same fit outcome, different truncation target) |
| ` • thinking off` / ` • {level}` (:167-171) | ✓ FIXED `off` :306 | **VALID** — thinking-level feature absent (pi `/thinking`, `core/slash-commands.js:6`); `off` is the only level the harness can have |
| `({provider}) ` prefix (:174-180) | ✓ :307 | =IDENTICAL |
| `no-model` fallback (:157) | ✓ :305 | =IDENTICAL |
| **extension-statuses line** (:213-221: sorted, sanitized, truncated 3rd line) | **omitted** | **VALID** — harness `ctx.ui.setStatus` is a no-op stub (`extensions.js:215`, :251); there is no status registry to render |

**INVALID divergences in this region: 2** (CH% :125-126, $cost :129-134). The prior audit's
"1:1 / 0 INVALID" verdict was wrong: 7 elements are omitted, of which 5 are VALID (missing
features named above) and 2 are INVALID (data tracked but never rendered).

---

# REGION 3 — cursor rendering (hide-on-work → position → block → restore)

### Step 1 — observation functions

| # | observation (file:line) | role |
|---|---|---|
| 1 | `working.js` `CURSOR_HIDE` :34 / `CURSOR_SHOW` :35 | `\x1b[?25l` / `\x1b[?25h` |
| 2 | `working.js` `createWorkingIndicator` :48 (`start` :77, `update` :89, `stop` :97) | pi `ld` `Loader` port: braille frames :25, 80 ms :28, "Working" :31; enabled gate :52 (`isTTY:false` → all no-ops) |
| 3 | `client.js` indicator :79 (create) / :113 (`start`) / :166 (`stop`) | spinner active exactly over the in-flight round trip (LINE mode) |
| 4 | `interactive.js` `piTypingFrame` :145, block bytes :176 | single-line path: `\x1b[7m<at>\x1b[27m` + pads + park (see INVALID-CURSOR-RESET) |
| 5 | `screen.js` `renderPromptArea` cursor core :396-441 | chunk-local block: glyph → `\x1b[7m<grapheme>\x1b[0m` (:400); end-of-line → `\x1b[7m \x1b[0m` (:441, W-fill pad-absorb) |
| 6 | `screen.js` `syncPromptScroll` :319 | `cRow` = chunk holding the cursor grapheme |
| 7 | `screen.js` `enter` :833 / `exit` :854 | hide on enter (:836 `CURSOR_HIDE`), show on exit (:855 `CURSOR_SHOW`); alt-screen + mouse mode |
| 8 | `screen.js` `paint` cursor park :800 | hardware cursor parked at the writing row each paint |
| 9 | `interactive.js` `dispatchMouse` :341 + :709-712 | click = jump-to-latest (no cursor reposition) |

### Step 2 — exact pi counterparts

| # | pi counterpart |
|---|---|
| 1 | `term` `hideCursor` :399 / `showCursor` :402 |
| 2–3 | `ld` `Loader` :7 (`render` :25, `start` :28, `stop` :32, `setMessage` :38, `updateDisplay` :67) + `si` `WorkingStatusIndicator` :22-26 (see R4 #13); line-mode equivalent = pi's non-fullscreen spinner |
| 4 | `e` `render` :441-455 (cursor bytes) + `tui:54` `CURSOR_MARKER` (hardware cursor for IME, stripped at `tui` `extractCursorPosition` :985-996) |
| 5 | `e` `render` :437-455; chunk-local position from `layoutText` `hasCursorInChunk`/`adjustedCursorPos` :856-874; glyph block `\x1b[7m${firstGrapheme}\x1b[0m` :448; block space `\x1b[7m \x1b[0m` :454; `cursorInPadding` :435/:458-459/:465 |
| 6 | `e` `render` :406-408 (`cursorLineIndex`) |
| 7 | `term:399-402`; `tui:212` (hide on start) / `tui:589` (show) |
| 8 | `tui` hardware-cursor placement from `extractCursorPosition` :985 (marker at :54) |
| 9 | `e` `handleMouse` :485-543 (click → cursor column via visual line map :512) |

### Step 3 — per-pair justification

**`=IDENTICAL`** for `# 1, 5, 7, 8`: the box-path cursor bytes are pi's exact `\x1b[7m<grapheme>\x1b[0m`
(`screen.js:400` = `e:448`), the end-of-line block space `\x1b[7m \x1b[0m` (`screen.js:441` = `e:454`)
with the same pad-absorb intent (`e:458-459`), and `\x1b[?25l/h` + alt-screen enter/leave match
`term:399-402`. **`VALID`** for `# 2-4, 6, 9`: pi positions the cursor through the **pi-tui
EditorComponent + IME pipeline** (hardware `CURSOR_MARKER` `tui:54`, kill-ring/undo, mouse
hit-testing `e:485-543`) — that component does not exist here; the readline park +
`rl._refreshLine` interplay is the mandated substitution.

**INVALID divergences in this region:**

| # | divergence | pi truth | why INVALID |
|---|---|---|---|
| 4 | **cursor-block reset `\x1b[27m`** in the single-line typing frame (`interactive.js:176`: `\x1b[7m${at}\x1b[27m`) | pi resets with full reset `\x1b[0m` (`e:448` `\x1b[7m${firstGrapheme}\x1b[0m`; `e:454` `\x1b[7m \x1b[0m`) | SGR 27 (double-underline off) does NOT clear reverse video — the remainder of the line keeps the block state; wrong reset byte, no missing-tool cause — **INVALID-CURSOR-RESET** (the box path `screen.js:400/:441` is already correct) |
| 11 | **OSC-0 title never written on the interactive path** — `terminalTitle` (`screen.js:56-58`) is written only when `options.title` is passed (`screen.js:837`), and `interactive.js:653` calls `createScreen({ output })` WITHOUT `title` | pi sets the title at startup (`i-mode:1792`→:1813 via `updateTerminalTitle` :749-757) and on `session_info_changed` :2657 / model switch :1538 — the base form `APP_TITLE - <cwd-basename>` requires no session name | The writer exists but is unwired — the divergence is a wiring gap, not a missing feature (the ` • sessionName ` half of pi's title IS VALID — session naming absent) — **INVALID-TITLE** |

---

# REGION 4 — tool + subagent rendering (invoke → pending block → result flip → expand)

### Step 1 — observation functions

| # | observation (file:line) | role |
|---|---|---|
| 1 | `session.js` `driveTurn` :130 (tool loop :160-215; `onTool` call :172, result :185, not-found :168, error :215) | event flow feeding the chart's tool blocks |
| 2 | `screen.js` `toolCallEntry` :485 | announcement entry: `state:"pending"` → **pending bg DURING processing**; subagent keeps `subagent: <agent>` prefix (`compactArgs`) |
| 3 | `screen.js` `applyToolResult` :511 | `state` pending → success/error → **bg flips**; `\r`-strip + BOM sanitize :528; truncation + spill :528-533 |
| 4 | `screen.js` `lastToolIndex` :475 / `lastSubagentIndex` :467 | result lands on the LAST announced block |
| 5 | `screen.js` `toolEvent` :921 | `call`/`result` events → entries |
| 6 | `screen.js` `toolLine` :943 | observation lines → subagent WORK block (collapsed) / plain rows |
| 7 | `screen.js` `entryRows` tool branch :592-596 / subagent branch :598-603 | collapsed = `toolBlockRows`; expanded = subagent context + result blocks |
| 8 | `pi_output.js` `structuredArgs` :183 / `compactArgs` :167 | args in pi's `JSON.stringify(args, null, 2)` structured form (subagent keeps the compact agent name) |
| 9 | `pi_output.js` `toolArgsRows` :200 / `wrapCell` :191 | blank row after title + one styled row per JSON line |
| 10 | `pi_output.js` `visibleLen` :213 / `toolBlockRow` :220 / `bgResetPad` :224 | full-width bg-box row (content + bg padding + one reset) |
| 11 | `pi_output.js` `toolBlockRows` :236-255 | the painted block: bold title, args rows, ≤10 gray preview, dim `... (N more lines, ctrl+o to expand)` :250-251, yellow `Output truncated. Full output: <path>` :252, red `(exit N)` :253 |
| 12 | `pi_output.js` `truncateHead` :125 / `splitLinesForCounting` :114 / `formatSize` :108 / `spillFullOutput` :157 | pi's 2000-lines/50-KB head-keep (:104-105) + real temp-file spill |
| 13 | `screen.js` `toggleSubagent` :973 + `interactive.js` :269 (ctrl+o/alt+o → `expand-subagent`) / :730 (chart) / :733-739 (line mode) | expand ↔ collapse the LAST subagent block |
| 14 | `subagent_tool.js` `setLastSubagentContext` :42 / `getLastSubagentContext` :46 / `subagentContextLines` :53 | expand body (work steps + per-step reads) |
| 15 | `subagent_tool.js` `createSubagentTool` :276 (+ `execute` :305, worker spawn :170-172) | the actual tool run (agent subprocess + summarizer) |
| 16 | `interactive.js` :787 `createWorkingIndicator({ isTTY: false })` | chart-mode spinner DISABLED (see INVALID-WORKING) |

### Step 2 — exact pi counterparts

| # | pi counterpart |
|---|---|
| 1 | `i-mode` `message_update` :2683-2708 (pending `ToolExecutionComponent` :2690-2696), `tool_execution_start` :2753-2767, `tool_execution_end` :2776-2784 |
| 2 | `te` `ToolExecutionComponent` :7 (class), pending box :49-50 (`Box(1,1, theme.bg("toolPendingBg"))`), `markExecutionStarted` :119 |
| 3 | `te` `updateResult` :129-133 → bg flip :225-229 (pending/error/success), `updateDisplay` :224; truncation = pi `core/tools` truncate (2000 lines/50 KB) + render-utils |
| 4 | `i-mode` `pendingTools` map (get :2754, set :2762, delete :2780) |
| 5 | `i-mode` event plumbing :2683-2784 |
| 6 | pi renders tool I/O inside the component (no observation lines) — the line-mode rows are the harness's non-chart path |
| 7 | `te` `updateDisplay` :224-283 (Box composition), `formatToolExecution` :324-335 |
| 8 | `te:325-328` (`JSON.stringify(this.args, null, 2)`) |
| 9 | `te` :328-329 (args on their own rows after a blank) |
| 10 | `te` `Box` bg rows (`pi-tui` `Box` — full-width bg + padding) |
| 11 | `te` `createResultFallback` :85-98 (10-line preview :8, `... (N more lines, <keyHint> to expand)` :95-97) + `keybinding-hints.js` `keyHint` |
| 12 | pi `core/tools` truncate.js (2000 lines / 50 KB head-keep; "Output truncated. Full output:" row) |
| 13 | `i-mode:2345` (`onAction("app.tools.expand")`), `toggleToolOutputExpansion` :3544-3546, `setToolsExpanded` :3547-3563, `te` `setExpanded` :168-171 |
| 14 | pi's subagent output expands INSIDE its tool block (same `setExpanded` path) — the harness's separate context block is the subagent-feature adaptation |
| 15 | pi's subagent tool (`core/tools`) — same tool-block rendering |
| 16 | `si` `WorkingStatusIndicator` :22-26 via `i-mode` `showWorkingStatusIndicator` :1707-1711 / `showStatusIndicator` :1677-1687 (embedded in the editor border via `renderInBorder` `si:11-14`, else dock status slot `cv:14`), on `turn_start` :2628-2641 (call :2634), cleared at `agent_end` :2785-2789 |

### Step 3 — per-pair justification

**`=IDENTICAL`** for `# 2-12`: bg sequences are pi `dark.json` truecolor bytes (pending `#282832` →
success `#283228` / error `#3c2828`, `pi_output.js:29-31` = dark.json:17-19), the collapse hint shape
matches `te:95-97` byte-for-byte with the harness's own expand key (`ctrl+o`, `pi_output.js:250`),
truncation follows pi's 2000-lines/50-KB head-keep + full-output spill (`truncateHead` :125,
`spillFullOutput` :157), the args block is pi's `JSON.stringify(args, null, 2)` (`te:325-328`).
**`VALID`** for `# 1, 13-15`: pi's counterpart is the **pi-tui widget stack**
(`ToolExecutionComponent`/`ExpandableText`-style expansion state) — components that do not exist
here; the harness substitutes row-state + the event loop's last-block index. The subagent context
block is the harness's own subagent feature (it EXISTS — `subagent_tool.js`), rendered in the same
tool-block family.

**INVALID divergence in this region:**

| # | divergence | pi truth | why INVALID |
|---|---|---|---|
| 16 | **Chart shows NO "Working" status row** — `createWorkingIndicator({ isTTY: false })` (`interactive.js:787`) makes the spinner a no-op (`working.js:52`, :77-78); the only during-processing signal is the pending tool bg | pi shows the `WorkingStatusIndicator` (spinner + "Working") embedded in the editor's top border (`si:11-14` `renderInBorder`) or the dock status slot (`cv:14`) on EVERY `turn_start` (`i-mode:2634` → :1707-1711 → :1677-1687), cleared at `agent_end` :2785-2789 | The spinner code already exists in the harness (`working.js` = `ld:7-72` port); pi's placement is pure byte rendering into the border/status row — no missing tool — **INVALID-WORKING** |

---

# REGION 5 — main LLM answer rendering (stream → style → document → viewport → slider)

### Step 1 — observation functions

| # | observation (file:line) | role |
|---|---|---|
| 1 | `session.js` `driveTurn` :130 `onPartial` → `interactive.js` :1111/:1155 `(partial) => screen.updateStream(partial)` | streamed chunks → live entry |
| 2 | `screen.js` `updateStream` :879 | live view rebuilt from the partial's thinking/text blocks, repainted on the go |
| 3 | `screen.js` `entryRows` thinking/answer branch :576-591 | leading blank :577-578; thinking gray :585; answer via `styleAnswerLine` :585; fences carry across lines :584-587; outputPad=1 indent :590 |
| 4 | `pi_output.js` `styleAnswerLine` :53 / `wrapStyled` :70 | per-line md styling (heading/quote/bullet/`**strong**`/`code`/`*em*`/fences) + ANSI-safe wrap |
| 5 | `pi_output.js` `COLOR` :17-33 / `MD_HEADING` :41 / `MD_CODE` :43 / `MD_CODE_BLOCK` :44 / `MD_QUOTE` :46 / `THINKING_COLOR` :47 / `DESC_ON/OFF` :49-50 | dark.json byte-exact palette (dark.json:5-19) |
| 6 | `screen.js` `content` :538 | full scrollable document (header + transcript + live entries) |
| 7 | `screen.js` `view` :610 | scroll-clamped slice; "jump to latest" overlay painted in `paint` |
| 8 | `screen.js` `scrollGeometry` :622 | thumb top/height from pi's formulas (`lay:183-206` port: thumbHeight :192, thumbOffset :195) |
| 9 | `screen.js` `markScrollbarActivity` :635 | transient scrollbar, 1 s hide timer (:99 `SCROLLBAR_HIDE_DELAY_MS`, unref'd) |
| 10 | `screen.js` `scrollByLines` :657 / `scrollToStart` :674 / `scrollToEnd` :684 | page scroll + home/end (follow-end resume) |
| 11 | `screen.js` `scrollbarToMouseRow` :704 / `scrollbarPress` :714 / `scrollbarDrag` :720 / `scrollbarRelease` :723 | thumb drag on the slider (press/jump, button-32 drag, release) |
| 12 | `screen.js` `paint` :750 — scrollbar column :756-761 (`\|` track, `█` thumb, :759), jump label :763-767 | per-row diff paint + overlays |
| 13 | `screen.js` `beginTurn` :871 / `endTurn` :887 / `freezeCurrent` :806 | streaming entries finalized into the transcript |
| 14 | `screen.js` `addHeader` :859 + `interactive.js` :754-779 | startup header rows (banner :754, map/work-dir/model :755-758, key legends :759-761, `[Context]` :772-773, `[Skills]` :776-778, `[Extensions]` :781-783, `✓ New session started` :784) |
| 15 | `interactive.js` :717-724 (pageUp/pageDown/home/end) + :707-712 (wheel/click) | scroll keys → viewport |
| 16 | `screen.js` `enter` :833 (mouse mode `MOUSE_ON` :66) / `exit` :854 | mouse mode enabled on enter, disabled on exit |

### Step 2 — exact pi counterparts

| # | pi counterpart |
|---|---|
| 1 | `i-mode` `message_start` :2665-2682 (assistant: `new AssistantMessageComponent` :2676, added :2678, `updateContent` :2679), `message_update` :2683-2708 (streamed `updateContent` :2686); `cv:4-10` `ScrollView` (`follow:"end"` :5, `scrollbar:"auto"` :8) |
| 2 | `am` `AssistantMessageComponent` :10, `updateContent` :69-131 |
| 3 | `am:76` (leading `Spacer(1)`), :89-130 (thinking runs), :85 (text `Markdown`), :111-117 (thinking `Markdown` with `{ color: theme.fg("thinkingText"), italic: true }`) |
| 4 | `md` (811-line Markdown renderer) + `markdown-transform.js`; inline styles via `applyDefaultStyle` :265-285 |
| 5 | dark.json:10-19 (`text` #d4d4d4, `gray` #808080, `green` #b5bd68, `accent` #8abeb7, `red` #cc6666, `yellow` #ffff00, …) |
| 6 | `sv` `ScrollView` :3 (`render` :186-191, `[LAYOUT_NODE]` :193-195 → `lay` scroll box) |
| 7 | `sv` `scrollTo` :101-119 (clamp), `updateLayout` :160-169 |
| 8 | `lay` `getScrollbarGeometry` :183-206 (thumbHeight :192 `max(min(2,T), min(T, round(T²/content)))`, thumbOffset :195) |
| 9 | `sv` `markScrollbarActivity` :70-85 (delay :35 `scrollbarHideDelayMs ?? 1000`, timer :84), `isScrollbarVisible` :49 |
| 10 | `sv` `scrollBy` :120-136, `scrollToStart` :138-147, `scrollToEnd` :149-158 |
| 11 | `tui-alt-screen.js` scrollbar hit-test + drag → `sv` `scrollTo`; `lay` `paintScrollbar` :208-221 |
| 12 | `lay` `paintScrollbar` :208-221 (track `"│"` :219, thumb `"█"/"┃"` :218) + `tr` `scrollToEndIndicator` :14-18 |
| 13 | `i-mode` `message_end` :2709-2749 (final `updateContent(…, false)` :2723, `footer.invalidate()` :2746) |
| 14 | `i-mode` :664-700 (logo :665-666 bold accent + dim version, startup instructions, `builtInHeader` `ExpandableText` :697) + loaded-resources sections |
| 15 | `tui` alt-screen keymap `tui.altScreen.*` (pageUp/pageDown/top/bottom) |
| 16 | `tui-alt-screen.js:20-21` synchronized output + mouse mode enable/disable |

### Step 3 — per-pair justification

**`=IDENTICAL`** for `# 6-13, 15-16`: document/view/slider are a faithful port of `sv` + `lay`
(`sv:3/49/70/101/120/138/149/160/186`, `lay:183-221`, `scrollbar:"auto"`, 1 s transient, follow-end,
`│` track, wheel/drag SGR mouse, zero-byte no-move paint gate = pi's differential renderer).
**`VALID`** for `# 1-2, 14`: the streaming `AssistantMessageComponent` + `Markdown` widget +
startup-header component do not exist here → live-entry incremental render, the ported
line-styler, and the header rows are the mandated substitutions (colors of what IS rendered are
byte-exact: thinking `#808080` :47 = dark.json:8, fenced code `#b5bd68` :44 = dark.json:7,
heading `#f0c674` :41 = dark.json:51, `#8abeb7` :43 = dark.json:10).

**INVALID divergences in this region:**

| # | divergence | pi truth | why INVALID |
|---|---|---|---|
| 7/12 | label text `jump to latest (end)` (`screen.js:103`, painted DIM at :764) | pi's exact indicator ` ↓ Jump to latest message · end ` on `selectedBg` `#3a3a4a` in `text` color (`tr:15-17`, dark.json:15) | Text + background differ with no missing-tool cause — **INVALID-TEXT-LABEL** |
| 12 | scrollbar thumb is **always** `█` (`screen.js:94`, painted :759) | pi draws `█` only while `isScrollbarActive`, **`┃` while inactive** (`lay:218`) | The inactive-glyph state is plain bytes — **INVALID-GLYPH-STATE** |
| 12 | scrollbar COLORS are the pi-tui defaults: track `\x1b[90m` + thumb `\x1b[37m` (`screen.js:95-96` = `sv:33-34` defaults) | pi i-mode passes THMED styles: track `scrollbarTrack` = darkGray `#505050` → `\x1b[38;2;80;80;80m`, thumb `scrollbarThumb` = text `#d4d4d4` → `\x1b[38;2;212;212;212m` (`i-mode:639-640`, dark.json:36-37) | Wrong hardcoded colors instead of pi's theme overrides — no missing tool — **INVALID-COLOR-SCROLLBAR** |
| 3 | **OSC133 zones absent** (0 matches of `133;` in `src`) | pi wraps the first/last line of EVERY user message in `\x1b]133;A…\x1b]133;B\x07\x1b]133;C` (`um:4-6`, :39-45) and every tool-call-free assistant message the same (`am:4-6`, :60-66) | OSC133 is a byte sequence, not a tool — **INVALID-OSC** |
| 3 | **thinking rendered WITHOUT italic** (`screen.js:585`: `THINKING_COLOR` gray only; the `ITALIC` const :73-74 is DEAD — never applied) | pi's thinking Markdown is `italic: true` in `thinkingText` (`am:111-117`; `md:278` applies `theme.italic` = chalk `\x1b[3m…\x1b[23m`, `theme.js:215-217` — the exact bytes the harness already defines at :73-74) | Missing 2 bytes, no missing tool — **INVALID-ITALIC** |
| 13 | aborted turn → obs prints dim `(interrupted)` (`screen.js:913-918` via `interactive.js:1128`/:1175) | pi prints the aborted message in ERROR color: `Operation aborted` (or `Aborted after N retry attempts`) — `am:143-148` (`i-mode:2715-2721`) | Text AND color differ, no missing tool (the retry half IS VALID — retry absent) — **INVALID-TEXT-ABORTED** |
| 13 | `stopReason === "length"` renders NOTHING in obs (stored only, `session.js:150`/:228) | pi renders `Response was truncated before completion.` in error color (`am:139-141`) | A row pi emits is entirely absent — no missing tool — **INVALID-ROW-TRUNCATED** |

(The prior audit's "INVALID-SUBSET" for the markdown coverage gap is reclassified **VALID** under the
corrected rule: the full `md` component (811 lines — links, nested lists, tables) is a pi-tui
feature that genuinely does not exist here; the line-styler is the mandated substitution, and every
style it DOES emit is byte-exact.) Coverage note: the obs line-styler (`pi_output.js:53`) renders
only heading / quote / bullet / `**strong**` / `inline-code` / `*em*` / fenced blocks — NO links,
nested lists, tables, horizontal rules, or fence-language highlighting — so the main answer is
currently a MARKDOWN SUBSET of pi's full `md` output.)

---

# REGION 6 — command interaction rendering ("/" detection → proposals → execute → output → pickers)

### Step 1 — observation functions

| # | observation (file:line) | role |
|---|---|---|
| 1 | `interactive.js` :307-312 (keypress `/` on empty line) + onKeyPress `slash-proposal` :686-690 | slash band opens the moment `/` starts a line |
| 2 | `commands.js` `slashProposalLines` :110 / `helpLines` :88 / `hotkeysLines` :101 / `extensionsLines` :123 / `skillsLines` :139 | proposal/help text (built-ins :40-50 + extension commands) |
| 3 | `commands.js` `handleCommand` :159 (dispatch :166-195; extension route :196) | pure dispatch: help/quit/new/info/model/hotkeys/reload/skills/resume/tree/extension |
| 4 | `interactive.js` :881 (call site in the commit frame flow) | line → command or turn |
| 5 | `screen.js` `out` :893 / `error` :899 / `warning` :906 / `status` :913 | the row kinds: plain / `Error: ` red / `Warning: ` yellow / dim unprefixed |
| 6 | `interactive.js` :785/:1029/:1117/:1125 (`setFooter` after command/model switch) | footer refresh |
| 7 | `interactive.js` `runPicker` :532 → TTY `pickByKeys` :547 (render :583, band :598, `> ` marker, search, `(no match)` close :590) · non-TTY `pickByLines` :618 (`renderList` :620, numbered) | /resume /tree /model pickers |
| 8 | `interactive.js` `contentText` :481 / `entryLabel` :486 | picker item text |
| 9 | `interactive.js` `renderTreeLines` :501-530 | /tree branch tree (`• ` leaf marker, `└─`/`├─` connectors) |
| 10 | `interactive.js` `screenEntriesFor` :61-76 | transcript messages → `{kind,text}` entries for `replaceTranscript` |
| 11 | `screen.js` `addUserPrompt` :866 + `entryRows` user branch :567-570 | user prompt on the `USER_MSG_BG` `#343541` box with blank pad rows above/below |
| 12 | `screen.js` `replaceTranscript` :818 (export :984) | /new /resume /tree → reload the document, follow to latest |
| 13 | `screen.js` `maxDialogRows` :1032 / `setDialog` :1076 | band capacity + content |
| 14 | `extensions.js` `extensionHandlerUi` :213 / `runExtensionCustom` :289 | extension-command UI: `custom` component in the band, `setWidget` belowEditor, `input` line-read (`interactive.js` :829-872 surface) |

### Step 2 — exact pi counterparts

| # | pi counterpart |
|---|---|
| 1 | slash menu = editor autocomplete: `i-mode` :421-426 (slash commands), :497-512 (provider), rows in `e` `render` :474-482 (bordered popup below the editor) |
| 2 | `i-mode` :421-426 from `core/slash-commands.js:2-27` (15+ built-ins incl. `/name` :13, `/thinking` :6, `/compact` :23) + help/skills sections |
| 3 | `i-mode` command handlers + `showStatus` :2939-2953 |
| 4 | `i-mode` `e` `submitValue` :1136 → command dispatch / chat transaction |
| 5 | `i-mode` `showError` :3604-3608 (`Error: ` in error color), `showWarning` :3609-3613 (`Warning: ` in warning color), `showStatus` :2939-2953 (dim, UNPREFIXED) |
| 6 | `i-mode` :3533 (model switch), :2617 (every event) |
| 7 | `i-mode` pickers = `SelectList`-based components (`components/session-selector.js`, `tree-selector.js`, `model-selector.js`) |
| 8 | `pi-tui` `select-list.js` item rows (filtering + `> ` marker) |
| 9 | `components/tree-selector.js` (branch tree with the same connector vocabulary) |
| 10 | `i-mode` `renderSessionItems` :3054 / `renderSessionEntries` :3141 |
| 11 | `um` `UserMessageComponent` :10, `Box` :29 (`outputPad`, `paddingY=1`, `theme.bg("userMessageBg")`), `render` :39-46 (+ OSC133 :44-45 — counted in R5 INVALID-OSC) |
| 12 | `i-mode` `/new` `/resume` → rebuild via `renderSessionEntries` :3141 |
| 13 | `i-mode` widgets (`setExtensionWidget` :1747) + `showStatus` :2939 |
| 14 | `i-mode` extension runner ctx.ui (`setExtensionStatus` :1666, `setExtensionWidget` :1747, custom component/input dialogs) |

### Step 3 — per-pair justification

**`=IDENTICAL`** for `# 3-6, 11-12`:
- `error()` (`screen.js:899-904`: `Error: ` + `#cc6666`) = pi `showError` :3604-3608 (`theme.fg("error", "Error: …")`, dark.json:14 red #cc6666) — byte-exact.
- **`warning()` (`screen.js:906-911`: `Warning: ` + `#ffff00`) = pi `showWarning` :3609-3613 (`theme.fg("warning", "Warning: …")`, dark.json:15 yellow #ffff00) — byte-exact.** (The prior audit's R6 INVALID-TEXT claiming "pi's warnings are unprefixed (showStatus :2939)" was a MISLABEL: `showStatus` is pi's DIM STATUS row — exactly what obs `status()` :913-918 (dim, unprefixed) ports; pi's dedicated `showWarning` DOES carry the `Warning: ` prefix.)
- user prompts on the `#343541` box with pad rows (`screen.js:88`, :567-570 = `um:29` Box, dark.json:19) and `/new`/`/resume` document rebuilds.
**`VALID`** for `# 1-2, 7-10, 13-14`: pi's slash menu and pickers are **pi-tui `SelectList` /
autocomplete popup components** (`select-list.js`, `e:474-482`, `i-mode:499-512`) and the
session/tree/model selectors — components that do not exist in this harness; the dim band rows +
`> `/numbered picker lists + the `renderTreeLines` tree are the mandated substitutions (reclassified
from the prior audit's INVALID-STYLE under the corrected rule: the divergence EXISTS BECAUSE the
pi-tui component is absent).

**INVALID divergences in this region: 0.**

---

# SUMMARY

- **Observation functions listed (rows above, all line numbers re-verified against source):**
  R1: 28 · R2: 14 · R3: 9 · R4: 16 · R5: 16 · R6: 14 → **97 observation functions.**
- **Pi pairs found: 97** — every listed observation function is paired with an exact pi
  `file:function:line` anchor above (all anchors re-opened and verified in this audit).
- **INVALID divergences: 13** — and the SUMMARY matches the tables exactly:

| Region | INVALID rows (class) | count |
|---|---|---|
| R1 | `INVALID-DUP` (screen.js:405/422) | 1 |
| R2 | `INVALID-FOOTER-DATA` ×2 (CH% cf:125-126; $cost cf:129-134) | 2 |
| R3 | `INVALID-CURSOR-RESET` (interactive.js:176 `\x1b[27m` vs e:448/454 `\x1b[0m`) · `INVALID-TITLE` (terminalTitle unwired, interactive.js:653) | 2 |
| R4 | `INVALID-WORKING` (no Working row in chart, interactive.js:787) | 1 |
| R5 | `INVALID-TEXT-LABEL` · `INVALID-GLYPH-STATE` · `INVALID-COLOR-SCROLLBAR` · `INVALID-OSC` · `INVALID-ITALIC` · `INVALID-TEXT-ABORTED` · `INVALID-ROW-TRUNCATED` | 7 |
| R6 | — | 0 |
| **Total** | **7 classes, 13 rows** | **13** |

**Corrections applied vs the rejected prior audit:**
1. **Tool-set premise** — the ACTUAL registered tools (read + fetch + subagent + extension-registered,
   `session.js:100-108`) are stated at the top; the VALID/INVALID rule is applied against that set
   and the verified feature lists (exists / genuinely absent).
2. **Footer verdict** — `cf:75-221` re-rendered element by element against `footer.js:269-332`
   (19-element table): 7 omitted elements, each classified — 5 VALID (session naming, compaction
   `(auto)`, `?/W` state, experimental `xp`, extension statuses — all named as genuinely absent
   features), **2 INVALID (CH% and $cost: the data is tracked in `client.js:25-27` but never
   rendered)**. The prior "1:1 / 0 INVALID" is withdrawn.
3. **Line cites** — every cite in this document was re-opened against source. Notably corrected:
   `um` render :39/OSC133 :44-45 (was :60-63) · `ld` :7/:25/:28/:32/:38/:67 (was :10/:31/:41/:49/:74) ·
   `sv` :3/:49/:70/:101/:120/:138/:149/:160/:186 (was :17/:48/:69/:89/:113/:137/:191) ·
   `si` `WorkingStatusIndicator` :22 (was :28) · `am` `Error: ` at :153 (was :144) + `showWarning`
   :3609-3613 (was "unprefixed") · `i-mode` `session_info_changed` :2656-2659 (was :790),
   `message_start` :2665-2682, `message_update` :2683-2708, `message_end` :2709-2749,
   `tool_execution_start` :2753-2767 / `tool_execution_end` :2776-2784, `turn_start` :2628-2641
   (was :2632-2640), `toggleToolOutputExpansion` :3544 (was :2345), `showError` :3604.
4. **Inventory completed** — added `terminalTitle` (screen.js:56) · `renderTreeLines`
   (interactive.js:501) · `screenEntriesFor` (interactive.js:61) · `wrapText` (screen.js:106) ·
   `viewHeight` (screen.js:281) · `resize()` (screen.js:1055 + interactive.js:786) · the pi_output
   renderers `compactArgs` :167 / `structuredArgs` :183 / `wrapCell` :191 / `visibleLen` :213 /
   `toolBlockRow` :220 / `bgResetPad` :224 — plus `pumpBytes`, `dispatchMouse`, the fuzzy pair,
   `visible_width.js` trio, `lastToolIndex`, the client usage/indicator plumbing, `extensionHandlerUi`/
   `runExtensionCustom`, and all one-shot footer sites. Full re-scan of `src\*.js` (26 active files)
   confirms no further rendering function is unlisted.
5. **Count + R6 mislabel fixed** — `warning()` (`screen.js:906`) emits `Warning: ` and is
   **=IDENTICAL** to pi `showWarning` (`i-mode:3609-3613`); `status()` (`screen.js:913`) does NOT
   carry a prefix and is =IDENTICAL to pi `showStatus` (`i-mode:2939-2953`). The false R6
   INVALID-TEXT row is removed and the total (13) equals the sum of the table rows (1+2+2+1+7+0).
   New INVALID rows found by the re-verification: `\x1b[27m` cursor reset (R3), unwired terminal
   title (R3), scrollbar colors (R5), missing thinking italic (R5), aborted-row wording/color (R5),
   missing `stopReason:"length"` row (R5).

**One-line summary**
`C:\Users\connessn\Observation_only_backup\backup_20260929_202516 | read+fetch+subagent+extension-tools | 97 | 97 | 13`

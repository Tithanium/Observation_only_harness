# Bundle Update Log

## 2026-10-01

* **Session: read + fetch tools consolidated into one fetch tool** (2026-10-01T13:23:18.594Z)
  * **Summary**: Analysis of the harness's two observation tools confirmed the user's gut feeling: fetch (URL + folder listing) was already the more powerful/general tool — it imported ALL of read's core (path resolution, image sniff, truncation, formatting from read_tool.js) and its shapeLinkResult was a line-for-line duplicate of read's text branch. The only capability read still had (file → text) was added to fetch's non-URL branch, making read strictly redundant. The harness now registers ONE tool: fetch (file | folder | http(s) URL, single `url` parameter) + subagent. A pre-existing one-shot bug (message never passed to driveTurn) was found and fixed during live verification.
  * **Decisions**:
    * fetch is the harness's single observation tool: file | folder | http(s) URL behind one `url` parameter; the round-3 `read` tool is retired from the toolset (no longer registered in session.js/worker.js, removed from the system prompt, which now says 'exactly two tools').
    * read_tool.js survives as the SHARED CORE module (path resolution, image sniff, truncateHead, formatSize — still imported by fetch_tool.js); createReadTool is kept only so the legacy round3/round4 entry points keep working.
    * Error-shape unification in the merged tool: missing path → 'Path not found: <resolved>' (fetch's shape, replacing read's raw ENOENT); offset beyond end → 'beyond end of content' (shapeLinkResult's shape); the merged file branch inherits shapeLinkResult's over-limit banner WITHOUT read's 'Use bash: sed …' hint (the observation-only harness has no bash).
    * The harness intentionally diverges from pi's built-in tool names (no `read` built-in anymore) — a deliberate observation-only design choice, like the original fetch tool.
  * **Changes**:
    * src/fetch_tool.js: new file branch in execute() (resolveReadPath → fsAccess F_OK → fsStat → directory? listFolderLikeLs : readFile → binary sniff → shapeLinkResult); description/parameters/promptSnippet/promptGuidelines rewritten for the three modes.
    * src/session.js: buildHarnessTools = [fetchTool, subagentTool, ...extensionToolsList()]; toolsPromptLines 'exactly two tools'; skills doc text now says 'via the fetch tool'.
    * src/worker.js: allTools = [fetchTool]; usage line [--tools fetch].
    * src/subagent_tool.js, src/skills.js, src/interactive.js, src/round5.js: user-visible strings + comments updated read+fetch → fetch.
    * agents/worker.md (project copy + ~/.Observation_only copy) frontmatter tools: fetch + body rewritten for the single tool; test-rig mockworker.md ×2 → tools: fetch.
    * test-rig/piece3 fixtures e-tool-preview.json + f-tool-truncate.json: wait markers '"path"' → '"url"', model-text marker 'the read tool answered fine' → 'answered fine'.
    * BUG FIX (pre-existing, found during live verification): src/round5.js one-shot branch did not pass `message` in driveTurn options → the one-shot message never reached the model (the door text ended in a literal 'undefined'). Added `message,` to the options object.
  * **Open questions**:
    * The piece3 pty e2e fixtures were marker-updated but NOT re-run on the rig (needs the mock server + node-pty session) — the model-dependent text markers ('answered fine') may need re-capture on the next full suite run.
    * Whether the legacy round3.js/round4.js entry points should be archived/disabled now that read lives inside fetch (they still work via the kept createReadTool export).

* **Session: ESC did not stop the subagent — the turn's AbortSignal never reached tool.execute — fixed** (2026-10-01T11:38:04.813Z)
  * **Summary**: User report: ESC (even several times) does not stop the current process (LLM answer generation / subagent). Root cause: src/session.js driveTurn called tool.execute(toolCallId, args, undefined, ...) — the 3rd arg is the turn's AbortSignal per pi's tool contract (pi dist/core/tools/tool-definition-wrapper.js: execute(toolCallId, params, signal, onUpdate, ctx)) but was hardcoded undefined, so the subagent's killProc (SIGTERM the spawned worker) never armed and the fetch tool could not listen for the abort. Plain LLM-generation interruption was ALREADY working (pty e2e: mock request closed + "Operation aborted" tail in ~100 ms). Subagent case before the fix (pty e2e, mock LLM): ESC at +7050 ms → NOTHING until +12494 ms, the worker's mock stream ran all 40 chunks (6 s) to completion. After the fix (same rig): "Operation aborted" at +110 ms after ESC, the worker process is dead by then (the abort tail can only render after tool.execute settles via the wasAborted throw), its mock connection dies after 6 of 40 chunks, zero stray worker.js processes. Fix: one line — pass options.signal (undefined on the one-shot path = behavior unchanged there).
  * **Decisions**:
    * Every tool.execute call must pass the turn's AbortSignal as the 3rd arg: execute(toolCallId, args, signal, onUpdate, ctx) — options.signal in driveTurn (undefined on one-shot/line paths is acceptable and equals prior behavior).
    * The subagent's user-visible 'still generating' stream IS the worker's partials (onTool updates) — interrupting the parent turn must therefore kill the worker process, not just abort HTTP; the killProc-on-signal pattern in subagent_tool.js is correct and now actually armed.
  * **Changes**:
    * src/session.js driveTurn tool loop: tool.execute(block.id, block.arguments, undefined, ...) → tool.execute(block.id, block.arguments, options.signal, ...) (+ contract comment).
    * Verified with a pty e2e rig (node-pty + stateful mock OpenAI server: parent → subagent tool_call → slow worker stream; ESC mid-subagent): before = abort tail 5.4 s later + worker completed 40/40 chunks; after = abort tail +110 ms, worker connection cut after 6/40 chunks, no stray worker processes.
    * Side benefit: the fetch tool now actually aborts in-flight fetches on ESC (it checks signal.aborted and listens for the whole fetch; it received undefined before).
  * **Open questions**:
    * Windows teardown cosmetics: after the worker process dies at ESC, the mock observed the TCP socket close ~1.1 s later (the mock kept writing into the void for ~6 chunks). Process-level death is immediate (<110 ms, proven by the abort-tail ordering); if this ever matters (e.g. shared upstream rate limits counting the dead connection), consider a job object / taskkill /T for the worker spawn.

## 2026-09-30

* **Session: Dead-keyboard after the two map_folder gates — root cause + fix** (2026-09-30T20:11:52.501Z)
  * **Summary**: Root-caused the "keyboard held after map_folder.md creation" bug: any `await` between a readline gate's answer and rl.close() sets kEnded on the TTY stdin (Node v24) — typed bytes never arrive again, unrecoverable from JS. Fix: interactivePreflight validates the directory with synchronous statSync (zero extra awaits); gates keep process.stdin.resume() in finally; createLineReader resumes the raw stream before subscribing the pump. Verified 4× on the real round5.js e2e + re-ask branch + 3-gate worst case.
  * **Decisions**:
    * Gate rule: rl.close() must run in the same synchronous chain as the question's answer — no await in between (even a microtask). Future gates on process.stdin must validate synchronously (statSync) or defer validation post-close.
    * Keep the defensive resume() on both sides: each gate's finally resumes process.stdin (rl.close pauses it, Node won't auto-resume a paused stream on a new data listener) AND createLineReader resumes the raw stream before attaching the pump (session immune to upstream pauses).
  * **Open questions**:
    * The exact Node-internal mechanism (why one extra microtask between answer and close advances the TTY keypress/read state into kEnded) is empirically pinned but not traced inside libuv — if a future Node upgrade changes stream state flags, re-run the pty e2e (pattern saved in VERIFIED_FACTS.md §Node TTY readline gate bug).

* **Session: settings.json BOM broke harness startup — fixed data + BOM-tolerant readJson** (2026-09-30T18:52:39.414Z)
  * **Summary**: Harness crashed at startup with "request failed: Unexpected token ' '" because ~/.Observation_only/settings.json (rewritten 2026-09-30 20:29, likely by a Windows PowerShell 5.1 writer) carried a UTF-8 BOM; Node's utf8 readFileSync does not strip it, so JSON.parse in config.js threw before any UI started. Stripped the BOM from the file and made readJson() in src/config.js BOM-tolerant with the file path included in parse errors.
  * **Decisions**:
    * readJson (src/config.js) is now BOM-tolerant: a leading U+FEFF is stripped before JSON.parse, and parse errors carry the file path ("... in <path>") so a malformed JSON file is never invisible again.
    * Any Windows-side writer of dot-folder JSON (alan_config_writer.ps1 etc.) must write UTF-8 WITHOUT BOM; the code-side tolerance is the safety net, not the source of truth.
  * **Open questions**:
    * Which writer produced the BOM-ified settings.json on 2026-09-30 ~20:29 (likely a PowerShell 5.1 Set-Content -Encoding UTF8 call during the working-folder/folder_map work) — worth pinning down so it stops emitting BOMs.

## 2026-09-29

* **Session: Footer model name jumping beside the stats after /model — composed lines were collapsed by sanitizeStatusText** (2026-09-29T09:29:57.827Z)
  * **Summary**: Second footer bug surfaced after the ANSI-escape fix: after /model (exact or picker), the model name appeared jammed right beside the stats (0.0%/128k (mock) Mock Fast) instead of at the right edge. Root cause: renderFooter returned [sanitizeStatusText(line1), sanitizeStatusText(line2)] — pi's sanitizeStatusText (correctly kept) includes .replace(/ +/g," ") + .trim(), which collapsed the 74-75 alignment pad cells to one space because pi applies that sanitizer ONLY to its extension-status text and NEVER to the composed footer lines. Fixed: the composed return now neutralizes only [\r\n\t] (newline/tab can never leak into the pinned rows) and lets the padding and ESC sequences ride along. Verified at 80/100/120 cells: footer lines are exactly width-wide with the model at the right edge after /model exact + the boot paint, /model cancel/re-select, and export sanitizeStatusText stays pi-exact.
  * **Decisions**:
    * Composed footer lines must never run through pi's sanitizeStatusText — its .replace(/ +/g," ") collapses the alignment padding; pi uses that sanitizer only for extension status text.
    * The composed-line safety path is now just [\r\n\t]→space; ESC (kept) and the width padding (kept) together deliver a stable, always-right-aligned model name before AND after /model.
  * **Changes**:
    * src/footer.js renderFooter return: replaced [sanitizeStatusText(line1), sanitizeStatusText(line2)] with a [\r\n\t]-only map — same ANSI/width guarantees, padding preserved.
    * Verified: chart paint bytes after "/model mock/mock-2" = "0.0%/256k" + 74 pad cells + "(mock) Mock Reasoner • thinking off" at the right edge; 80/100/120 widths exact; exported sanitizeStatusText still pi-exact ('a b c d').

* **Session: Observation-only harness footer fixed: ANSI escapes preserved + true-width rendering** (2026-09-29T07:54:06.329Z)
  * **Summary**: Repaired the Round-25 footer in the observation-only harness to pi behavior: (1) sanitizeStatusText in src/footer.js now matches pi's footer.js exactly (only [\r\n\t] collapsed/trimmed) — the old [\u0000-\u001f] class replaced 0x1b (ESC) with spaces, destroying every dim/reset sequence and rendering literal "[38;2;102;102;102m..." text; (2) the chart renders the footer at the true terminal width instead of the hardcoded 120 — pi's FooterComponent.render(width) renders at the real width, so the right-aligned model name was being chopped by wrapStyled(cols()) on narrower terminals. screen.setFooter now accepts the live client (re-rendered at cols() every paint; resize re-fits), interactive.js chart call sites updated; line mode and one-shot footers default to process.stdout.columns (120 in piped/injected runs, so deterministic suites keep their bytes).
  * **Decisions**:
    * sanitizeStatusText must only normalize whitespace ([\r\n\t]), never strip control chars: 0x1b ESC is a control character and must survive so the footer's ANSI dim/reset sequences reach the terminal.
    * The footer must be rendered at the true terminal width every paint (pi's FooterComponent.render(width)); a hardcoded 120 + wrapStyled(cols()) chop drops the right-aligned model name on narrower terminals.
    * screen.setFooter(client[, options]) stores the live client and re-renders at cols(); a plain string still paints a static footline (back-compat). footerLine width defaults to process.stdout.columns ?? 120, keeping piped/injected test captures at the old 120 the deterministic suites rely on.
  * **Changes**:
    * src/footer.js: sanitizeStatusText → pi's exact regex (.replace(/[\r\n\t]/g,' ').replace(/ +/g,' ').trim()); ESC codes now survive; truncateStyled gained the optional ellipsis arg the existing call sites already passed (dim("…")).
    * src/footer.js: footerLine(client, { width }) threads width through; default width ?? process.stdout?.columns ?? 120.
    * src/screen.js: setFooter(client, options) stores { client, options } and paint() (and footerRows()) re-render at cols(); all 7 chart call sites in src/interactive.js now pass the client.
    * Verified: line mode and chart at 96/80/100/120 cols — dim sequences intact, model name right-aligned, no literal '[38;2;102' leakage.

## 2026-09-28

* **Session: Slash-command filtering imported from pi (all grooves)** (2026-09-28T16:28:53.178Z)
  * **Summary**: Diagnosed the "filtering out non-matching /commands does not work" report against the current source + pi 0.86.1 (pi-tui fuzzy.js: fuzzyMatch = all query chars IN ORDER (subsequence), fuzzyFilter token-splits [\s/]+; pi autocomplete.js:203-207 passes the prefix WITHOUT the slash, zero matches cancels the menu editor.js:1978-1979). Real window (chart + real screen) already narrows identically to pi — verified with screen attached: "/" full list, "/t" → only t-containing commands with /tree first, "/treee" → menu closes. Discovered node readline emits NO keypress events on non-TTY input (only 'line'), so real line mode never routed "/" through the menu at all; the injected-event path previously reprinted the FULL proposal on every key. Port: updateSlashDialog's !screen branch now prints slashDialogLines() (same filter; bare "/" byte-identical; zero matches silent). All probes green, backups refreshed.
  * **Decisions**:
    * Line-mode/injected keypress path now uses the same slashDialogLines filter as the chart — a bare '/' keeps the round-18 full print, further keys print only matches
    * Real byte-piped line mode cannot show a slash menu (readline has no keypress events on non-TTY input) — left as-is
  * **Changes**:
    * src/interactive.js updateSlashDialog !screen branch prints filtered slashDialogLines() instead of full slashProposalLines()
  * **Open questions**:
    * Human real-window re-test of the slash menu filtering (both previous probes green with the real screen)

* **Session: Startup template port (loaded Context/Skills/Extensions presentation)** (2026-09-28T16:23:58.861Z)
  * **Summary**: Ported pi's startup presentation into the chart boot header (src/interactive.js): bold-accent logo + dim version (interactive-mode.js:697-698), dim info lines, and the loaded-resources template replacing the placeholder rows — [Context] (mdHeading #f0c674) + dim compact file list (AGENTS.md only when it exists, agents/ only when agents exist), [Skills] only when discoverSkills() is non-empty, [Extensions] only when extensionCommandsList() is non-empty; fake [Prompts]/[Prompt conflicts] placeholder rows removed (pi omits empty sections, interactive-mode.js:1322-1356; conflicts only with real diagnostics, 1375-1408). Probe verified rows/colors/omission rules 1/1 PASS, boot clean, backup refreshed.
  * **Decisions**:
    * Resource sections follow pi's omit-if-empty rule: empty skills/ dir today means no [Skills] section until a SKILL.md exists under ~/.Observation_only/skills
    * dim = theme dimGray #666666, mdHeading #f0c674, accent #8abeb7 — exact dark.json encodings
  * **Changes**:
    * src/interactive.js chart boot block rewrote the 13 header rows into the pi template; new imports existsSync/join/userDotDir/discoverSkills/discoverAgents/extensionCommandsList/COLOR/MD_CODE/MD_HEADING
  * **Open questions**:
    * Human real-window side-by-side pending: header + [Context]/[Extensions] sections vs pi
    * ExpandableText collapsed/expanded toggle (app.tools.expand reveals the full path listing) not ported — only the compact form; decide later whether the transcript-topping sections need the toggle

* **Session: Rebuild of src/interactive.js complete after overwrite incident** (2026-09-28T16:17:01.685Z)
  * **Summary**: Recovered src/interactive.js from the 854-line .bak (08:34:45 base, the only full copy left), re-ported the Step-2/3/4/4b/5a dialog layer on top, verified with a chart-mode byte-pump probe, locked the new state as src/interactive.js.rebuilt-port.js. The only port bug the probe caught: pickerActive was never SET true in runPicker (arrows stripped as idle, chain never stepped aside) and cancel-on-held-escape could hang the pick; both fixed. Full details in PROGRESS.md "Incident recovery" section.
  * **Decisions**:
    * Recovery base stays the .bak; the port is verified; the human's real-window pass remains the judge for Step 4/4b + 5a
    * pickerActive is now set in runPicker (with promise.finally release) — the reader chain steps aside while a pick is open
    * if (state.cancelled) in pickByKeys now resolves null (never hangs when the chart's held \x1b fires cancel before the picker's own keypress)
  * **Changes**:
    * src/interactive.js rebuilt: box branch + boxWasActive latch, slashDialogLines/closeSlashDialog/updateSlashDialog/markSlashRows, tab-branch fuzzy completion (row applied as `/name ` + space + close, bare-tab pull-back), pump \x1b[A/B forwarded while pickerActive||dialogOpen, pickByKeys dialog-band rendering, reader.rearmPromptGate exposure + resize handler, tree-fill rearmPromptGate
  * **Open questions**:
    * Human real-window side-by-side pass pending: pickers ↑/↓/type-narrow/Enter/Esc, /-menu ↓/↑ selection, /h+Tab → /help, answer plain+mdown styles, user box padding

* **Session: Ghost-line root cause + hard-check rule** (2026-09-28T14:45:11.425Z)
  * **Summary**: User confirmed the prompt-place step passes. Added PART 1b to goal.md: a hard rule that every technical solution must be verified IN the real pi harness source (file:line citations, UNVERIFIED markers) before implementation — triggered by the single-line-vs-box debate where capture bytes misled and only pi's render source (tui-alt-screen.js per-row \x1b[2K + \x1b[2J-on-shrink; wrapping Editor vs SelectList-only Input) settled it. The ghost-line on erasing a wrapped prompt was root-caused the same way: pi's full-dock repaint-on-shrink vs the clone's single-line path writing only row R-2; fixed via a boxWasActive latch routing the first post-collapse frame through the full-dock repaint (interactive.js lines 81/146/157/166). Pty suite 9 PASS / 1 FAIL (pre-existing paint-boundary diff).
  * **Decisions**:
    * Adopt the 5-step method as a fixed goal rule: name pi behavior → read pi source with citations → compare with src/ → implement only the pi mechanism → record citations in dev_rounds/
    * bxWasActive latch in src/interactive.js routes the first len<W frame after a wrapped prompt through the full-dock repaint (pi's x1b[2J-on-shrink semantics)
    * Byte suites stay a regression net only; the human window remains the judge
  * **Changes**:
    * goal.md: new PART 1b 'HARD RULE: verify the technical solution IN the pi harness source before implementing anything' with the 5-step checklist
    * src/interactive.js: boxWasActive latch + collapse branch (lines 81, 146, 157-166)
    * PROGRESS.md: issue 1b marked FIXED (byte-proven) with root cause + pi citations; full-run-ghost.txt 9 PASS / 1 FAIL
    * bug-ghost-pi.md: source-verified pi ghost-prevention (tui-alt-screen.js:1481-1488, editor.js:426-471) + clone gap + recommended fix
  * **Open questions**:
    * Human window re-test of the ghost-line erase flow (backspace a wrapped prompt across the boundary) — byte-proven but not yet human-verified
    * Pre-existing FAIL 'window paint-boundary states equal' remains (pi paints exact boundary states, harness merges intermediates)

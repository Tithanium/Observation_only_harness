# Bundle Update Log

## 2026-10-01
* **Session: pi-style context compaction ported (auto-compact + /compact)** (2026-10-01T19:37:47.156Z)
  * **Summary**: The Observation_only harness now compacts its context like pi: auto-compaction (overflow-retry / silent-overflow / threshold) hooked around every driveTurn round trip, plus a manual /compact command; compaction entries persist in the session jsonl and /resume /tree are compaction-aware.
  * **Decisions**:
    * Ported pi v0.85+ compaction verbatim where shapes match (DEFAULT_COMPACTION_SETTINGS 16384/20000, cut-point walk 'never cut at a tool result', split-turn prefix summary, update-prompt merge on recompaction, <read-files>/<modified-files> appendix, COMPACTION_SUMMARY_PREFIX user-message replay, footer '?' post-compaction state) â€” src/compaction.js documents each pi source file it mirrors.
    * Observation-only adaptation: <modified-files> is always empty (no write/edit tools); fetch file reads (local url) feed <read-files> and carry across recompactions on the summary message's `compaction` marker (the harness analog of the session entry's details).
    * The flat in-memory transcript and the session store must hold the SAME messages (the compaction entry being the only difference): this required pushing the turn's FINAL assistant reply into the live transcript (previously store-only) â€” without it the positional firstKeptEntryId mapping drifted by one ghost entry per turn.
    * Summarization round trip = new client.completeSummary (standalone, no tools, maxTokens = min(0.8*reserveTokens, model.maxTokens), cacheRetention 'none'); diverges from pi by NOT retrying transient stream drops (the harness client has no retry layer anywhere) â€” a failed summary is reported, never half-persisted.
    * Footer ctx % only switches to the pi getContextUsage display (estimate / '?' after compaction) once a compaction has happened in the session; before any compaction the historical session-cumulative totalTokens formula stays byte-identical for the deterministic suites.
    * settings.json `compaction` key overrides pi's defaults (enabled/reserveTokens/keepRecentTokens); enabled:false makes auto-compaction inert while /compact remains available.
    * Subagent workers (src/worker.js own client.run loop) were NOT given compaction â€” their transcripts are MAX_TURNS-bounded and isolated; main-context overflow was the reported pain point.
  * **Changes**:
    * NEW src/compaction.js â€” the compaction core (token estimates, overflow detection patterns from pi-ai overflow.js, cut points, prompts, prepare/compact) + createCompactionDriver (session-scoped state machine: beginTurn/handleRunError/handleRecoverableLength/afterTurn/compactManual/reportRecoveryGaveUp/resetState/adoptStore/refreshContextUsage).
    * src/client.js â€” completeSummary() (pi completeSimple analog).
    * src/session.js driveTurn â€” runOnce/runWithRecoverableLength wrappers around client.run (case 1 + 1b, one compact-and-retry per turn, pi's second-overflow give-up line), final reply now pushed into the transcript, afterTurn check (cases 2+3) after the final message is stored.
    * src/session_store.js â€” appendCompaction (pi's entry shape), compaction-aware contextEntries/getMessages (pi buildContextEntries), getContextEntryIds (the driver's positional id mapping).
    * src/interactive.js â€” compaction driver created once (follows live client/messages/store bindings), passed to every drive() call, /compact command handler (pi's guards), driver lifecycle on /new /resume /tree /model /reload, [compaction] transcript row in the chart, compaction row in /tree labels.
    * src/commands.js â€” /compact [instructions] registered (removed from the 'deliberately not ported' list).
    * src/round5.js â€” one-shot path gets the same driver (no store; overflow recovery + threshold there too).
    * src/footer.js â€” renderFooter/footerLine accept the compaction driver's contextUsage (client.contextUsage): '?' post-compaction, estimate afterwards, legacy formula untouched when no compaction happened.
    * README.md â€” new 'Context compaction' section + /compact in the / menu line.
  * **Open questions**:
    * Compaction was verified with a mock client (all of pi's trigger cases + store round trip + recompaction merge + split turns); a live end-to-end run against the ALAN server (a real overflow) has not been executed â€” worth one real long session to confirm the provider's actual overflow error text matches the ported patterns (the ALAN/Qwen endpoint's exact wording is unknown).
    * pi's extension hooks (session_before_compact / session_compact / session_compact_failed) are not exposed on the harness extension API â€” extensions cannot cancel or replace a compaction; pi-faithful porting of the hook seam would be the next step if ever needed.


* **Session: Removed map_folder creation from harness start** (2026-10-01T19:11:48.676Z)
  * **Summary**: The observation harness no longer builds folder maps at launch; it now only settles the required working directory and runs the recursive PDFâ†’TXT conversion over it.
  * **Decisions**:
    * map_folder.md / map_folder_full.md creation (round-2 map_folder_walk) is removed: at the start of the harness the map_folder creation is skipped, since the harness now ships its own ls/grep/find tools for folder exploration
    * The working-directory question stays REQUIRED at launch (interactivePreflight unchanged; a --work-dir on the CLI still counts as specified)
    * The PDFâ†’TXT conversion now runs UNCONDITIONALLY and RECURSIVELY once the working folder is settled (pdf2text.py over the whole tree, best-effort: a missing python or failing PDF never aborts the launch); the old y/n conversion gate and the folder-count confirmation gate are gone
    * The settings key create_folder_path and the config switch resolveCreateFolderPath were deleted as dead code
  * **Changes**:
    * src/map_walk.js rewritten: only preflightQuestion/interactivePreflight, pdf2TextScriptPath/runPdf2Text, pdfWaitLine and the new settleWorkingFolder(root, {preflight, waiting}) remain (mapFolderWalk, scanTree, fullMapContent, finalConfirm/interactiveConfirm, convertQuestion/interactiveConvert, mapWaitLine removed)
    * src/round5.js calls settleWorkingFolder; mapRef/fullMapRef removed from the runInteractiveSession and driveTurn options
    * src/session.js userContent(message) now returns the bare message (no map door); driveTurn no longer takes mapRef/fullMapRef
    * src/interactive.js: mapRef/fullMapRef removed from session opts, cmdCtx and drive calls; /info description updated
    * README.md and .Observation_only/settings.json updated (create_folder_path removed)
  * **Open questions**:
    * The map_folder.md skip-list entries in .Observation_only/extensions/git_it.ts are now vestigial (no map files are produced) â€” left in place as harmless

* **Session: /tree was faulty â€” pi's /tree method imported (row/entry zip mismatch + navigation-semantics gaps)** (2026-10-01T20:55:00.000Z)
  * **Summary**: The /tree picker selected the WRONG entry on any branched session. Root cause (diagnosed against pi 0.86.1: dist/core/agent-session.js navigateTree ~:2578, dist/core/session-manager.js getTree :1023 / buildSessionContext :235, dist/modes/interactive/components/tree-selector.js TreeList): the old code walked the store's tree for DISPLAY (renderTreeLines â€” pre-order walk) and then ZIPPED the rows against store.getEntries() (append order) with `items = entries.map((e, i) => ({ id: e.id, line: rows[i] }))`. The two orders diverge the moment a session branches (the whole point of /tree): row i displayed entry X's text but Enter selected entry Y. Reproduced: 5-entry branched session â†’ 2/5 rows mismatched, INCLUDING the row carrying the `â€¢ ` active-leaf marker selecting a different branch. Secondary gaps vs pi's method: (1) no no-op guard â€” pi's navigateTree returns "Already at this point" when the target IS the current leaf; the old code re-branched, and if the leaf was a USER entry it even moved the leaf BACK to the entry's parent; (2) the picker opened at row 0 instead of the active leaf (pi: initialSelectedId ?? currentLeafId via findNearestVisibleIndex â€” nearest visible ancestor walk, last entry fallback); (3) `â€¢ ` marked only the leaf, pi marks EVERY entry of the active rootâ†’leaf path (activePathIds); (4) the selected user entry's text overwrote the input line unconditionally â€” pi fills the editor ONLY when it is empty (`result.editorText && !editor.getText().trim()`).
  * **Decisions**:
    * A tree row and its entry id must be born in ONE walk (pi's TreeList.flattenTree invariant) â€” two orderings are never zipped. `treeItems(store)` is now the single source for the /tree picker; `renderTreeLines(store)` stays exported as a derived line-only view (suite inspection surface).
    * `â€¢ ` marks the whole active rootâ†’leaf path (pi's activePathIds), not just the leaf.
    * The picker opens on the active leaf; fallback = nearest LISTED ancestor (leafâ†’root walk), then the last item (pi's findNearestVisibleIndex fallback).
    * Re-selecting the current leaf is a no-op printing "tree: already at this point" (pi: "Already at this point").
    * pi's richer tree UX (filter modes default/no-tools/user-only/labeled-only/all, fold/unfold, labels, copy, branch summarization with branch_summary entries) is DELIBERATELY NOT ported â€” the harness picker stays the reduced set (type-to-search, â†‘/â†“, enter, esc); no summarizer exists in the harness, so abandoned branches stay plain history in the same file (pi's navigateTree file semantics ARE kept: branch() moves the leaf, appends continue to the same file).
  * **Changes**:
    * src/session_store.js: new `getTree()` on every store â€” pi's SessionManager.getTree ported (one node { entry, children } per entry; roots = parentId null/undefined PLUS orphans, pi's rule, so no entry silently vanishes; children sorted by timestamp; iterative post-order sort â€” deep-tree safe).
    * src/interactive.js: new `treeItems(store)` â€” single iterative pre-order walk of store.getTree() producing { id, line } pairs together (children pushed in reverse; per-frame `last` flag), `â€¢ ` marker from the leafâ†’root active path; `renderTreeLines` re-implemented as `treeItems(store).map(it => it.line)` (kept export).
    * src/interactive.js /tree handler: items from treeItems (zip bug gone); startIndex = active leaf with the ancestor-walk fallback; no-op guard on re-selecting the leaf; user entry â†’ store.branch(entry.parentId) + `editor: <text>` print (unchanged) + input line filled ONLY when `reader.rl.line` is empty (pi's guard); other entries â†’ store.branch(entry.id) (unchanged).
    * src/commands.js: /tree describe updated ("opens at the active leaf Â· â€¢ marks the active path â€¦ only when empty â€¦ continues from its PARENT").
  * **Verification**:
    * Old-code repro (branched 5-entry session): 2/5 picker rows displayed another entry's text; the active-leaf marker row selected the wrong branch; selecting the leaf user entry moved the leaf to its parent (no no-op). Confirmed before the fix.
    * Post-fix: same scenario â†’ every row selects the entry it displays (the marker row selects the true leaf).
    * Line-mode E2E (runInteractiveSession, injected non-TTY PassThrough, fake driveTurn honoring session.js's messages.push + onMessage contract): turn â†’ /tree pick user entry (leafâ†’head, `editor:` print) â†’ re-typed line appends as NEW branch child of head â†’ /tree pick the other branch's assistant â†’ /tree pick the abandoned branch's assistant â†’ /tree re-select the leaf (no-op "tree: already at this point") â†’ next turn appends under the navigated branch â†’ /quit, clean exit. All selections landed on the right entries.
    * 36/36 src files `node --check` OK; interactive.js imports clean with both exports (treeItems, renderTreeLines) present.
    * Re-verifiable one-liner (from the repo root): `node --input-type=module -e "import('./src/session_store.js').then(async (ss)=>{const m=await import('./src/interactive.js'); const store=ss.createSessionStore({workDir:'C:/x'}); store.appendHead({sections:{},toolsAdded:[]}); const u1=store.appendMessage({role:'user',content:[{type:'text',text:'hello'}]}); const a1=store.appendMessage({role:'assistant',content:[{type:'text',text:'hi'}]}); store.branch(store.getEntry(u1).parentId); store.appendMessage({role:'user',content:[{type:'text',text:'second'}]}); store.branch(a1); store.appendMessage({role:'user',content:[{type:'text',text:'third'}]}); const items=m.treeItems(store); const bad=items.filter(it=>{const t=store.getEntry(it.id).message?.content?.[0]?.text??'';return t!==''&&!it.line.includes(t)}); console.log(bad.length===0?'TREE-MAPPING-OK':'TREE-MAPPING-FAIL')})"` â†’ TREE-MAPPING-OK.
    * git: backup branch `backup/pre-tree-fix` (8999cde) taken before the change; fix committed on main.
  * **Open questions**:
    * Chart-mode (screen) /tree visual was verified by code path only (dialog band + startIndex render), not on a real terminal â€” run `node src/round5.js --interactive`, branch once, then /tree to eyeball the leaf-cursor + active-path markers.
    * If pi's filter modes (user-only / no-tools) are ever wanted, they slot into treeItems as a visibility predicate + the picker's existing search â€” no picker-engine change needed.

* **Session: read + fetch tools consolidated into one fetch tool** (2026-10-01T13:23:18.594Z)
  * **Summary**: Analysis of the harness's two observation tools confirmed the user's gut feeling: fetch (URL + folder listing) was already the more powerful/general tool â€” it imported ALL of read's core (path resolution, image sniff, truncation, formatting from read_tool.js) and its shapeLinkResult was a line-for-line duplicate of read's text branch. The only capability read still had (file â†’ text) was added to fetch's non-URL branch, making read strictly redundant. The harness now registers ONE tool: fetch (file | folder | http(s) URL, single `url` parameter) + subagent. A pre-existing one-shot bug (message never passed to driveTurn) was found and fixed during live verification.
  * **Decisions**:
    * fetch is the harness's single observation tool: file | folder | http(s) URL behind one `url` parameter; the round-3 `read` tool is retired from the toolset (no longer registered in session.js/worker.js, removed from the system prompt, which now says 'exactly two tools').
    * read_tool.js survives as the SHARED CORE module (path resolution, image sniff, truncateHead, formatSize â€” still imported by fetch_tool.js); createReadTool is kept only so the legacy round3/round4 entry points keep working.
    * Error-shape unification in the merged tool: missing path â†’ 'Path not found: <resolved>' (fetch's shape, replacing read's raw ENOENT); offset beyond end â†’ 'beyond end of content' (shapeLinkResult's shape); the merged file branch inherits shapeLinkResult's over-limit banner WITHOUT read's 'Use bash: sed â€¦' hint (the observation-only harness has no bash).
    * The harness intentionally diverges from pi's built-in tool names (no `read` built-in anymore) â€” a deliberate observation-only design choice, like the original fetch tool.
  * **Changes**:
    * src/fetch_tool.js: new file branch in execute() (resolveReadPath â†’ fsAccess F_OK â†’ fsStat â†’ directory? listFolderLikeLs : readFile â†’ binary sniff â†’ shapeLinkResult); description/parameters/promptSnippet/promptGuidelines rewritten for the three modes.
    * src/session.js: buildHarnessTools = [fetchTool, subagentTool, ...extensionToolsList()]; toolsPromptLines 'exactly two tools'; skills doc text now says 'via the fetch tool'.
    * src/worker.js: allTools = [fetchTool]; usage line [--tools fetch].
    * src/subagent_tool.js, src/skills.js, src/interactive.js, src/round5.js: user-visible strings + comments updated read+fetch â†’ fetch.
    * agents/worker.md (project copy + ~/.Observation_only copy) frontmatter tools: fetch + body rewritten for the single tool; test-rig mockworker.md Ã—2 â†’ tools: fetch.
    * test-rig/piece3 fixtures e-tool-preview.json + f-tool-truncate.json: wait markers '"path"' â†’ '"url"', model-text marker 'the read tool answered fine' â†’ 'answered fine'.
    * BUG FIX (pre-existing, found during live verification): src/round5.js one-shot branch did not pass `message` in driveTurn options â†’ the one-shot message never reached the model (the door text ended in a literal 'undefined'). Added `message,` to the options object.
  * **Open questions**:
    * The piece3 pty e2e fixtures were marker-updated but NOT re-run on the rig (needs the mock server + node-pty session) â€” the model-dependent text markers ('answered fine') may need re-capture on the next full suite run.
    * Whether the legacy round3.js/round4.js entry points should be archived/disabled now that read lives inside fetch (they still work via the kept createReadTool export).

* **Session: ESC did not stop the subagent â€” the turn's AbortSignal never reached tool.execute â€” fixed** (2026-10-01T11:38:04.813Z)
  * **Summary**: User report: ESC (even several times) does not stop the current process (LLM answer generation / subagent). Root cause: src/session.js driveTurn called tool.execute(toolCallId, args, undefined, ...) â€” the 3rd arg is the turn's AbortSignal per pi's tool contract (pi dist/core/tools/tool-definition-wrapper.js: execute(toolCallId, params, signal, onUpdate, ctx)) but was hardcoded undefined, so the subagent's killProc (SIGTERM the spawned worker) never armed and the fetch tool could not listen for the abort. Plain LLM-generation interruption was ALREADY working (pty e2e: mock request closed + "Operation aborted" tail in ~100 ms). Subagent case before the fix (pty e2e, mock LLM): ESC at +7050 ms â†’ NOTHING until +12494 ms, the worker's mock stream ran all 40 chunks (6 s) to completion. After the fix (same rig): "Operation aborted" at +110 ms after ESC, the worker process is dead by then (the abort tail can only render after tool.execute settles via the wasAborted throw), its mock connection dies after 6 of 40 chunks, zero stray worker.js processes. Fix: one line â€” pass options.signal (undefined on the one-shot path = behavior unchanged there).
  * **Decisions**:
    * Every tool.execute call must pass the turn's AbortSignal as the 3rd arg: execute(toolCallId, args, signal, onUpdate, ctx) â€” options.signal in driveTurn (undefined on one-shot/line paths is acceptable and equals prior behavior).
    * The subagent's user-visible 'still generating' stream IS the worker's partials (onTool updates) â€” interrupting the parent turn must therefore kill the worker process, not just abort HTTP; the killProc-on-signal pattern in subagent_tool.js is correct and now actually armed.
  * **Changes**:
    * src/session.js driveTurn tool loop: tool.execute(block.id, block.arguments, undefined, ...) â†’ tool.execute(block.id, block.arguments, options.signal, ...) (+ contract comment).
    * Verified with a pty e2e rig (node-pty + stateful mock OpenAI server: parent â†’ subagent tool_call â†’ slow worker stream; ESC mid-subagent): before = abort tail 5.4 s later + worker completed 40/40 chunks; after = abort tail +110 ms, worker connection cut after 6/40 chunks, no stray worker processes.
    * Side benefit: the fetch tool now actually aborts in-flight fetches on ESC (it checks signal.aborted and listens for the whole fetch; it received undefined before).
  * **Open questions**:
    * Windows teardown cosmetics: after the worker process dies at ESC, the mock observed the TCP socket close ~1.1 s later (the mock kept writing into the void for ~6 chunks). Process-level death is immediate (<110 ms, proven by the abort-tail ordering); if this ever matters (e.g. shared upstream rate limits counting the dead connection), consider a job object / taskkill /T for the worker spawn.

## 2026-09-30

* **Session: Dead-keyboard after the two map_folder gates â€” root cause + fix** (2026-09-30T20:11:52.501Z)
  * **Summary**: Root-caused the "keyboard held after map_folder.md creation" bug: any `await` between a readline gate's answer and rl.close() sets kEnded on the TTY stdin (Node v24) â€” typed bytes never arrive again, unrecoverable from JS. Fix: interactivePreflight validates the directory with synchronous statSync (zero extra awaits); gates keep process.stdin.resume() in finally; createLineReader resumes the raw stream before subscribing the pump. Verified 4Ã— on the real round5.js e2e + re-ask branch + 3-gate worst case.
  * **Decisions**:
    * Gate rule: rl.close() must run in the same synchronous chain as the question's answer â€” no await in between (even a microtask). Future gates on process.stdin must validate synchronously (statSync) or defer validation post-close.
    * Keep the defensive resume() on both sides: each gate's finally resumes process.stdin (rl.close pauses it, Node won't auto-resume a paused stream on a new data listener) AND createLineReader resumes the raw stream before attaching the pump (session immune to upstream pauses).
  * **Open questions**:
    * The exact Node-internal mechanism (why one extra microtask between answer and close advances the TTY keypress/read state into kEnded) is empirically pinned but not traced inside libuv â€” if a future Node upgrade changes stream state flags, re-run the pty e2e (pattern saved in VERIFIED_FACTS.md Â§Node TTY readline gate bug).

* **Session: settings.json BOM broke harness startup â€” fixed data + BOM-tolerant readJson** (2026-09-30T18:52:39.414Z)
  * **Summary**: Harness crashed at startup with "request failed: Unexpected token ' '" because ~/.Observation_only/settings.json (rewritten 2026-09-30 20:29, likely by a Windows PowerShell 5.1 writer) carried a UTF-8 BOM; Node's utf8 readFileSync does not strip it, so JSON.parse in config.js threw before any UI started. Stripped the BOM from the file and made readJson() in src/config.js BOM-tolerant with the file path included in parse errors.
  * **Decisions**:
    * readJson (src/config.js) is now BOM-tolerant: a leading U+FEFF is stripped before JSON.parse, and parse errors carry the file path ("... in <path>") so a malformed JSON file is never invisible again.
    * Any Windows-side writer of dot-folder JSON (alan_config_writer.ps1 etc.) must write UTF-8 WITHOUT BOM; the code-side tolerance is the safety net, not the source of truth.
  * **Open questions**:
    * Which writer produced the BOM-ified settings.json on 2026-09-30 ~20:29 (likely a PowerShell 5.1 Set-Content -Encoding UTF8 call during the working-folder/folder_map work) â€” worth pinning down so it stops emitting BOMs.

## 2026-09-29

* **Session: Footer model name jumping beside the stats after /model â€” composed lines were collapsed by sanitizeStatusText** (2026-09-29T09:29:57.827Z)
  * **Summary**: Second footer bug surfaced after the ANSI-escape fix: after /model (exact or picker), the model name appeared jammed right beside the stats (0.0%/128k (mock) Mock Fast) instead of at the right edge. Root cause: renderFooter returned [sanitizeStatusText(line1), sanitizeStatusText(line2)] â€” pi's sanitizeStatusText (correctly kept) includes .replace(/ +/g," ") + .trim(), which collapsed the 74-75 alignment pad cells to one space because pi applies that sanitizer ONLY to its extension-status text and NEVER to the composed footer lines. Fixed: the composed return now neutralizes only [\r\n\t] (newline/tab can never leak into the pinned rows) and lets the padding and ESC sequences ride along. Verified at 80/100/120 cells: footer lines are exactly width-wide with the model at the right edge after /model exact + the boot paint, /model cancel/re-select, and export sanitizeStatusText stays pi-exact.
  * **Decisions**:
    * Composed footer lines must never run through pi's sanitizeStatusText â€” its .replace(/ +/g," ") collapses the alignment padding; pi uses that sanitizer only for extension status text.
    * The composed-line safety path is now just [\r\n\t]â†’space; ESC (kept) and the width padding (kept) together deliver a stable, always-right-aligned model name before AND after /model.
  * **Changes**:
    * src/footer.js renderFooter return: replaced [sanitizeStatusText(line1), sanitizeStatusText(line2)] with a [\r\n\t]-only map â€” same ANSI/width guarantees, padding preserved.
    * Verified: chart paint bytes after "/model mock/mock-2" = "0.0%/256k" + 74 pad cells + "(mock) Mock Reasoner â€¢ thinking off" at the right edge; 80/100/120 widths exact; exported sanitizeStatusText still pi-exact ('a b c d').

* **Session: Observation-only harness footer fixed: ANSI escapes preserved + true-width rendering** (2026-09-29T07:54:06.329Z)
  * **Summary**: Repaired the Round-25 footer in the observation-only harness to pi behavior: (1) sanitizeStatusText in src/footer.js now matches pi's footer.js exactly (only [\r\n\t] collapsed/trimmed) â€” the old [\u0000-\u001f] class replaced 0x1b (ESC) with spaces, destroying every dim/reset sequence and rendering literal "[38;2;102;102;102m..." text; (2) the chart renders the footer at the true terminal width instead of the hardcoded 120 â€” pi's FooterComponent.render(width) renders at the real width, so the right-aligned model name was being chopped by wrapStyled(cols()) on narrower terminals. screen.setFooter now accepts the live client (re-rendered at cols() every paint; resize re-fits), interactive.js chart call sites updated; line mode and one-shot footers default to process.stdout.columns (120 in piped/injected runs, so deterministic suites keep their bytes).
  * **Decisions**:
    * sanitizeStatusText must only normalize whitespace ([\r\n\t]), never strip control chars: 0x1b ESC is a control character and must survive so the footer's ANSI dim/reset sequences reach the terminal.
    * The footer must be rendered at the true terminal width every paint (pi's FooterComponent.render(width)); a hardcoded 120 + wrapStyled(cols()) chop drops the right-aligned model name on narrower terminals.
    * screen.setFooter(client[, options]) stores the live client and re-renders at cols(); a plain string still paints a static footline (back-compat). footerLine width defaults to process.stdout.columns ?? 120, keeping piped/injected test captures at the old 120 the deterministic suites rely on.
  * **Changes**:
    * src/footer.js: sanitizeStatusText â†’ pi's exact regex (.replace(/[\r\n\t]/g,' ').replace(/ +/g,' ').trim()); ESC codes now survive; truncateStyled gained the optional ellipsis arg the existing call sites already passed (dim("â€¦")).
    * src/footer.js: footerLine(client, { width }) threads width through; default width ?? process.stdout?.columns ?? 120.
    * src/screen.js: setFooter(client, options) stores { client, options } and paint() (and footerRows()) re-render at cols(); all 7 chart call sites in src/interactive.js now pass the client.
    * Verified: line mode and chart at 96/80/100/120 cols â€” dim sequences intact, model name right-aligned, no literal '[38;2;102' leakage.

## 2026-09-28

* **Session: Slash-command filtering imported from pi (all grooves)** (2026-09-28T16:28:53.178Z)
  * **Summary**: Diagnosed the "filtering out non-matching /commands does not work" report against the current source + pi 0.86.1 (pi-tui fuzzy.js: fuzzyMatch = all query chars IN ORDER (subsequence), fuzzyFilter token-splits [\s/]+; pi autocomplete.js:203-207 passes the prefix WITHOUT the slash, zero matches cancels the menu editor.js:1978-1979). Real window (chart + real screen) already narrows identically to pi â€” verified with screen attached: "/" full list, "/t" â†’ only t-containing commands with /tree first, "/treee" â†’ menu closes. Discovered node readline emits NO keypress events on non-TTY input (only 'line'), so real line mode never routed "/" through the menu at all; the injected-event path previously reprinted the FULL proposal on every key. Port: updateSlashDialog's !screen branch now prints slashDialogLines() (same filter; bare "/" byte-identical; zero matches silent). All probes green, backups refreshed.
  * **Decisions**:
    * Line-mode/injected keypress path now uses the same slashDialogLines filter as the chart â€” a bare '/' keeps the round-18 full print, further keys print only matches
    * Real byte-piped line mode cannot show a slash menu (readline has no keypress events on non-TTY input) â€” left as-is
  * **Changes**:
    * src/interactive.js updateSlashDialog !screen branch prints filtered slashDialogLines() instead of full slashProposalLines()
  * **Open questions**:
    * Human real-window re-test of the slash menu filtering (both previous probes green with the real screen)

* **Session: Startup template port (loaded Context/Skills/Extensions presentation)** (2026-09-28T16:23:58.861Z)
  * **Summary**: Ported pi's startup presentation into the chart boot header (src/interactive.js): bold-accent logo + dim version (interactive-mode.js:697-698), dim info lines, and the loaded-resources template replacing the placeholder rows â€” [Context] (mdHeading #f0c674) + dim compact file list (AGENTS.md only when it exists, agents/ only when agents exist), [Skills] only when discoverSkills() is non-empty, [Extensions] only when extensionCommandsList() is non-empty; fake [Prompts]/[Prompt conflicts] placeholder rows removed (pi omits empty sections, interactive-mode.js:1322-1356; conflicts only with real diagnostics, 1375-1408). Probe verified rows/colors/omission rules 1/1 PASS, boot clean, backup refreshed.
  * **Decisions**:
    * Resource sections follow pi's omit-if-empty rule: empty skills/ dir today means no [Skills] section until a SKILL.md exists under ~/.Observation_only/skills
    * dim = theme dimGray #666666, mdHeading #f0c674, accent #8abeb7 â€” exact dark.json encodings
  * **Changes**:
    * src/interactive.js chart boot block rewrote the 13 header rows into the pi template; new imports existsSync/join/userDotDir/discoverSkills/discoverAgents/extensionCommandsList/COLOR/MD_CODE/MD_HEADING
  * **Open questions**:
    * Human real-window side-by-side pending: header + [Context]/[Extensions] sections vs pi
    * ExpandableText collapsed/expanded toggle (app.tools.expand reveals the full path listing) not ported â€” only the compact form; decide later whether the transcript-topping sections need the toggle

* **Session: Rebuild of src/interactive.js complete after overwrite incident** (2026-09-28T16:17:01.685Z)
  * **Summary**: Recovered src/interactive.js from the 854-line .bak (08:34:45 base, the only full copy left), re-ported the Step-2/3/4/4b/5a dialog layer on top, verified with a chart-mode byte-pump probe, locked the new state as src/interactive.js.rebuilt-port.js. The only port bug the probe caught: pickerActive was never SET true in runPicker (arrows stripped as idle, chain never stepped aside) and cancel-on-held-escape could hang the pick; both fixed. Full details in PROGRESS.md "Incident recovery" section.
  * **Decisions**:
    * Recovery base stays the .bak; the port is verified; the human's real-window pass remains the judge for Step 4/4b + 5a
    * pickerActive is now set in runPicker (with promise.finally release) â€” the reader chain steps aside while a pick is open
    * if (state.cancelled) in pickByKeys now resolves null (never hangs when the chart's held \x1b fires cancel before the picker's own keypress)
  * **Changes**:
    * src/interactive.js rebuilt: box branch + boxWasActive latch, slashDialogLines/closeSlashDialog/updateSlashDialog/markSlashRows, tab-branch fuzzy completion (row applied as `/name ` + space + close, bare-tab pull-back), pump \x1b[A/B forwarded while pickerActive||dialogOpen, pickByKeys dialog-band rendering, reader.rearmPromptGate exposure + resize handler, tree-fill rearmPromptGate
  * **Open questions**:
    * Human real-window side-by-side pass pending: pickers â†‘/â†“/type-narrow/Enter/Esc, /-menu â†“/â†‘ selection, /h+Tab â†’ /help, answer plain+mdown styles, user box padding

* **Session: Ghost-line root cause + hard-check rule** (2026-09-28T14:45:11.425Z)
  * **Summary**: User confirmed the prompt-place step passes. Added PART 1b to goal.md: a hard rule that every technical solution must be verified IN the real pi harness source (file:line citations, UNVERIFIED markers) before implementation â€” triggered by the single-line-vs-box debate where capture bytes misled and only pi's render source (tui-alt-screen.js per-row \x1b[2K + \x1b[2J-on-shrink; wrapping Editor vs SelectList-only Input) settled it. The ghost-line on erasing a wrapped prompt was root-caused the same way: pi's full-dock repaint-on-shrink vs the clone's single-line path writing only row R-2; fixed via a boxWasActive latch routing the first post-collapse frame through the full-dock repaint (interactive.js lines 81/146/157/166). Pty suite 9 PASS / 1 FAIL (pre-existing paint-boundary diff).
  * **Decisions**:
    * Adopt the 5-step method as a fixed goal rule: name pi behavior â†’ read pi source with citations â†’ compare with src/ â†’ implement only the pi mechanism â†’ record citations in dev_rounds/
    * bxWasActive latch in src/interactive.js routes the first len<W frame after a wrapped prompt through the full-dock repaint (pi's x1b[2J-on-shrink semantics)
    * Byte suites stay a regression net only; the human window remains the judge
  * **Changes**:
    * goal.md: new PART 1b 'HARD RULE: verify the technical solution IN the pi harness source before implementing anything' with the 5-step checklist
    * src/interactive.js: boxWasActive latch + collapse branch (lines 81, 146, 157-166)
    * PROGRESS.md: issue 1b marked FIXED (byte-proven) with root cause + pi citations; full-run-ghost.txt 9 PASS / 1 FAIL
    * bug-ghost-pi.md: source-verified pi ghost-prevention (tui-alt-screen.js:1481-1488, editor.js:426-471) + clone gap + recommended fix
  * **Open questions**:
    * Human window re-test of the ghost-line erase flow (backspace a wrapped prompt across the boundary) â€” byte-proven but not yet human-verified
    * Pre-existing FAIL 'window paint-boundary states equal' remains (pi paints exact boundary states, harness merges intermediates)

// src/map_walk.js
// Round 2 feature: map_folder_walk (new, not from pi). At harness start, walk the
// working folder and each subfolder recursively and write a map_folder.md in EVERY
// folder of residence: one line per file and per subfolder existing there, each
// line being the entry's path, relative to the working folder, forward slashes,
// "/" suffix on subfolders (pi-style: relative-if-inside-cwd, "/" separators).
// Deterministic (case-insensitive sorted) and idempotent (map_folder.md and
// map_folder_full.md are never listed, so a second run regenerates byte-identical
// files). The working folder also receives map_folder_full.md: the FULL structure
// of the whole tree as ONE mermaid graph — every folder and every file, one node
// per entry, one edge per parent→child link (human AND machine readable); it
// contains EVERYTHING and can be LARGE — the harness hands its path to the LLM as
// the file a SUBAGENT should read to extract the paths of interest. Symlinks are
// listed but never followed (pi never follows symlinks -> no cycles, no junction
// descent). Robust: an unreadable dir's SUBTREE is skipped and a map whose
// write is refused (EPERM, e.g. AppData\Roaming\Microsoft\Installer) is
// omitted — the walk NEVER aborts, the harness always reaches the conversation
// point.
//
// THE CONFIRMATION GATES (post-round-12, working directory REQUIRED at launch,
// 2026-09-30): STEP 1 is the WORKING-DIRECTORY QUESTION — on a real terminal
// the harness first says "Specify the working directory to map (path with or
// without a trailing \, launch folder: \"<root>\") :". The answer is REQUIRED:
// the harness NEVER walks the launch folder by default — it walks the
// directory the user names. An empty answer re-asks; a path that is not an
// existing directory is reported and re-asked. The path is accepted WITH OR
// WITHOUT a trailing separator ("C:\foo", "C:\foo\", "C:/foo/" all settle to
// "C:\foo"; a drive root "C:\" keeps its separator; relative paths resolve
// against the launch folder) and is validated as an existing directory BEFORE
// ANY pass over the tree — NO folder size shown (2026-09-25: there is no O(1)
// folder-size API on Windows; the per-file stat pass made the launch far too
// slow on big trees → removed, the pass is readdir-only). ONLY THEN is the
// number of folders RETRIEVED and the LAST
// validation asked: "…creation/update of <folders> map_folder.md files in each
// subfolder. Do you want to continue [y] Yes, [n] no :". A "no" SKIPS the walk
// (declined → no map_folder.md / map_folder_full.md is created/updated
// anywhere) and the harness still starts; a piped/closed stdin (one-shot,
// tests) never asks (auto-continue on the given root). When the walk RUNS, a
// WAITING line is shown (the walk on a big tree is slow).
import { readdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { resolveCreateFolderPath, userDotDir } from "./config.js";

export const MAP_FILE = "map_folder.md";
export const FULL_MAP_FILE = "map_folder_full.md";

/** "a/b" — always "/" separators. */
function fwd(p) {
  return p.split(sep).join("/");
}

/** Case-insensitive stable compare, pi ls-style; byte order breaks ties. */
function compareLines(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A PDF entry (a case-insensitive ".pdf" extension) — filtered OUT of the maps
 *  (map_folder.md + map_folder_full.md): STEP 1.5 (pdf2text) turns PDFs into
 *  readable .txt files, and the .txt is what the harness reads — the raw .pdf
 *  never appears in a map. */
function isPdf(name) {
  return /\.pdf$/i.test(name);
}

/** Mermaid quoted labels: a `"` inside a path becomes `#quot;` (mermaid entities). */
function mermaidEscape(s) {
  return s.replace(/"/g, "#quot;");
}

/** The FULL mermaid map (map_folder_full.md) — the whole tree in ONE file: one node
 *  per folder AND per file (label = the entry's path relative to the working
 *  folder, "." = the working folder, folders carry a "/" suffix), one edge per
 *  parent → child link. Human AND machine readable, deterministic (BFS listings
 *  order, case-insensitive sorted) → byte-identical across runs. The harness
 *  hands this path to the LLM: it contains ALL of it (every folder, every file,
 *  not only the working folder) and can be LARGE — a subagent should read it to
 *  extract the paths of interest. */
export function fullMapContent(rootDir, listings) {
  let fileCount = 0;
  for (const dirLines of listings.values()) for (const l of dirLines) if (!l.endsWith("/")) fileCount += 1;
  const header = [
    `# ${FULL_MAP_FILE} — the FULL structure of ${rootDir} as one mermaid graph`,
    "",
    "Human AND machine readable: ONE node per folder and per file of the working",
    "folder (label = the path relative to the working folder, \".\" = the working",
    "folder, folders carry a \"/\" suffix), ONE edge per parent \u2192 child link.",
    "It contains ALL folders and files — everything, not only the working folder —",
    "and can be LARGE: do not read it whole, have a SUBAGENT read it and hand back",
    "the paths of interest.",
    "",
    `${listings.size} folder(s) mapped \u00b7 ${fileCount} file(s) mapped`,
    "",
    "```mermaid",
    "graph TD",
  ].join("\n");
  const lines = ['  n0["."]'];
  const parent = new Map([[rootDir, "n0"]]); // absDir -> node id (BFS: a folder's node comes before its children)
  let id = 0;
  for (const [dir, dirLines] of listings) {
    const parentId = parent.get(dir);
    for (const line of dirLines) {
      id += 1;
      const node = `n${id}`;
      lines.push(`  ${node}["${mermaidEscape(line)}"]`);
      lines.push(`  ${parentId} --> ${node}`);
      parent.set(resolve(rootDir, line), node); // a dir's children hang under its own node
    }
  }
  return `${header}\n${lines.join("\n")}\n\`\`\`\n`;
}

/** STEP 1 — ONE pass over the tree: per-dir sorted listings (paths relative to
 *  rootDir; a dir's entry is a plain path — NO per-file stat: there is no O(1)
 *  folder-size API on Windows and the size pass made the launch far too slow on
 *  big trees, removed 2026-09-25) + the skipped counters. BFS: parent
 *  folder BEFORE its children (a mermaid node exists before its edges). */
async function scanTree(rootDir) {
  const pending = [rootDir];
  const listings = new Map(); // absDir -> sorted lines
  const skipped = { reads: 0, writes: 0, fullWrites: 0 };
  while (pending.length) {
    const dir = pending.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.reads += 1; // unreadable dir → its subtree is skipped, never an abort
      continue;
    }
    const lines = [];
    for (const entry of entries) {
      if (entry.name === MAP_FILE || entry.name === FULL_MAP_FILE) continue; // maps are regenerated, never listed -> idempotent
      const full = resolve(dir, entry.name);
      const path = fwd(relative(rootDir, full));
      if (entry.isDirectory()) {
        pending.push(full);
        lines.push(path + "/");
      } else if (isPdf(entry.name)) {
        continue; // .pdf files are NEVER listed (map_folder.md + map_folder_full.md): pdf2text (STEP 1.5) converts them to readable .txt, and the .txt is what the harness reads
      } else {
        lines.push(path); // symlinks too: listed, never followed (pi-style) — no stat (sizes are not collected anymore)
      }
    }
    lines.sort(compareLines);
    listings.set(dir, lines);
  }
  return { listings, skipped };
}

/** Accept a directory path WITH OR WITHOUT a trailing separator: strip the
 *  trailing `\\` / `/` run but keep the root forms intact (a drive root like
 *  "C:\\" and the root "\\" keep their single separator). */
function stripTrailingSeparators(p) {
  let s = p;
  while (s.length > 1 && (s.endsWith("\\") || s.endsWith("/"))) {
    if (/^[A-Za-z]:[\\/]$/.test(s)) break; // drive root ("C:\\") — keep the separator
    s = s.slice(0, -1);
  }
  return s;
}

/** STEP 1 — the WORKING-DIRECTORY QUESTION, asked IMMEDIATELY at harness
 * start, before ANY pass over the tree (no listing, no count — the recursive
 * scan is the launch's slow part and must not gate the prompt):
 *   Specify the working directory to map (path with or without a trailing \,
 *   launch folder: "<root>") :
 * The answer is REQUIRED — the user must SPECIFY the working directory (the
 * harness never walks the launch folder by default): an empty answer re-asks,
 * a path that is not an existing directory is reported and re-asked. The path
 * is accepted WITH OR WITHOUT a trailing separator and resolved against the
 * launch folder (relative paths allowed). Returns
 *   <path>  → the working folder the user named (trailing separators stripped,
 *             validated as an existing directory) — the walk uses it,
 *   false   → Ctrl+C at the question: the walk is SKIPPED (declined), the
 *             harness still starts (orderly, never stalls),
 *   true    → non-TTY (piped/closed stdin: one-shot mode, tests) — automatic:
 *             the given root is used unchanged, never blocks.
 */
export function preflightQuestion({ root }) {
  return `Specify the working directory to map (path with or without a trailing \\, launch folder: "${root}") : `;
}

export async function interactivePreflight({ root }) {
  if (!process.stdin.isTTY) return true; // no interactive human → automatic (piped/one-shot/tests never block): the given root is used
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let sigint = false;
  let waiter = null;
  rl.on("SIGINT", () => {
    // PIECE-3 (F6): Ctrl+C at the preflight prompt — the question's promise resolves
    // null → the walk is DECLINED (answer === null → false) → the harness continues
    // to the chart instead of stalling on a promise that never resolves. One
    // physical Ctrl+C cancels; the loop checks the flag BEFORE asking again.
    sigint = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  const question = (q) =>
    new Promise((resolveLine) => {
      waiter = resolveLine;
      rl.question(q, (a) => {
        waiter = null;
        resolveLine(a);
      });
    });
  try {
    for (;;) {
      const answer = await question(preflightQuestion({ root }));
      if (sigint) return false; // Ctrl+C → declined (orderly, never stalls)
      const p = stripTrailingSeparators((answer ?? "").trim());
      if (!p) continue; // REQUIRED: an empty answer re-asks — the working directory must be specified
      const abs = resolve(p);
      // SYNCHRONOUS validation — no `await` between the answer and rl.close() (in the
      // finally below). BUG (2026-09-30, the dead-keyboard-after-two-gates): an `await`
      // (even a microtask one) executed after the question's callback resolves but before
      // rl.close() lets the TTY stream's keypress/read state advance once; the stream then
      // ends up kEnded and NEVER delivers typed bytes again (isPaused() is false,
      // reading=true, resume()/read(0) are no-ops — unrecoverable from JS). The gate must
      // close in the SAME synchronous chain as its answer, so the validation is statSync.
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) return abs; // the walk MOVES to the user-specified working folder
      process.stdout.write(`not an existing directory: ${abs}\n`); // reported → the question is repeated
    }
  } finally {
    rl.close(); // restore the terminal before the interactive session takes over stdin
    process.stdin.resume(); // rl.close() leaves process.stdin EXPLICITLY PAUSED (Node's Interface.close pauses its input) and Node does NOT auto-resume a paused stream when a new "data" listener is added (state.flowing === false skips the auto-resume) — the chart's byte pump (rawInput.on("data")) would then never see a typed byte: the keyboard looks held and the prompt area stays dead. Resume so the next reader finds the stream flowing, cooked — exactly as this gate found it.
  }
}

/** STEP 3 — the LAST validation, asked ONLY after the number of folders was
 *  retrieved (STEP 2) for the SETTLED working folder:
 *   you started the harness from "<root>". This will lead to the creation/update
 *   of <folders> map_folder.md files in each subfolder. Do you want to continue
 *   [y] Yes, [n] no :   ← the quotes around the NUMBER were REMOVED.
 * y/yes → true → the walk runs; n/no → false → the walk is SKIPPED (declined →
 * no map_folder.md / map_folder_full.md is created/updated anywhere) and the
 * harness still starts. Anything else → the question is repeated. NOT a TTY
 * (piped/closed stdin: one-shot mode, tests) → auto-yes (true), never blocks. */
export function finalConfirmQuestion({ root, folders }) {
  return `you started the harness from "${root}". This will lead to the creation/update of ${folders} map_folder.md files in each subfolder. Do you want to continue [y] Yes, [n] no : `;
}

export async function interactiveConfirm({ root, folders }) {
  if (!process.stdin.isTTY) return true; // no interactive human → automatic (piped/one-shot/tests never block)
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let waiterRef = null;
  // PIECE-3 (F6): Ctrl+C at the LAST validation → the answer resolves null → false
  // → the walk is DECLINED → the harness continues to the chart (orderly, never
  // stalls on a promise that never resolves).
  rl.on("SIGINT", () => {
    if (waiterRef) {
      const w = waiterRef;
      waiterRef = null;
      w(null);
    }
  });
  try {
    for (;;) {
      const answer = await new Promise((resolveLine) => {
        waiterRef = resolveLine;
        rl.question(finalConfirmQuestion({ root, folders }), (a) => {
          waiterRef = null;
          resolveLine(a);
        });
      });
      const a = (answer ?? "").trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no" || answer === null) return false; // "no" / Ctrl+C / EOF → walk SKIPPED
    }
  } finally {
    rl.close(); // restore the terminal before the interactive session takes over stdin
    process.stdin.resume(); // the gate must leave the stream flowing: rl.close() pauses it (see interactivePreflight) and a paused stream is not auto-resumed by the next reader's "data" listener — without this the interactive session's input would be dead
  }
}

/** STEP 1.5 — the PDF → TXT CONVERSION GATE, asked on a real terminal AFTER the
 *  working folder is SETTLED and BEFORE the tree is scanned: it offers to launch
 *  the harness's own pdf2text.py over the working folder so every .pdf becomes a
 *  readable .txt (the .pdf files are filtered OUT of the maps, the .txt files are
 *  what get listed). It REQUIRES an explicit user "yes" — conversion WRITES files,
 *  so it never runs unconfirmed and never runs on a non-TTY (piped/one-shot/tests
 *  → auto-NO: no silent side effect). Returns true → convert, false → skip (the
 *  walk proceeds either way, and the maps never list .pdf regardless). */
export function convertQuestion({ root }) {
  return `Convert PDF files to TXT in "${root}" before building the maps? This runs the harness's pdf2text.py (it writes a .txt next to each .pdf; existing .txt files are kept). .pdf files are always filtered out of the maps. [y]es / [n]o (enter = no) : `;
}

export async function interactiveConvert({ root }) {
  if (!process.stdin.isTTY) return false; // no interactive human → never auto-convert (a side effect needs an explicit yes)
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let waiter = null;
  // Ctrl+C at the conversion gate → the answer resolves null → skip (orderly, never stalls)
  rl.on("SIGINT", () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  try {
    for (;;) {
      const answer = await new Promise((r) => {
        waiter = r;
        rl.question(convertQuestion({ root }), (a) => {
          waiter = null;
          r(a);
        });
      });
      const a = (answer ?? "").trim().toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no" || answer === null || a === "") return false; // no / Ctrl+C / empty (default) → skip the conversion
      // anything else → the question is repeated
    }
  } finally {
    rl.close(); // restore the terminal before the rest of the launch takes over stdin
    process.stdin.resume(); // the gate must leave the stream flowing: rl.close() pauses it (see interactivePreflight) and a paused stream is not auto-resumed by the next reader's "data" listener — without this the interactive session's input would be dead
  }
}

/** The harness's pdf2text.py, resolved from the dot-folder (honours the
 *  OBSERVATION_ONLY_DIR override — never a hard-coded absolute path). */
export function pdf2TextScriptPath() {
  return join(userDotDir(), "extensions", "pdf2text.py");
}

/** STEP 1.5 action — run `python <pdf2text.py> <rootDir>`, letting the user see
 *  pdf2text's own progress (stdio inherited). Best-effort: it RESOLVES regardless
 *  of the exit code (a missing python / a failing PDF is reported to stderr but
 *  never aborts the walk — the maps are still built from whatever .txt exists and
 *  never list .pdf). */
export function runPdf2Text(rootDir) {
  return new Promise((resolveDone) => {
    const script = pdf2TextScriptPath();
    let child;
    try {
      child = spawn("python", [script, rootDir], { stdio: "inherit" });
    } catch (error) {
      process.stderr.write(`pdf2text: failed to launch: ${error?.message ?? error}\n`);
      resolveDone(0);
      return;
    }
    child.on("error", (error) => {
      // ENOENT (no `python` on PATH) or a spawn failure — report and continue
      process.stderr.write(`pdf2text: ${error?.message ?? error}\n`);
      resolveDone(0);
    });
    child.on("exit", (code) => resolveDone(code ?? 0));
  });
}

/**
 * The WAITING line printed only when the walk actually RUNS (after the LAST
 * validation's "yes"): the user sees what is happening instead of a silent stall
 * on a big tree.
 */
export function mapWaitLine({ root, folders }) {
  return `map_folder_walk: walking ${root} — creating/updating ${folders} map_folder.md files (one per folder) + ${FULL_MAP_FILE} at the working folder (this can take a while)…`;
}

/**
 * Walk `root` (absolute or cwd-relative) recursively, writing map_folder.md in
 * every folder including the working folder + map_folder_full.md (the FULL mermaid
 * structure of the whole tree) at the working folder. STEP 1 `preflight`
 * (`interactivePreflight`, optional) is the WORKING-DIRECTORY QUESTION, asked
 * IMMEDIATELY — BEFORE
 * any pass over the tree (the question must not wait for the slow recursive
 * scan): it returns true → proceed with the given root, false → SKIP
 * (`declined: true`), a path → the user-specified working folder (validated
 * as an existing directory, trailing separators stripped) — the walk uses it;
 * only AFTER the working folder is SETTLED (the user named it) is the tree scanned ONCE
 * (STEP 2, the folder count) and the LAST validation `confirm` (STEP 3, optional) asked
 * — a falsy return SKIPS the walk (`declined: true`) and the harness still
 * starts. `waiting` (optional) is called between the confirmation and the
 * writes (the waiting message; TTY runs print it via mapWaitLine). Returns
 *   { root, mapPath, fullMapPath, maps, skipped, declined }
 *   root        — the SETTLED working folder (the user-specified target when the user
 *                 moved — the harness uses it as the tools' work dir from there).
 *   mapPath     — the working folder's map_folder.md path (the path the harness hands the LLM).
 *   fullMapPath — the working folder's map_folder_full.md path (the FULL mermaid map).
 *   maps        — every map_folder.md written, in walk order.
 *   declined    — true when a gate returned "no": no map_folder.md / map_folder_full.md
 *                 was written anywhere.
 */
export async function mapFolderWalk(root, options = {}) {
  // create_folder_path switch (see resolveCreateFolderPath): the walk — the
  // INITIAL function that writes map_folder.md / map_folder_full.md — is
  // CONDITIONALLY activated by the variable, OFF by default (create_folder_path
  // = false). When off the function returns the DECLINED shape immediately with
  // `disabled: true` (distinguishes "the feature is off" from a human "no" at a
  // gate): nothing is scanned, no map_folder.md / map_folder_full.md is
  // created/updated ANYWHERE, and the harness still starts.
  if (!resolveCreateFolderPath()) {
    const rootDir = resolve(root);
    return { root: rootDir, mapPath: resolve(rootDir, MAP_FILE), fullMapPath: resolve(rootDir, FULL_MAP_FILE), maps: [], skipped: { reads: 0, writes: 0, fullWrites: 0 }, declined: true, disabled: true };
  }
  const { preflight, confirm, waiting, convert } = options;
  let rootDir = resolve(root);
  let scanned = null; // { listings, skipped } of the SETTLED rootDir
  if (preflight) {
    // STEP 1 FIRST — the WARNING (preflight) is asked IMMEDIATELY, BEFORE ANY PASS
    // over the tree: scanTree is a full recursive readdir walk — the launch's slow
    // part on big trees — so the question must never wait for it. Nothing is
    // counted and no folder is DESCENDED before the working folder is SETTLED: a
    // "no" (skip) or an "[o]ther" move never pays for a scan of a tree that will
    // not be walked. The tree is scanned exactly once, only after "yes" (STEP 1)
    // settled the folder — the count is then exposed and STEP 3 (last validation)
    // asked with it.
    for (;;) {
      const choice = await preflight({ root: rootDir });
      if (choice === false) {
        // "no" → the walk is SKIPPED: nothing was scanned, nothing is written anywhere, the harness starts anyway.
        return { root: rootDir, mapPath: resolve(rootDir, MAP_FILE), fullMapPath: resolve(rootDir, FULL_MAP_FILE), maps: [], skipped: { reads: 0, writes: 0, fullWrites: 0 }, declined: true };
      }
      // A valid answer SETTLES the working folder — `true` keeps the given root, a string is
      // the user-NAMED folder (the walk MOVES to it). Per interactivePreflight's contract
      // ("<path> → the walk uses it") a path answer is TERMINAL: scan it and stop re-asking.
      // BUG FIX: this used to fall through to `rootDir = resolve(choice)` and loop, re-asking
      // with the named folder shown as the new "launch folder" — but interactivePreflight never
      // returns true on a TTY (it returns the named path), so the harness re-asked forever and
      // never reached the conversation point. A path now settles and breaks, exactly like `true`.
      if (typeof choice === "string") rootDir = resolve(choice);
      break; // working folder SETTLED → STEP 1.5 + STEP 2 below
    }
  }
  // STEP 1.5 — PDF → TXT (optional, user-confirmed), BEFORE the scan: pdf2text.py is
  // launched over the SETTLED working folder so every .pdf becomes a readable .txt
  // (the .pdf files are filtered OUT of the maps — the .txt files are what get listed).
  // It requires an explicit "yes" on a real terminal and never runs on a non-TTY; it is
  // best-effort — a conversion failure is reported but the walk still proceeds.
  if (convert && (await convert({ root: rootDir }))) {
    await runPdf2Text(rootDir);
  }
  scanned = await scanTree(rootDir); // STEP 2 — the only pass (listings + folder count), AFTER the working folder is settled
  const { listings, skipped } = scanned;
  // STEP 3 — the LAST validation (the folder count is now known); "no" → SKIPPED.
  if (confirm && !(await confirm({ root: rootDir, folders: listings.size }))) {
    return { root: rootDir, mapPath: resolve(rootDir, MAP_FILE), fullMapPath: resolve(rootDir, FULL_MAP_FILE), maps: [], skipped, declined: true };
  }
  if (waiting) waiting({ root: rootDir, folders: listings.size }); // the waiting message — the walk is running
  const maps = [];
  for (const [dir, lines] of listings) {
    const mapFile = resolve(dir, MAP_FILE);
    try {
      await writeFile(mapFile, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      maps.push(mapFile);
    } catch {
      skipped.writes += 1; // write refused (EPERM on AppData\Roaming\Microsoft\Installer)
      continue; // folder stays listed in its parent; the launch proceeds
    }
  }
  const fullMapFile = resolve(rootDir, FULL_MAP_FILE);
  try {
    await writeFile(fullMapFile, fullMapContent(rootDir, listings), "utf8");
  } catch {
    skipped.fullWrites += 1; // same robustness: a refused full-map write → omitted, no abort
  }
  return { root: rootDir, mapPath: resolve(rootDir, MAP_FILE), fullMapPath: fullMapFile, maps, skipped, declined: false };
}

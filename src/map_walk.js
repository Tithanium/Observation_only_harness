// src/map_walk.js
// Harness start: SETTLE THE WORKING FOLDER, then CONVERT PDFs TO TXT.
// (The round-2 map_folder_walk — writing map_folder.md in every folder +
// map_folder_full.md at the root — was REMOVED (2026-10-01): at the start of
// the observation harness the map_folder creation is SKIPPED, and the harness
// now carries its own ls/grep/find tools to explore the working folder, so no
// pre-built folder map is needed anymore.)
//
// Two things remain at start:
//
// 1. THE CONFIRMATION GATE — the WORKING-DIRECTORY QUESTION (post-round-12,
// working directory REQUIRED at launch, 2026-09-30): on a real terminal the
// harness first says "Specify the working directory to map (path with or
// without a trailing \, launch folder: \"<root>\") :". The answer is REQUIRED:
// the harness NEVER uses the launch folder by default — it uses the directory
// the user names. An empty answer re-asks; a path that is not an existing
// directory is reported and re-asked. The path is accepted WITH OR WITHOUT a
// trailing separator ("C:\foo", "C:\foo\", "C:/foo/" all settle to "C:\foo"; a
// drive root "C:\" keeps its separator; relative paths resolve against the
// launch folder) and is validated as an existing directory BEFORE the
// conversion runs.
//
// 2. THE PDF → TXT CONVERSION — unconditionally runs the harness's own
// pdf2text.py over the SETTLED working folder, RECURSIVELY: every .pdf in the
// tree becomes a readable .txt next to it (existing non-empty .txt files are
// kept — pdf2text's default skip). Best-effort: a missing python / a failing
// PDF is reported to stderr but NEVER aborts the launch — the harness always
// reaches the conversation point.
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { userDotDir } from "./config.js";

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

/** THE WORKING-DIRECTORY QUESTION, asked IMMEDIATELY at harness start, before
 * anything else (no listing, no count):
 *   Specify the working directory to map (path with or without a trailing \,
 *   launch folder: "<root>") :
 * The answer is REQUIRED — the user must SPECIFY the working directory (the
 * harness never uses the launch folder by default): an empty answer re-asks,
 * a path that is not an existing directory is reported and re-asked. The path
 * is accepted WITH OR WITHOUT a trailing separator and resolved against the
 * launch folder (relative paths allowed). Returns
 *   <path>  → the working folder the user named (trailing separators stripped,
 *             validated as an existing directory),
 *   false   → Ctrl+C at the question: the gate is SKIPPED (declined) — the
 *             given root is used and the harness still starts (orderly, never
 *             stalls),
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
    // null → the gate is DECLINED (answer === null → false) → the harness continues
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
      if (isDir) return abs; // the harness MOVES to the user-specified working folder
      process.stdout.write(`not an existing directory: ${abs}\n`); // reported → the question is repeated
    }
  } finally {
    rl.close(); // restore the terminal before the interactive session takes over stdin
    process.stdin.resume(); // rl.close() leaves process.stdin EXPLICITLY PAUSED (Node's Interface.close pauses its input) and Node does NOT auto-resume a paused stream when a new "data" listener is added (state.flowing === false skips the auto-resume) — the chart's byte pump (rawInput.on("data")) would then never see a typed byte: the keyboard looks held and the prompt area stays dead. Resume so the next reader finds the stream flowing, cooked — exactly as this gate found it.
  }
}

/** The harness's pdf2text.py, resolved from the dot-folder (honours the
 *  OBSERVATION_ONLY_DIR override — never a hard-coded absolute path). */
export function pdf2TextScriptPath() {
  return join(userDotDir(), "extensions", "pdf2text.py");
}

/** Run `python <pdf2text.py> <rootDir>`, letting the user see pdf2text's own
 *  progress (stdio inherited). RECURSIVE: pdf2text walks the whole tree and
 *  converts every .pdf to a .txt next to it (existing non-empty .txt kept).
 *  Best-effort: it RESOLVES regardless of the exit code (a missing python / a
 *  failing PDF is reported to stderr but never aborts the launch — the
 *  harness always reaches the conversation point). */
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

/** The WAITING line printed when the conversion RUNS: the user sees what is
 *  happening instead of a silent stall on a big tree with many PDFs. */
export function pdfWaitLine({ root }) {
  return `pdf2text: converting PDF files to TXT in ${root} (recursive — every .pdf in the tree, existing .txt kept; this can take a while)…`;
}

/**
 * Harness start, in order: (1) the WORKING-DIRECTORY QUESTION — `preflight`
 * (optional) is asked IMMEDIATELY; it returns true → proceed with the given
 * root, false → the gate is DECLINED (the given root is used, the conversion
 * is SKIPPED, `declined: true` — the harness still starts), a path → the
 * user-specified working folder (validated as an existing directory, trailing
 * separators stripped) — the harness uses it. (2) ONCE THE FOLDER IS SETTLED,
 * the PDF → TXT conversion runs UNCONDITIONALLY over it (recursively,
 * best-effort, see runPdf2Text). `waiting` (optional) is called right before
 * the conversion (the waiting message; TTY runs print it via pdfWaitLine).
 * Returns
 *   { root, declined, pdfExitCode }
 *   root          — the SETTLED working folder (the user-specified target when
 *                   the user named one; the harness uses it as the tools' work
 *                   dir from there).
 *   declined      — true when the gate was declined: the given root is used,
 *                   the PDF conversion was skipped.
 *   pdfExitCode   — pdf2text's exit code (0 or a failure code; 0 also when the
 *                   gate was declined — the conversion then did not run).
 */
export async function settleWorkingFolder(root, options = {}) {
  const { preflight, waiting } = options;
  let rootDir = resolve(root);
  if (preflight) {
    const choice = await preflight({ root: rootDir });
    if (choice === false) {
      // Declined (Ctrl+C at the question): the given root is used unchanged,
      // the conversion is skipped, the harness starts anyway.
      return { root: rootDir, declined: true, pdfExitCode: 0 };
    }
    // A valid answer SETTLES the working folder — `true` keeps the given root,
    // a string is the user-NAMED folder (the harness MOVES to it). Per
    // interactivePreflight's contract ("<path> → the harness uses it") a path
    // answer is TERMINAL.
    if (typeof choice === "string") rootDir = resolve(choice);
  }
  if (waiting) waiting({ root: rootDir }); // the waiting message — the conversion is about to run
  const pdfExitCode = await runPdf2Text(rootDir); // PDF → TXT, recursive, unconditional, best-effort
  return { root: rootDir, declined: false, pdfExitCode };
}

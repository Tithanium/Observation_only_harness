#!/usr/bin/env node
// Observation_only — the harness command (bin entry, rounds 5 + 6). From ANY
// directory: settle the working folder (the working-directory question, 2026-09-30)
// and convert its PDFs to TXT recursively (pdf2text.py — the round-2
// map_folder_walk creation was REMOVED 2026-10-01: at start the map_folder
// creation is skipped, the harness's own ls/grep/find tools explore the
// folder), connect via the
// round-1 pi-method connection (settings.json provider/model, auth.json /
// models.json keys), and drive the round-4 fetch tool (the round-3 read tool
// was merged into it) and the round-5 subagent tool through the shared
// driveTurn loop — and, with NO
// message — bare on a terminal — OPEN the harness and provide a conversation
// point exactly as `pi` does (rounds 10 + 11): banner, prompt, multi-turn
// interactive session, footer after every turn, the evaluated "/" command subset
// and the keyboard shortcuts (readline history, Ctrl+C cancel/quit, Ctrl+D
// quit). EMPTY piped stdin (non-terminal) ends SILENTLY, exit 0 — as `pi` does.
// A message (argument or piped stdin) runs the SAME session ONE-SHOT:
// settle + pdf2text + driveTurn + footer — rounds 1–7 unchanged.
// A launch NEVER answers with a usage line. Never prints secrets.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { interactivePreflight, pdfWaitLine, settleWorkingFolder } from "./map_walk.js";
import { createClient } from "./client.js";
import { footerLine } from "./footer.js";
import { buildHarnessTools, driveTurn, harnessSystemPrompt } from "./session.js";
import { runInteractiveSession } from "./interactive.js";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

const flags = new Set(["--work-dir", "--provider", "--model", "--api-key", "--agent-scope"]);
const overrides = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) {
    overrides[args[i].slice(2)] = args[++i];
  } else {
    positional.push(args[i]);
  }
}

const forceInteractive = args.includes("--interactive");
let message = positional.join(" ");
if (!forceInteractive && !message && !process.stdin.isTTY) {
  message = (await readStdin()).trim();
  if (!message) {
    // Empty piped stdin, nothing to say: `pi` answers that launch with silence
    // (no usage line, clean exit 0). A REAL terminal never comes here — it falls
    // to the branch below and gets the conversation point.
    process.exit(0);
  }
}

// The working folder the harness walks; must stay inside the project dir.
const projectRoot = resolve(process.cwd());
const workDir = resolve(projectRoot, overrides["work-dir"] ?? ".");
const relCheck = relative(realpathSync(projectRoot), realpathSync(workDir));
if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
  process.stderr.write(`work dir outside the project: ${workDir}\n`);
  process.exit(1);
}
// THE WORKING DIRECTORY IS REQUIRED AT LAUNCH (2026-09-30): on a real terminal
// the harness first asks the user to SPECIFY the working directory (path with
// or without a trailing \; interactivePreflight in map_walk.js) — the answer
// is required (an empty or not-a-directory answer re-asks). ONLY ONCE THE
// FOLDER IS SETTLED does the harness run the RECURSIVE PDF → TXT conversion
// (pdf2text.py) over it — unconditionally, best-effort (a failing PDF or a
// missing python never aborts the launch). A --work-dir on the command line
// already counts as specified → no question. The pre-chart phase gets a
// no-hang SIGINT listener: an early Ctrl+C during the (possibly slow)
// conversion/connect must neither hang nor kill the launch — it is swallowed,
// the chart comes up, and the session's own Ctrl+C handling takes over from
// there (this listener is a permanent no-op; the session's decoded Ctrl+C
// drives the turn abort / bye).
const screen = Boolean(process.stdin.isTTY && process.stdout.isTTY); // the ONLY gate: real terminal input AND output — the chart lives on real TTYs only
const preChartSigInt = screen ? () => {} : null; // PIECE-3 (F6) no-hang, extended to the SILENT launch: start never blocks on a question after the folder is settled, so an early Ctrl+C resolves nothing — it is swallowed
if (preChartSigInt) process.on("SIGINT", preChartSigInt);

// ROOT-CAUSE GUARD against Node's "Detected unsettled top-level await" warning.
// Node emits that warning (and exits) when the event loop DRAINS while a top-level
// await in this entry module is still pending. It is written by the runtime straight
// to stderr — NOT via process.emitWarning — so it cannot be caught with
// process.on("warning") and cannot be redirected after the fact; the only cure is to
// keep the loop from draining early. During startup the top-level flow
// (settleWorkingFolder -> createClient -> buildHarnessTools ->
// runInteractiveSession) can hit a moment with no active handle while one of
// those awaits is pending; the loop then drains, the warning fires, and its
// text lands in the prompt zone. A ref'd no-op timer is an active handle: it
// holds the loop for the whole top-level flow, so it can never drain early and
// the warning can never fire. The finally below clears it on the one-shot
// natural-exit path; the interactive and error paths end with an unconditional
// process.exit, so it can never strand the process.
const keepAlive = setInterval(() => {}, 2 ** 30);

try {
  // Harness start: SETTLE THE WORKING FOLDER, then CONVERT THE PDFs. The
  // WORKING-DIRECTORY QUESTION (required, 2026-09-30): on a terminal the
  // harness first says "Specify the working directory to map (path with or
  // without a trailing \\, launch folder: \"<root>\") :" — the user must
  // SPECIFY the working directory (an empty or not-a-directory answer re-asks;
  // paths are accepted with or without a trailing \\ and resolved against the
  // launch folder); the harness then MOVES to that folder (it uses it from
  // there on). ONLY ONCE THE FOLDER IS SETTLED does the RECURSIVE PDF → TXT
  // conversion run: pdf2text.py converts every .pdf in the tree to a .txt next
  // to it (unconditional — the round-2 map_folder_walk creation is REMOVED,
  // 2026-10-01: the map_folder.md / map_folder_full.md files are no longer
  // written anywhere; the harness's own ls/grep/find tools explore the folder
  // instead). A Ctrl+C at the question DECLINES: the given root is used, the
  // conversion is skipped, the harness starts anyway; a piped/closed stdin
  // (one-shot, tests) never asks (auto-continue on the given root).
  const settled = await settleWorkingFolder(workDir, {
    // THE WORKING DIRECTORY IS REQUIRED: on a real terminal interactivePreflight
    // asks the user to specify it (a --work-dir on the command line already
    // counts as specified → no question). Piped/injected (one-shot, the
    // deterministic suites) never ask on a non-TTY anyway.
    preflight: screen && overrides["work-dir"] !== undefined ? async () => true : interactivePreflight,
    waiting: screen ? (a) => process.stdout.write(pdfWaitLine(a) + "\n") : undefined,
  });
  const settledWorkDir = settled.root; // the SETTLED working folder — the folder the user specified at launch
  if (settled.declined) process.stderr.write(`pdf2text: skipped (working-directory question declined) — using ${settledWorkDir}\n`);
  if (forceInteractive || !message) {
    // THE INTERACTIVE SESSION (rounds 10 + 11): no message → the harness and its
    // conversation point — banner + prompt + multi-turn turns; a closed piped
    // stdin (EOF) ends it cleanly (exit 0). ROUND 16: when the interactive
    // input+output are REAL TTYs the session renders the GRAPHICAL CHART
    // (src/screen.js — the pi-style layout: header, the answer streamed live in
    // the main area — thinking in ITALIC, the final answer upright and BOLD — the
    // user's prompt between two underscore lines, the footer pinned at the BOTTOM
    // line, the subagent work collapsed, alt+o/ctrl+o toggles it). Injected /
    // non-TTY streams (the suites) never pass `screen` → the deterministic LINE
    // mode, byte-identical. PIECE-4: `screen` was decided ABOVE (before the walk)
    // — the launch's silence is part of the chart path.
    const client = await createClient({ provider: overrides.provider, model: overrides.model, apiKey: overrides.apiKey });
    const toolsMap = await buildHarnessTools(settledWorkDir);
    await runInteractiveSession({ workDir: settledWorkDir, projectRoot, overrides, toolsMap, client, screen });
    process.exit(0); // PIECE-3: the interactive session OWNS the process — once its loop ends (bye) the process is done; the pump's keep-alive stream must never strand it
    // CLEAN EXIT (round-10/11 gap fix): the interactive session OWNS the process —
    // banner → turns → quit — and the one-shot block below is now the else branch:
    // after "bye" (ctrl+d / ctrl+c idle / /quit) the module evaluation simply
    // ENDS → natural exit with code 0. There is NO fall-through anymore: no second
    // driveTurn, no unbilled one-shot turn on the empty prompt, no network request.
  } else {
    // ONE-SHOT mode: the same driveTurn, the same footer — exactly as rounds 1–7.
    const client = await createClient({ provider: overrides.provider, model: overrides.model, apiKey: overrides.apiKey });
    const toolsMap = await buildHarnessTools(settledWorkDir);
    const messages = [];
    const { text } = await driveTurn(client, messages, {
      workDir: settledWorkDir,
      // BUG FIX: `message` was missing here — the one-shot's typed message never
      // reached driveTurn (options.message undefined → the door text ended in a
      // literal "undefined" and the model answered an empty request).
      message,
      systemPrompt: harnessSystemPrompt(),
      toolsMap,
      output: (s) => process.stdout.write(s + "\n"),
    });
    if (!text) {
      process.stderr.write("no text in model reply\n");
      process.exit(1);
    }
    process.stdout.write(text.replace(/\n+$/, "") + "\n");
    process.stderr.write(footerLine(client) + "\n"); // round-7 footer: in/out tokens, ctx/max, model, tok/s
  }
} catch (error) {
  process.stderr.write(`request failed: ${error?.message ?? error}\n`);
  process.exit(1);
} finally {
  clearInterval(keepAlive); // one-shot success exits naturally here — drop the keep-alive so the loop can drain and the process exits cleanly
}

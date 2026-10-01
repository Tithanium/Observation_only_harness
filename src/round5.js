#!/usr/bin/env node
// Observation_only — the harness command (bin entry, rounds 5 + 6). From ANY
// directory: walk the working folder (round 2 map_folder_walk), connect via the
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
// map_folder_walk + driveTurn + footer — rounds 1–7 unchanged.
// A launch NEVER answers with a usage line. Never prints secrets.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { interactiveConfirm, interactiveConvert, interactivePreflight, mapFolderWalk, mapWaitLine } from "./map_walk.js";
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
// is required (an empty or not-a-directory answer re-asks), and the walk then
// creates the map_folder.md / map_folder_full.md structure for that folder.
// A --work-dir on the command line already counts as specified → no question.
// The LAST validation (folder count) and the waiting line stay suppressed on
// the chart path (pi never re-asks once the directory is settled), piped runs
// keep the round-2 gates — those never asked on a non-TTY anyway. The pre-chart
// phase gets a no-hang SIGINT listener: an early Ctrl+C during the (possibly
// slow) walk/connect must neither hang nor kill the launch — it is swallowed,
// the chart comes up, and the session's own Ctrl+C handling takes over from
// there (this listener is a permanent no-op; the session's decoded Ctrl+C
// drives the turn abort / bye).
const screen = Boolean(process.stdin.isTTY && process.stdout.isTTY); // the ONLY gate: real terminal input AND output — the chart lives on real TTYs only
const preChartSigInt = screen ? () => {} : null; // PIECE-3 (F6) no-hang, extended to the SILENT launch: the walk never blocks on a question, so an early Ctrl+C resolves nothing — it is swallowed
if (preChartSigInt) process.on("SIGINT", preChartSigInt);

// ROOT-CAUSE GUARD against Node's "Detected unsettled top-level await" warning.
// Node emits that warning (and exits) when the event loop DRAINS while a top-level
// await in this entry module is still pending. It is written by the runtime straight
// to stderr — NOT via process.emitWarning — so it cannot be caught with
// process.on("warning") and cannot be redirected after the fact; the only cure is to
// keep the loop from draining early. During startup the top-level flow (mapFolderWalk
// -> createClient -> buildHarnessTools -> runInteractiveSession) can hit a moment with
// no active handle while one of those awaits is pending; the loop then drains, the
// warning fires, and its text lands in the prompt zone. A ref'd no-op timer is an
// active handle: it holds the loop for the whole top-level flow, so it can never drain
// early and the warning can never fire. The finally below clears it on the one-shot
// natural-exit path; the interactive and error paths end with an unconditional
// process.exit, so it can never strand the process.
const keepAlive = setInterval(() => {}, 2 ** 30);

try {
  // Harness start: the map_folder_walk (round-2 feature) — the LLM's door. STEP 1
  // is the WORKING-DIRECTORY QUESTION (required, 2026-09-30): on a terminal the
  // harness first says "Specify the working directory to map (path with or
  // without a trailing \\, launch folder: \"<root>\") :" — the user must
  // SPECIFY the working directory (an empty or not-a-directory answer re-asks;
  // paths are accepted with or without a trailing \\ and resolved against the
  // launch folder); the walk then MOVES to that folder (the harness uses it
  // from there on) and creates its map_folder.md / map_folder_full.md
  // structure. ONLY THEN is the number of folders retrieved and the LAST
  // validation asked (piped runs): "…the creation/update of <N> map_folder.md
  // files in each subfolder. Do you want to continue [y] Yes, [n] no :" — a
  // "no" SKIPS the walk (declined → no map_folder.md / map_folder_full.md is
  // created/updated anywhere) and the harness starts anyway; a piped/closed
  // stdin (one-shot, tests) never asks (auto-continue). When the walk RUNS, a
  // WAITING line is shown (the walk on a big tree is slow). The working folder
  // also receives map_folder_full.md — the FULL mermaid structure of the whole
  // tree — and its path is handed to the LLM alongside map_folder.md (see
  // session.js userContent).
  const walk = await mapFolderWalk(workDir, {
    // THE WORKING DIRECTORY IS REQUIRED: on a real terminal interactivePreflight
    // asks the user to specify it (a --work-dir on the command line already
    // counts as specified → no question). The LAST validation and the waiting
    // line stay suppressed on the chart path (pi never re-asks once the
    // directory is settled; the settled-folder line of the chart header still
    // names the walked folder). Piped/injected (one-shot, the deterministic
    // suites) keep the round-2 gates exactly as they were — those never asked
    // on a non-TTY anyway.
    preflight: screen && overrides["work-dir"] !== undefined ? async () => true : interactivePreflight,
    confirm: screen ? async () => true : interactiveConfirm,
    // STEP 1.5 — PDF → TXT conversion gate: on a real terminal the user is ASKED
    // (before the maps are built) whether to run pdf2text.py over the working
    // folder; non-TTY (one-shot/piped/suites) never converts (a side effect needs
    // an explicit human yes → auto-NO, keeping the deterministic runs unchanged).
    convert: screen ? interactiveConvert : async () => false,
    waiting: screen ? undefined : ({ root, folders }) => process.stdout.write(mapWaitLine({ root, folders }) + "\n"),
  });
  const settledWorkDir = walk.root; // the SETTLED working folder — the "[o]ther" target when the user chose to move
  // The door refs are relative to the SETTLED folder (the map files always sit AT its
  // root), so the fetch tool — bound to settledWorkDir — can actually open them even
  // after an [o]ther move outside the launch directory.
  const mapRef = walk.declined
    ? walk.disabled
      ? "(skipped — create_folder_path is off: no map_folder.md is created/updated anywhere, the harness starts without it)"
      : "(skipped — declined: the harness starts without map_folder.md)"
    : relative(settledWorkDir, walk.mapPath).split(sep).join("/");
  const fullMapRef = walk.declined
    ? walk.disabled
      ? "(skipped — create_folder_path is off: no map_folder_full.md is created/updated anywhere, the harness starts without it)"
      : "(skipped — declined: the harness starts without map_folder_full.md)"
    : relative(settledWorkDir, walk.fullMapPath).split(sep).join("/");
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
    await runInteractiveSession({ mapRef, fullMapRef, workDir: settledWorkDir, projectRoot, overrides, toolsMap, client, screen });
    process.exit(0); // PIECE-3: the interactive session OWNS the process — once its loop ends (bye) the process is done; the pump's keep-alive stream must never strand it
    // CLEAN EXIT (round-10/11 gap fix): the interactive session OWNS the process —
    // banner → turns → quit — and the one-shot block below is now the else branch:
    // after "bye" (ctrl+d / ctrl+c idle / /quit) the module evaluation simply
    // ENDS → natural exit with code 0. There is NO fall-through anymore: no second
    // driveTurn, no unbilled one-shot turn on the empty prompt, no network request.
  } else {
    // ONE-SHOT mode: the same driveTurn, the same footer — exactly as rounds 1–7.
    process.stdout.write(`map_folder_walk: ${mapRef}\n`); // round-8 piped shape: the walk WAITING line, the MAP line, then the reply on its own line (rounds 2/3/4 print the same door line; the round-16/17 rewrite had dropped it — restored)
    const client = await createClient({ provider: overrides.provider, model: overrides.model, apiKey: overrides.apiKey });
    const toolsMap = await buildHarnessTools(settledWorkDir);
    const messages = [];
    const { text } = await driveTurn(client, messages, {
      mapRef,
      fullMapRef,
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

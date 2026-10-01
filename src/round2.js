#!/usr/bin/env node
// Observation_only Round 2 entry (round-1 LLM connection + map_folder_walk).
// Harness start = map_folder_walk on the working folder (default: cwd,
// override: --work-dir DIR, must stay inside the project). Then one round trip
// through the round-1 connection, handed the working folder's map_folder.md path
// (relative to cwd, forward slashes — pi-style). The path is printed to stdout
// AND sent with the message; the LLM follows paths from it. Never prints secrets.
//   node src/round2.js [--work-dir DIR] [--provider P] [--model M] [--api-key K] [message...]
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { interactiveConfirm, mapFolderWalk, mapWaitLine } from "./map_walk.js";
import { createClient } from "./client.js";
import { footerLine } from "./footer.js";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

const flags = new Set(["--work-dir", "--provider", "--model", "--api-key"]);
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

let message = positional.join(" ");
if (!message && !process.stdin.isTTY) {
  message = (await readStdin()).trim();
}
if (!message) {
  console.error("usage: node src/round2.js [--work-dir DIR] [--provider P] [--model M] [--api-key K] [message...]  (or pipe a message via stdin)");
  process.exit(2);
}

// The working folder the harness walks; must stay inside the project dir.
const projectRoot = resolve(process.cwd());
const workDir = resolve(projectRoot, overrides["work-dir"] ?? ".");
const relCheck = relative(realpathSync(projectRoot), realpathSync(workDir));
if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
  process.stderr.write(`work dir outside the project: ${workDir}\n`);
  process.exit(1);
}

try {
  // Harness start: the map_folder_walk, pi-style startup step (walk, then write).
  // The confirmation gate (post-round-12): on a terminal the user is told how many
  // map_folder.md files the recursive walk would create/update and asked to
  // continue [y]/[n] — a "no" SKIPS the walk (declined) and the harness starts
  // anyway; piped/closed stdin (scripts, tests) never asks (auto-continue). A
  // waiting line is shown while the walk runs.
  const { mapPath, declined } = await mapFolderWalk(workDir, {
    confirm: interactiveConfirm,
    waiting: ({ root, folders }) => process.stdout.write(mapWaitLine({ root, folders }) + "\n"),
  });
  const mapRef = declined ? "(skipped — declined: the harness starts without map_folder.md)" : relative(projectRoot, mapPath).split(sep).join("/"); // relative-if-inside-cwd, "/" separators
  process.stdout.write(`map_folder_walk: ${mapRef}\n`); // hand the LLM's door: visible in command output
  const client = await createClient({
    provider: overrides.provider,
    model: overrides.model,
    apiKey: overrides.apiKey,
  });
  const { text } = await client.complete(`Working folder map_folder.md: ${mapRef} — one line per file and per subfolder there, paths relative to the working folder.\n\n${message}`);
  if (!text) {
    process.stderr.write("no text in model reply\n");
    process.exit(1);
  }
  process.stdout.write(text + "\n");
  process.stderr.write(footerLine(client) + "\n"); // round-7 footer: in/out tokens, ctx/max, model, tok/s
} catch (error) {
  process.stderr.write(`request failed: ${error?.message ?? error}\n`);
  process.exit(1);
}

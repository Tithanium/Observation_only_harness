// probe-soak60.cjs — ROUND 27 PIECE 2: the 60-SECOND REAL-PTY SOAK.
//
// Proves the Observation_only harness runs SMOOTHLY on a REAL PTY (a Windows
// ConPTY via node-pty — the SAME rig family as probe-conpty.cjs / probe-type.cjs:
// real raw-mode console input, real TERM size, real escape processing; node-pty
// is vendored at test-rig/node_modules/node-pty, win32-x64 ConPTY prebuilds).
// The live model is the deterministic local mock (test-rig/mock-server.mjs on port
// 8407 — the isolated-harness dot-folder's single provider), so a turn completes
// without any real API.
//
// Scripted ~60s session (every mechanic the harsh critic named as carry-over):
//   1. boot to the prompt inside the alt screen (raw-mode ConPTY stdin),
//   2. typing text, keystroke by keystroke, with realistic inter-keystroke delays,
//   3. Enter -> a REAL turn through driveTurn -> the mock's streamed answer,
//   4. a pty window-size change (resize -> the harness output 'resize' handler ->
//      screen.resize()), twice,
//   5. opening the "/" slash-command menu (a "/" as the first char of a line),
//   6. the documented quit path (/quit -> src/commands.js:167 -> bye -> exit 0).
// Capture = the FULL raw pty byte stream (stderr included — a node crash would
// land its stack there) + a step timestamp log -> dev_rounds/round27_soak.log.
// Verdict: ZERO uncaught-exception patterns, exit code 0 on quit.
//
// Usage: node test-rig/work/probe-soak60.cjs   (writes dev_rounds/round27_soak.log)
const pty = require("node-pty");
const path = require("path");
const fs = require("fs");
const { spawn } = require("node:child_process");

const ROOT = "C:/Users/connessn/Observation_only";
const DOTS = path.join(ROOT, "test-rig", "work", "isolated-harness");
const LOG = path.join(ROOT, "dev_rounds", "round27_soak.log");
const COLS = 100, ROWS = 30;

const t0 = Date.now();
const steps = [];
const mark = (msg) => steps.push(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let raw = ""; // every pty byte (stdout AND stderr — both land in the ConPTY stream)
let ptyExit = null;
let probeErr = null;

function main() {
  return new Promise(async (resolve) => {
    // --- 1. the mock model server (deterministic local LLM, port 8407) ----------
    const server = spawn(process.execPath, ["test-rig/mock-server.mjs", "--port", "8407"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env),
    });
    let serverReady = false;
    server.stdout.on("data", (d) => {
      const line = String(d).trim();
      if (line.includes("MOCK-READY")) serverReady = true;
      mark("mock: " + line.slice(0, 100));
    });
    server.stderr.on("data", (d) => mark("mock-stderr: " + String(d).trim().slice(0, 200)));
    server.on("error", (e) => mark("mock-spawn-error: " + e.message));

    try {
      // --- 2. the harness inside a REAL ConPTY ----------------------------------
      const env = Object.assign({}, process.env, { OBSERVATION_ONLY_DIR: DOTS });
      const p = pty.spawn("node.exe", ["src/round5.js"], {
        name: "xterm-256color", cols: COLS, rows: ROWS, env, cwd: ROOT,
      });
      mark(`pty spawned node v${process.versions.node} cols=${COLS} rows=${ROWS}`);
      p.onData((d) => { raw += d; if (raw.length > 4000000) raw = raw.slice(-3000000); });
      p.onExit((e) => { ptyExit = e; });

      // wait for the mock + the harness boot (alt screen + footer + prompt)
      for (let w = 0; w < 60 && !serverReady; w += 100) await delay(100);
      mark(`mock ready: ${serverReady}`);
      await delay(8000); // 8.0s boot-to-prompt soak
      mark("BOOT: alt-screen " + (raw.includes("\x1b[?1049h") ? "ENTERED" : "NOT-DETECTED") + " (chart paints: " + (raw.match(/\x1b\[/g)?.length ?? 0) + " escape seqs so far)");
      mark("BOOT: header model line painted: " + (/model: mock\/mock-1/.test(raw) ? "yes" : "no"));

      // --- 3. typing text, one keystroke at a time ----------------------------------
      const text = "hello from the soak";
      for (const ch of text) { p.write(ch); await delay(140); }
      await delay(800);
      mark("TYPED: " + JSON.stringify(text) + " (frame painted: " + (raw.includes(text) ? "yes" : "no") + ")");

      // --- 4. Enter -> a real turn -> the mock answer streams into the chart ---------
      p.write("\r");
      await delay(14000);
      mark("TURN: mock answer painted: " + (/hello from the mock/.test(raw) ? "yes" : "no") + " | footer(s): " + ((raw.match(/tok\/s/g) || []).length) + " | prompts: " + ((raw.match(/Observation_only/g) || []).length));

      // --- 5. pty window-size change -> process.stdout 'resize' -> screen.resize() ---
      p.resize(120, 34);
      await delay(7000);
      mark("RESIZE(120x34) done — raw grew " + raw.length + " bytes");
      p.resize(100, 30);
      await delay(7000);
      mark("RESIZE(100x30) back — raw grew " + raw.length + " bytes");

      // --- 6. scroll keys (pageUp/pageDown — chart transcript scroll) ---------------
      p.write("\x1b[6~"); // PgDn — pi's tui.altScreen.pageDown -> page scroll down
      await delay(2000);
      p.write("\x1b[5~"); // PgUp — pi's tui.altScreen.pageUp -> page scroll up
      await delay(5000);
      mark("SCROLL: pageDown+pageUp sent");

      // --- 7. the "/" slash-command menu ------------------------------------------
      p.write("/");
      await delay(5000);
      mark("SLASH-MENU: opened (dialog rows painting: " + (raw.includes("quit the harness") || raw.includes("/quit") ? "yes" : "no") + ")");

      // --- 8. /quit -> the documented quit path ---------------------------------------
      for (const ch of "quit") { p.write(ch); await delay(250); }
      await delay(4000);
      mark("/quit typed — narrowing rows: " + (raw.includes("quit") ? "yes" : "no"));
      p.write("\r");
      await delay(6000);
      mark("ENTER sent — waiting for clean quit…");

      // --- 9. wait for the child to exit (watchdog 15s) ------------------------------
      for (let w = 0; w < 150 && !ptyExit; w += 100) await delay(100);
      mark("FINAL: pty exit = " + JSON.stringify(ptyExit));

      // --- 10. verdict ----------------------------------------------------------------
      const ex = /Uncaught|unhandledRejection|unhandled exception/i;
      const errKinds = /\b(SyntaxError|TypeError|ReferenceError|RangeError|URIError|ERR_[A-Z_]+)\b/g;
      const stacks = (raw.match(/^\s+at .*:\d+:\d+$/gm) || []).slice(0, 6);
      const uncaught = (raw.match(ex) || []).slice(0, 10);
      mark("VERDICT: uncaught-pattern hits=" + JSON.stringify(uncaught));
      mark("VERDICT: error-kind hits=" + JSON.stringify((raw.match(errKinds) || []).slice(0, 10)));
      mark("VERDICT: stack-frame lines=" + stacks.length + " first=" + JSON.stringify(stacks[0] ?? ""));
      mark("VERDICT: exitCode=" + (ptyExit ? ptyExit.exitCode : "NO-EXIT (watchdog fired)"));
      const sane = uncaught.length === 0 && (raw.match(errKinds) || []).length === 0 && ptyExit && ptyExit.exitCode === 0;
      mark("VERDICT: " + (sane ? "PASS — ZERO uncaught exceptions, exit code " + ptyExit.exitCode : "FAIL"));
      probeErr = sane ? null : "Verdict FAIL — see the log";
    } catch (e) {
      probeErr = e;
      mark("PROBE-ERROR: " + (e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : e));
    } finally {
      try { server.kill(); } catch { /* already gone */ }
      const log = [
        "ROUND 27 PIECE 2 — 60-SECOND REAL-PTY SOAK CAPTURE (node v" + process.version + ", node-pty win32-x64 ConPTY)",
        "spawned: node src/round5.js  cols=" + COLS + " rows=" + ROWS + "  OBSERVATION_ONLY_DIR=" + DOTS,
        "",
        ...steps,
        "",
        "--- FULL PTY CAPTURE (" + raw.length + " bytes, stderr included) ---",
        JSON.stringify(raw),
        "",
        "--- END CAPTURE ---",
        "",
      ].join("\n");
      fs.writeFileSync(LOG, log);
      mark("log written: " + LOG + " (" + log.length + " bytes)");
      console.log(steps.join("\n"));
      resolve();
    }
  });
}

main().then(() => process.exit(probeErr ? 1 : 0));

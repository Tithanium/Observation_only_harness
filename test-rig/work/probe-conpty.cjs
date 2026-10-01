// REAL ConPTY integration: spawn the harness, long mock answer -> overflow,
// then inject SGR wheel/click exactly like Windows Terminal. Capture the render.
const pty = require("node-pty");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");

const ROWS = 30, COLS = 100;
const env = Object.assign({}, process.env);
const cwd = "C:/Users/connessn/Observation_only/test-rig/work";
// run the mock server on a fixed port
const server = spawn(process.execPath, ["test-rig/mock-server.mjs", "--port", "41888"], { cwd: "C:/Users/connessn/Observation_only", stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => console.log("SERVER:", String(d).trim().slice(0, 120)));

const p = pty.spawn("node.exe", ["src/index.js", "--port", "41888"], { name: "xterm-256color", cols: COLS, rows: ROWS, env, cwd: "C:\\Users\\connessn\\Observation_only" });
let buf = "";
const paintedLines = {};
p.onData((d) => {
  buf += d;
  // track current painted text per row (strip ANSI)
  const rows = buf.split(/\x1b\[\d*(;\d*)*[A-Za-z]/g).join("");
  // simple: record every row currently displayed using CSI H moves
  const re = /\x1b\[(\d+);(\d*)H([^\u001b]*)/g;
  let m;
  while ((m = re.exec(buf))) paintedLines[m[1]] = m[3];
});
p.onExit(({ exitCode, signal }) => { console.log("PTY EXIT code=" + exitCode + " sig=" + signal); server.kill(); process.exit(0); });
p.onData((d) => { if (d.length > 4000) process.stderr.write("[huge]"); process.stderr.write("P:" + JSON.stringify(d.slice(0, 300)) + "\n"); });
const flush = () => { console.log("--- painted rows 1.." + ROWS + " ---"); for (let r = 1; r <= ROWS; r++) console.log(r + ": " + JSON.stringify(paintedLines[r] ?? "")); };

setTimeout(() => {
  console.log("--- BOOT ---"); flush();
  p.write("long question please\r");
  setTimeout(() => {
    console.log("--- AFTER LONG ANSWER STREAMED ---"); flush();
    // wheel up x3 (like WT scrolls up)
    p.write("\x1b[<64;20;20M\x1b[<64;20;20M\x1b[<64;20;20M");
    setTimeout(() => {
      console.log("--- AFTER WHEEL-UP x3 (real terminal bytes) ---"); flush();
      process.exit(0);
    }, 700);
  }, 2500);
}, 2500);

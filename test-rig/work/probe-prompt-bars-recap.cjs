// Probe: capture the REAL harness (src/round5.js) on a node-pty at boot + typing,
// rendering a decoded screen grid at each stage. Purpose: verify the prompt
// writing area is BETWEEN the two `─` bars, anchored at the bottom, and grows UP
// for wrapped prompts — exactly like pi's bottom dock.
const pty = require("node-pty");
const path = require("path");
const fs = require("fs");

const ROWS = 30, COLS = 100;
const env = Object.assign({}, process.env);
env.OBSERVATION_ONLY_DIR = "C:/Users/connessn/Observation_only/test-rig/work/isolated-harness";
const cwd = "C:/Users/connessn/Observation_only";

// --- minimal VT grid emulator ---
function makeGrid(rows, cols) {
  const g = [];
  for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(" "));
  let cur = [0, 0];
  return {
    grid: g,
    cur,
    write(s) {
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === "\x1b") {
          const m = /^\x1b\[(\d+)(?:;(\d+))?H/.exec(s.slice(i));
          if (m) { cur[0] = Number(m[1]) - 1; cur[1] = Number(m[2] || 1) - 1; i += m[0].length; continue; }
          if (/^\x1b\[H/.test(s.slice(i))) { cur = [0, 0]; i += 2; continue; }
          const k = /^\x1b\[(\d*)K/.exec(s.slice(i));
          if (k) {
            const n = k[1] === "" ? 2 : Number(k[1]);
            const row = g[cur[0]];
            if (n === 0) for (let x = cur[1]; x < cols; x++) row[x] = " ";
            if (n === 2) for (let x = 0; x < cols; x++) row[x] = " ";
            i += k[0].length; continue;
          }
          if (/^\x1b\[2J/.test(s.slice(i))) { for (let r = 0; r < rows; r++) g[r] = new Array(cols).fill(" "); i += 4; continue; }
          const u = /^\x1b\[(\d+)A/.exec(s.slice(i));
          if (u) { cur[0] = Math.max(0, cur[0] - Number(u[1])); i += u[0].length; continue; }
          const d = /^\x1b\[(\d*)B/.exec(s.slice(i));
          if (d) { cur[0] = Math.min(rows - 1, cur[0] + (d[1] === "" ? 1 : Number(d[1]))); i += d[0].length; continue; }
          const c2 = /^\x1b\[(\d*)C/.exec(s.slice(i));
          if (c2) { cur[1] = Math.min(cols - 1, cur[1] + (c2[1] === "" ? 1 : Number(c2[1]))); i += c2[0].length; continue; }
          const c3 = /^\x1b\[(\d*)D/.exec(s.slice(i));
          if (c3) { cur[1] = Math.max(0, cur[1] - (c3[1] === "" ? 1 : Number(c3[1]))); i += c3[0].length; continue; }
          if (/^\x1b\[\?2026[hl]/.test(s.slice(i))) { i += 7; continue; }
          if (/^\x1b\]0;/.test(s.slice(i))) { let j = s.indexOf("\x07", i); if (j < 0) j = i + 1; i = j + 1; continue; }
          const any = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
          if (any) { i += any[0].length; continue; }
          i += 1; continue;
        }
        if (c === "\r") { cur[1] = 0; i += 1; continue; }
        if (c === "\n") { cur[0] = Math.min(rows - 1, cur[0] + 1); i += 1; continue; }
        g[cur[0]][cur[1]] = c;
        cur[1] = Math.min(cols, cur[1] + 1);
        i += 1;
      }
    },
  };
}
const em = makeGrid(ROWS, COLS);
let raw = "";
function dump(tag) {
  fs.writeFileSync("C:/Users/connessn/Observation_only/test-rig/work/prompt-bars-raw.txt", JSON.stringify(raw.replace(/\x1b/g, "<ESC>")));
  console.log(`--- ${tag} (raw ${raw.length} bytes) alt=${raw.includes("\x1b[?1049h")} bars=${(raw.match(/─/g) ?? []).length} ---`);
  for (let r = 0; r < ROWS; r++) {
    const line = em.grid[r].join("").replace(/\s+$/, "");
    console.log(String(r + 1).padStart(2) + "|" + line);
  }
  console.log("cursor@" + (em.cur[0] + 1) + "," + (em.cur[1] + 1));
  console.log("");
}
const waitFor = (needle, ms) => new Promise((res) => { const t = setInterval(() => { if (raw.includes(needle)) { clearInterval(t); res(true); } }, 100); setTimeout(() => { clearInterval(t); res(false); }, ms); });

const server = require("node:child_process").spawn(process.execPath, ["test-rig/mock-server.mjs", "--port", "8407"], { cwd: "C:/Users/connessn/Observation_only", stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});
const p = pty.spawn("node.exe", ["src/round5.js"], { name: "xterm-256color", cols: COLS, rows: ROWS, env, cwd });
p.onData((d) => { raw += d; em.write(d); });
p.onExit(({ exitCode, signal }) => { console.log("PTY EXIT code=" + exitCode + " sig=" + signal); server.kill(); process.exit(0); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const bootOk = await waitFor("model: mock/mock-1", 15000);
  await sleep(1200);
  dump("BOOT via round5.js (waited for banner)");
  if (!bootOk) { console.log("boot marker missing — abort"); p.kill(); server.kill(); process.exit(0); }
  p.write("hi");
  await sleep(500);
  dump("AFTER typed 'hi' (single-line)");
  p.write("\r");
  await sleep(900);
  dump("AFTER enter (turn submitted)");
  p.write("a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-a-very-long-prompt-xxxxxxxx");
  await sleep(600);
  dump("AFTER long wrap attempt (multi-row box)");
  p.write("\x03");
  await sleep(400);
  p.kill();
  server.kill();
  process.exit(0);
})();

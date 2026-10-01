// TEMP: run the harness in a real pty, snapshot the VISIBLE grid at key moments
const path = require("path");
const fs = require("fs");
const pty = require(path.join("C:/Users/connessn/Observation_only", "test-rig", "node_modules", "node-pty"));
const { spawn } = require("node:child_process");
const { VT } = require("./_vt.cjs");
const ROOT = "C:/Users/connessn/Observation_only";
const REAL_NODE = "C:\\Program Files\\nodejs\\node.exe";
const OUT = process.argv[2] || "C:/Users/connessn/Observation_only/test-rig/work/_vt_out.txt";
const LONG_LINE = "the quick brown fox jumps over the lazy dog near the river bank in the morning light above the tall dark tree line and beyond the hill where the old lighthouse keeps its slow bright watch all night";

function main() {
  return new Promise(async (resolve) => {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^ALAN_|^PI_MODEL$|^PI_PROVIDER$|^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$|^NODE_OPTIONS$/.test(k)) delete env[k];
    env.OBSERVATION_ONLY_DIR = path.join(ROOT, "test-rig", "work", "isolated-harness");
    const server = spawn(process.execPath, ["test-rig/mock-server.mjs", "--port", "8407", "--log", path.join(ROOT, "work", "requests_vt.jsonl")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let serverReady = false;
    server.stdout.on("data", (d) => { if (String(d).includes("MOCK-READY") && !serverReady) serverReady = true; });
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const vt = new VT();
    const t0 = Date.now();
    const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
    const p = pty.spawn(REAL_NODE, ["src/round5.js"], { name: "xterm-256color", cols: 100, rows: 30, env, cwd: ROOT });
    let bytes = 0, events = 0, lastEventAt = 0;
    p.onData((d) => { bytes += d.length; events++; lastEventAt = ts(); vt.feed(d); });
    const stat = () => `bytes=${bytes} events=${events} last=${lastEventAt}s`;
    for (let w = 0; w < 60 && !serverReady; w += 100) await delay(100);
    await delay(8000);
    console.log(`t=${ts()} BOOT-IDLE  ${stat()}`);
    vt.snapshot("BOOT-IDLE");
    for (const ch of LONG_LINE) { p.write(ch); await delay(30); }
    await delay(1200);
    console.log(`t=${ts()} MULTILINE  ${stat()}`);
    vt.snapshot("MULTILINE-SETTLED");
    p.write("\x15"); // Ctrl+U
    await delay(1200);
    console.log(`t=${ts()} CTRL-U     ${stat()}`);
    vt.snapshot("AFTER-CTRL-U-IDLE");
    p.write("/"); await delay(600);
    console.log(`t=${ts()} SLASH      ${stat()}`);
    vt.snapshot("MENU-OPEN-FULL");
    p.write("q"); await delay(900);
    console.log(`t=${ts()} Q          ${stat()}`);
    vt.snapshot("MENU-NARROWED-q");
    p.write("u"); await delay(300); p.write("i"); await delay(300); p.write("t"); await delay(900);
    console.log(`t=${ts()} QUIT       ${stat()}`);
    vt.snapshot("MENU-NARROWED-quit");
    let out = "";
    for (const s of vt.snapshots) {
      out += `=== SNAPSHOT ${s.label} (rows 1..30, cols 1..100) ===\n`;
      s.rows.forEach((line, i) => { out += String(i + 1).padStart(2) + " │" + line + "│\n"; });
      out += "\n";
    }
    fs.writeFileSync(OUT, out);
    p.kill();
    server.kill();
    console.log("wrote", OUT);
    resolve();
  });
}
main().then(() => process.exit(0));

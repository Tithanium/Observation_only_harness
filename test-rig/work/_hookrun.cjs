// TEMP: spawn the harness in a real pty WITH the stdout write hook; type "/" + "q"; dump the app's own bar writes
const path = require("path");
const fs = require("fs");
const pty = require(path.join("C:/Users/connessn/Observation_only", "test-rig", "node_modules", "node-pty"));
const { spawn } = require("node:child_process");
const ROOT = "C:/Users/connessn/Observation_only";
const REAL_NODE = "C:\\Program Files\\nodejs\\node.exe";
const HOOK_OUT = "C:/Users/connessn/Observation_only/test-rig/work/_hook_out.txt";
try { fs.unlinkSync(HOOK_OUT); } catch {}

function main() {
  return new Promise(async (resolve) => {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^ALAN_|^PI_MODEL$|^PI_PROVIDER$|^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$|^NODE_OPTIONS$/.test(k)) delete env[k];
    env.OBSERVATION_ONLY_DIR = path.join(ROOT, "test-rig", "work", "isolated-harness");
    const server = spawn(process.execPath, ["test-rig/mock-server.mjs", "--port", "8407", "--log", path.join(ROOT, "work", "requests_hook.jsonl")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let serverReady = false;
    server.stdout.on("data", (d) => { if (String(d).includes("MOCK-READY") && !serverReady) serverReady = true; });
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let raw = "";
    const p = pty.spawn(REAL_NODE, ["-r", "C:/Users/connessn/Observation_only/test-rig/work/_hook.cjs", "src/round5.js"], {
      name: "xterm-256color", cols: 100, rows: 30, env, cwd: ROOT,
    });
    p.onData((d) => { raw += d; });
    for (let w = 0; w < 60 && !serverReady; w += 100) await delay(100);
    console.log("mock ready:", serverReady);
    await delay(8000);
    p.write("/"); await delay(400);
    p.write("q"); await delay(800);
    p.write("\x03"); // ctrl-c to quit cleanly? use /quit enter instead:
    await delay(500);
    p.kill();
    server.kill();
    // dump the app's own writes containing the bar color
    const lines = fs.readFileSync(HOOK_OUT, "utf8").split("\n").filter(Boolean);
    console.log("total writes:", lines.length);
    const barWrites = [];
    for (const l of lines) {
      let s;
      try { s = JSON.parse(l); } catch { continue; }
      if (s.includes("\u2500")) barWrites.push(s);
    }
    console.log("bar writes:", barWrites.length);
    for (const s of barWrites.slice(0, 4)) {
      const m = s.match(/(\u2500+)/);
      console.log("  dashrun:", m ? m[0].length : 0, " len:", s.length);
      console.log("  JSON  :", JSON.stringify(s).slice(0, 400));
    }
    // also: the last 8 writes overall (typing frames after "/q")
    console.log("--- last 6 writes overall ---");
    for (const l of lines.slice(-6)) {
      console.log(JSON.stringify(JSON.parse(l)).slice(0, 300));
    }
    resolve();
  });
}
main().then(() => process.exit(0));

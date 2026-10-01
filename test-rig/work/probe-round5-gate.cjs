const pty = require("node-pty");
const env = Object.assign({}, process.env, { OBSERVATION_ONLY_DIR: "C:/Users/connessn/Observation_only/test-rig/work/isolated-harness" });
const p = pty.spawn("node.exe", ["src/round5.js"], { name: "xterm-256color", cols: 100, rows: 30, env, cwd: "C:/Users/connessn/Observation_only" });
let raw = "";
p.onData((d) => { raw += d; });
const fin = (why) => {
  require("fs").writeFileSync("C:/Users/connessn/Observation_only/test-rig/work/gate-real.txt", JSON.stringify(raw.replace(/\x1b/g, "<ESC>")));
  console.log(why, "len", raw.length, "1049h", raw.includes("\x1b[?1049h"), "bars", (raw.match(/─/g) ?? []).length, "DBG", raw.includes("[DBG]"));
  process.exit(0);
};
p.onExit(() => fin("EXIT"));
setTimeout(() => { fin("TIMEOUT"); p.kill(); }, 6000);

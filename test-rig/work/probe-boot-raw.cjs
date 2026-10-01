const pty = require("node-pty");
const env = Object.assign({}, process.env, { OBSERVATION_ONLY_DIR: "C:/Users/connessn/Observation_only/test-rig/work/isolated-harness" });
const fs = require("fs");
const p = pty.spawn("node.exe", ["src/round5.js"], { name: "xterm-256color", cols: 100, rows: 30, env, cwd: "C:/Users/connessn/Observation_only" });
let raw = "";
p.onData((d) => { raw += d; });
const ins = (n) => raw.includes(n);
p.onExit(() => { cleanup("EXIT"); });
const cleanup = (why) => {
  fs.writeFileSync("C:/Users/connessn/Observation_only/test-rig/work/boot-raw.txt", JSON.stringify(raw.replace(/\x1b/g, "<ESC>")));
  console.log(why, "len", raw.length, "has1049h", ins("\x1b[?1049h"), "hasEnter", ins("?1049h"));
  process.exit(0);
};
setTimeout(() => { cleanup("TIMEOUT"); p.kill(); }, 6000);

const pty = require("node-pty");
const ROWS = 30, COLS = 100;
const env = Object.assign({}, process.env);
const p = pty.spawn("node.exe", ["src/round5.js"], { name: "xterm-256color", cols: COLS, rows: ROWS, env, cwd: "C:/Users/connessn/Observation_only" });
let buf = "";
p.onData((d) => { buf += d; if (buf.length > 20000) buf = buf.slice(-20000); });
p.onExit(() => process.exit(0));
setTimeout(() => { p.write("payload NOW\r"); }, 18000);
setTimeout(() => { const hit = buf.includes("\x1b[27;1Hpayload NOW"); console.log("payload-painted-on-row27:", hit, hit ? "" : JSON.stringify(buf.slice(-120))); process.exit(0); }, 20000);

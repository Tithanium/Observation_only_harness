const pty = require("node-pty");
const env = Object.assign({}, process.env, { OBSERVATION_ONLY_DIR: "C:/Users/connessn/Observation_only/test-rig/work/isolated-harness" });
const p = pty.spawn("node.exe", ["-e", "process.stdout.write('GATE='+JSON.stringify({stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY,TERM:process.env.TERM,cols:process.stdout.columns,rows:process.stdout.rows})+'\\n')"], { name: "xterm-256color", cols: 100, rows: 30, env, cwd: "C:/Users/connessn/Observation_only" });
p.onData((d) => { process.stdout.write("[PTYOUT]" + d); });
p.onExit(() => { console.log("PTYEXIT"); process.exit(0); });
setTimeout(() => { console.log("TIMEOUT"); p.kill(); process.exit(0); }, 5000);

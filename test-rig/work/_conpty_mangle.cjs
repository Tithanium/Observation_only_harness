// TEMP micro-probe: which write patterns does ConPTY mangle at the last column?
const path = require("path");
const pty = require(path.join("C:/Users/connessn/Observation_only", "test-rig", "node_modules", "node-pty"));
function main() {
  return new Promise((resolve) => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const p = pty.spawn("C:\\Program Files\\nodejs\\node.exe", [path.join(__dirname, "_conpty_child.cjs")], { name: "xterm-256color", cols: 100, rows: 10 });
    let raw = "";
    p.onData((d) => { raw += d; });
    p.onExit(() => {});
    setTimeout(() => {
      p.kill();
      const clean = raw.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, (m) => "[" + m.slice(2) + "]");
      clean.split("\n").forEach((l, i) => {
        const m = l.match(/\u2500+/);
        console.log(`L${i}: dashrun=${m ? m[0].length : 0}  ${JSON.stringify(l.slice(0, 150))}`);
      });
      resolve();
    }, 3000);
  });
}
main().then(() => process.exit(0));

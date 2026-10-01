// TEMP: dump the RAW re-serialized stream of the mangle child (escapes visible)
const path = require("path");
const pty = require(path.join("C:/Users/connessn/Observation_only", "test-rig", "node_modules", "node-pty"));
function main() {
  return new Promise((resolve) => {
    const p = pty.spawn("C:\\Program Files\\nodejs\\node.exe", [path.join(__dirname, "_conpty_child.cjs")], { name: "xterm-256color", cols: 100, rows: 10 });
    let raw = "";
    p.onData((d) => { raw += d; });
    p.onExit(() => {});
    setTimeout(() => {
      p.kill();
      const vis = raw
        .replace(/\u001b\][^\u0007]*\u0007/g, "")
        .replace(/\u001b/g, "⟨ESC⟩")
        .replace(/\r/g, "⟨CR⟩")
        .replace(/\n/g, "⟨LF⟩");
      console.log(vis);
      resolve();
    }, 3000);
  });
}
main().then(() => process.exit(0));

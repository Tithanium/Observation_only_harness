// TEMP write hook: record every process.stdout.write to a file
const fs = require("fs");
const F = "C:/Users/connessn/Observation_only/test-rig/work/_hook_out.txt";
let n = 0;
const orig = process.stdout.write.bind(process.stdout);
Object.defineProperty(process.stdout, "write", {
  value(s) {
    try { fs.appendFileSync(F, JSON.stringify(String(s)) + "\n"); n++; } catch {}
    return orig(s);
  },
});
process.on("exit", () => {});
console.error("HOOK-ARMED " + n);

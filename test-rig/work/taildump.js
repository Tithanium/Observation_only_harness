const fs = require("fs");
let s = fs.readFileSync("C:/Users/connessn/Observation_only/src/screen.js", "utf8");
const lines = s.replace(/\r/g, "").split("\n");
const out = [];
for (let i = 1080; i < lines.length; i++) out.push(String(i + 1).padStart(4) + "|" + JSON.stringify(lines[i]));
fs.writeFileSync("C:/Users/connessn/Observation_only/test-rig/work/taildump.txt", out.join("\n") + "\nTOTAL=" + lines.length);
const m = s.replace(/\r/g, "");
let d = 0, signs = [];
for (let i = 0; i < m.length; i++) { if (m[i] === "{") { d++; signs.push(i); } }
fs.appendFileSync("C:/Users/connessn/Observation_only/test-rig/work/taildump.txt", "\nBRACES=" + d + " TOTALCHARS=" + m.length);
try { const fn = eval("(" + m.slice(m.indexOf("function createScreen"), m.lastIndexOf("}") + 1) + ")").toString(); fs.appendFileSync("C:/Users/connessn/Observation_only/test-rig/work/taildump.txt", "\nFNOK=" + fn.length); } catch (e) { fs.appendFileSync("C:/Users/connessn/Observation_only/test-rig/work/taildump.txt", "\nFNERR=" + e.message); }

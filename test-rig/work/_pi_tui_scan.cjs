// TEMP: scan pi-tui tui.js for the frame-building bytes
const fs = require("fs");
const p = "C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js";
const lines = fs.readFileSync(p, "utf8").split("\n");
lines.forEach((l, i) => {
  const t = l.trim();
  if (t.includes("\x1b[")) console.log(i + 1, JSON.stringify(t.slice(0, 220)));
});
console.log("--- render-ish function names ---");
lines.forEach((l, i) => {
  const t = l.trim();
  if (/^\w+\s*\(.*\)\s*\{?$/.test(t) && /(render|frame|paint|output|draw)/i.test(t)) console.log(i + 1, t);
});

// TEMP: show the FIRST few bar writes in the stream (context around each ─ run's head)
const fs = require("fs");
const txt = fs.readFileSync("C:/Users/connessn/Observation_only/dev_rounds/piece1_ours.txt", "utf8");
const start = txt.indexOf("--- FULL PTY CAPTURE");
const end = txt.indexOf("--- END CAPTURE ---");
let raw = txt.slice(start, end);
const qstart = raw.indexOf('"');
const qend = raw.lastIndexOf('"');
let s = raw.slice(raw.indexOf('"', qstart + 1) + 1, qend);
let out = "";
for (let j = 0; j < s.length; j++) {
  const c = s[j];
  if (c === "\\") {
    const n = s[j + 1];
    if (n === "u") { out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 5; }
    else if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "0") out += "\0";
    else if (n === "\\") out += "\\";
    else if (n === '"') out += '"';
    else out += n;
    j += 1;
  } else out += c;
}
// find first 6 occurrences of the bar-color + dash run, print 40 chars of preceding context
let idx = 0;
let count = 0;
while (count < 6) {
  const p = out.indexOf("\x1b[38;2;80;80;80m", idx);
  if (p === -1) break;
  const pre = JSON.stringify(out.slice(Math.max(0, p - 45), p));
  const after = JSON.stringify(out.slice(p, p + 130));
  console.log(`--- occurrence ${++count} at ${p}`);
  console.log("pre  :", pre);
  console.log("bar  :", after);
  idx = p + 10;
}

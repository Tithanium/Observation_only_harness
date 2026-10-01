// TEMP: decode the capture stream and inspect around the literal-CSI location
const fs = require("fs");
const txt = fs.readFileSync("C:/Users/connessn/Observation_only/dev_rounds/piece1_ours.txt", "utf8");
const start = txt.indexOf("--- FULL PTY CAPTURE");
const end = txt.indexOf("--- END CAPTURE ---");
const sec = txt.slice(start, end);
console.log("sec len:", sec.length, "first quote:", sec.indexOf('"'), "last quote:", sec.lastIndexOf('"'));
// The content is between the FIRST and LAST quote of the section
const open = sec.indexOf('"');
const close = sec.lastIndexOf('"');
const s = sec.slice(open + 1, close);
console.log("raw content len:", s.length, "head:", JSON.stringify(s.slice(0, 60)));
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
fs.writeFileSync("C:/Users/connessn/Observation_only/test-rig/work/_stream_decoded.bin", Buffer.from(out, "binary"));
let esc = 0;
for (const c of out) if (c === "\x1b") esc++;
console.log("decoded len:", out.length, "ESC count:", esc);
let count = 0;
for (let i = 0; i < out.length && count < 5; i++) {
  if (out[i] === "[" && (i === 0 || out.charCodeAt(i - 1) !== 27) && /[0-9;?]/.test(out[i + 1] ?? "")) {
    console.log("literal-CSI at", i, JSON.stringify(out.slice(Math.max(0, i - 30), i + 30)));
    count++;
  }
}

// TEMP: analyze the runs of ─ in the piece1_ours.txt capture (stream), and in the
// final simulated screen state (tiny VT emulator).
const fs = require("fs");
const txt = fs.readFileSync("C:/Users/connessn/Observation_only/dev_rounds/piece1_ours.txt", "utf8");

// --- 1. stream-level: find every maximal run of ─, report length
const runs = [...txt.matchAll(/\u2500+/g)];
const counts = {};
for (const m of runs) counts[m[0].length] = (counts[m[0].length] || 0) + 1;
console.log("STREAM dash-run lengths:", JSON.stringify(counts));

// --- 2. tiny VT emulator for the FULL PTY CAPTURE section
const start = txt.indexOf("--- FULL PTY CAPTURE");
const end = txt.indexOf("--- END CAPTURE ---");
if (start === -1 || end === -1) { console.log("no full capture section"); process.exit(1); }
let raw = txt.slice(start, end);
// unescape the JS string escapes: the capture is stored as a JSON-ish quoted string
const qstart = raw.indexOf('"');
let stream = "";
let i = raw.indexOf('"', qstart + 1) + 1;
// the string ends at the last " before --- END CAPTURE
const qend = raw.lastIndexOf('"');
let s = raw.slice(i, qend);
// decode escapes
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
// minimal grid 30x100, alt-screen aware
const COLS = 100, ROWS = 30;
const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
let cx = 0, cy = 0;
let inAlt = false;
let buf = "";
function put(ch) {
  if (cy < 0 || cy >= ROWS) return;
  if (cx >= COLS) { cx = 0; cy = Math.min(ROWS - 1, cy + 1); return; }
  grid[cy][cx] = ch;
  cx += 1;
}
function feed(data) {
  for (let k = 0; k < data.length; k++) {
    const ch = data[k];
    if (ch === "\x1b") {
      // collect sequence
      let seq = "";
      if (data[k + 1] === "[") {
        k += 2;
        while (k < data.length && !/[@-~]/.test(data[k])) { k++; seq += data[k]; }
        k += 1;
        const fin = data[k];
        handleCSI(seq, fin);
      } else if (data[k + 1] === "]") {
        k += 2;
        while (k < data.length && data[k] !== "\x07" && data[k] !== "\x1b") k++;
        if (data[k] === "\x1b") k -= 1;
      } else {
        k += 2;
      }
      continue;
    }
    if (ch === "\r") { cx = 0; continue; }
    if (ch === "\n") { cy = Math.min(ROWS - 1, cy + 1); continue; }
    if (ch === "\b") { cx = Math.max(0, cx - 1); continue; }
    if (ch === "\t") { cx = Math.min(COLS - 1, (Math.floor(cx / 8) + 1) * 8); continue; }
    if (ch >= " " || ch === "\u2500") put(ch);
    else if (ch === "\x07") continue;
  }
}
function handleCSI(seq, fin) {
  const parts = seq.split(";").map((p) => (p === "" ? null : parseInt(p, 10)));
  if (fin === "H") { cy = clamp01(parts[0] ?? 1); cx = clamp01(parts[1] ?? 1); return; }
  if (fin === "A") { cy = Math.max(0, cy - (parts[0] ?? 1)); return; }
  if (fin === "B") { cy = Math.min(ROWS - 1, cy + (parts[0] ?? 1)); return; }
  if (fin === "C") { cx = Math.min(COLS - 1, cx + (parts[0] ?? 1)); return; }
  if (fin === "D") { cx = Math.max(0, cx - (parts[0] ?? 1)); return; }
  if (fin === "J") { // erase in display: 0=to end, 1=to start, 2=all, 3=all
    const m = parts[0] ?? 0;
    if (m === 0) { for (let r = cy; r < ROWS; r++) for (let c = (r === cy ? cx : 0); c < COLS; c++) grid[r][c] = " "; }
    else if (m === 1) { for (let r = 0; r <= cy; r++) for (let c = (r === cy ? cx : 0); c < COLS; c++) grid[r][c] = " "; }
    else { for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid[r][c] = " "; }
    return;
  }
  if (fin === "K") { // erase in line
    const m = parts[0] ?? 0;
    if (m === 0) { for (let c = cx; c < COLS; c++) grid[cy][c] = " "; }
    else if (m === 1) { for (let c = 0; c <= cx; c++) grid[cy][c] = " "; }
    else { for (let c = 0; c < COLS; c++) grid[cy][c] = " "; }
    return;
  }
  if (fin === "h" && seq === "?1049") { inAlt = true; return; }
  if (fin === "l" && seq === "?1049") { inAlt = false; return; }
}
function clamp01(v) { return Math.max(1, Math.min(v === ROWS ? ROWS : Math.min(v, ROWS), ROWS)) - 1 < 0 ? 0 : Math.max(0, Math.min(v, ROWS) - 1); }
feed(out);
console.log("\n=== FINAL GRID (rows 12..30, showing bar rows) ===");
for (let r = 11; r < ROWS; r++) {
  const line = grid[r].join("");
  const dash = line.match(/\u2500+/);
  console.log(String(r + 1).padStart(2) + (dash ? `  [dashes=${dash[0].length}]` : "") + "  " + JSON.stringify(line.slice(0, 120)));
}

// TEMP: minimal VT grid emulator (30x100) for the ConPTY re-serialized stream.
// Carries incomplete escape sequences across chunks.
const COLS = 100, ROWS = 30;
const FIN = /[@-~]/;
class VT {
  constructor() {
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
    this.cx = 0; this.cy = 0;
    this.snapshots = [];
    this.carry = ""; // incomplete escape head waiting for more bytes
  }
  snapshot(label) {
    this.snapshots.push({ label, rows: this.grid.map((r) => r.join("")) });
  }
  put(ch) {
    if (this.cy < 0 || this.cy >= ROWS) return;
    if (this.cx >= COLS) { this.cx = 0; this.cy = Math.min(ROWS - 1, this.cy + 1); if (this.cy >= ROWS) return; }
    this.grid[this.cy][this.cx] = ch;
    this.cx += 1;
  }
  feed(data) {
    let s = this.carry + String(data);
    this.carry = "";
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === "\x1b") {
        const start = k;
        if (k + 1 < s.length && s[k + 1] === "[") {
          let j = k + 2;
          while (j < s.length && !FIN.test(s[j])) j += 1;
          if (j >= s.length) { this.carry = s.slice(start); break; } // incomplete CSI — wait for more
          this.csi(s.slice(k + 2, j), s[j]);
          k = j;
        } else if (k + 1 < s.length && s[k + 1] === "]") {
          let j = k + 2;
          while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j += 1;
          if (j >= s.length) { this.carry = s.slice(start); break; } // incomplete OSC
          if (s[j] === "\x1b") j += 1; // ST (ESC \) — consume both
          k = j; // k at BEL (or past ST); loop k++ consumes the BEL
        } else if (k + 1 < s.length) {
          k += 1; // two-byte escape (ESC x) — ignore both
        } else {
          this.carry = s.slice(start); break; // lone ESC at chunk end
        }
        continue;
      }
      if (ch === "\r") { this.cx = 0; continue; }
      if (ch === "\n") { this.cy = Math.min(ROWS - 1, this.cy + 1); continue; }
      if (ch === "\b") { this.cx = Math.max(0, this.cx - 1); continue; }
      if (ch === "\t") { this.cx = Math.min(COLS - 1, (Math.floor(this.cx / 8) + 1) * 8); continue; }
      if (ch === "\x07") continue;
      if (ch >= " ") this.put(ch);
    }
  }
  csi(seq, fin) {
    const parts = seq.split(";").map((p) => (p === "" ? 0 : parseInt(p, 10)));
    const p0 = parts[0] || 0;
    if (seq.startsWith("?")) return; // private modes (9001, 1049, 25, 2026, 1000-1006, 2004, 2031…)
    if (fin === "H" || fin === "f") { this.cy = Math.max(0, Math.min((parts[0] || 1) - 1, ROWS - 1)); this.cx = Math.max(0, Math.min((parts[1] || 1) - 1, COLS - 1)); return; }
    if (fin === "A") { this.cy = Math.max(0, this.cy - p0); return; }
    if (fin === "B") { this.cy = Math.min(ROWS - 1, this.cy + p0); return; }
    if (fin === "C") { this.cx = Math.min(COLS - 1, this.cx + p0); return; }
    if (fin === "D") { this.cx = Math.max(0, this.cx - p0); return; }
    if (fin === "G" || fin === "`") { this.cx = Math.max(0, Math.min(p0 - 1, COLS - 1)); return; }
    if (fin === "d") { this.cy = Math.max(0, Math.min(p0 - 1, ROWS - 1)); return; }
    if (fin === "J") {
      const m = parts[0] === undefined ? 0 : parts[0];
      if (m === 0) { for (let r = this.cy; r < ROWS; r++) for (let c = (r === this.cy ? this.cx : 0); c < COLS; c++) this.grid[r][c] = " "; }
      else if (m === 1) { for (let r = 0; r <= this.cy; r++) for (let c = (r === this.cy ? this.cx : 0); c < COLS; c++) this.grid[r][c] = " "; }
      else { this.grid.forEach((r) => r.fill(" ")); }
      return;
    }
    if (fin === "K") {
      const m = parts[0] === undefined ? 0 : parts[0];
      if (m === 0) { for (let c = this.cx; c < COLS; c++) this.grid[this.cy][c] = " "; }
      else if (m === 1) { for (let c = 0; c <= this.cx; c++) this.grid[this.cy][c] = " "; }
      else { for (let c = 0; c < COLS; c++) this.grid[this.cy][c] = " "; }
      return;
    }
  }
  dump(label) {
    const out = [`=== SNAPSHOT ${label} (rows 1..30, cols 1..100) ===`];
    for (let r = 0; r < ROWS; r++) {
      const line = this.grid[r].join("");
      out.push(String(r + 1).padStart(2) + " │" + line + "│");
    }
    return out.join("\n");
  }
}
module.exports = { VT };

import fs from "node:fs";
const s = fs.readFileSync("src/screen.js", "utf8");
let depth = 0;
let inStr = null;
let line = 1;
for (let j = 0; j < s.length; j++) {
  const ch = s[j];
  if (inStr) {
    if (ch === "\\") { j++; continue; }
    if (ch === inStr) inStr = null;
    if (ch === "\n") line++;
    continue;
  }
  if (ch === "\n") line++;
  if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
  if (ch === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j++; continue; }
  if (ch === "{") { depth++; if (depth >= 189) console.log("OPEN depth " + depth + " at line " + line + " ctx: " + s.slice(Math.max(0, j - 30), j + 2)); }
  if (ch === "}") depth--;
}
console.log("final depth", depth);

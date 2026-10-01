import { readFileSync } from "node:fs";
const src = "// probe\n" + readFileSync(new URL("../../src/screen.js", import.meta.url), "utf8");
// Count tokens: lines at module level we care about
const lines = src.split("\n");
process.stdout.write("LAST5=" + JSON.stringify(lines.slice(-5)) + "\n");
// Find the module-level brace balance progress by counting all { } naive count
let bal = 0, minBal = 0, maxIdx = 0;
for (const ch of src) {
  if (ch === "{") bal++;
  if (ch === "}") bal--;
  if (bal > maxIdx) maxIdx = bal;
  if (bal < minBal) minBal = bal;
}
process.stdout.write("NAIVE_BAL=" + bal + " MAX=" + maxIdx + "\n");
// Count CREATE_SCREEN occurrences any form
const r = /createScreen/g;
process.stdout.write("CREATES=" + src.match(r).length + "\n");
// Balanced brace SCAN ignoring strings/comments — full lexical scan
let depth = 0;
let inStr = null, inLineC = false, inBlockC = false, i = 0;
const stack = [];
let posDepth828 = -1, lastTopReturn = -1;
for (i = 0; i < src.length; i++) {
  const c = src[i], n = src[i + 1];
  if (inLineC) { if (c === "\n") inLineC = false; continue; }
  if (inBlockC) { if (c === "*" && n === "/") { inBlockC = false; i++; } continue; }
  if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
  if (c === "/" && n === "/") { inLineC = true; i++; continue; }
  if (c === "/" && n === "*") { inBlockC = true; i++; continue; }
  if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
  if (c === "{") { depth++; }
  if (c === "}") { depth--; }
  if (src.startsWith("return {", i)) { if (depth === 1) { lastTopReturn = depth; posDepth828 = depth; } i += "return {".length - 1; }
}
process.stdout.write("LEX_DEPTH_END=" + depth + "\n");
process.stdout.write("LEX_LASTDEPTH_AT_RETURN=" + posDepth828 + "\n");

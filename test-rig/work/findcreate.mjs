import fs from "fs";
const src = fs.readFileSync("src/screen.js", "utf8").replace(/\r/g, "");
const idx = src.indexOf("function createScreen");
const fn = src.slice(idx);
const after = fn.slice(fn.indexOf("{") + 1);
let depth = 0;
let closes = [];
for (let i = 0; i < after.length; i++) {
  if (after[i] === "{") depth++;
  if (after[i] === "}") { depth--; if (depth === 0) closes.push(i); }
}
console.log("first d0 close at", closes[0], "fn len", fn.length, "after len:", after.length);
console.log("last 60 of fn:", JSON.stringify(fn.slice(-60)));
console.log("TOTAL FILE len:", src.length, "fn total:", fn.length, "tail after fn:", src.length - idx);
// find what's the text right around fn end
const fnEnd = idx + closes[0] + 1; // offset of the closing } of createScreen
console.log("fn ends at file offset", fnEnd);
console.log("text after createScreen:", JSON.stringify(src.slice(fnEnd, fnEnd + 120)));

import fs from "fs";
const src = fs.readFileSync("src/screen.js", "utf8");
// Strip block comments and line comments (naive but good enough for brace counting)
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(l => l.replace(/\/\/.*$/, ""));
let depth = 0;
let out = [];
for (let i = 0; i < stripped.length; i++) {
  const line = stripped[i];
  depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  if (i === 218) {} 
  if (i >= 218 && /\breturn\b/.test(line)) {
    out.push(`${i + 1} depth=${depth}: ${line.trim().slice(0, 80)}`);
  }
}
console.log(out.join("\n"));
console.log("== 828 ==");
console.log(`828 depth=${stripped.slice(0, 828).join("").length >= 0 ? depth : ""}`);

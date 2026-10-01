import fs from "fs";
const src = fs.readFileSync("src/screen.js", "utf8").replace(/\r/g, "").split("\n");
const stripped = () => src.map(l => l.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]/g, ""));
let depth = 0;
let started = false;
for (let i = 0; i < src.length; i++) {
  const line = src[i].replace(/\/\*.*$/, "");
  if (i === 218) { started = true; depth++; continue; }
  if (!started) continue;
  depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  const m = line.match(/\breturn\b/);
  if (m && depth <= 1 && line.trim() !== "return {") {
    console.log(`${i + 1} depth=${depth}: ${line.trim().slice(0, 90)}`);
  }
  if (depth <= 0) { console.log(`>> createScreen CLOSES at line ${i + 1}, depth now ${depth}`); }
}

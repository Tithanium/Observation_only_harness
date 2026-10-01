import fs from "fs";
const c = fs.readFileSync("src/screen.js", "utf8").split("\n");
// Track depth INSIDE createScreen only: count every { and }, find ALL `return X` at depth==1
let depth = 0;
let fnStack = []; // simulate function scoping
for (let i = 0; i < c.length; i++) {
  const line = c[i] ?? "";
  depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  if (i === 218) console.log(`219 FUNCTION createScreen { -> depth now ${depth}`);
  if (i >= 218) {
    if (/\breturn\b/.test(line)) {
      console.log(`${i + 1} depth=${depth}: ${line.trim().slice(0, 100)}`);
    }
  }
  if (i === 827) console.log(`828 depth=${depth}`);
}

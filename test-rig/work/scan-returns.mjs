import fs from "fs";
const c = fs.readFileSync("src/screen.js", "utf8").split("\n");
let depth = 0;
for (let i = 218; i < 828 && i < c.length; i++) {
  const line = c[i];
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  const trimmed = line.trim();
  if (/^return\s*(;|$)/.test(trimmed)) console.log(`${i + 1} (depth ${depth}): ${trimmed}`);
  depth += opens - closes;
}
console.log("final depth at 828:", depth);
const brace = c[827];
console.log("828:", brace);

import fs from "fs";
const c = fs.readFileSync("src/screen.js", "utf8").split("\n");
let depth = 0;
for (let i = 0; i < 830; i++) {
  const line = c[i] ?? "";
  const noComment = line.replace(/\/\/.*$/, "");
  const opens = (noComment.match(/\{/g) || []).length;
  const closes = (noComment.match(/\}/g) || []).length;
  depth += opens - closes;
  if (i >= 217 && (i < 226 || /^\s*return\s*$/.test(line) || depth <= 1)) {
    console.log(`${i + 1} depth=${depth}: ${line.trim().slice(0, 90)}`);
  }
}
console.log("DEPTH AT 828:", depth);

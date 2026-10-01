import { readFileSync } from "node:fs";
const b = readFileSync(new URL("../../src/screen.js", import.meta.url), "utf8");
const lines = b.split("\n");
process.stdout.write("NL=" + lines.length + "\n");
for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
  process.stdout.write("L" + (i + 1) + "=" + JSON.stringify(lines[i]) + "\n");
}

import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../src/screen.js", import.meta.url), "utf8");
// Posindex of every { } in order for the LAST 1200 chars
const tail = src.slice(-160);
process.stdout.write("TAIL=" + JSON.stringify(src.slice(-160)) + "\n");

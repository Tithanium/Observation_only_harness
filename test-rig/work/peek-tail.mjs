import { readFileSync } from "node:fs";
const b = readFileSync(new URL("./instr-screen/screen.mjs", import.meta.url), "utf8");
process.stdout.write("TAIL_JSON=" + JSON.stringify(b.slice(-260)) + "\n");

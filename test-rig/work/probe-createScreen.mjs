import { createScreen } from "../../src/screen.js";
const s = createScreen({ output: { write() {}, columns: 120, rows: 30 } });
console.log("TYPE:", typeof s);
console.log("IS NULL:", s === null);
console.log("IS UNDEF:", s === undefined);
if (s) console.log("keys:", Object.keys(s).slice(0, 30).join(","));

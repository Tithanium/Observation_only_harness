import * as m from "../../src/screen.js";
const fn = m.createScreen;
const s = fn({ output: { write() {}, columns: 120, rows: 30 } });
console.log("typeof result:", typeof s);
console.log("result === undefined ?", s === undefined);
if (s) console.log("has keys:", Object.keys(s));
// print true last chars of exported fn
const fnStr = Function.prototype.toString.call(fn);
console.log("real fn last 40:", JSON.stringify(fnStr.slice(-40)));
console.log("real fn length:", fnStr.length);
console.log("inner start:", JSON.stringify(fnStr.slice(0, 60)));
// try evaluating the same file text directly
const fs = await import("fs");
const src = fs.readFileSync(new URL("../../src/screen.js", import.meta.url), "utf8").replace(/\r/g, "");
const body = src.slice(src.indexOf("function createScreen") + "function createScreen".length);
console.log("file fn last40:", JSON.stringify(body.slice(-40)));
// fixed whole-file check char by char
let d = 0, pos = 0;
for (const ch of src) { if (ch === "{") d++; if (ch === "}") d--; }
console.log("file depth:", d);

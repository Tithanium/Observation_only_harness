import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
const lines = readFileSync("src/screen.js", "utf8").split("\n");
const tmp = "src/_tagged_screen.mjs";
const out = [];
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  if (i + 1 >= 219 && /^\s*return\s*\{?\s*$/.test(ln)) out.push(`console.error("TRACE return at line ${i + 1}")`);
  out.push(ln);
}
writeFileSync(tmp, out.join("\n"));
const m = await import(pathToFileURL(tmp).href).catch((e) => { console.log("import fail", e.message); process.exit(1); });
const o = new PassThrough();
Object.defineProperty(o, "isTTY", { value: true });
o.columns = 100; o.rows = 30;
console.log("--- calling createScreen({output:TTY}) ---");
const r = m.createScreen({ output: o });
console.log("RESULT typeof:", typeof r);
rmSync(tmp, { force: true });

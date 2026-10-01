// Instrument a STRING COPY of src/screen.js into a REAL temp file (relative
// imports resolve from it), patch it, and import THAT. Live src/screen.js untouched.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const srcPath = join(thisDir, "../../src/screen.js");

// Copy the module's real deps next to the instrumented copy so imports resolve.
const depDests = [
  ["../../src/working.js", "working.js"],
  ["../../src/visible_width.js", "visible_width.js"],
  ["../../src/footer.js", "footer.js"],
  ["../../src/subagent_tool.js", "subagent_tool.js"],
  ["../../src/pi_output.js", "pi_output.js"],
];
const tmpBase = join(thisDir, "instr-screen");
mkdirSync(tmpBase, { recursive: true });
for (const [rel, name] of depDests) {
  try { copyFileSync(join(thisDir, rel), join(tmpBase, name)); } catch (e) { process.stdout.write("DEP_FAIL " + name + ": " + e.message + "\n"); }
}

let src = readFileSync(srcPath, "utf8");
// CRLF-safe: normalize to \n, we only transform our own injected lines after this.
const entryNeedle = "export function createScreen(options = {})";
const entryIdx = src.indexOf(entryNeedle);
if (entryIdx < 0) { process.stdout.write("ENTRY_NOT_FOUND\n"); process.exit(2); }
// Inject a LOG right after the opening brace of the function (the `{` right after the needle).
const bodyBrace = src.indexOf(")", entryIdx);
const braceIdx = src.indexOf("{", bodyBrace);
src = src.slice(0, braceIdx + 1) + '\n  LOG("ENTRY");' + src.slice(braceIdx + 1);

// Point relative imports at the ORIGINAL src/ modules (CRLF-safe, ESM-safe).
src = src.replace(/\.\/\.\/src\//g, "../../");
src = src.replace(/\.\/working\.js/g, "../../../src/working.js");
src = src.replace(/\.\/visible_width\.js/g, "../../../src/visible_width.js");
src = src.replace(/\.\/footer\.js/g, "../../../src/footer.js");
src = src.replace(/\.\/subagent_tool\.js/g, "../../../src/subagent_tool.js");
src = src.replace(/\.\/pi_output\.js/g, "../../../src/pi_output.js");
globalThis.fsMk = tmpBase;

// Mark the LAST `return {` (line ~828 object) so we can see whether it executes.
const returnIdx = src.lastIndexOf("return {");
if (returnIdx < 0) { process.stdout.write("NO_RETURN\n"); process.exit(2); }
src = src.slice(0, returnIdx) + 'LOG("AT_RETURN_OBJ");\n' + src.slice(returnIdx);

// Mark the FINAL closing brace of createScreen: the LAST `}` in the file.
const endIdx = src.lastIndexOf("}");
if (endIdx < 0) { process.stdout.write("NO_END\n"); process.exit(2); }
src = src.slice(0, endIdx) + 'LOG("END_OF_FN");\n' + src.slice(endIdx);

// Prepend LOG helper.
src = 'function LOG(m){ process.stderr.write("[INSTR] " + m + "\\n"); }\n' + src;

writeFileSync(join(tmpBase, "screen.mjs"), src, "utf8");
process.stdout.write("WROTE " + src.length + " bytes\n");
try {
  const m = await import(new URL("file://" + tmpBase.replace(/\\/g, "/") + "/screen.mjs?t=" + Date.now()));;
  const s = m.createScreen({ output: { write() {}, columns: 100, rows: 30 } });
  process.stdout.write("TYPE=" + typeof s + " KEYS=" + (s ? Object.keys(s).join(",") : "-") + "\n");
} catch (e) {
  process.stdout.write("THREW: " + (e && e.stack ? e.stack.split("\n").slice(0, 8).join(" | ") : e) + "\n");
}

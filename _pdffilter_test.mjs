import { mapFolderWalk, interactiveConvert, pdf2TextScriptPath } from "./src/map_walk.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OBSERVATION_ONLY_CREATE_FOLDER_PATH = "1";

const root = mkdtempSync(join(tmpdir(), "pdfmap-"));
const sub = join(root, "sub");
mkdirSync(sub, { recursive: true });
writeFileSync(join(root, "report.pdf"), "%PDF-1.4 fake");
writeFileSync(join(root, "notes.txt"), "hello");
writeFileSync(join(sub, "guide.PDF"), "%PDF-1.4 fake2"); // uppercase ext must be filtered too
writeFileSync(join(sub, "data.txt"), "world");

console.log("pdf2text path:", pdf2TextScriptPath());

// conversion SKIPPED (non-TTY auto-NO); preflight keeps the given root
const res = await mapFolderWalk(root, {
  preflight: async () => true,
  confirm: async () => true,
  convert: async () => false,
});

const map = readFileSync(join(root, "map_folder.md"), "utf8");
const subMap = readFileSync(join(sub, "map_folder.md"), "utf8");
const full = readFileSync(join(root, "map_folder_full.md"), "utf8");
console.log("--- root/map_folder.md ---\n" + map);
console.log("--- sub/map_folder.md ---\n" + subMap);
console.log("--- map_folder_full.md (pdf/txt lines) ---\n" + full.split("\n").filter((l) => /\.(pdf|txt)/i.test(l)).join("\n"));

let ok = true;
const fail = (m) => { ok = false; console.error("FAIL:", m); };
if (/\.pdf/i.test(map)) fail("root map_folder.md lists a .pdf (must be filtered)");
if (!/notes\.txt/.test(map)) fail("root map_folder.md missing notes.txt");
if (!/sub\//.test(map)) fail("root map_folder.md missing the sub/ dir");
if (/\.pdf/i.test(subMap)) fail("sub map_folder.md lists a .pdf (must be filtered)");
if (!/data\.txt/.test(subMap)) fail("sub map_folder.md missing data.txt");
if (/\.pdf/i.test(full)) fail("map_folder_full.md lists a .pdf (must be filtered)");
if (!/data\.txt/.test(full)) fail("map_folder_full.md missing sub/data.txt");
if (res.declined) fail("walk should not be declined");
const c = await interactiveConvert({ root }); // non-TTY must auto-NO
if (c !== false) fail("interactiveConvert must be false on non-TTY (no auto-convert)");

rmSync(root, { recursive: true, force: true });
console.log(ok ? "ALL_PASS" : "FAILURES");
process.exit(ok ? 0 : 1);

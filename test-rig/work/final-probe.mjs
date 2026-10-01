// FINAL clean probe: does createScreen really return an object?
import { createScreen } from "../../src/screen.js";

const fakeOut = { write() {}, columns: 100, rows: 30 };
let s;
try {
  s = createScreen({ output: fakeOut });
} catch (e) {
  process.stdout.write("THREW: " + (e && e.message) + "\n");
  process.exit(3);
}
process.stdout.write("TYPE=" + typeof s + " KEYS=" + (s ? Object.keys(s).join(",") : "-") + "\n");
if (s && typeof s.out === "function" && typeof s.enter === "function") process.stdout.write("SCREEN_OK\n");
else process.stdout.write("SCREEN_BAD\n");

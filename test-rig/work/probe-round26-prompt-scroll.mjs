// Probe: ROUND 26 piece 2 — the LARGE-PROMPT SCROLL. Drives the REAL createScreen
// (src/screen.js) with an injected TTY output and the REAL input pump
// (runInteractiveSession → createLineReader) with raw bytes. The prompt box is
// pi's FIXED-height editor box (maxVisibleLines = max(5, floor(rows*0.3)),
// pi-tui components/editor.js:402-404); a prompt taller than the box SCROLLS
// inside it, cursor-FOLLOW (editor.js:409-418), the ` ↑ N more ` / ` ↓ N more `
// indicators ride IN the two ─ bars (createScrollBorder editor.js:183-197,
// renderTopBorder/renderBottomBorder 383-390); plain Up/Down on a wrapped prompt
// move the CURSOR across wrapped rows (editor.js:749-767) which scrolls.

process.env.OBSERVATION_ONLY_DIR = "C:/Users/connessn/Observation_only/test-rig/work/isolated";
import { PassThrough } from "node:stream";
import { createScreen } from "../../src/screen.js";
import { runInteractiveSession } from "../../src/interactive.js";
import { createClient } from "../../src/client.js";
import { createSessionStore } from "../../src/session_store.js";

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}: ${name} ${info}`); };

function makeScreen() {
  const recv = [];
  const output = new PassThrough();
  Object.defineProperty(output, "isTTY", { value: true, enumerable: true });
  output.columns = 100;
  output.rows = 30;
  output.write = ((orig) => (buf, ...rest) => { recv.push(buf.toString()); return orig.call(output, buf, ...rest); })(output.write.bind(output));
  const screen = createScreen({ output });
  screen.enter();
  return { screen, recv };
}
const lastParkRow = (b) => { const m = [...b.matchAll(/\x1b\[(\d+);\d+H/g)]; return m.length ? m[m.length - 1][1] : null; };
const burst = (recv) => recv.join("");

// ---------- PART A: screen-level — the fixed-height scrolling box + bar indicators ----------
{
  const { screen, recv } = makeScreen();
  screen.setFooter({ providerId: "mock", modelId: "mock-1" }, {});
  const W = 100; // 100x30 window → maxVisibleLines = max(5, floor(30*0.3)) = 9
  const LONG = "x".repeat(1190); // 12 wrapped rows at W=100

  // A1/A2: single-line prompt — byte-identical: plain bars, park at writingTopRow() (= R-2)
  screen.setPromptLine("hi", 2);
  recv.length = 0;
  screen.writePromptBox();
  const b1 = burst(recv);
  check("A1 single-line: no ` N more ` indicator", !/ more /.test(b1), "");
  check("A2 single-line: park row = writingTopRow() (R-2)", lastParkRow(b1) === String(screen.writingTopRow()), `park=${lastParkRow(b1)} writingTopRow=${screen.writingTopRow()}`);
  check("A2b single-line: 1 box row only (N=1, row 27 written, row 19 NOT)", b1.includes(`\x1b[27;1H`) && !b1.includes(`\x1b[19;1H`), "");

  // A3-A6: 12-row prompt — box CAPS at maxVisibleLines=9, cursor at the END (row 11)
  // → scrollOffset = 11 − 9 + 1 = 3 → top bar ` ↑ 3 more `, park = writingTopRow + 8
  screen.setPromptLine(LONG, 1190);
  recv.length = 0;
  screen.writePromptBox();
  const b2 = burst(recv);
  check("A3 cursor end: top bar shows ' ↑ 3 more ' (12 − 9 hidden above)", b2.includes(" ↑ 3 more "), "");
  check("A4 box fixed at 9 rows (pi maxVisibleLines, editor.js:404)", b2.includes("\x1b[19;1H") && b2.includes("\x1b[27;1H"), "");
  check("A5 cursor end: park = writingTopRow + (11 − 3)", lastParkRow(b2) === String(screen.writingTopRow() + 8), `park=${lastParkRow(b2)}`);
  check("A6 cursor end: nothing hidden below", !/ ↓ /.test(b2), "");

  // A7/A8: cursor at 0 — scrollOffset 0 → bottom bar ` ↓ 3 more `, park = writingTopRow + 0
  screen.setPromptLine(LONG, 0);
  recv.length = 0;
  screen.writePromptBox();
  const b3 = burst(recv);
  check("A7 cursor top: bottom bar shows ' ↓ 3 more ' (12 − 9 hidden below)", b3.includes(" ↓ 3 more ") && !/ ↑ /.test(b3), "");
  check("A8 cursor top: park = writingTopRow + 0", lastParkRow(b3) === String(screen.writingTopRow()), `park=${lastParkRow(b3)}`);

  // A9: cursor row 4 — inside [0,9) — scroll stays 0, ` ↓ 3 more `, park = writingTopRow + 4
  screen.setPromptLine(LONG, 450);
  recv.length = 0;
  screen.writePromptBox();
  const b4 = burst(recv);
  check("A9 cursor row 4: ` ↓ 3 more `, park = writingTopRow + 4", b4.includes(" ↓ 3 more ") && lastParkRow(b4) === String(screen.writingTopRow() + 4), `park=${lastParkRow(b4)}`);

  // A10: cursor row 1 FROM scroll 0 — row 1 is INSIDE [0,9) — scroll stays 0 (the
  // reveal-UP case is covered by the real pump in PART B)
  screen.setPromptLine(LONG, 120);
  recv.length = 0;
  screen.writePromptBox();
  const b5 = burst(recv);
  check("A10 cursor row 1 from scroll 0: scroll stays 0 → ` ↓ 3 more `, park = writingTopRow + 1", b5.includes(" ↓ 3 more ") && !/ ↑ /.test(b5) && lastParkRow(b5) === String(screen.writingTopRow() + 1), `park=${lastParkRow(b5)}`);

  // A11: a 3-row wrapped prompt (fits inside 9) — 3 rows, plain bars
  screen.setPromptLine("y".repeat(201), 201);
  recv.length = 0;
  screen.writePromptBox();
  const b6 = burst(recv);
  check("A11 3-row prompt: box = 3 rows, plain bars", !/ more /.test(b6), "");
}

// ---------- PART B: the REAL input pump — plain Up on a wrapped prompt moves the CURSOR (which scrolls, editor.js:749-767) ----------
{
  const recv = [];
  const output = new PassThrough();
  Object.defineProperty(output, "isTTY", { value: true, enumerable: true });
  output.columns = 100;
  output.rows = 30;
  output.write = ((orig) => (buf, ...rest) => { recv.push(buf.toString()); return orig.call(output, buf, ...rest); })(output.write.bind(output));
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true, enumerable: true });
  const client = await createClient({ provider: "mock", model: "mock-1" });
  const store = createSessionStore({ workDir: "C:/Users/connessn/Observation_only/test-rig/work" });
  const drive = async () => { return { text: "ok" }; };
  const p = runInteractiveSession({
    input, output, client, store, screen: true, driveTurn: drive,
    overrides: { provider: "mock", model: "mock-1" },
    mapRef: "map_folder_walk.md", workDir: "C:/Users/connessn/Observation_only/test-rig/work",
    out: () => {},
  });
  input.write("x".repeat(1190)); // ONE typed chunk → the box branch (len >= W) → writePromptBox at the END (row 11)
  await new Promise((r) => setTimeout(r, 250));
  input.write("\x1b[A"); // Up → cursor 1089 (row 10) — IN view → scroll stays 3
  await new Promise((r) => setTimeout(r, 150));
  input.write("\x1b[A".repeat(9)); // 1089 → 189 (row 1) — cursor-FOLLOW slides the slice up
  await new Promise((r) => setTimeout(r, 150));
  const all = recv.join("");
  check("B1 Up moved the cursor across wrapped rows → the box scrolled ( ` ↑ 1 more ` + ` ↓ 2 more ` )", all.includes(" ↑ 1 more ") && all.includes(" ↓ 2 more "), "");
  check("B2 the final park stays inside the box top row after the Up chain (scroll 1 → writingTopRow 19)", lastParkRow(all) === "19", `park=${lastParkRow(all)}`);
  check("B3 the Up chain moved the cursor 10 rows up (the strip moved the CURSOR — the box followed, editor.js:763-767)", all.includes(" ↑ 1 more "), "");
  input.write("/quit\n");
  input.end();
  await Promise.race([p, new Promise((r) => setTimeout(r, 500))]);
  await new Promise((r) => setTimeout(r, 200));
}

const fails = results.filter((r) => !r.ok);
console.log(fails.length === 0 ? "PROBE PASS" : `PROBE FAIL (${fails.length})`);
process.exit(fails.length === 0 ? 0 : 1);

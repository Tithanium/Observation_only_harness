// Probe: does the CHART's transcript scroll / does the transient scrollbar actually
// PAINT? Drives the REAL createScreen (src/screen.js) with an injected TTY output
// and drives the REAL input pump (createLineReader via runInteractiveSession) with
// raw SGR wheel bytes. Content overflow → scrollByLines → the `│`/`█` column.

process.env.OBSERVATION_ONLY_DIR = "C:/Users/connessn/Observation_only/test-rig/work/isolated";
import { PassThrough } from "node:stream";
import { createScreen } from "../../src/screen.js";
import { runInteractiveSession } from "../../src/interactive.js";
import { createClient } from "../../src/client.js";
import { createSessionStore } from "../../src/session_store.js";

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok, info }); console.log(`${ok ? "PASS" : "FAIL"}: ${name} ${info}`); };

// ---------- PART A: screen-level scroll + scrollbar paint ----------
{
  const recv = [];
  const output = new PassThrough();
  Object.defineProperty(output, "isTTY", { value: true, enumerable: true });
  output.columns = 100;
  output.rows = 30;
  output.write = ((orig) => (buf, ...rest) => { recv.push(buf.toString()); return orig.call(output, buf, ...rest); })(output.write.bind(output));
  const screen = createScreen({ output });
  screen.enter();
  for (let i = 0; i < 40; i++) screen.addUserPrompt(`user question number ${i}`);
  const before = screen.scroll();
  const maxBefore = before.max;
  const after = screen.scrollByLines(-3);
  const st = screen.scroll();
  check("A1 content overflows the viewport", maxBefore > 0, `scroll()={scrollTop:${before.scrollTop}, max:${maxBefore}}`);
  check("A2 wheel-up moves the viewport", st.scrollTop < st.max, `scroll()={scrollTop:${st.scrollTop}, max:${st.max}, followingEnd:${st.followingEnd}}`);
  check("A3 wheel moved exactly 3 rows", before.scrollTop - st.scrollTop === 3, `moved=${before.scrollTop - st.scrollTop}`);
  const lastPaint = recv.join("");
  check("A4 scrollbar glyph painted after scroll", /\x1b\[90m│/.test(lastPaint) || /\x1b\[37m█/.test(lastPaint), "");
  check("A5 jump-to-latest label painted while scrolled up", lastPaint.includes("jump to latest (end)"));
  await new Promise((r) => setTimeout(r, 1500)); // scrollbar hide delay (1000 ms) elapses -> hide-repaint
  const idx = recv.map((b, i) => ({ b, i })).filter((x) => /\x1b\[90m│/.test(x.b)).pop()?.i ?? -1;
  const afterHide = (idx >= 0 ? recv.slice(idx + 1) : []).join("");
  check("A6 scrollbar hidden after 1 s", idx >= 0 && !/\x1b\[90m│/.test(afterHide), idx >= 0 ? "hide-repaint after last track paint" : "track never painted");
}

// ---------- PART B: REAL input pump — SGR wheel bytes ----------
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
  const LONG = Array.from({ length: 60 }, (_, i) => `line ${i} of the long mock answer`).join("\n");
  const drive = async (client, messages, { message, onPartial, signal }) => {
    onPartial?.({ content: [{ type: "thinking", thinking: "let me think step by step" }] });
    await new Promise((r) => setTimeout(r, 10));
    onPartial?.({ content: [{ type: "text", text: LONG }] });
    return { text: LONG };
  };
  const p = runInteractiveSession({
    input,
    output,
    client,
    store,
    screen: true,
    driveTurn: drive,
    overrides: { provider: "mock", model: "mock-1" },
    mapRef: "map_folder_walk.md",
    workDir: "C:/Users/connessn/Observation_only/test-rig/work",
    out: (s) => recv.push(s + "\n"),
  });
  input.write("hi\n");
  await new Promise((r) => setTimeout(r, 300));
  input.write("\x1b[<64;5;5M"); // SGR wheel-up packet (button 64, press M)
  await new Promise((r) => setTimeout(r, 200));
  const all = recv.join("");
  check("B1 wheel-up scrolled the viewport (a non-latest paint)", /\x1b\[[0-9]+;1H/.test(all.split("jump to latest (end)")[0] ?? ""), "jump-to-latest label did appear after wheel => scrolled up");
  const mo = /\x1b\[\?1002h/.test(all);
  check("B4 MOUSE_ON includes ?1002h + ?1004h (pi's ENABLE_BUTTON_MOTION_MOUSE)", mo && all.includes("\x1b[?1004h"), "");
  input.write("/quit\n");
  input.end();
  await p;
  await new Promise((r) => setTimeout(r, 200));
  check("B2 wheel-up painted the scrollbar track", /\x1b\[90m│/.test(all), "");
  const hasThumb = /\x1b\[37m█/.test(all);
  check("B3 scrollbar thumb painted where applicable", hasThumb, "");
}

// ---------- PART C: the SCROLLBAR itself — press on the column = grab+jump, drag = follow, release = end ----
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
  const LONG = Array.from({ length: 60 }, (_, i) => `line ${i} of the long mock answer`).join("\n");
  const drive = async (client, messages, { onPartial }) => { onPartial?.({ content: [{ type: "text", text: LONG }] }); return { text: LONG }; };
  const p = runInteractiveSession({
    input, output, client, store, screen: true, driveTurn: drive,
    overrides: { provider: "mock", model: "mock-1" },
    mapRef: "map_folder_walk.md", workDir: "C:/Users/connessn/Observation_only/test-rig/work",
    out: () => {},
  });
  input.write("hi\n");
  await new Promise((r) => setTimeout(r, 300));
  input.write("\x1b[<0;100;5M"); // press on the SCROLLBAR column (100 = cols, row 5) — grab + jump
  await new Promise((r) => setTimeout(r, 200));
  input.write("\x1b[<32;100;20M"); // drag to row 20 — thumb follows
  await new Promise((r) => setTimeout(r, 100));
  const all = recv.join("");
  check("C1 press on the scrollbar column jumps (viewport left the top)", all.includes("jump to latest (end)"), "label present after scrollbar press");
  check("C2 drag keeps the track/thumb column painted", /\x1b\[90m│/.test(all), "");
  input.write("\x1b[<0;100;20m"); // release — ends the drag
  input.write("/quit\n");
  input.end();
  await p;
  await new Promise((r) => setTimeout(r, 200));
  const after = recv.slice(-1).join("");
  check("C3 the drag removed nothing / no crash after release", !after.includes("Error"), "");
}

const fails = results.filter((r) => !r.ok);
console.log(fails.length === 0 ? "PROBE PASS" : `PROBE FAIL (${fails.length})`);
process.exit(fails.length === 0 ? 0 : 1);

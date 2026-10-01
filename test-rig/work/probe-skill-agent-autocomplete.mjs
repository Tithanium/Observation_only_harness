// Probe: skills + agents in the slash autocomplete in PI'S EXACT FORMATS — the
// menu rows are `skill:<name>` (pi's built-in /skill:name, interactive-mode.js:490)
// and `agents:<name>` (pi's subagent extension prefix, index.ts:492) + the
// /skill:<name> /agents:<name> dispatch arms.
//
// Part A (LINE mode, non-TTY): the dispatch — /skill:alan expands the skill block
// into the turn's user message (injected driveTurn records it); /agents:worker (no
// task) shows the definition; /agents:worker <task> RUNS the agent through the
// subagent path against the local mock LLM; unknown names → the available list.
// Part B (CHART mode, TTY): typing "/" opens the slash dialog — its band carries a
// row per skill (skill:<name>) and per agent (agents:<name>), pi's SelectList
// rendering (`→ ` marker, accent selected row, muted descriptions, (n/total)
// window), narrowed by the same fuzzy filter as the commands; "skill:a" →
// skill:alan first.
//
// Usage: node test-rig/work/probe-skill-agent-autocomplete.mjs
process.env.OBSERVATION_ONLY_DIR = "C:/Users/connessn/Observation_only/test-rig/work/isolated";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createClient } from "../../src/client.js";
import { runInteractiveSession } from "../../src/interactive.js";

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}: ${name} ${info}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the mock LLM (127.0.0.1:8407 per the isolated models.json) — the /agent:<name> <task>
// run's worker speaks to it; the fixed answer is "hello from the mock".
const mock = spawn(process.execPath, ["C:/Users/connessn/Observation_only/test-rig/mock-server.mjs", "--log", "C:/Users/connessn/Observation_only/test-rig/work/_probe_skillagent_requests.log", "--port", "8407"], { stdio: ["ignore", "pipe", "pipe"] });
mock.stderr.on("data", (d) => console.log("mock:", d.toString().trim()));
await sleep(500);

// ---------- PART A: LINE mode — the dispatch ----------
{
  const recv = [];
  const input = new PassThrough(); // isTTY UNSET → line mode (readline 'line' events)
  const output = new PassThrough();
  const client = await createClient({ provider: "mock", model: "mock-1" });
  const driveCalls = [];
  const drive = async (c, messages, { message, onPartial }) => {
    driveCalls.push(message);
    onPartial?.({ content: [{ type: "text", text: "canned answer" }] });
    return { text: "canned answer" };
  };
  const p = runInteractiveSession({
    input,
    output,
    client,
    screen: false,
    driveTurn: drive,
    overrides: { provider: "mock", model: "mock-1" },
    mapRef: "map_folder.md",
    fullMapRef: "map_folder_full.md",
    workDir: "C:/Users/connessn/Observation_only/test-rig/work",
    out: (s) => recv.push(s + "\n"),
  });
  const all = () => recv.join("");

  input.write("/skill:alan\n");
  await sleep(400);
  const skillMsg = driveCalls.find((m) => typeof m === "string" && m.startsWith('<skill name="alan"'));
  check("A1 /skill:alan — the expanded skill block IS the turn's user message", Boolean(skillMsg), skillMsg ? skillMsg.slice(0, 50).replace(/\n/g, "\\n") : "drive got: " + JSON.stringify(driveCalls.slice(-1)));
  check("A2 skill turn got a model answer (canned)", all().includes("canned answer"));

  input.write("/agents:worker\n");
  await sleep(300);
  check("A3 /agents:worker (no task) — definition shown", all().includes("agent worker") && all().includes("run it: /agents:worker <task>"));

  input.write("/agents:worker list the files\n");
  await sleep(9000); // the worker spawns + speaks to the mock (fast, but give it room)
  check("A4 /agents:worker <task> — the agent RAN via the subagent path (mock answer printed)", all().includes("hello from the mock"));

  input.write("/skill:zzz\n");
  await sleep(200);
  check("A5 unknown skill → the available list", all().includes("skill not found: zzz — available:"));
  input.write("/agents:zzz\n");
  await sleep(200);
  check("A6 unknown agent → the available list", all().includes("agent not found: zzz — available:"));

  input.write("/quit\n");
  input.end();
  await p;
}

// ---------- PART B: CHART mode — the slash DIALOG carries the skill/agent rows ----------
{
  const recv = [];
  const input = new PassThrough();
  const output = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true, enumerable: true });
  Object.defineProperty(output, "isTTY", { value: true, enumerable: true });
  output.columns = 100;
  output.rows = 30;
  output.write = ((orig) => (buf, ...rest) => { recv.push(buf.toString()); return orig.call(output, buf, ...rest); })(output.write.bind(output));
  const client = await createClient({ provider: "mock", model: "mock-1" });
  const driveCalls = [];
  const drive = async (c, messages, { message, onPartial }) => {
    driveCalls.push(message);
    onPartial?.({ content: [{ type: "text", text: "canned answer" }] });
    return { text: "canned answer" };
  };
  const p = runInteractiveSession({
    input,
    output,
    client,
    screen: true,
    driveTurn: drive,
    overrides: { provider: "mock", model: "mock-1" },
    mapRef: "map_folder.md",
    fullMapRef: "map_folder_full.md",
    workDir: "C:/Users/connessn/Observation_only/test-rig/work",
  });
  const all = () => recv.join("");

  input.write("/");
  await sleep(400);
  // pi's SelectList windows to maxVisible=5 rows + the `  (n/total)` scroll line
  // (select-list.js:74-78, editor.js:287-295) — a bare "/" shows the FIRST five
  // builtins; the discovered rows (pi's order: builtins → extensions → skills →
  // agents) sit at the tail, reached with the down arrows.
  check("B0 bare / — the band opens on the first window (1/13)", all().includes("(1/13)"));
  for (let i = 0; i < 11; i += 1) input.write("\x1b[B"); // 11 down arrows (\x1b[B) → sel=11 = the skill:alan row
  await sleep(400);
  check("B1 band lists the pi-form skill row skill:alan", all().includes("skill:alan"));
  check("B2 band lists the pi-form agent row agents:worker", all().includes("agents:worker"));
  check("B2b band scroll position (12/13)", all().includes("(12/13)"));

  input.write("skill:a"); // the line is now "/skill:a" → the SAME fuzzy filter narrows (pi searches `skill:` items by full + bare name)
  await sleep(400);
  check("B3 'skill:a' narrows to the skill rows only", all().includes("skill:alan") && !all().split("skill:alan").pop().includes("agents:worker"));

  input.write("lan\r"); // complete the line to "/skill:alan" and submit
  await sleep(500);
  const skillMsg = driveCalls.find((m) => typeof m === "string" && m.startsWith('<skill name="alan"'));
  check("B4 enter on the skill row runs it (expanded block reached the turn)", Boolean(skillMsg));

  input.write("/quit\r");
  input.end();
  await p;
}

mock.kill();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} FAILED / ${results.length}` : `ALL ${results.length} PASS`);
process.exit(failed.length ? 1 : 0);

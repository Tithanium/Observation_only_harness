// Probe: /model must put the model in the FOOTER, not in the global text (pi's
// handleModelCommand → footer.invalidate(); NO transcript line). Line mode, injected
// streams — no LLM, no mock server (createClient never connects on its own).
// PASS criteria:
//   1. the banner's `model: mock/mock-1` appears EXACTLY ONCE (startup header only)
//   2. the /model switch itself adds NO `model: …` line
//   3. a footer line carrying the new model (`… mock-1 ⚡ … tok/s`) IS printed
//      right after the switch (line mode shows the footer as a line)
process.env.OBSERVATION_ONLY_DIR = "C:/Users/connessn/Observation_only/test-rig/work/isolated";
import { PassThrough } from "node:stream";
import { createClient } from "../src/client.js";
import { createSessionStore } from "../src/session_store.js";
import { runInteractiveSession } from "../src/interactive.js";

const lines = [];
const input = new PassThrough();
const output = new PassThrough();
const client = await createClient({ provider: "mock", model: "mock-1" });
const store = createSessionStore({ workDir: "C:/Users/connessn/Observation_only/test-rig/work" });
const p = runInteractiveSession({
  input,
  output,
  client,
  store,
  overrides: { provider: "mock", model: "mock-1" },
  mapRef: "map_folder_walk.md",
  workDir: "C:/Users/connessn/Observation_only/test-rig/work",
  out: (s) => lines.push(s),
});
// drive: /model <exact match> then /quit
input.write("/model mock/mock-1\n");
input.write("/quit\n");
input.end();
const turns = await p;
await new Promise((r) => setTimeout(r, 200));

const modelLines = lines.filter((l) => l.includes("model: mock/mock-1"));
const footLines = lines.filter((l) => l.includes("mock-1") && /⚡/.test(l));
console.log("=== captured lines ===");
for (const l of lines) console.log(JSON.stringify(l));
console.log("=== checks ===");
console.log(`turns: ${turns}`);
console.log(`'model: mock/mock-1' occurrences: ${modelLines.length} (PASS if 1)`);
console.log(`footer lines: ${JSON.stringify(footLines.map((l) => l.trim()))}`);
const pass = modelLines.length === 1 && footLines.some((l) => /^↑0 ↓0 ctx 0\/128k mock-1 ⚡ n\/a tok\/s$/.test(l.trim()));
console.log(pass ? "PROBE PASS" : "PROBE FAIL");
process.exit(pass ? 0 : 1);

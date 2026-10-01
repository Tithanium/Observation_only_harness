#!/usr/bin/env node
// Observation_only Round 1 entry: one LLM round trip from the CLI, using pi's
// config (settings.json provider/model selection, auth.json + models.json keys).
//   node src/index.js [--provider P] [--model M] [--api-key K] [message...]
// Message comes from the arguments or from stdin when piped. Prints only the
// assistant's reply. Never prints secrets.
import { createClient } from "./client.js";
import { footerLine } from "./footer.js";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

const flags = new Set(["--provider", "--model", "--api-key"]);
const overrides = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) {
    overrides[args[i].slice(2)] = args[++i];
  } else {
    positional.push(args[i]);
  }
}

let message = positional.join(" ");
if (!message && !process.stdin.isTTY) {
  message = (await readStdin()).trim();
}
if (!message) {
  console.error("usage: node src/index.js [--provider P] [--model M] [--api-key K] [message...]  (or pipe a message via stdin)");
  process.exit(2);
}

try {
  const client = await createClient(overrides);
  const { text } = await client.complete(message);
  if (!text) {
    process.stderr.write("no text in model reply\n");
    process.exit(1);
  }
  process.stdout.write(text + "\n");
  process.stderr.write(footerLine(client) + "\n"); // round-7 footer: in/out tokens, ctx/max, model, tok/s
} catch (error) {
  process.stderr.write(`request failed: ${error?.message ?? error}\n`);
  process.exit(1);
}

// Probe: replicate the corrected /model picker item construction (src/interactive.js)
// and verify: (1) rows fit the terminal width, (2) no repeated names, (3) search-by-name still works.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const p = JSON.parse(readFileSync(`${homedir()}/.Observation_only/models.json`, "utf8"));
const providers = p.providers ?? {};

const ctxBadge = (cw) => {
  if (!cw) return "";
  const k = Math.round((cw / 1024) * 10) / 10;
  return ` (${Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`})`;
};

for (const termW of [80, 120]) {
  const items = [];
  for (const [providerId, cfg] of Object.entries(providers)) {
    for (const m of cfg?.models ?? []) {
      const ctxStr = ctxBadge(m.contextWindow);
      const maxId = Math.max(8, termW - (3 + `[${providerId}]`.length + ctxStr.length));
      const displayId = m.id.length > maxId ? "…" + m.id.slice(-(maxId - 1)) : m.id;
      const name = typeof m.name === "string" ? m.name : "";
      items.push({
        id: `${providerId}/${m.id}`,
        line: `${displayId} [${providerId}]${ctxStr}`,
        search: `${providerId} ${providerId}/${m.id} ${providerId} ${m.id}${name ? ` ${name}` : ""}${ctxStr}`,
        detail: name ? `${name}${ctxStr}` : "",
      });
    }
  }
  const maxLen = Math.max(...items.map((it) => 2 + it.line.length)); // "> " cursor
  console.log(`== termW ${termW}: ${items.length} rows, longest rendered row ${maxLen} (must be <= ${termW})`);
  for (const it of items) console.log("   " + JSON.stringify("> " + it.line));
  // search-by-name (the old behavior that must survive)
  for (const q of ["gemma", "qwen-3.6", "ares"]) {
    const hits = items.filter((it) => it.search.toLowerCase().includes(q)).length;
    console.log(`   search "${q}" → ${hits} hits`);
  }
  console.log("   detail of row 0: " + JSON.stringify(items[0].detail));
}

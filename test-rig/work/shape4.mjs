import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../src/screen.js", import.meta.url), "utf8");
const lines = src.split("\n");
// Find ALL lines ending INSIDE which brace levels — report the line number + trimmed for lines that are PURE braces
const pure = [];
lines.forEach((l, i) => { const t = l.trim(); if (/^[{}]+$/.test(t) || /^[{}]*$/.test(l)) pure.push((i + 1) + ":" + JSON.stringify(l)); });
process.stdout.write("PURE=" + pure.join(" ") + "\n");
// Every line 219 (chunks) its brace tokens ONLY
const toks = lines.slice(218).map((l, i) => { const n = 219 + i; const to = (l.match(/\{/g) || []).length; const tc = (l.match(/\}/g) || []).length; return n + "{" + to + "}" + tc; }).filter(x => !x.endsWith("{0}0")).join(",");
process.stdout.write("TOKENS=" + toks + "\n");

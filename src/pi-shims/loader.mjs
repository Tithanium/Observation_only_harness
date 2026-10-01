// src/pi-shims/loader.mjs — Node module-registration hook that aliases the pi
// packages (@earendil-works/pi-coding-agent, pi-ai, pi-agent-core, pi-tui,
// typebox) to the harness shims — only for code OUTSIDE the harness itself.
// ROUND 21: pi's REAL extension files import these specifiers at runtime; the
// harness has no such packages. Registering the hook (once, lazily) turns the
// extension imports into the shim modules instead of a MODULE_NOT_FOUND.
//
// The pass-through guard matters: the HARNESS's own src/pi-ai.js imports the REAL
// @earendil-works/pi-ai on purpose (round 1 — the LLM connection). If the hook
// intercepted that too, the harness would silently lose its LLM layer. So the
// alias applies only when the importing module is NOT under the harness root.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const HARNESS_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM_TARGETS = new Map([
  ["@earendil-works/pi-coding-agent", "./pi-coding-agent.mjs"],
  ["@earendil-works/pi-ai", "./pi-ai.mjs"],
  ["@earendil-works/pi-agent-core", "./pi-agent-core.mjs"],
  ["@earendil-works/pi-tui", "./pi-tui.mjs"],
  ["typebox", "./typebox.mjs"],
]);

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  const target = SHIM_TARGETS.get(specifier);
  if (target !== undefined) {
    const rootHref = pathToFileURL(HARNESS_ROOT + "/").href;
    // NO alias for the harness's own modules (src/pi-ai.js imports the REAL
    // @earendil-works/pi-ai on purpose — the round-1 LLM layer) NOR for anything
    // under a node_modules tree (the real pi packages pi-ai.js pulls in import
    // "typebox"/"@earendil-works/pi-*"; aliasing those would re-enter the shims
    // from inside pi's own package graph → init deadlock). Everything else — the
    // extensions dirs — gets the shim modules.
    if (!parent.startsWith(rootHref) && !parent.includes("/node_modules/")) {
      return { url: pathToFileURL(pathResolve(dirname(fileURLToPath(import.meta.url)), target)).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

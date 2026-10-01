// src/pi-shims/pi-ai.mjs — the "@earendil-works/pi-ai" import target for extension
// files. Pi's extensions import `{ StringEnum }` (runtime — subagent/index.ts) and
// `type { Message }` (erased). StringEnum = Type.Union of Literals, over the same
// Type the typebox.mjs shim resolved (real pi-ai Type when present, the built-in
// builder otherwise).
import { Type } from "./typebox.mjs";

/** StringEnum(["a", "b"], options) → a Union schema (pi's pi-ai StringEnum). */
export function StringEnum(values, options) {
  return Type.Union(values.map((value) => Type.Literal(value)), options);
}

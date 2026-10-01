// src/pi-shims/typebox.mjs — the "typebox" import target for extension files
// (ROUND 21: pi's REAL extension files import `{ Type } from "typebox"` — pi's own
// subagent/index.ts builds its tool schemas with it at MODULE SCOPE, so the
// specifier must resolve to a real module, not a type). Priority: the REAL
// TypeBox build pi uses (the same @earendil-works/pi-ai resolution src/pi-ai.js
// follows — the harness already depends on pi-ai for the round-1 connection, so
// real schemas flow into pi-ai's validateToolCall unchanged); on a machine
// WITHOUT pi a small built-in builder takes over (TypeBox-shaped JSON schema:
// type/object/properties/required/anyOf/const — enough for the LLM declaration).
// The harness itself has no "typebox" package — top-level await keeps the
// fallback synchronous for extension module-scope code (subagent/index.ts calls
// Type.* at module scope).
const Kind = Symbol.for("@sinclair/typebox/kind");
const objectSchema = (properties = {}, options = {}) => {
  const schema = { type: "object", properties: {}, ...options };
  const required = [];
  for (const [key, value] of Object.entries(properties)) {
    schema.properties[key] = value;
    if (!value || value.optional !== true) required.push(key);
  }
  if (required.length > 0) schema.required = required;
  return schema;
};

/** The pi-less fallback: a minimal TypeBox-shaped schema builder. The fields
 *  carry TypeBox's JSON-schema surface (type/properties/anyOf/const), so tool
 *  declarations survive JSON serialization; the Kind tags make pi's TypeBox
 *  converters treat them as known nodes when pi-ai IS present. */
const miniType = {
  Object: (properties, options) => ({ ...objectSchema(properties, options), [Kind]: "Object" }),
  String: (options) => ({ [Kind]: "String", type: "string", ...options }),
  Number: (options) => ({ [Kind]: "Number", type: "number", ...options }),
  Boolean: (options) => ({ [Kind]: "Boolean", type: "boolean", ...options }),
  Array: (items, options) => ({ [Kind]: "Array", type: "array", items, ...options }),
  Union: (values, options) => ({ [Kind]: "Union", anyOf: [...values], ...options }),
  Literal: (value) => ({ [Kind]: "Literal", const: value }),
  Optional: (schema) => ({ ...schema, [Kind]: "Optional", optional: true }),
  Any: (options) => ({ [Kind]: "Any", ...options }),
};

/** Real TypeBox first (pi's own build — the harness's round-1 connection already
 *  locates @earendil-works/pi-ai via src/pi-ai.js), the built-in builder when pi
 *  is absent. A failing lookup NEVER fails the load — extensions keep loading. */
export const Type = await (async () => {
  try {
    const harnessType = await import("../pi-ai.js");
    const real = harnessType.typeboxType ? await harnessType.typeboxType() : undefined;
    if (real !== undefined) return real;
  } catch {
    /* pi-less machine → the built-in builder below */
  }
  return miniType;
})();

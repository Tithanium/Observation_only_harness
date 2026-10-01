// src/pi-shims/pi-agent-core.mjs — the "@earendil-works/pi-agent-core" import
// target for extension files. Pi's extensions only import TYPES from it
// (`import type { AgentToolResult, ThinkingLevel }` — fully erased by Node's type
// stripping), so this module carries no runtime surface. It must still exist:
// the ROUND-21 alias loader maps the specifier here, and an erased import never
// even loads it — but a future runtime import of the package must resolve.
export {};

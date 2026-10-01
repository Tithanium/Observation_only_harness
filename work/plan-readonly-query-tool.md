# Plan — read-only query tool (grep + recursive dir) for the Observation harness

Date: 2026-10-01 · Status: PROPOSED (not implemented)
Inspiration: `C:/Users/connessn/.pi/agent/extensions/bash-to-powershell.ts` (pi extension re-registering a tool)
Constraint: **no modification of the pi harness** — everything lands in the Observation_only project / its dot-folder only.

## 1. The goal (as stated)

- The LLM can "run grep and dir" through the harness.
- Only commands that **retrieve** information are accepted (recursive folder content, word search).
- **Read-only**: the tool must never modify anything on the computer.
- **Scoped**: restricted to the working folder and folders inside it.
- **Fail-closed**: anything not whitelisted → the execution fails (error tool result), it never runs.

## 2. Key design decision — the whitelist lives in the SCHEMA, not in a string parser

Two ways to build "only whitelisted commands":

| | Option A — structured parameters (RECOMMENDED) | Option B — literal command string + parser |
|---|---|---|
| LLM emits | `query {mode:"grep", pattern:"foo", path:"src"}` | `command:"grep -r foo src"` |
| Whitelist enforced by | the JSON schema: exactly two operations exist (`list`, `grep`) | a strict grammar parser over the raw string |
| Injection surface | **None** — no shell string exists, no `child_process` at all | `;`, `&&`, `>`, `$(...)`, backticks, quoting, env vars all need parser rules |
| Failure mode | impossible to express a forbidden action → nothing to fail | every new form = new false-reject or new hole |
| Precedent | **pi itself**: pi's `grep`/`find`/`ls` are typed tools; the model never writes bash | none in pi |

**Recommendation: Option A.** The user's intuition "the LLM answers with a bash-like command" is satisfied at the
intent level — the tool's description teaches the mapping ("`dir /s` = mode list, `findstr /s /i` / `grep -r` =
mode grep; no other commands exist") — while the whitelist is the tool's own parameter schema. There is no command
string anywhere, therefore nothing to parse and nothing to inject. Fail-closed is guaranteed by construction, not by
parser completeness.

Option B is only worth it if a literal bash-string UX is a hard requirement; it is strictly more fragile.
(If it were ever chosen: accept ONLY `dir <path> [/s]`, `Get-ChildItem <path> [-Recurse]`,
`grep [-i] <pattern> <path>`, `findstr [/s] [/i] "<pattern>" <path>`; anything else → error listing the accepted forms.)

## 3. Verified integration point (facts from this machine, 2026-10-01)

- The harness has a **pi-compatible extension system** (ROUND 20/21): `src/extensions.js` loads every top-level
  `*.ts`/`*.js` (not `.mjs`) and `*/index.ts|js` under `~/.Observation_only/extensions/` (env `OBSERVATION_ONLY_DIR`
  honoured). Real pi extension files already load there (`git_it.ts`, `hello.ts`, `alan-connector/`).
- Loaded at interactive startup **before the first line** (`src/interactive.js:690`) and on `/reload`
  (`src/interactive.js:1133`). A `pi.registerTool(...)` is merged into the session tools
  (`src/session.js:102 buildHarnessTools`) AND into the system prompt (`toolsPromptLines` uses
  `promptSnippet`/`description`) — **zero harness file changes needed**.
- The shim loader (`src/pi-shims/loader.mjs`) aliases `typebox` + `@earendil-works/pi-*` for extension imports
  (`src/pi-shims/typebox.mjs` → real TypeBox via `src/pi-ai.js typeboxType()`, mini fallback otherwise) → an
  extension can `import { Type } from "typebox"` at module scope, exactly like pi extensions do.
- Tool execute contract (all tools, incl. extensions): `execute(toolCallId, params, signal, onUpdate, ctx)` with
  **`ctx.cwd = workDir`** (the working folder — `src/session.js driveTurn`) → the scope anchor.
- Error contract: a **thrown Error's `.message` becomes the tool-result text with `isError: true`** (the model sees
  the refusal and adapts). Unknown tool name → existing "Tool X not found" error result.
- Truncation convention: `truncateHead` 2000 lines / 50KB (`src/read_tool.js`) — the new tool reuses the same shape.
- **Gap (verified): the one-shot entry `src/round5.js` never calls `loadExtensions()`** → extension tools exist only
  in interactive mode. See §7 decision point.
- Subagent children carry `fetch` only (existing design, `src/subagent_tool.js`) → the new tool is main-session in v1.

## 4. Tool contract (Option A)

**File**: `~/.Observation_only/extensions/readonly_query.ts` (top-level `.ts` = auto-discovered; Node ≥ 22.19 native
type-stripping; erasable TS syntax only — no enums/namespaces/parameter properties).
**Self-contained**: NO cross-imports into `src/` (the dot-folder is outside the project on a fresh machine — the
repo is designed for re-clone elsewhere per `Export_to_git.txt`). It carries its own small copies of path resolution
+ truncation (~60 lines, copied from `src/read_tool.js` semantics).

```ts
import { Type } from "typebox"; // → harness shim → real TypeBox or mini fallback

export default function (pi) {
  pi.registerTool({
    name: "query",                       // candidate names: query | search | scan  ← DECISION 1
    label: "Query (read-only)",
    description: `Read-only observation tool — the only "shell" in this harness.
      mode "list" = recursive folder content (like dir /s /b); mode "grep" = word search (like findstr /s /i or grep -r).
      NO other commands exist: anything that modifies, moves or executes cannot be expressed and is refused.
      Every path is resolved and scoped to the working folder (and its subfolders).
      Output capped: list = ${500} entries or 50KB; grep = ${200} matches or 50KB (whichever first); files >5MB and binaries are skipped and counted.`,
    promptSnippet: "Read-only query: recursive folder listing or word search (the only 'shell' — list/grep only, working-folder scoped)",
    promptGuidelines: [
      "Use query mode=list to get a folder's full recursive content (dir /s).",
      "Use query mode=grep to search for a word across the working folder (grep -r / findstr /s).",
      "query is read-only and refuses every path outside the working folder — never ask it to modify anything.",
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("list"), Type.Literal("grep")]),   // the WHITELIST — nothing else is expressible
      path: Type.Optional(Type.String({ description: "Target path (default '.'): relative to the working folder, absolute, or ~. Must stay inside the working folder." })),
      pattern: Type.Optional(Type.String({ description: "WORD REQUIRED for mode=grep — the word/text to search for (literal substring by default)." })),
      regex: Type.Optional(Type.Boolean({ description: "mode=grep: treat pattern as a JavaScript regex (default false = literal substring)." })),
      case_insensitive: Type.Optional(Type.Boolean({ description: "mode=grep: case-insensitive match (default true)." })),
      max_results: Type.Optional(Type.Number({ description: "mode=grep: maximum matches to return (default 200)." })),
      limit: Type.Optional(Type.Number({ description: "mode=list: maximum entries to return (default 500)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) { /* §5 guards + engines */ },
  });
}
```

## 5. Execution logic — fail-closed guard order

```
0. schema (mode enum) already blocks unknown ops at the provider/validator level
1. double guard: mode ∉ {list, grep}            → throw "query: only 'list' and 'grep' are allowed (read-only tool)"
2. mode=grep && !pattern                        → throw "query: mode 'grep' requires 'pattern'"
3. resolve path (copy of resolveReadPath: @-strip, ~, WSL-style, relative→ctx.cwd)
   workRoot = resolve(ctx.cwd)
   guard: resolved === workRoot || resolved.toLowerCase().startsWith(workRoot.toLowerCase() + sep)
   else → throw `query: path '<resolved>' is outside the working folder '<workRoot>' — this tool is read-only and scoped to the working folder`
   (case-insensitive compare: Windows fs; `..` that escapes is caught by the prefix check after resolve)
4. stat: missing → throw "Path not found: …"; list: must be a directory; grep: file or directory
5. walk (both modes) — fs.readdir withFileTypes, iterative stack:
     - entry.isSymbolicLink() → SKIP + count ("N symlinks/junctions skipped" — matters: this repo contains a
       .Observation_only junction to the live dot-folder; skipping keeps the scope bulletproof)
     - signal?.aborted check every ~100 files → throw "Operation aborted"
6. engine (below)
7. shape result: text + truncateHead(2000/50KB) + counters in details
```

**list engine** (`dir /s /b` style): flat list of paths RELATIVE to the working folder, posix separators,
directories suffixed `/`, case-insensitive alphabetical on the full relative path, dotfiles included,
`limit` (default 500) cap with a "… N more entries — use limit=…" notice.

**grep engine**: per file — size > 5MB → skip + count; first 8KB NUL-byte probe → binary, skip + count;
read utf-8, line-by-line literal `includes` (or `new RegExp(pattern, "i"?)` when `regex:true`);
emit `rel/path:LINENO: line` (rg-style); cap `max_results` (default 200) with a
"… N more matches in M files — narrow the pattern or path" notice.
**Zero matches → SUCCESS text** "No matches for '<pattern>' under <path>" (grep's exit-1 is a normal outcome,
not an error — `isError:false`, so the model does not spin retrying).

Result envelope (harness contract): `{ content: [{type:"text", text}], details: {filesScanned, symlinksSkipped,
bigSkipped, binarySkipped, matches, truncated} }`.

**Read-only proof (audit step)**: the module uses ONLY `node:fs/promises` `readdir/stat/readFile` + `node:path` —
no `child_process`, no write/rename/unlink/mkdir API anywhere in the file (grep-audit in the test plan).

## 6. Why each requirement is met

| Requirement | Where enforced |
|---|---|
| only grep + dir accepted | schema `mode` enum (whitelist) + this is the ONLY execution-style tool (fetch is read/list/URL, subagent delegates to fetch) |
| never modify anything | no shell, no child_process, only read-only fs APIs (§5) |
| restricted to work folder | prefix guard vs `ctx.cwd` (§5.3) + symlink/junction skip (§5.5) |
| fail on anything else | thrown Error → `isError` tool result (harness contract); unknown tool name → existing "Tool X not found" |

## 7. Decision points (user)

1. **Tool name**: `query` (proposed) vs `search` vs `dir_grep`?
2. **One-shot mode gap**: `round5.js` (one-shot) never loads extensions → the tool is interactive-only.
   Acceptable? If the tool must also exist one-shot, the ONLY alternative is a first-class tool:
   new `src/query_tool.js` + a 2-line hook in `src/session.js` (`buildHarnessTools` + `toolsPromptLines`)
   — that would be the only harness-file change of this whole feature.
3. **`fetch` has no scope guard today** (reads any file on disk, pi parity). This change does NOT touch fetch.
   If the whole harness should be work-folder-bound, that is a separate, later decision.

## 8. Implementation steps (when approved)

1. (per repo convention) timestamped backup: `robocopy C:\Users\connessn\Observation_only C:\Users\connessn\Observation_only_backup\backup_<ts> /E /XD node_modules`
2. Write `~/.Observation_only/extensions/readonly_query.ts` (§4/§5).
3. Unit probe `work/probe-readonly-query.mjs`: fake `api` capturing `registerTool` → drive `execute` on a temp tree:
   list (sorted flat list, `/` suffixes, cap+notice) · grep (hits `f:line:text`, case default, zero-match text,
   cap+notice, binary/big skips counted) · refusals (mode="x" throws; `../../` escape throws with boundary message;
   symlink escape skipped) · aborted signal throws.
4. Loader probe: temp dot-dir + `loadExtensions(dir)` → `extensionToolsList()` contains `query`; parameters is a
   real schema object (typebox shim resolved).
5. Interactive E2E (existing `test-rig/mock-server.mjs` pattern, `OBSERVATION_ONLY_DIR` isolated): mock LLM emits
   `toolCall query {mode:"grep",…}` → correct toolResult text; mock emits a bogus tool name → "Tool not found".
6. Read-only audit: grep the new file for `writeFile|unlink|rename|mkdir|spawn|exec|appendFile` → 0 hits.
7. Remove the temp probe tree; commit + push (usual cycle — the dot-folder junction tracks the new file into the repo).

## 9. Risks / notes

- Pure-Node walk (no rg dependency) keeps the fresh-machine story intact (`Export_to_git.txt` prerequisites stay
  Node ≥ 22.19 + ALAN). `rg.exe` exists on this machine (`C:\Users\connessn\.pi\agent\bin\rg.exe`) — a v1.1 option:
  use rg when on PATH for speed, fall back to the pure walk. Not in v1.
- Performance: recursive grep over a typical work folder (thousands of small text files) ≈ tens–hundreds of ms —
  acceptable; the 5MB-per-file + 200-match caps bound the worst case.
- Duplicated ~60 lines (path resolve + truncation) inside the extension — deliberate: the extension must stay
  self-contained for portability (no import from `src/`, which sits outside the dot-folder on a fresh machine).

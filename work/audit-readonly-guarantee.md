# Audit — "the Observation_only toolset can only get information, never modify"

Date: 2026-10-01 · Method: one `reviewer` subagent per tool (5 parallel deep adversarial audits,
each tracing every fs/process/network API reachable from `execute()` with in-schema args,
citing file:line, VERIFIED vs INFERRED). Toolset audited: **fetch, grep, find, ls, subagent**
(the 5 built-ins; extension-registered tools are arbitrary code by design — out of scope, see §4).

## Verdict

**HOLDS in the meaningful sense: no in-schema invocation of any built-in tool can modify
user data (file content, folder structure) on this machine.** The worker (subagent children)
is hard-limited to the four scoped read tools — no shell, no write tool, no extension loading
(`worker.js:75-77,108-118`), so even a fully jailbroken worker LLM has no write primitive.

The LITERAL claim "never modify a file, a folder, or a process" is false in six narrow ways,
all harness-owned, transient, metadata-only, dormant, or operator-gated (§2). One genuine
(defect-class) finding (§3) and two read-scope gaps (§4) are worth knowing.

## 1. Per-tool verdicts

| Tool | Verdict | Own-code write surface |
|---|---|---|
| fetch | CONDITIONALLY READ-ONLY | `access/stat/readdir/readFile` + transient HTTPS GET only |
| grep | CONDITIONALLY READ-ONLY (dormant self-provisioning) | spawns its own `rg` child (no `--follow`), kills only that child |
| find | CONDITIONALLY READ-ONLY (dormant self-provisioning) | spawns its own `fd` child (no `-L/--follow`), kills only that child |
| ls | PURE READ-OWN (own code: zero write syscalls reachable) | `access/stat/readdir` only; no child process at all |
| subagent | CONDITIONALLY READ-ONLY | parent writes a temp prompt file (create+delete per call) + session JSONL (interactive) |

## 2. The six literal-modification mechanisms (all non-user-data)

1. **Dormant binary self-provisioning** (grep + find): if `rg`/`fd` were missing from
   `~/.Observation_only/bin`, `~/.pi/agent/bin` AND PATH, the next call downloads the GitHub
   release and installs the .exe into `~/.Observation_only/bin` (`bin_tools.js:239-290`:
   mkdir, zip write, extract, rename, cleanup) + outbound network egress. **Dormant on this
   machine** (pi's `rg.exe`/`fd.exe` are reused; `~/.Observation_only/bin` does not exist).
   Intended pi-parity behavior. Suppressed by `OBSERVATION_ONLY_OFFLINE=1`.
2. **Harness-owned persistence**: interactive session JSONL auto-save
   (`session_store.js:131-137`, includes the full worker conversation via `details`);
   subagent temp prompt file `%TEMP%\obs-subagent-<pid>\prompt-<agent>.md`
   (`subagent_tool.js:107-113`, deleted in `finally`; `mode 0o600` is ignored on Windows);
   parent spill-full-output temp file for big tool outputs (interactive, `screen.js:710`,
   never deleted). First-run dot-folder bootstrap (`config.js:53-73`) is a **no-op on this
   machine** (dot-folder exists).
3. **Transient process state**: every grep/find/subagent call creates and (on abort) kills
   a child process (`rg`/`fd`/node worker). Killing a grandchild `rg` mid-scan is not
   propagated — it finishes on its own (read-only, transient).
4. **File metadata**: reading a file can update its NTFS last-access time (atime) —
   OS-policy dependent (usually throttled/disabled on modern Windows). Same footprint as
   any read; inherent to the observation-only design.
5. **In-memory process env**: `userDotDir()` self-exports `process.env.OBSERVATION_ONLY_DIR`
   if unset (`config.js:39`) — own process only, non-persistent, idempotent, by design
   (mirrors pi's `PI_CODING_AGENT_DIR`).
6. **Operator/env-gated (not LLM-reachable — no shell tool in the set)**:
   `OBS_PROBE_EVENTS` → event dump with model-output snippets (`client.js:124-128`);
   `"!command"` config values → `execSync` at config load (`config.js:103-107`, pi-parity,
   operator trust domain).

## 3. Genuine defect found (minor) — **FIXED (2026-10-01)**

**Unsanitized agent name in the subagent temp-prompt path** — `subagent_tool.js:110`:
`join(dir, "prompt-${agentName}.md")` with `agentName` taken verbatim from the agent
frontmatter (`agents.js:39-63`). A pre-planted agent `.md` with `name: x\..\..\..\evil`
would write OUTSIDE `%TEMP%\obs-subagent-<pid>` — overwriting an existing `evil.md` during
the run, then the `finally` `rmSync` (`:258`) deletes it. Requires a malicious/buggy agent
definition in the trust domain (not reachable by in-schema args alone); `.md`-suffixed
targets only.
**FIXED:** `sanitizeAgentFileName()` in `subagent_tool.js` — keeps `[A-Za-z0-9_-]`,
replaces the rest with `_`, caps at 64 chars, falls back to `"agent"` when empty; used in
`writePromptToTempFile`. 4 probe checks in `work/probe-grep-find-ls.mjs`.

## 4. Read-scope gaps (NOT modifications — they let the harness READ more, which is
still "getting information", but weakens the work-folder-scoped property)

1. **fetch/ls followed in-workdir symlinks/junctions** to read outside the scope: the guard
   was a lexical prefix check on the resolved path (`scope_guard.js`, documented), and the
   fetch file branch / ls did not check the real target. A junction inside the work folder
   pointing outside passed the guard → outside content was read/listed. **grep/find** skip
   symlinked entries DURING traversal (engines spawned without `--follow`/`-L`), but an
   explicit search path that IS a link is followed by the engines too — same class.
   **FIXED (2026-10-01):** `assertRealPathWithinRoots()` in `scope_guard.js` (realpath +
   prefix re-check; ENOENT → defer to the caller's own "Path not found" error shape; other
   realpath errors → rethrow fail-closed) is now called at ALL FIVE tool entry points
   (fetch file+folder branch, ls, grep search root, find search root). Links whose target
   is INSIDE a root keep working; links out are refused with the standard "outside the
   allowed folder(s)" error. 7 probe checks (4 refusals + 3 inside-links-still-work).
   Still true by design: the second allowed root is the live dot-folder (a junction into
   the real `~/.Observation_only`), so fetch can read `auth.json` (API keys) — intended
   for skills/AGENTS.md, broader than strictly necessary.
2. **subagent `cwd` param re-roots the worker's scope** to any directory the node process
   can read (`subagent_tool.js:186` → `worker.js:62`) — read surface, not modification;
   kept by design (subagents are for working in other folders, still read-only there).

## What is provably clean (cross-audit consensus)

- No write-class API (`writeFile/appendFile/mkdir/rename/unlink/truncate/chmod/spawn-write/
  createWriteStream`) is reachable from any built-in tool's `execute()` in normal operation,
  except the enumerated harness-owned paths above.
- No disk logging on any error path (all errors are in-memory `throw`/tool-result text).
- No import-time side effects in the tool modules.
- Error contract: thrown Error → tool result text, `isError: true` — errors never write.
- Abort paths kill only harness-spawned children, never foreign processes.
- Worker: exactly `[fetch, grep, find, ls]`, no shell/write/extension; task text (prompt)
  cannot induce a local modification — the capability set is hard-limited by tool registration.
- Supply-chain note (inherent to the pi design): the dormant provisioning trusts GitHub over
  TLS; a MITM/compromised GitHub would control the downloaded binary.

## Residual recommendations (priority order)

1. ~~Sanitize `agentName` in `subagent_tool.js:110`~~ — **DONE** (2026-10-01, §3).
2. ~~Realpath + re-check (or refuse) symlinked paths in fetch/ls~~ — **DONE** for ALL FIVE
   tool entry points incl. the grep/find search roots (2026-10-01, §4.1).
3. Optional, still open: gate `ensureTool` to resolve-only for an observation-only harness
   (kills the dormant §2.1 download path) — currently suppressed in practice because pi's
   rg/fd are reused; `OBSERVATION_ONLY_OFFLINE=1` already provides the kill switch.

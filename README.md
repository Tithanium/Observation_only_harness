# Observation_only — git save of the observation-only harness

Snapshot of a working observation-only TUI harness + its personal configuration,
taken 2026-10-01 from a Windows 11 machine (Node v24.12.0, PowerShell 5.1,
git 2.52).

The harness is a **port of the pi coding-agent method** — LLM connection layer,
interactive terminal UI, slash commands, pi-compatible extensions, skills,
subagents — but **observation-only**: every tool the LLM can call
(`read`, `grep`, `find`, `ls`, `fetch`) is read-only and scope-guarded; nothing
in the tool schema can modify user data (audit trail in
`audit-readonly-guarantee.md`).

| Folder | Content |
|---|---|
| `src/` | The harness itself — pure Node.js (≥ 22.19, **no build step**: TypeScript extensions load natively via Node's type-stripping). Entry point `src/round5.js --interactive` (the TUI); `npm start` runs the older Round-1 `src/index.js`. `src/pi-shims/` carries the pi-compatible API surface that pi-written extensions run against |
| `.Observation_only/` | The personal configuration (a copy of `%USERPROFILE%\.Observation_only`; on the dev machine it is a **junction** to it, so git tracks the live config): `extensions/` (incl. the `alan-connector/` ALAN flow), `skills/`, `agents/`, `settings.json`, `models.json` (apiKey masked), `agent/` (`models.json` masked, `models-store.json`, `bin/fd.exe` + `bin/rg.exe`) |
| `agents/` | Standalone agent definition in development (`worker.md`) |
| `pi-cfg/` | Empty placeholder for pi configuration references |
| `okf/` | OKF bundle (log) for this project |
| root | `Export_to_git.txt` (the install lines as plain text), `audit-readonly-guarantee.md` (the read-only-guarantee audit) |

**Portable by design**: the harness **always** reads its config from the user
profile (`%USERPROFILE%\.Observation_only` / `~/.Observation_only`) — never from
the project folder. Nothing in `src/` is hard-coded to the source user
(`connessn`). A few agent/skill docs mention source-machine doc trees — see
[Path conventions](#path-conventions).

**Excluded by design** (table at the bottom): `node_modules/`, logs, `auth.json`
(ALAN credentials), `sessions/` transcripts, and — from this commit on — the
`alan-connector` secret artifacts.

---

## Prerequisites (one-time, on the new machine)

- Windows 10/11 (PowerShell 5.1+ ships with the OS) — or macOS/Linux (bash
  variant below)
- **Node.js ≥ 22.19** — required for the native TS type-stripping the extension
  loader relies on (source machine runs v24.12.0; any recent LTS works)
- git
- A reachable **ALAN model server** (or any OpenAI-compatible endpoint you point
  the config at — see [ALAN provider](#alan-provider--the-alan_connector-flow-key-auto-save))

Install them (PowerShell, run as **normal user** — winget installs for the
current user by default):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# make PowerShell run npm.ps1 (default Restricted policy blocks it; cmd would
# work via npm.cmd anyway). One-time, per-user, no admin needed:
Set-ExecutionPolicy -Scope CurrentUser -Force RemoteSigned
# close and reopen PowerShell so the new PATH (node, npm, git) is picked up, then check:
node -v        # v22.19+ expected
npm --version
git --version
```

> **If `npm` works in `cmd` but not in PowerShell:** both shells see the same
> PATH but resolve `npm` to different shims — PowerShell runs the `npm.ps1`
> script, which the default **Restricted** execution policy blocks. One-time
> fix, no admin: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
> (or just type `npm.cmd`). If the error is instead "`npm` is not recognized",
> it is a stale PATH — the terminal was opened before the winget install;
> close it and reopen it.

## Install — from the folder to a working session

All commands below are PowerShell and use the FIXED path `C:\Observation_only`
— no variables, so every command works in any window (even a freshly opened
one). If the repo is not there, run the one-time move in step 0.

```powershell
# ── 0) Get this folder ─────────────────────────────────────────────────────────
# Option A — clone the repo (private repo: you need access + a git credential,
# e.g. `gh auth login` first, or a personal access token):
git clone https://github.com/Tithanium/Observation_only_harness.git C:\Observation_only
# Option B — you already have the folder (USB, sync, …) at another path:
#            move it to C:\Observation_only ONCE (adapt the source path):
#            Move-Item "C:\where\you\put\Observation_only" C:\Observation_only

# ── 1) Install the npm dependencies ───────────────────────────────────────────
cd C:\Observation_only
npm install      # four small deps: marked, highlight.js, yaml, get-east-asian-width

# ── 2) Install the personal configuration into the user profile ───────────────
# THE HARNESS ALWAYS READS CONFIG FROM THE PROFILE, NEVER FROM THE PROJECT
# FOLDER — this step is what makes the saved config (settings.json,
# models.json, extensions/, skills/, agents/) take effect.
#
#   CASE A — %USERPROFILE%\.Observation_only ALREADY EXISTS (the harness was
#            already used on this machine):
#            Move-Item REFUSES to overwrite — delete or merge first. For a
#            PRISTINE start:
#                Remove-Item $env:USERPROFILE\.Observation_only -Recurse -Force
#
#   CASE B — IT DOES NOT EXIST (fresh machine):
#            the move creates it — nothing else to do.
Move-Item C:\Observation_only\.Observation_only $env:USERPROFILE\.Observation_only
Test-Path $env:USERPROFILE\.Observation_only\settings.json   # expected: True (both cases)

# ── 3) (dev only) Re-create the junction so git tracks the LIVE config ────────
# The dev setup tracks the dot-folder through a junction INSIDE the project:
# `git status` then shows live config changes directly, nothing to sync.
# SKIP on a run-only machine.
cmd /c mklink /J C:\Observation_only\.Observation_only $env:USERPROFILE\.Observation_only

# ── 4) Start a working session ────────────────────────────────────────────────
node src\round5.js --interactive
```

macOS / Linux (bash):

```bash
cd /where/you/want/the/installation/folder
git clone https://github.com/Tithanium/Observation_only_harness.git Observation_only_harness
cd Observation_only_harness
npm install
mv .Observation_only ~/.Observation_only
# (dev only) ln -s ~/.Observation_only .Observation_only
node src/round5.js --interactive
```

Then, in the harness session:

```
/ALAN_connector <your ALAN API key>   # connect the ALAN provider (key saved)
/model                                 # verify / pick the model
```

(details in the ALAN section below)

## Verify the session is complete

- The TUI starts: `◙ ` prompt, dark theme, banner (model, work dir), and a
  **footer** with input/output token counts, context size and **tok/s**
  (pi-style, pi's numbers)
- `/` menu offers: `/new` (+ `/clear`), `/model`, `/reload`, `/resume`,
  `/tree`, `/hotkeys`, `/quit` (+ `/exit`), the extension command
  `/ALAN_connector`, and the harness additions `/help`, `/info`, `/skills`
  (plus `skill:<name>` and `agents:<name>` rows)
- Skills loaded: `ALAN`, `ansys`, `fedoo`
- Subagents loaded: `ANSYS`, `alan-connector`, `model`, `researcher`,
  `reviewer`, `worker`
- Tools are READ-ONLY by construction: `read`, `grep`, `find`, `ls`, `fetch`
  (work-folder scoped; user-provided http(s) links only) and `subagent`
- `/reload` re-loads extensions fresh (cache-bust); an extension file whose
  factory throws registers NOTHING (pi-faithful staged commit)

**Troubleshooting — the session starts but no model is set:** the saved
`models.json` carries a **masked** API key (by design). Run
`/ALAN_connector <your key>` once — it regenerates the credentials (see ALAN
section). If the ALAN service is unreachable, point the config at another
provider first.

## ALAN provider — the /ALAN_connector flow (key auto-save)

The `alan-connector` extension (`.Observation_only/extensions/alan-connector/`,
shipped in this save) is a port of pi's connector. **No LLM connection of its
own**: it shells out to two deterministic PowerShell scripts that live next to
it (all references stay inside the extension folder):

- `alan_probe.ps1` — deterministic probe of
  `GET https://alan.univ-grenoble-alpes.fr/api/models`, model selection
  (forced → config match → favorite → first), token limits. The API key is
  read from `config.local.ps1` in the extension folder if that file exists —
  otherwise the probe runs unauthenticated. Never prints the key.
- `alan_config_writer.ps1` — surgical config writer: backs up
  `models.json` + `settings.json` (`.bak_yyyyMMdd_HHmmss`), merges the `alan`
  provider **including the key**, validates, writes, verifies. `-DryRun` shows
  the diff.

In a session:

1. `/ALAN_connector` — probe; if the service answers HTTP 401/403, the harness
   asks interactively for the **ALAN (UGA) API key**. You can also pass it
   directly — the only argument form: `/ALAN_connector <apiKey>` (more than one
   token → error).
2. **Model picker**: a scrollable list of the live models appears below the
   prompt (↑/↓ navigate, Enter select, Esc cancel).
3. **Auto-save (no further questions)**: on select — backup → merge provider +
   key into `models.json` → set `defaultProvider: alan` + `defaultModel:
   <picked>` in `settings.json` → **hot-apply** (live catalog reload + model
   switch — no restart needed).
4. The key is never printed and never written to any log
   (`alan_connector.log` carries one bracketed result line per run).

So on a fresh install: start the harness → `/ALAN_connector <your ALAN API
key>` → `/model` → done. Rollback after a bad write: the writer keeps `.bak_*`
copies next to the configs — restore one, or re-run `/ALAN_connector`.

If the ALAN service is NOT reachable from your machine (it is the source
user's institutional service), point `defaultProvider`/`defaultModel` in
`$env:USERPROFILE\.Observation_only\settings.json` (and the provider entry in
`models.json`) at any OpenAI-compatible endpoint you have; the ALAN skill and
extension remain inert but harmless.

## Path conventions

- `~` = your user profile = `%USERPROFILE%` (e.g. `C:\Users\<you>`).
- Harness config: `%USERPROFILE%\.Observation_only\` (extensions, skills,
  agents, settings.json, models.json, `agent/bin/` with `fd.exe` + `rg.exe`
  used by find/grep). The harness never reads config from the project folder.
- **Junction design (dev machine)**: the project's `.Observation_only` entry
  is a Windows junction (a symlink with `ln -s` on macOS/Linux) to the profile
  config, so git tracks the live config directly — nothing to sync before
  `git add -A`.
- Optional doc trees referenced by the `ansys` / `fedoo` skills and agents
  (ANSYS APDL documentation + examples, fedoo docs + examples) live under
  `%USERPROFILE%\Datas\02_RECHERCHE\00_Biblio\…` **on the source machine only**
  — that research data is NOT part of this save. If the folders don't exist,
  the ANSYS/FEDOO advisers still load and work, but answer without local doc
  references.

## What is included

### Extensions (`.Observation_only/extensions/`)

pi's own real extension files load and run **unchanged** through the harness
loader (`src/extensions.js` — discovery, staged commit and cache-bust semantics
ported from pi).

| Item | Role |
|---|---|
| `alan-connector/` | `/ALAN_connector` — probe + interactive key prompt + model picker + config writer + hot-apply (see ALAN section). **Secrets git-ignored** (`config.local.ps1`, `probe_result.json`) |
| `git_it.ts` | Git-workflow extension (carries source-user paths — dev) |
| `hello.ts` | Minimal extension sample |
| `pdf2text.py` | PDF text-extraction helper script |

Note: `*.mjs` extensions are deliberately **not** autoloaded — pi's own
extensions dir carries one that calls `process.exit` at top level, and the
harness must survive loading the pi dir.

### Skills (`.Observation_only/skills/`)

`ALAN` (ALAN model-service wiring) · `ansys` (ANSYS APDL adviser, OKF-backed) ·
`fedoo` (fedoo FEA-library adviser, OKF-backed)

### Agents (`.Observation_only/agents/`)

`ANSYS` · `alan-connector` · `model` · `researcher` · `reviewer` · `worker`
(read-only investigation workers — see `worker.md`: exactly four tools,
`fetch`/`grep`/`find`/`ls`)

### Memory & configuration (root of `.Observation_only/`)

`AGENTS.md` (session rules) · `settings.json` (`defaultProvider: alan`,
`defaultModel: qwen-3.8-27b`, dark theme, `create_folder_path: false` — the
launch folder-map walk; the pi-style `packages` list is inert — the pi package
flow is not part of the harness) · `models.json` (**apiKey masked as
`sk-REMPLACEZ_PAR_VOTRE_CLE`**) · `agent/` (`models.json` masked,
`models-store.json`, `bin/fd.exe` + `bin/rg.exe`)

### npm dependencies (root `package.json`)

`marked` (markdown rendering) · `highlight.js` (code highlighting) · `yaml`
(frontmatter) · `get-east-asian-width` (TUI width). No pi packages — the
harness is a port, not pi; `src/pi-shims/` provides the pi-compatible API
surface.

## What was excluded, and why

| Excluded | Why |
|---|---|
| `node_modules/` | Recreated by `npm install` |
| `*.log`, `.env` | Local noise / secrets |
| `**/auth.json` | ALAN credentials — regenerate with `/ALAN_connector` |
| `**/sessions/` | Session transcripts — machine-local |
| `alan-connector/config.local.ps1`, `alan-connector/probe_result.json` | API key — git-ignored **from this commit on** (both were tracked in the initial commit — see Notes) |

## Notes

- **The ALAN key WAS committed in the initial commit** (`models.json` ×2,
  `config.local.ps1`, `probe_result.json`). From this commit everything is
  masked/untracked, but the key is still in the remote history of the private
  repo. **Rotate the ALAN key** (then re-run `/ALAN_connector <new key>`);
  purge the remote history (e.g. `git filter-repo` + force-push) only if you
  accept rewriting the whole repo.
- **No build step**: Node ≥ 22.19 strips TS types natively; extension files
  must use erasable syntax (no enums/namespaces/parameter properties).
- **Observation-only guarantee**: five per-tool adversarial audits — no
  in-schema tool invocation can modify user data; symlink/junction escapes
  closed at all tool entry points (`audit-readonly-guarantee.md`).
- **Update cycle from this repo**: after changing anything in the harness or
  in the dot-folder, `git add -A && git commit -m "..." && git push` (private
  repo — keep it that way; the junction means live config changes show up in
  `git status` automatically).

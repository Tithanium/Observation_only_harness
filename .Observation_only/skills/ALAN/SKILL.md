---
name: alan
description: Operates the ALAN (UGA) OpenAI-compatible model service from pi — deterministic capability probe, model selection, and pi provider wiring. Use when choosing an ALAN model, writing or restoring the alan provider config in models.json/settings.json, running the /ALAN_connector command, or recovering pi config after a bad write. Covers the probe recipe (endpoints, alias lists, fallbacks), the pi wiring schema, connector subcommands, and the BACKUP-IF-PI-BREAKS rollback procedure.
---

# ALAN (UGA) service — probe, pi wiring, connector, rollback

Ground truth lives in the ALAN toolkit folder:
`C:\Users\connessn\Datas\02_RECHERCHE\11_all_AI\00_Harnesses_launch_ALAN`
- `PROBE_RECIPE.md` — full deterministic probe recipe (extracted from the original launch scripts)
- `PI_PROVIDER_WIRING.md` — pi custom-provider schema, verbatim from the pi docs
- `alan_probe.ps1` — deterministic probe (writes `probe_result.json`, never prints the API key)
- `alan_config_writer.ps1` — surgical pi-config writer (`-DryRun`, `-Restore`, backup `.bak_yyyyMMdd_HHmmss`)
- `config.ps1` + `config.local.ps1` — `$baseUrl`, `$apiKey` (placeholder overridden in `config.local.ps1`), `$preferredModelIds`
- logs: `alan_connector_probe.log` and `alan_config_writer.log` (same folder as the scripts)

Never print, log, or commit the API key (it lives in `config.local.ps1`, travels inside
`probe_result.json` → `models.json`, and is git-ignored: `.gitignore` lists
`config.local.ps1`, `probe_result.json`, `*.bak_*`).

---

## 1. Probing the Alan service to choose a model (deterministic recipe)

Authoritative source: `PROBE_RECIPE.md` (line numbers map to `launch_Harness_old.ps1` + `config.ps1`).

### 1.1 Endpoints and auth

| Thing | Value |
|---|---|
| Base URL | `https://alan.univ-grenoble-alpes.fr/api` (config.ps1) |
| List call | `GET {baseUrl}/models`, `Authorization: Bearer <apiKey>`, timeout 20 s — fatal on HTTP error / empty list |
| Per-model detail | `GET {baseUrl}/models/{id}`, timeout 10 s — **does NOT exist on Alan** (returns the Open WebUI HTML SPA with HTTP 200); any failure or non-JSON body is a non-fatal warning that must never abort |
| Key source | `$apiKey` PowerShell variable (config.ps1 placeholder → overridden by `config.local.ps1`), not an env var; placeholder or blank key = probe runs without the Authorization header (list may be public) |

### 1.2 Response path and fields

List location priority: `resp.data` → `resp.models` → the body itself is the array.
Empty/unusable list (no entries, or first entry lacks an `id`) → hard error + raw JSON dump to the log.

Per entry, the probe reads `id` and `name`, plus limits via alias lists (first non-empty hit):
- contextWindow aliases: `context_length`, `context_window`, `contextWindow`, `max_context_length`, `n_ctx`, `max_model_len`, `max_position_embeddings` — **the real Alan field is `max_model_len`** (e.g. 262144 for `ARES/Qwen3.8-27B`, 128000 for `ARES/DeepSeek-V4-Flash-0731`)
- maxTokens aliases: `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `maxTokens`, `max_new_tokens` — **never found on Alan today** → fallback `32768`
- sub-objects searched when a top-level field is missing: `meta`, `info`, `model_info`, `params`, `parameters`
- non-numeric limit from the server → fallback `32768` with a WARN line

### 1.3 Selection order (forced → config match → favorite → first)

1. `--model <id|N>` force: exact match by `id` OR display `name`, OR the `[N]` index shown by `--list` (0-based, server order) → validate. Not found / out-of-bounds → WARN, fall through.
2. `$modelId` from config (exact match by `id` OR `name`).
3. First entry of `$preferredModelIds` that exists on the server (favorites; missing favorite = WARN only).
4. First model of the server list.
Selections are matched case-sensitively; a config *name* such as `ARES\Qwen3.8-27B` also matches.

### 1.4 Log conventions and fatal paths

- Session header `===== Session yyyy-MM-dd HH:mm:ss =====`, then `[yyyy-MM-dd HH:mm:ss] [LEVEL] message`, LEVEL ∈ `INFO | OK | WARN | ERROR` (OK green, WARN yellow, ERROR red; `-FileOnly` for JSON dumps).
- `RESULTAT contextWindow = <v> (source: serveur | config.ps1, rien trouve sur le serveur)` and the same for maxTokens; missing fields also log the entry's available top-level property names + a full JSON dump (file-only).
- Fatal (exit 1): missing config.ps1; GET /models throws; GET /models returns no usable list; probe_result.json unwritable.
- Non-fatal: GET /models/{id} failure; missing limits (fallback 32768); missing favorite; unreadable existing models.json/settings.json (previous content treated as absent, other providers not recovered).
- `alan_probe.ps1` resolves its config by dot-sourcing `config.ps1` (which dot-sources `config.local.ps1` last, so `config.local.ps1` overrides everything) and writes the probe contract to `probe_result.json`: `{ baseUrl, api:"openai-completions", apiKeyPresent, apiKey?(consumed only by the config-writer, never printed), models:[{id,name,contextWindow,maxTokens}], selectedModelId, probedAt, raw }`.

Hand-run (PowerShell, equivalent to the script):

```powershell
$headers = @{ Authorization = "Bearer $apiKey" }          # $apiKey from config.local.ps1
$resp    = Invoke-RestMethod -Uri "https://alan.univ-grenoble-alpes.fr/api/models" -Headers $headers -TimeoutSec 20
$list    = if ($resp.data) { $resp.data } elseif ($resp.models) { $resp.models } else { $resp }
$entry   = $list | Where-Object { $_.id -eq "ARES/Qwen3.8-27B" } | Select-Object -First 1
$ctx     = $entry.max_model_len      # observed: 262144 (Qwen3.8-27B) / 128000 (DeepSeek-V4-Flash-0731)
$maxTok  = 32768                     # maxTokens is unobtainable on Alan -> keep the 32768 fallback
```

---

## 2. How the ALAN provider is wired in pi

Authoritative source: `PI_PROVIDER_WIRING.md` (pi docs v0.85.x). Route A = config-only via `~/.pi/agent/models.json` (recommended for OpenAI-compatible endpoints) — no code, reloaded on every `/model` open.

### 2.1 models.json

```json
{
  "providers": {
    "alan": {
      "baseUrl": "https://alan.univ-grenoble-alpes.fr/api",
      "api": "openai-completions",
      "apiKey": "<key>",
      "models": [
        { "id": "<modelId>", "name": "ARES Qwen3.8-27B (Alan UGA)", "contextWindow": 262144, "maxTokens": 32768 }
      ]
    }
  }
}
```

Rules that matter (models.md tables):
- The key under `providers` is the provider id (`alan`) used by `--provider alan`, `defaultProvider`, and `provider/modelId` strings.
- `baseUrl` + `api` are load-time requirements for a non-built-in provider; `apiKey` is NOT required to load — it only gates availability in `/model` and `--list-models` (no auth → models load but stay hidden from the picker, and `/model` availability checks never execute shell commands).
- `api` selects the streaming dialect; Alan is `openai-completions` (OpenAI Chat Completions). `openai-completions` is the most compatible flavor for vLLM/Open WebUI-style proxies.
- `apiKey` also supports env interpolation (`$ALAN_API_KEY`) and `!command`; but the reference implementation writes the raw key inline (dsh-style `apiKeyEnv` does NOT apply to pi).
- No network validation at load: pi never probes `{baseUrl}` at startup for `models.json` providers and never auto-fetches `/v1/models` — the connection is exercised only on the first real request.
- **Schema-perfect JSON is mandatory**: unreadable/ill-formed models.json or settings.json drops the file (providers not recovered, only a warning). The writer therefore validates its output by re-parsing before and after writing and restores backups on any failure.
- Per-model defaults when omitted: `name`→`id`, `reasoning`→false, `input`→["text"], `contextWindow`→128000, `maxTokens`→16384, `cost`→zeros. The writer always writes explicit `id/name/contextWindow/maxTokens`.
- Model references are by `id` (may contain slashes, e.g. `ARES/Qwen3.8-27B`); there is NO `aliases` field in the model schema.

### 2.2 settings.json

Only two keys are touched (everything else — `packages`, `theme`, `defaultTools`, … — is preserved byte-exact by the writer):

```json
{ "defaultProvider": "alan", "defaultModel": "<modelId>" }
```

### 2.3 Launch wiring

- pi's config dir resolves as `PI_CODING_AGENT_DIR` → `$env:USERPROFILE\.pi\agent`.
- The reference launch sets `PI_CODING_AGENT_DIR` before launching `pi`. Without it, pi silently ignores written files.
- The model `name` written is the config string (`"ARES Qwen3.8-27B (Alan UGA)"`), which intentionally differs from the server name (`"ARES/Qwen3.8-27B"`) — do not "correct" it.

---

## 3. The /ALAN_connector pi command

Extension: **folder** `C:\Users\connessn\.pi\agent\extensions\alan-connector\` (`index.ts` + `alan_probe.ps1` + `alan_config_writer.ps1` + `config.ps1` + `config.local.ps1`; auto-discovered, apply with `/reload` or a pi restart). **Layout rule: the command references files ONLY inside this extension folder** — the ALAN toolkit copy at `Datas\02_RECHERCHE\11_all_AI\00_Harnesses_launch_ALAN` is no longer used (probe_result.json, alan_connector_probe.log, alan_config_writer.log and the new connector log `alan_connector.log` all live in the extension folder). **Output rule: every trace of a run goes to `alan_connector.log`** in that folder; in TUI mode the session only shows a single bracketed comment line `[alan-connector] …` rendered **under the editor** via `ctx.ui.setWidget(placement:"belowEditor")` — never inside the message/prompt area (console.log / notify both land there); headless modes get it via console.log. Plus thrown errors. It is stand-alone deterministic (pure HTTP probe + file ops via the two local scripts), never requires an LLM connection, never touches skills/agents/extensions/auth.json, never prints the API key and never writes it to any log (relayed output is redacted). `probe_result.json` and `config.local.ps1` contain the API key → git-ignored by `extensions/alan-connector/.gitignore`. Errors always name the script paths involved.

| Invocation | Behavior |
|---|---|
| `/ALAN_connector` | Probe (default selection) + real write: backup first, write models.json + settings.json (merge semantics, byte-preserving other keys), print selected model, backup SHA-256 hashes, summary, **then HOT-APPLIES to the running session: `ctx.modelRegistry.refresh()` + `pi.setModel()` (verified fix for "must restart pi")** — the live catalog reloads at runtime (pi only re-reads models.json on `/model` open) and the current session switches to the picked model immediately |
| `/ALAN_connector --list` | Dry probe only: shows the models to choose from, nothing written |
| `/ALAN_connector --model <id|N>` | Force that model (exact id, display name, or the `[N]` index from `--list`, 0-based) for probe + write; `--model <N>` / `--model=<id>` also accepted |
| `/ALAN_connector --dry-run` | Probe + `alan_config_writer.ps1 -DryRun`: validation + textual diff, NO write, NO backup |
| `/ALAN_connector --restore` | Restore the latest `.bak_yyyyMMdd_HHmmss` pair, SHA-256-verify each restored file equals its backup, error if no backup exists, touch nothing else |
| `/ALAN_connector --help` | Usage + script paths |

Backup naming: `~/.pi/agent/models.json.bak_yyyyMMdd_HHmmss` and `~/.pi/agent/settings.json.bak_yyyyMMdd_HHmmss` (created before ANY write; backups are never deleted). Restore semantics: a backed-up file is copied back and verified; a file with no backup in the latest timestamp is removed if it exists (it did not exist before that write).

Direct script usage (equivalent, same contracts — the scripts live in the extension folder, not the ALAN toolkit folder):

```powershell
pwsh .\alan_probe.ps1                  # or: .\alan_probe.ps1 --model ARES/Qwen3.8-27B
pwsh .\alan_config_writer.ps1          # real write (backup first)
pwsh .\alan_config_writer.ps1 -DryRun  # validate + diff, nothing written
pwsh .\alan_config_writer.ps1 -Restore # restore latest backup pair, verify hashes
```

---

## 4. BACKUP-IF-PI-BREAKS procedure

### 4.1 What the connector backs up

Every real write of `/ALAN_connector` (or the writer script) creates a timestamped pair
`models.json.bak_yyyyMMdd_HHmmss` + `settings.json.bak_yyyyMMdd_HHmmss` in `~/.pi/agent/` BEFORE writing.
The connector touches NOTHING else — skills, agents, extensions, auth.json, sessions are out of scope.

### 4.2 Restore config after a bad write

```powershell
pwsh C:\Users\connessn\Datas\02_RECHERCHE\11_all_AI\00_Harnesses_launch_ALAN\alan_config_writer.ps1 -Restore
# or inside pi: /ALAN_connector --restore
```

The writer: finds the newest `.bak_yyyyMMdd_HHmmss` timestamp, copies each backup over the live file,
prints `SHA256 backup` vs `SHA256 restored` per file, and fails (exit 1) on any hash MISMATCH.
Verify hash-identical manually with:

```powershell
Get-FileHash C:\Users\connessn\.pi\agent\models.json, C:\Users\connessn\.pi\agent\models.json.bak_* -Algorithm SHA256
```

If a file had no backup in that timestamp (it did not exist before that write) it is removed — the
pre-write state is restored exactly. The file `PI_PROVIDER_WIRING.md` and the writer's own
post-write verification (re-parse + other-provider diff) are the evidence a write was clean.

### 4.3 Full pi-installation backup (roll back a broken pi version)

The connector only ever covers models.json/settings.json. To roll back a broken **pi version**, keep a
full snapshot:

```powershell
# 1. Copy the whole pi user dir (config, skills, agents, extensions, packages, sessions, trust)
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item -Recurse -Force "$env:USERPROFILE\.pi"          "$env:USERPROFILE\.pi.backup_$stamp"

# 2. Record the installed npm packages (rollback = pi install the pinned versions again)
npm ls -g --json > "$env:USERPROFILE\.pi.backup_$stamp\npm-global-list.json"

# 3. Reinstall the exact previous version from that list, e.g.
#    npm install -g @earendil-works/pi-coding-agent@<previous-version>
```

Rollback order after a broken `pi update`: (1) `pi update --self` back to the known-good release, or
`npm install -g <package>@<version>` from the snapshot's npm list; (2) restore `~/.pi` from the
snapshot if config was also damaged; (3) verify `pi -v` and `pi --list-models` before working.
Do not forget `auth.json` lives in `~/.pi/agent/` — it is covered by the `~/.pi` copy and is NOT covered
by the connector's backup pair.

---

## 5. Verification checklist after any connect/write

- [ ] `~/.pi/agent/models.json` parses, `providers.alan.baseUrl`/`api`/`apiKey`/`models[]` present, other providers untouched
- [ ] `~/.pi/agent/settings.json` parses, `defaultProvider=alan`, `defaultModel=<selected>`, other keys value-identical
- [ ] Backup pair exists: `models.json.bak_yyyyMMdd_HHmmss` + `settings.json.bak_yyyyMMdd_HHmmss`
- [ ] `pi --list-models` (or `/model`) shows the alan models after `/reload` — the file reloads on every `/model` open
- [ ] Hot-apply happened (current session uses ALAN without restart): the connector ends with `ctx.modelRegistry.refresh()` + `pi.setModel()`, logged as `hot-apply: session switched to alan/<id>` in `alan_connector.log`; a `hot-apply failed/warning` line means config is still written (open `/model` to select) — a pi restart is only a fallback
- [ ] Model id with slashes: reference it exactly as in models.json, e.g. `pi --model ARES/Qwen3.8-27B -p "…"`; full form `alan/ARES/Qwen3.8-27B` also resolves (provider id prefix)

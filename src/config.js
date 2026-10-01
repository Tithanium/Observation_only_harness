// src/config.js
// The harness's SHARED config resolver (round 8: folder structure/organisation).
// The source of truth is the USER DOT-FOLDER — env override OBSERVATION_ONLY_DIR
// first (mirroring pi's PI_CODING_AGENT_DIR), default ~/.Observation_only — a
// folder of the SAME KIND as pi's ~/.pi/agent: settings.json, models.json,
// auth.json, agents/, skills/, extensions/, AGENTS.md. First-run bootstrap seeds the default
// dot-folder from pi's non-secret config; auth.json is NEVER copied (secrets stay
// in pi's dot-folder; pi's auth.json is only a compatibility fallback). Resolves
// the selected provider + model + api key, following pi's order for custom
// models.json providers
// (pi's provider-composer.js composeApiKeyAuth + models.prepareRequest):
//   --api-key flag  >  auth.json credential  >  models.json provider "apiKey"
// Key values may be literals, "$VAR"/"${VAR}" (environment) or "!shell-command",
// like pi's resolve-config-value.js.
// IMPORTANT: resolved keys are never printed, logged or written anywhere by this
// harness; they only ever flow into the in-memory request.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The harness dot-folder — the source of truth for user-level config, pi-style:
 * env override first (OBSERVATION_ONLY_DIR, mirroring pi's PI_CODING_AGENT_DIR),
 * default join(homedir(), ".Observation_only"). Resolved at CALL time (never
 * cached at module load) so the env override works from tests and CLI alike.
 */
export function userDotDir() {
  const dir = process.env.OBSERVATION_ONLY_DIR ?? join(homedir(), ".Observation_only");
  // PIECE 2 (ALAN_connector round 2): the harness's OWN mirror of pi's
  // PI_CODING_AGENT_DIR (pi NEVER reads OBSERVATION_ONLY_DIR — grep-verified on
  // both files — while the connector's alan_config_writer.ps1 resolves its target
  // from $env:OBSERVATION_ONLY_DIR FIRST: see its Resolve-PiAgentDir); the env is
  // self-exported here AT CALL time (never overwriting an explicit override) so a
  // PLAIN harness run — no manual export — makes the spawned powershell writer
  // back up + rewrite the HARNESS dot-folder, never pi's real ~/.pi/agent (and
  // leaves pi's own /ALAN_connector and git_it's `pi list` untouched: pi only
  // reads PI_CODING_AGENT_DIR, which the harness does not touch).
  if (process.env.OBSERVATION_ONLY_DIR === undefined) process.env.OBSERVATION_ONLY_DIR = dir;
  return dir;
}

/**
 * First-run bootstrap: when the USER dot-folder is missing, create the skeleton
 * automatically — agents/, skills/, an EMPTY auth.json (the harness's own
 * credential store) and COPIES of pi's non-secret settings.json + models.json — so
 * the harness keeps working exactly as round 1 did. auth.json is never copied:
 * secrets stay in pi's dot-folder (resolveApiKey falls back there only). Only
 * the DEFAULT dot-folder is seeded: an OBSERVATION_ONLY_DIR env override points
 * at an explicitly managed folder (e.g. a test fixture) which bootstrap must not
 * touch. ROUND 20: extensions/ too — the autoload dir of src/extensions.js
 * (pi's skeleton also ships one). Never prints or logs secrets.
 */
export function bootstrapDotFolder() {
  const dir = userDotDir(); // also self-exports the harness dot-folder (see userDotDir)
  // An EXPLICIT override pointing OUTSIDE the default folder is an explicitly
  // managed dot-folder (e.g. a test fixture) which bootstrap must never touch.
  if (dir !== join(homedir(), ".Observation_only")) return dir;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "extensions"), { recursive: true });
  const authPath = join(dir, "auth.json");
  if (!existsSync(authPath)) writeFileSync(authPath, "{}\n");
  const piAgentDir = join(homedir(), ".pi", "agent");
  for (const name of ["settings.json", "models.json"]) {
    const dest = join(dir, name);
    if (!existsSync(dest)) {
      const srcPath = join(piAgentDir, name);
      if (existsSync(srcPath)) writeFileSync(dest, readFileSync(srcPath));
    }
  }
  return dir;
}

function readJson(path) {
  try {
    const raw = readFileSync(path, "utf8");
    try {
      // A leading UTF-8 BOM (U+FEFF) breaks JSON.parse ("Unexpected token '\uFEFF'") — a
      // Windows artifact (e.g. PowerShell 5.1 `Set-Content -Encoding UTF8` writes one):
      // strip it before parsing (Node's utf8 read does NOT strip it).
      return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (parseError) {
      parseError.message += ` (in ${path})`; // the bare JSON.parse error names no file
      throw parseError;
    }
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Resolve a configured value like pi's resolve-config-value.js:
 * "!cmd" runs a shell command, "$VAR"/"${VAR}" reads an env var, "$$"/"$!"
 * escape literal "$"/"!", anything else is a literal. Missing env vars make the
 * whole value unresolvable (returns undefined), like pi.
 */
export function resolveValue(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("!")) {
    try {
      return execSync(value.slice(1), { encoding: "utf8", timeout: 10000 }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const re = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let resolved = "";
  let last = 0;
  let missing = false;
  for (let m; (m = re.exec(value)); ) {
    resolved += value.slice(last, m.index);
    if (m[0] === "$$") resolved += "$";
    else if (m[0] === "$!") resolved += "!";
    else {
      const envValue = process.env[m[1] ?? m[2]];
      if (envValue === undefined) missing = true;
      else resolved += envValue;
    }
    last = m.index + m[0].length;
  }
  if (missing) return undefined;
  return resolved + value.slice(last);
}

/** settings.json (the dot-folder's global settings, merged over by a project
 *  .pi/settings.json if present — pi's project-scope override, unchanged). */
export function loadSettings() {
  bootstrapDotFolder();
  const globalSettings = readJson(join(userDotDir(), "settings.json"));
  const projectSettings = readJson(join(process.cwd(), ".pi", "settings.json"));
  return { ...globalSettings, ...projectSettings };
}

/** models.json custom providers (the dot-folder's). */
export function loadProviders() {
  bootstrapDotFolder();
  return readJson(join(userDotDir(), "models.json")).providers ?? {};
}

/** The dot-folder's global instructions/memory — pi's ~/.pi/agent/AGENTS.md kind:
 *  read AT CALL TIME from <userDotDir()>/AGENTS.md (env override
 *  OBSERVATION_ONLY_DIR first, default ~/.Observation_only), so the env override
 *  works from tests and CLI alike. MISSING file → undefined (no instructions, NO
 *  error — the system prompt stays the harness base). Never prints the content. */
export function loadGlobalInstructions() {
  const path = join(userDotDir(), "AGENTS.md");
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function credentialFromAuthJson(path, providerId) {
  const stored = readJson(path)[providerId];
  if (stored && typeof stored === "object" && stored.type === "api_key" && stored.key !== undefined) {
    return resolveValue(stored.key);
  }
  return undefined;
}

/**
 * Resolve the api key for a provider, pi's order with the harness's own store
 * first:
 *   1. explicit apiKey (pi: CLI --api-key / per-request apiKey),
 *   2. the dot-folder's OWN auth.json (the harness's credential store),
 *   3. pi's auth.json — compatibility fallback ONLY (the dot-folder seeds no
 *      secrets; pi's is consulted solely so round-1 flows that rely on pi's
 *      stored credentials keep working),
 *   4. models.json provider "apiKey".
 * Returns undefined when unresolvable. Never returns or logs the raw value of a
 * stash file; callers must not print the result.
 */
export function resolveApiKey(providerId, providerConfig, cliApiKey) {
  if (cliApiKey !== undefined && cliApiKey !== null && cliApiKey !== "") {
    return cliApiKey;
  }
  const own = credentialFromAuthJson(join(userDotDir(), "auth.json"), providerId);
  if (own !== undefined) return own;
  const pi = credentialFromAuthJson(join(homedir(), ".pi", "agent", "auth.json"), providerId);
  if (pi !== undefined) return pi;
  if (providerConfig && providerConfig.apiKey !== undefined) {
    return resolveValue(providerConfig.apiKey);
  }
  return undefined;
}

/** create_folder_path — the round-2 map_folder_walk feature switch (the harness
 *  start writes map_folder.md / map_folder_full.md ONLY when the variable is ON;
 *  default FALSE → the initial folder-map walk never runs: nothing is scanned
 *  and no map file is created/updated anywhere, the harness still starts).
 *  Resolution order, AT CALL TIME (tests flip it via the env FIRST — the env
 *  override wins over the settings flag): env OBSERVATION_ONLY_CREATE_FOLDER_PATH
 *  ("true"/"1"/"yes") → settings.json "create_folder_path" (boolean) → false.
 *  Never cached: the flag can change between calls (settings #.pi/settings.json
 *  override merged over the global one). */
export function resolveCreateFolderPath() {
  const env = process.env.OBSERVATION_ONLY_CREATE_FOLDER_PATH;
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  const settings = loadSettings();
  if (typeof settings.create_folder_path === "boolean") return settings.create_folder_path;
  return false; // create_folder_path=false by default: the folder-map walk is OFF
}

/** Resolved selection: provider/model from settings.json (or CLI overrides) + api key. */
export function resolveSelection(overrides = {}) {
  const settings = loadSettings();
  const providers = loadProviders();
  const providerId = overrides.provider ?? settings.defaultProvider;
  const modelId = overrides.model ?? settings.defaultModel;
  if (!providerId) {
    throw new Error('No provider selected: set "defaultProvider" in ' + join(userDotDir(), "settings.json") + " or pass --provider");
  }
  const providerConfig = providers[providerId];
  if (!providerConfig) {
    throw new Error(`Provider "${providerId}" not found in ${join(userDotDir(), "models.json")}`);
  }
  const apiKey = resolveApiKey(providerId, providerConfig, overrides.apiKey);
  return { providerId, modelId, providerConfig, apiKey };
}

// src/pi-ai.js
// Loads the exact pi-ai build pi itself ships (@earendil-works/pi-ai, same version,
// same provider SDKs: openai, @anthropic-ai/sdk, ...). Resolution order:
//   1. the package if it is installed in this project,
//   2. the copy pi bundles under its global npm install.
// Only the public openai-completions entry is needed for Round 1.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_AI_ID = "@earendil-works/pi-ai";

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return undefined;
  }
}

function piAiDir() {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  return join(globalRoot, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai");
}

async function importFromPiInstall(subpath) {
  const base = piAiDir();
  if (!existsSync(base)) {
    throw new Error(
      `Cannot find ${PI_AI_ID}: add it to this project's dependencies or install pi at the global npm root (${base})`
    );
  }
  return import(pathToFileURL(join(base, subpath)).href);
}

/** Same exports pi exposes: createModels / createProvider from the pi-ai index. */
export async function createModels(options) {
  const mod = (await tryImport(PI_AI_ID)) ?? (await importFromPiInstall("dist/index.js"));
  return mod.createModels(options);
}

/** Provider factory used by pi's models.json loader (provider-composer.js). */
export async function createProvider(options) {
  const mod = (await tryImport(PI_AI_ID)) ?? (await importFromPiInstall("dist/index.js"));
  return mod.createProvider(options);
}

/** API adapter for models.json "api": "openai-completions". */
export async function openAICompletionsApi() {
  const module = await (await tryImport(`${PI_AI_ID}/api/openai-completions.lazy`)) ?? (await importFromPiInstall("dist/api/openai-completions.lazy.js"));
  return module.openAICompletionsApi();
}

/** TypeBox TypeBuilder, same build pi uses (re-exported by pi-ai's index). */
export async function typeboxType() {
  const mod = (await tryImport(PI_AI_ID)) ?? (await importFromPiInstall("dist/index.js"));
  return mod.Type;
}

/** Tool-call argument validation — the exact validator pi's agent loop runs
 *  (pi-ai validateToolCall: find by name, TypeBox convert + constraint check). */
export async function validateToolCall(tools, toolCall) {
  const mod = (await tryImport(PI_AI_ID)) ?? (await importFromPiInstall("dist/index.js"));
  return mod.validateToolCall(tools, toolCall);
}

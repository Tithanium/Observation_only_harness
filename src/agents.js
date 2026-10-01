// src/agents.js
// Round 5: agent discovery + frontmatter parsing for the subagent tool — a port of
// pi's subagent extension agents.ts (examples/extensions/subagent/agents.ts).
// Agent definitions are markdown files with frontmatter; the markdown body IS the
// agent's system prompt. Same parsing rules as pi:
//   - frontmatter keys (split on ---): name (REQUIRED string — the lookup key in a
//     subagent call), description (REQUIRED string), tools (optional: comma-string
//     OR YAML array), model (optional: provider shorthand, "provider/id");
//   - a file lacking name/description strings is skipped, like pi; a malformed
//     tools value (number/map/…) yields no tools rather than throwing;
//   - discovery dirs: user scope = <dot-folder>/agents (the harness's OWN agents
//     home — ~/.Observation_only/agents, seeded from the project's agents,
//     shared resolver in config.js; the workers never write there, they run OUR
//     harness code), project scope = <projectRoot>/agents (the project mirror),
//     "both" = union with the project winning on a name collision.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { userDotDir } from "./config.js";

export function getAgentDir() {
  return userDotDir();
}

/** The harness's own project root = the folder this module lives in (src/) + .. */
export function projectRoot() {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/** Split the frontmatter block off a markdown file; body = everything after ---. */
export function parseFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text.startsWith("\n") ? text.slice(1) : text };
  const rest = text.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return { frontmatter: {}, body: text };
  const fmLines = rest.slice(0, end);
  const body = rest.slice(end + 4);
  const frontmatter = {};
  for (const line of fmLines.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!value) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean).filter((v) => v !== "[" && v !== "]");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: body.startsWith("\n") ? body.slice(1) : body };
}

/** Normalize a frontmatter `tools` value to a list of tool names (comma-string OR
 *  YAML array; anything else yields no tools rather than throwing, like pi). */
function parseToolList(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir, source) {
  const agents = [];
  if (!existsSync(dir)) return agents;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let content;
    try {
      content = readFileSync(join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath: join(dir, entry.name),
    });
  }
  return agents;
}

/** Discover agents: user dir (read-only reference) and/or the harness's own
 *  <projectRoot>/agents. "both" = union, the project winning on a name collision,
 *  exactly pi's discoverAgents. */
export function discoverAgents(scope = "both") {
  const userDir = join(getAgentDir(), "agents");
  const projectAgentsDir = join(projectRoot(), "agents");
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents = scope === "user" ? [] : loadAgentsFromDir(projectAgentsDir, "project");
  const map = new Map();
  if (scope === "both") {
    for (const agent of userAgents) map.set(agent.name, agent);
    for (const agent of projectAgents) map.set(agent.name, agent);
  } else if (scope === "project") {
    for (const agent of projectAgents) map.set(agent.name, agent);
  } else {
    for (const agent of userAgents) map.set(agent.name, agent);
  }
  return { agents: Array.from(map.values()), projectAgentsDir };
}

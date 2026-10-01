// src/skills.js
// Round 12: skill organization + auto-loading via the YAML HEADER — the Agent
// Skills standard the way pi ACTUALLY implements it (docs/skills.md +
// dist/core/skills.js), evaluated against the Observation_only harness. A skill =
// a directory holding SKILL.md; under <userSkillsDir()> (~/.Observation_only/
// skills, env override OBSERVATION_ONLY_DIR first — the round-8 dot-folder)
// directories containing SKILL.md are discovered RECURSIVELY (pi's
// loadSkillsFromDirInternal: a dir that HOLDS a SKILL.md loads that one and does
// NOT descend further into its subdirectories). The YAML frontmatter
// (parseSkillFrontmatter — pi's extractFrontmatter + yaml.parse, scalars only):
// name (string; the parent dir name when absent — pi allows that) + description
// (REQUIRED non-empty string — the DISPATCH TRIGGER the LLM matches when
// deciding to load the skill). Like pi: malformed frontmatter or a missing
// description → SKIPPED gracefully (warning only, never a throw); unknown
// fields ignored; a name collision keeps the FIRST skill found;
// `disable-model-invocation: true` LOADS the skill but HIDES it from the
// system-prompt index (users must invoke it explicitly, pi's STRICT `=== true`).
// AUTO-LOADING = pi's mechanism, no more: only the INDEX goes into the system
// prompt — skillsPromptSection() renders pi's exact <available_skills> XML
// (name + description + location per skill); the full SKILL.md body loads ON
// DEMAND via the fetch tool (progressive disclosure — pi does NOT auto-load
// bodies). THE PARSER (round-12 critic gap, fixed): parseSkillFrontmatter is a
// faithful port of pi's dist/utils/frontmatter.js — extractFrontmatter's exact
// split (`indexOf("\n---", 3)`, `slice(4, endIndex)`, body `.trim()`) feeding
// the REAL `yaml` parser. The `yaml` dependency was ADDED (the project's one
// and only dependency), pinned EXACTLY to 2.9.0 — the very version pi bundles
// (pi's node_modules/yaml). DECISION over vendoring: yaml's dist is 153
// files/395KB — a vendored copy would be a far larger, drift-prone delta;
// one pinned package.json line gives pi's exact semantics with zero divergence
// (the deleted hand-rolled scanner turned `description: true` into the STRING
// "true" → a skill loaded where pi skips it; `foo # comment` leaked the
// comment into the LLM's prompt; block scalars / flow collections were
// mangled). Never prints secrets.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { parse } from "yaml"; // yaml@2.9.0 — the REAL parser, pi's `parseFrontmatter` = `parse(yamlString) ?? {}`
import { userDotDir } from "./config.js";

/** The skills dir at the harness dot-folder — ~/.Observation_only/skills (the
 *  round-12 home of the skill mechanism, pi's ~/.pi/agent/skills kind); env
 *  override OBSERVATION_ONLY_DIR honoured at CALL time, like userDotDir. */
export function userSkillsDir() {
  return join(userDotDir(), "skills");
}

/** Split the YAML frontmatter off a SKILL.md the way pi's parseFrontmatter does — an
 *  exact port of pi's dist/utils/frontmatter.js (stripBom + newline normalization,
 *  `indexOf("\n---", 3)`, `slice(4, endIndex)`, body `slice(endIndex + 4).trim()`)
 *  feeding `yaml.parse` (yaml@2.9.0, the pinned dependency — see the header
 *  note): a file that does NOT start with "---", or whose opening "---" never
 *  closes on a "\n---" line, has NO frontmatter ({}) — for a skill that means
 *  "no description" → skipped, never an error. Values keep YAML'S OWN TYPES:
 *  `description: true` is the BOOLEAN true (→ not a string → not a skill, pi's
 *  hasDescription); `foo # comment` → "foo" (comments are stripped — they
 *  never leak into the LLM's prompt); flow collections / block scalars parse
 *  properly; a value that makes yaml.parse THROW (unclosed flow collection /
 *  quote) is MALFORMED → frontmatter is null (pi: parseFrontmatter throws →
 *  loadSkillFromFile catches → the file is skipped gracefully). The body is
 *  `.trim()`ed like pi's. Unknown fields are ignored. Returns { frontmatter,
 *  body }. */
export function parseSkillFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"); // pi's stripBom + normalizeNewlines
  if (!text.startsWith("---")) return { frontmatter: {}, body: text }; // no opening --- → { yamlString: null, body }
  const endIndex = text.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: text }; // pi: an unclosed "---" → no yaml string → {}
  const yamlString = text.slice(4, endIndex); // pi's EXACT slice (after the opening "---\n" — the old scanner used slice(3, end))
  const body = text.slice(endIndex + 4).trim(); // pi: body .trim()
  try {
    return { frontmatter: parse(yamlString) ?? {}, body }; // the REAL parser: true → boolean, `# comment` stripped, block/flow parsed
  } catch {
    return { frontmatter: null, body }; // malformed → pi's parseFrontmatter throws → loadSkillFromFile catches → skipped
  }
}

/** Load ONE SKILL.md the way pi's loadSkillFromFile does: name = the frontmatter
 *  `name` string, the parent dir name when absent; the description MUST be a
 *  non-empty string or the skill is SKIPPED (pi: warning + not loaded);
 *  malformed frontmatter (null) → skipped. Returns the skill
 *  { name, description, path, baseDir, disableModelInvocation } or null. */
export function loadSkillFromFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const { frontmatter } = parseSkillFrontmatter(raw);
  if (frontmatter === null) return null; // malformed → skipped gracefully
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") return null; // pi's hasDescription: non-string (bool/number/flow) → not a skill
  return {
    name: typeof frontmatter.name === "string" && frontmatter.name !== "" ? frontmatter.name : dirname(filePath).split(sep).pop(),
    description: description.trim(),
    path: filePath,
    baseDir: dirname(filePath),
    disableModelInvocation: frontmatter["disable-model-invocation"] === true, // STRICT === true only (pi: the STRING "true" loads AND stays visible)
  };
}

/** Recursive walk of ONE skill dir (pi's loadSkillsFromDirInternal): a dir that
 *  holds SKILL.md loads exactly that skill and does NOT descend into its
 *  subdirectories; otherwise every subdirectory is walked the same way, so skill
 *  dirs can nest. Missing/unreadable dir → [] (no error, like pi). */
export function loadSkillsFromDir(dir, includeRootFiles = true) {
  const skills = [];
  if (!existsSync(dir)) return skills;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const skill = loadSkillFromFile(join(dir, entry.name));
    if (skill) skills.push(skill);
    return skills; // pi: a dir containing SKILL.md loads it, full stop (no descent)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      // pi's includeRootFiles (TRUE at the TOP level only): root *.md files with
      // valid frontmatter + description are skills too — a notes.md sitting
      // directly under the skills dir (pi's loadSkillsFromDirInternal second
      // loop); recursion passes false → deeper levels are SKILL.md-only.
      if (entry.name.startsWith(".") || !includeRootFiles || !entry.name.endsWith(".md")) continue;
      const skill = loadSkillFromFile(join(dir, entry.name));
      if (skill) skills.push(skill);
      continue;
    }
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    skills.push(...loadSkillsFromDir(join(dir, entry.name), false));
  }
  return skills;
}

/** ALL discovered skills under <userSkillsDir()> — the progressive-disclosure
 *  input (pi's loadSkills): name + description (+ path) per skill, the
 *  descriptions being the dispatch criteria the LLM sees; missing skills dir → []
 *  (no error). A name collision keeps the FIRST skill found, like pi. */
export function discoverSkills() {
  const map = new Map();
  for (const skill of loadSkillsFromDir(userSkillsDir())) {
    if (!map.has(skill.name)) map.set(skill.name, skill);
  }
  return Array.from(map.values());
}

/** The skills section of the system prompt — pi's formatSkillsForPrompt, XML per
 *  the Agent Skills spec: one <skill> block per VISIBLE skill (name + description
 *  + location, XML-escaped), `disable-model-invocation: true` skills HIDDEN
 *  (they still load — /skills lists them — but the model is not invited to use
 *  them). "" when nothing visible → the caller skips the section entirely (like
 *  pi — the prompt stays the harness base + global instructions). This IS the
 *  auto-loading: the descriptions are always in context; the full SKILL.md body
 *  loads on demand via the fetch tool. */
export function skillsPromptSection(skills = discoverSkills()) {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const escapeXml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const lines = [
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the fetch tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>", `    <name>${escapeXml(skill.name)}</name>`, `    <description>${escapeXml(skill.description)}</description>`, `    <location>${escapeXml(skill.path)}</location>`, "  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

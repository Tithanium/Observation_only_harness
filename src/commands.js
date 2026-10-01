// src/commands.js
// Round 11 feature: "/" commands — pi's command set evaluated against the
// Observation_only harness and reduced to the ones that apply, pi as the reference:
// docs/usage.md §Slash Commands (24 builtins in dist/core/slash-commands.js + the
// /llama extension). APPLIES here — ported: /quit, /new (+ /clear — pi's
// OLD name for /new; pi's CHANGELOG: "Renamed /clear to /new"; kept as an
// alias like /exit → /quit), /model, /hotkeys,
// /reload (round 11), and /resume + /tree (ROUND 17 — the session store now
// exists: see src/session_store.js, the interactive picker in src/interactive.js
// owns the picker I/O). ROUND 20: EXTENSION commands — .ts/.js files under
// <userExtensionsDir()> (the dot-folder extensions/ dir, src/extensions.js)
// autoload at session start and register extra slash commands (pi's
// registerCommand contract: the registry + the dispatch default branch below;
// /help and the slash proposal list them after the builtins). /help, /exit (the
// /quit alias), /info and /skills are
// HARNESS ADDITIONS beyond pi's set — pi itself has none of the three; their
// nearest pi analogs are the startup header, the footer and /skill:name (round 12
// IS the skill mechanism — see src/skills.js).
// Deliberately NOT ported: /login /logout (no interactive credential flow — keys
// resolve from files), /llama (no llama.cpp integration), /settings
// /scoped-models /thinking (TUI menus), /session /fork /clone /import /export
// /compact (session display / summaries / trasfer channels), /share /bug
// /changelog (share/upload channels), /copy (no clipboard), /name /trust (no
// session display names / trust flow). Dispatch is PURE — no I/O — so the test
// suite can drive every command deterministically. A line that is a command
// returns { action, lines, model? }; anything else returns { action: "turn" }
// (a normal message for the LLM). Never prints secrets.

import { existsSync, readFileSync } from "node:fs";
import { userDotDir } from "./config.js";
import { discoverSkills, parseSkillFrontmatter, userSkillsDir } from "./skills.js";
import { discoverAgents } from "./agents.js";
import { extensionCommand, extensionCommandsList, userExtensionsDir } from "./extensions.js";

export { userDotDir }; // the round-8 shared dot-folder resolver, re-exported for callers
export { userSkillsDir }; // the round-12 skills dir (defined in src/skills.js), re-exported for callers
export { userExtensionsDir }; // the round-20 extensions dir (defined in src/extensions.js), re-exported for callers

/** The prompt shown at the start of every interactive line (pi's editor prompt). */
export const PROMPT = "❯ ";

/** The command list, in /help order. */
export const COMMANDS = [
  { name: "/help", usage: "/help", describe: "list commands + keyboard shortcuts + footer legend" },
  { name: "/quit", usage: "/quit", describe: "quit the harness (alias: /exit)" },
  { name: "/new", usage: "/new", describe: "reset the transcript — fresh session, same work dir" },
  { name: "/clear", usage: "/clear", describe: "alias for /new — pi's former /clear (pi renamed it to /new; its clear handler is handleClearCommand, interactive-mode.js:5528)" },
  { name: "/info", usage: "/info", describe: "session facts: provider, model, work dir, footer" },
  { name: "/model", usage: "/model [<provider/model>]", describe: "Select model (opens selector UI)" },
  { name: "/hotkeys", usage: "/hotkeys", describe: "keyboard shortcuts (enter, arrows, home/end, ctrl+o, ctrl+c, ctrl+d)" },
  { name: "/reload", usage: "/reload", describe: "re-read settings.json + models.json (transcript kept)" },
  { name: "/skills", usage: "/skills", describe: "list the skills found under the user dot-folder" },
  { name: "/skill:<name>", usage: "/skill:<name>", menu: false, describe: "load a skill's full instructions into the conversation (pi's /skill:name) — the slash menu lists one row per skill" },
  { name: "/agents:<name>", usage: "/agents:<name> [task]", menu: false, describe: "run an agent: with a task it runs via the subagent path, without one its definition is shown — the slash menu lists one row per agent" },
  { name: "/resume", usage: "/resume", describe: "pick a saved session of this work dir to continue (search, ↑/↓, enter, esc cancels)" },
  { name: "/tree", usage: "/tree", describe: "the conversation as a branch tree — indentation by ROLE: user at column 0, assistant + tools one indent right, subagents one more (opens at the active leaf · • marks the active path — ↑/↓, enter selects; a user entry re-enters its text into the input line (only when empty) and continues from its PARENT, enter submits it; esc cancels)" },
];

/** The keyboard shortcuts, as implemented by the interactive session (round 10):
 *  the line-editing keys plus the two session keys. WHAT APPLIES from pi's
 *  keybindings.md: enter submit, up/down history recall (pi's cursorUp/cursorDown),
 *  left/right (cursorLeft/cursorRight, pi's ctrl+b/ctrl+f too), home/end line
 *  start/end (pi's ctrl+a/ctrl+e), backspace/delete backward/forward (pi's ctrl+h
 *  /ctrl+d too), and the session keys ctrl+o (pi's app.tools.expand — expand /
 *  collapse the last subagent's context), ctrl+c (pi's app.clear: cancel the
 *  request in flight first, quit when idle) and ctrl+d (pi's app.exit: quit on an
 *  empty line). ROUND 19: the CHART's transcript scroll keys, pi's tui.altScreen.*
 *  (fullscreen): pageUp/pageDown scroll the transcript by a page (the editor is
 *  single-line, so those keys are free), home scrolls to the TOP, end scrolls to
 *  the LATEST and resumes following (they still move the writing-line cursor).
 *  Ctrl+o with no subagent context does nothing (harmless no-op). */
export const HOTKEYS = [
  ["enter", "submit the current line"],
  ["up / down", "recall an earlier / later line (history)"],
  ["left / right", "move the cursor (ctrl+b / ctrl+f)"],
  ["home / end", "jump to the line start / end (ctrl+a / ctrl+e) · in the chart also: transcript top / latest"],
  ["pageup / pagedown", "scroll the chart's transcript up / down by a page (pi's tui.altScreen.pageUp / pageDown)"],
  ["esc", "interrupt the current answer (pi's app.interrupt) — the in-flight request aborts → (interrupted); idle → ignored"],
  ["mouse wheel / two-finger scroll", "scroll the chart's transcript (pi's fullscreen TUI) · click jumps to the latest + follow"],
  ["backspace / delete", "delete backward / forward (ctrl+h / ctrl+d)"],
  ["ctrl+u / ctrl+k", "delete to line start / line end"],
  ["ctrl+w", "delete the word before the cursor"],
  ["ctrl+o", "expand / collapse all tool output"],
  ["alt+o", "expand / collapse all tool output"],
  ["ctrl+c", "cancel the request in flight · quit when idle"],
  ["ctrl+d", "delete forward · quit on an empty line"],
];

// userSkillsDir() now lives in src/skills.js (the round-12 skill mechanism, the
// natural owner); commands.js re-exports it — see the export above.
/** Help text: the command list + the shortcuts + the footer legend (round 7). The
 *  keyboard shortcuts live in the HOTKEYS table — /help carries them too, so both
 *  listings document the same keys (round 10). */
export function helpLines() {
  const rows = COMMANDS.map((c) => `${c.usage.padEnd(14)} ${c.describe}`);
  return [
    "commands (pi's set evaluated → the subset that applies to this harness):",
    ...rows,
    ...extensionCommandsList().map((c) => `${("/" + c.name).padEnd(14)} ${c.description}`), // ROUND 20: the autoloaded extension commands, after the builtins (pi's /help lists extension commands too)
    "",
    ...hotkeysLines(),
    "",
    `skills live in ${userSkillsDir()} (a skill = one <dir>/SKILL.md there — YAML header name + description)`,    "footer:  ↑in ↓out ctx <used>/<max> <model> ⚡ <tokens/s>  (session-cumulative)",
  ];
}

export function hotkeysLines() {
  return ["keyboard shortcuts:", ...HOTKEYS.map(([k, d]) => `${k.padEnd(14)} ${d}`)];
}

/** PI'S SLASH-MENU ITEMS — the ONE source of the `/` autocomplete (the chart's
 *  dialog band AND the line-mode print render from it): pi's
 *  CombinedAutocompleteProvider command set (pi-tui dist/autocomplete.js:206-232)
 *  in pi's order — the builtins (names WITHOUT the leading slash: the typed "/"
 *  stays in the editor line, pi's applyCompletion re-adds it, autocomplete.js:294-301)
 *  → the autoloaded extension commands (ROUND 20) → one `skill:<name>` PER
 *  discovered skill (pi's built-in /skill:name feature, interactive-mode.js:490)
 *  → one `agents:<name>` PER discovered agent (pi's subagent extension registers
 *  exactly this prefix, index.ts:492). The discovered rows carry pi's source tag
 *  in the description ([u]ser / [p]roject — prefixAutocompleteDescription,
 *  interactive-mode.js:396-400). The COMMANDS doc rows (`menu:false` —
 *  /skill:<name>, /agents:<name>) stay OUT of the menu: pi lists real commands
 *  only — the per-skill/per-agent rows ARE the docs. The dispatch arms live in
 *  handleCommand below. PURE (no I/O): the same items in the menu and in the
 *  suite's inspection surface. */
export function slashProposalItems() {
  const items = [];
  for (const c of COMMANDS) {
    if (c.menu === false) continue; // the /skill:<name> / /agents:<name> doc rows
    items.push({ name: c.name.replace(/^\//, ""), description: c.describe });
  }
  for (const c of extensionCommandsList()) items.push({ name: c.name, description: `[u] ${c.description}` });
  for (const s of discoverSkills()) items.push({ name: `skill:${s.name}`, description: `[u] ${s.description}` });
  for (const a of discoverAgents("both").agents) items.push({ name: `agents:${a.name}`, description: `[${a.source === "project" ? "p" : "u"}] ${a.description}` });
  return items;
}

/** ROUND 18 (pi-parity rows): the slash menu as PLAIN rows — line mode / the
 *  suite's inspection surface. pi's SelectList row shape without the selection
 *  marker: the name padded to the primary column (pi's
 *  SLASH_COMMAND_SELECT_LIST_LAYOUT min of 12, editor.js:165-168) + the
 *  description. */
export function slashProposalLines() {
  const items = slashProposalItems();
  const w = Math.max(12, ...items.map((i) => i.name.length));
  return items.map((i) => `${i.name.padEnd(w)} ${i.description ?? ""}`.trimEnd());
}

/** Commands registered by the autoloaded extensions (ROUND 20 — src/extensions.js,
 *  the dot-folder extensions/ dir; command names WITHOUT the leading "/"). A
 *  missing/empty extensions dir or nothing registered → one "none yet" line
 *  naming the dir, NO error (pi: nothing discovered, no failure). */
export function extensionsLines() {
  const dir = userExtensionsDir();
  const ext = extensionCommandsList();
  if (ext.length === 0) {
    return [`extensions: none yet — ${dir} does not exist or nothing registered (an extension = one <dir>/<name>.ts)`];
  }
  return [`extensions (${dir}):`, ...ext.map((e) => `  /${e.name} — ${e.description}`)];
}

/** Skills found under ~/.Observation_only/skills — ROUND 12: the REAL skill
 *  discovery (src/skills.js, pi's recursive SKILL.md walk) instead of bare dir
 *  names: one line per DISCOVERED skill with its frontmatter description (the
 *  dispatch trigger). Missing/empty skills dir → one "none yet" line naming the
 *  dir, NO error (pi: nothing discovered, no failure). Lists ALL discovered
 *  skills including disable-model-invocation ones (pi: those are loaded, just
 *  hidden from the system prompt). */
export function skillsLines() {
  const dir = userSkillsDir();
  if (!existsSync(dir)) {
    return [`skills: none yet — ${dir} does not exist (a skill = one <dir>/SKILL.md)`];
  }
  const skills = discoverSkills();
  if (skills.length === 0) return [`skills: none yet — ${dir} is empty`];
  return [`skills (${dir}):`, ...skills.map((s) => `  ${s.name} — ${s.description}`)];
}

/** Which of pi's commands apply to THIS harness, from the evaluation in the header;
 *  `rest` is the trimmed line AFTER the command name (keep words on the same line
 *  separate so `/model  some id` is the /model command). Null when the line is
 *  not a command (`turn`). Pure: writes nothing, reads nothing except the skills
 *  listing itself. Returns { action: "quit"|"new"|"turn"|"model"|"reload"
 *  |"extension"|"skill"|"agent", model?: string, lines?: string[], extension?: {name,
 *  description, handler, path}, arg?: string, skillName?: string, text?: string,
 *  agentName?: string, task?: string } — the extension action is a
 *  ROUND-20 autoloaded command (src/extensions.js) whose handler the session
 *  runs as (args, ctx).
 */
export function handleCommand(line, ctx = {}) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return { action: "turn" };
  const [name, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ").trim();
  // THE SKILL COMMAND (pi's /skill:name — agent-session.js _expandSkillCommand,
  // ported verbatim in shape): `/skill:<name> [args]` expands the skill's
  // SKILL.md body (frontmatter stripped) into the skill block that becomes the
  // TURN'S user message (the interactive session routes it through the normal
  // turn path — the model answers it, the block shows as the user prompt).
  // The prefix is pi's exact one (interactive-mode.js:490: `skill:${skill.name}`):
  // the slash menu row reads `skill:<name>`, Tab completes to `/skill:<name> `.
  if (name.startsWith("/skill:")) {
    const skillName = name.slice("/skill:".length);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) {
      return { action: "show", lines: [`skill not found: ${skillName || "(missing name)"}${skills.length ? ` — available: ${skills.map((s) => s.name).join(", ")}` : " — none discovered"}`] };
    }
    let body;
    try {
      body = parseSkillFrontmatter(readFileSync(skill.path, "utf8")).body.trim();
    } catch {
      return { action: "show", lines: [`skill not readable: ${skill.name} — ${skill.path}`] };
    }
    const skillBlock = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return { action: "skill", skillName: skill.name, text: arg ? `${skillBlock}\n\n${arg}` : skillBlock };
  }
  // THE AGENT COMMAND: `/agents:<name> [task]` — with a task the agent RUNS via
  // the subagent path (the interactive session drives createSubagentTool's
  // single-mode execute, the same path the LLM's subagent tool call takes);
  // without one the DEFINITION is shown (the dispatch stays pure — no I/O
  // beyond the listings). Unknown agent / missing name → the available list.
  // The prefix is pi's exact one — pi's subagent extension registers each
  // discovered agent as the slash command `agents:<name>` (index.ts:492), so the
  // menu row reads `agents:<name>` and Tab completes to `/agents:<name> `.
  if (name.startsWith("/agents:")) {
    const agentName = name.slice("/agents:".length);
    const { agents } = discoverAgents("both");
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
      return { action: "show", lines: [`agent not found: ${agentName || "(missing name)"}${agents.length ? ` — available: ${agents.map((a) => a.name).join(", ")}` : " — none discovered"}`] };
    }
    if (!arg) {
      return {
        action: "show",
        lines: [
          `agent ${agent.name} (${agent.source}) — ${agent.filePath}`,
          `  ${agent.description}`,
          `  tools: ${agent.tools ? agent.tools.join(", ") : "harness default"}`,
          `  run it: /agents:${agent.name} <task>`,
        ],
      };
    }
    return { action: "agent", agentName: agent.name, task: arg };
  }
  switch (name) {
    case "/help":
      return { action: "show", lines: helpLines() };
    case "/quit":
    case "/exit":
      return { action: "quit" };
    case "/new":
    case "/clear": // pi's former /clear — pi's CHANGELOG: "Renamed /clear to /new"; pi's clear IS the new-session path (handleClearCommand → runtimeHost.newSession, interactive-mode.js:5528-5542), which obs's action "new" already ports. The old name stays as an alias (obs keeps /exit → /quit the same way)
      return { action: "new" };
    case "/info":
      return {
        action: "show",
        lines: [
          `provider: ${ctx.providerId ?? "?"}`,
          `model: ${ctx.modelId ?? "?"}`,
          `work dir: ${ctx.workDir ?? "?"}`,
        ],
      };
    case "/model": // pi: with an argument → exact provider/model match → switch; NO argument → the model SELECTOR opens (the I/O belongs to the interactive session, like /resume /tree — pure dispatch here)
      return arg ? { action: "model", model: arg } : { action: "model" };
    case "/hotkeys":
      return { action: "show", lines: hotkeysLines() };
    case "/reload":
      return { action: "reload" };
    case "/skills":
      return { action: "show", lines: skillsLines() };
    case "/resume": // round 17: the picker I/O belongs to the interactive session (src/interactive.js) — pure dispatch here
      return { action: "resume" };
    case "/tree":
      return { action: "tree" };
    default:
      const ext = extensionCommand(name.slice(1)); // ROUND 20: an autoloaded extension command (src/extensions.js) — the interactive session runs its handler (args, ctx) and prints what it returns
      if (ext) return { action: "extension", extension: ext, arg };
      // ROUND 27 PIECE 3 (parity rework, critic's gap): pi's submit dispatch copied
      // verbatim — after every EXACT slash-command arm fails, the submitted text
      // falls to the MESSAGE path, NEVER an "unknown command" row:
      //   text = text.trim(); if (!text) return;              (interactive-mode.js:2413-2415)
      //   if (text === "/quit") { … await this.shutdown(); return; }  (interactive-mode.js:2552-2556)
      //   this.flushPendingBashComponents();
      //   if (this.onInputCallback) { this.onInputCallback(text); }  (interactive-mode.js:2598-2600)
      // → a slash-shaped input that matches NO command IS a message → a turn.
      return { action: "turn" };
  }
}

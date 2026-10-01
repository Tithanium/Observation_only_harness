// src/pi-shims/pi-coding-agent.mjs — the "@earendil-works/pi-coding-agent" import
// target for extension files (ROUND 21). Pi's REAL extension files import the
// package at RUNTIME: bash-to-powershell.ts needs createPowerShellToolDefinition,
// subagent/agents.ts needs CONFIG_DIR_NAME / getAgentDir / parseFrontmatter at
// load time, wsl-powershell.ts dynamically imports createLocalPowerShellOperations,
// subagent/index.ts needs getMarkdownTheme / withFileMutationQueue. The harness
// has no such package — the alias loader in loader.mjs maps the specifier HERE.
// What must work at LOAD time is implemented for real; render-only surfaces
// (themes/components) are functional stubs that never run in line mode.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter } from "../skills.js";

/** pi's config-dir name (the PACKAGE's own dot folder — pi's constant, unchanged:
 *  extensions code carries pi's value, the harness's own dot folder is
 *  .Observation_only via src/config.js). */
export const CONFIG_DIR_NAME = ".pi";

/** pi's ~/.pi/agent (agent dir under the user home). */
export function getAgentDir() {
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** pi's parseFrontmatter: the harness's exact port (src/skills.js parseSkillFrontmatter
 *  — same split, same yaml@2.9.0 parser) — subagent/agents.ts calls it on every
 *  agent .md at load time. */
export const parseFrontmatter = parseSkillFrontmatter;

/** Serial file-mutation queue (pi's withFileMutationQueue): calls for a file run
 *  one after another on a single chain — subagent/index.ts wraps its writes. */
const mutationChain = Promise.resolve();
export function withFileMutationQueue(_filePath, callback) {
  const run = mutationChain.then(callback);
  mutationChain.catch(() => {}); // a failed mutation must never poison the queue
  return run;
}

/** pi's getMarkdownTheme — a markdown renderer's theme. Subagent/index.ts calls
 *  it inside display helpers (renderer paths that never run in line mode): a
 *  functional no-op palette is enough, it must simply EXIST and be callable. */
export function getMarkdownTheme() {
  return {
    fg: (_color, text) => text,
    apply: (_color, text) => text,
    applyWithDefault: (_color, text) => text,
    DEFAULT_COLOR: "default",
    reset: "",
  };
}

/** The PowerShell shell operations pi's PowerShell tool wraps (createLocalPowerShellOperations).
 *  Runs powershell.exe for real (bash-to-powershell.ts / wsl-powershell.ts use it
 *  at HANDLER time; wsl-powershell.ts also re-imports this module dynamically). */
export function createLocalPowerShellOperations() {
  const run = async (command, cwd, options = {}) => {
    const { onData = () => {} } = options;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const exitCode = await new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { cwd: cwd ?? process.cwd(), windowsHide: true },
      );
      child.stdout?.on("data", (d) => onData(d));
      child.stderr?.on("data", (d) => onData(d));
      child.on("error", (err) => resolve({ exitCode: 1, error: err }));
      child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
    });
    return typeof exitCode.exitCode === "number" ? exitCode : { exitCode: exitCode.exitCode ?? 1 };
  };
  return {
    /** Execute a PowerShell command (the operations pi's shell tool uses). */
    exec: run,
    readFile: async (file, cwd, options) => run(`Get-Content -Raw -LiteralPath '${String(file).replaceAll("'", "''")}'`, cwd, options),
    applyFileMutation: async (file, cwd, mutate, options = {}) => {
      const chunks = [];
      const exit = await run(`Get-Content -Raw -LiteralPath '${String(file).replaceAll("'", "''")}'`, cwd, { onData: (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) });
      if ((exit.exitCode ?? 1) !== 0) throw new Error(`read failed: ${Buffer.concat(chunks).toString("utf8")}`);
      const next = mutate(Buffer.concat(chunks).toString("utf8"));
      const encoded = Buffer.from(next, "utf16le").toString("base64");
      const out = [];
      const w = await run(`Set-Content -LiteralPath '${String(file).replaceAll("'", "''")}' -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))) -NoNewline`, cwd, { onData: (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))) });
      if ((w.exitCode ?? 1) !== 0) throw new Error(`write failed: ${Buffer.concat(out).toString("utf8")}`);
    },
  };
}

/** pi's createPowerShellToolDefinition(cwd) → the PowerShell tool's definition —
 *  the object bash-to-powershell.ts SPREADS into its own registerTool (it only
 *  overrides name/label/description/promptSnippet). The execute runs
 *  powershell.exe for real, so the harness gains a working shell tool. */
export function createPowerShellToolDefinition(cwd) {
  const Type = undefined; // kept runtime-free: parameters are plain JSON schema — the LLM declaration only needs the JSON surface
  return {
    name: "powershell",
    label: "PowerShell",
    description:
      "Execute a PowerShell command (or powershell.exe ..) with an optional timeout in seconds, and then return the output, stats, truncated output saved to a temp file when truncated.",
    promptSnippet: "Execute PowerShell commands",
    promptGuidelines: ["Write commands that work in PowerShell with no extra setup beyond the tool itself."],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        timeout: { type: "number", description: "Optional timeout in seconds" },
      },
      required: ["command"],
    },
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params, signal, _onUpdate) {
      const command = typeof params?.command === "string" ? params.command : String(params?.command ?? "");
      const encoded = Buffer.from(command, "utf16le").toString("base64");
      const chunks = [];
      let code = 1;
      let killed = false;
      const exitCode = await new Promise((resolve) => {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { cwd: cwd ?? process.cwd(), windowsHide: true },
        );
        const timer = typeof params?.timeout === "number" && params.timeout > 0 ? setTimeout(() => { killed = true; child.kill(); }, params.timeout * 1000) : null;
        child.stdout?.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
        child.stderr?.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
        child.on("error", (err) => { if (timer) clearTimeout(timer); resolve(1); });
        child.on("close", (c) => { if (timer) clearTimeout(timer); resolve(c ?? 1); });
      });
      void killed;
      code = exitCode;
      const stdout = Buffer.concat(chunks).toString("utf8");
      const full = Buffer.concat(chunks);
      const truncated = full.length > 1024 * 1024;
      const output = truncated ? full.subarray(0, 1024 * 1024).toString("utf8") : stdout;
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { output, exitCode: code, truncated },
        isError: code !== 0,
      };
    },
  };
}

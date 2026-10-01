/**
 * alan-connector — /ALAN_connector pi command (interactive model picker, /session-style)
 * Extension directory: ~/.pi/agent/extensions/alan-connector/
 *
 * Deterministic connector between the ALAN (UGA) OpenAI-compatible service and the
 * pi harness. NO LLM connection of its own: it shells out to two standalone scripts
 * that live NEXT TO this file, inside the pi extension folder:
 *
 *   alan_probe.ps1          — deterministic probe of GET {baseUrl}/models, model
 *                             selection (forced -> config match -> favorite -> first),
 *                             limits via the ctx/out alias lists (real field on Alan:
 *                             max_model_len; maxTokens fallback 32768). Writes
 *                             probe_result.json in this folder. Never prints the key.
 *   alan_config_writer.ps1  — surgical pi-config writer: backs up
 *                             ~/.pi/agent/models.json + settings.json
 *                             (.bak_yyyyMMdd_HHmmss), merges the alan provider,
 *                             validates, writes, verifies. -DryRun shows diff.
 *   config.ps1 / config.local.ps1  — probe config; config.local.ps1 holds the API key
 *                             and is git-ignored (see .gitignore next to this file).
 *
 * LAYOUT RULE: this command references files ONLY inside its own extension folder.
 * Nothing outside ~/.pi/agent/extensions/alan-connector/ is read or written except
 * pi's own config (~/.pi/agent/models.json + settings.json, the connector's purpose —
 * with .bak_* backups retained) and the interactive key input.
 *
 * OUTPUT RULE: every trace of a run is appended to alan_connector.log in this
 * folder. In TUI mode the session itself only shows ONE bracketed comment line
 * ("[alan-connector] ...") rendered under the EDITOR via ctx.ui.setWidget(
 * placement:"belowEditor") — never inside the message/prompt area (console.log
 * and ctx.ui.notify both land there). Headless modes get that same line via
 * console.log. The API key is NEVER written to the log nor printed.
 *
 * Interaction model (same UX as the /session picker):
 *   - A scrollable model picker is presented BELOW the prompt line (it temporarily
 *     replaces the editor, like the built-in selectors). Move with ↑/↓ (or j/k),
 *     Enter confirms, Esc cancels. The picker disappears as soon as a model is
 *     chosen (done()), then the write runs and control returns to the prompt.
 *   - The API key is OPTIONAL at invocation time: the probe first tries
 *     config.local.ps1. Only when the service requires a key (HTTP 401/403) is the
 *     user asked for one (via the interactive input dialog). A key passed as the
 *     single argument is forwarded verbatim to alan_probe.ps1 --apiKey <key>.
 *   - The selected model is set as DEFAULT (defaultProvider=alan, defaultModel=<id>)
 *     WITHOUT asking further questions.
 *   - HOT-APPLY (the fix for "restart needed"): pi only re-reads models.json when
 *     /model is opened, and defaultProvider/defaultModel only affect NEW sessions.
 *     So after the write this command reloads the live catalog
 *     (await ctx.modelRegistry.refresh()) and switches the CURRENT session to the
 *     picked model (pi.setModel) — the harness resumes with ALAN active, no restart.
 *
 * Arguments (args after /ALAN_connector — zero or exactly one):
 *   (none)         interactive flow: probe (key read from config.local.ps1; asked
 *                  interactively only if Alan requires one) + scrollable model picker
 *                  below the prompt (↑/↓ + Enter) + full write (set as default,
 *                  backup first) + summary in alan_connector.log + one-line result.
 *   <apiKey>       EXACTLY ONE token, a raw API key, forwarded to the probe as
 *                  alan_probe.ps1 --apiKey <key>; skips the interactive key prompt.
 *                  The key is never printed nor logged. In headless use this is the
 *                  only way to connect.
 *   (error)        more than one token, or any token starting with '-' ->
 *                  "no arguments accepted — /ALAN_connector [<apiKey>]"
 */

import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Paths — ALL inside this extension folder (import.meta.url = real file location,
// same mechanism pi-okf uses to resolve its own files).
// ─────────────────────────────────────────────────────────────────────────────
const EXT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ALAN_PROBE_PS1 = join(EXT_DIR, "alan_probe.ps1");
const ALAN_WRITER_PS1 = join(EXT_DIR, "alan_config_writer.ps1");
const PROBE_RESULT_JSON = join(EXT_DIR, "probe_result.json");
const CONNECTOR_LOG = join(EXT_DIR, "alan_connector.log");

const PS_BASE = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const PROBE_TIMEOUT_MS = 120_000; // GET /models timeout is 20 s inside the script; keep headroom
const WRITER_TIMEOUT_MS = 90_000;
const BAK_RE = /\.bak_\d{8}_\d{6}$/;
const BACKUP_CREATED_RE = /Backup created : (.+\.bak_\d{8}_\d{6})/g;

interface ProbeModel {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
}

interface ProbeResult {
  baseUrl: string;
  api: string;
  models: ProbeModel[];
  selectedModelId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging — every trace of a run goes to alan_connector.log (in this folder).
// The program only ever shows a one-line summary + notify (plus thrown errors).
// ─────────────────────────────────────────────────────────────────────────────
function logLine(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    appendFileSync(CONNECTOR_LOG, line + "\n", "utf8");
  } catch (e) {
    // Log must never break the connector; surface the failure instead.
    console.log(`[alan-connector] WARNING: cannot write log at ${CONNECTOR_LOG}: ${(e as Error).message}`);
  }
}

function logSection(title: string): void {
  logLine(`===== Session ${title} =====`);
}

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function loadProbeResult(): ProbeResult {
  if (!existsSync(PROBE_RESULT_JSON)) {
    throw new Error(
      `[alan-connector] probe result missing: ${PROBE_RESULT_JSON} ` +
        `(run the probe first: ${ALAN_PROBE_PS1})`
    );
  }
  const data = JSON.parse(readFileSync(PROBE_RESULT_JSON, "utf8")) as ProbeResult;
  if (!Array.isArray(data.models)) {
    throw new Error(`[alan-connector] ${PROBE_RESULT_JSON} has no "models" array (stale probe?).`);
  }
  return data;
}

function requireScripts(): void {
  for (const p of [ALAN_PROBE_PS1, ALAN_WRITER_PS1]) {
    if (!existsSync(p)) {
      throw new Error(`[alan-connector] script missing: ${p}`);
    }
  }
}

async function execPs(
  pi: ExtensionAPI,
  script: string,
  scriptArgs: string[],
  timeoutMs: number
): Promise<ExecResult> {
  return pi.exec("powershell.exe", [...PS_BASE, script, ...scriptArgs], { timeout: timeoutMs });
}

/** Never let a relayed line leak a key value into the connector log. */
function sanitize(text: string): string {
  return text.replace(/(apiKey\s*[:=]\s*["']?)[^\s"',}]+/g, "$1<REDACTED>");
}

function relayOutput(res: ExecResult, label: string): void {
  const out = sanitize((res.stdout ?? "").trim());
  if (out) logLine(`[${label} stdout]\n${out}`);
  const err = sanitize((res.stderr ?? "").trim());
  if (err) logLine(`[${label} stderr]\n${err}`);
}

function probeText(res: ExecResult): string {
  return ((res.stderr ?? "") + "\n" + (res.stdout ?? "")).replace(/\s+/g, " ");
}

function printBackupHashes(writerStdout: string): void {
  const bakFiles: string[] = [];
  for (const m of writerStdout.matchAll(BACKUP_CREATED_RE)) bakFiles.push(m[1]);
  if (bakFiles.length === 0) {
    logLine("backups   : (none printed by writer — nothing backed up)");
    return;
  }
  for (const f of bakFiles) {
    try {
      logLine(`backup    : ${f}`);
      logLine(`SHA256    : ${sha256Of(f)}`);
    } catch (e) {
      logLine(`SHA256    : <unreadable: ${(e as Error).message}>`);
    }
  }
}

function usage(): string {
  return [
    "/ALAN_connector [<apiKey>]",
    "",
    "  (no args)  interactive flow (TUI): probe Alan, ask for the API key ONLY if Alan",
    "             requires one, then pick a model in a scrollable list shown below the",
    "             prompt (↑/↓ navigate, Enter select, Esc cancel). The picker disappears",
    "             once a model is chosen; the model is then written as pi default",
    "             (backup first). All output goes to alan_connector.log in the",
    "             extension folder; the session shows only a one-line summary.",
    "  <apiKey>   EXACTLY ONE token: the raw API key, forwarded to the probe as",
    "             alan_probe.ps1 --apiKey <key>, skipping the interactive key prompt.",
    "             Never printed nor logged. Headless in/out-of-TUI runs use this form.",
    "  (error)    more than one token, or any token starting with '-':",
    "             \"no arguments accepted — /ALAN_connector [<apiKey>]\"",
    "",
    `  extension dir : ${EXT_DIR}`,
    `  probe  script: ${ALAN_PROBE_PS1}`,
    `  writer script: ${ALAN_WRITER_PS1}`,
    `  log          : ${CONNECTOR_LOG}`,
  ].join("\n");
}

/**
 * Scrollable model picker (same interaction as the /session picker family): a
 * compact list that temporarily replaces the editor BELOW the prompt line; ↑/↓ or
 * j/k moves, Enter confirms, Esc cancels. done(index) is called with the selected
 * model index (or undefined on cancel) — the harness then removes the picker and
 * restores the editor automatically.
 *
 * Contract per docs/tui.md: a custom component MUST return { render, invalidate,
 * handleInput } and MUST use the keybindings manager injected by ctx.ui.custom(cb)
 * (the injected one, not the ambient getKeybindings()) — calling done() is what
 * returns control to the harness.
 */
function modelPicker(
  models: ProbeModel[],
  theme: any,
  kb: KeybindingsManager,
  tui: any,
  startIndex: number,
  done: (index?: number) => void
): any {
  const MAX_VISIBLE = 10;
  let index = startIndex;
  const visibleStart = (): number =>
    models.length <= MAX_VISIBLE ? 0 : Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE / 2), models.length - MAX_VISIBLE));
  const labelOf = (m: ProbeModel): string => {
    const k = Math.round((m.contextWindow / 1024) * 10) / 10; // context in k, rounded to 1 decimal
    const ctx = Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    const base = m.name && m.name !== m.id ? `${m.name}  (${m.id})` : m.id;
    return `${base} (${ctx})`; // k suffix guarantees the label never equals the model id
  };
  return {
    render() {
      const start = visibleStart();
      const end = Math.min(models.length, start + MAX_VISIBLE);
      const lines = [theme.fg("accent", theme.bold("Select ALAN model"))];
      for (let i = start; i < end; i++) {
        const sel = i === index;
        lines.push(`${sel ? theme.fg("accent", "› ") : "  "}${sel ? theme.fg("accent", labelOf(models[i])) : theme.fg("text", labelOf(models[i]))}`);
      }
      lines.push(theme.fg("dim", `↑/↓ navigate · Enter select · Esc cancel (${models.length} model(s))`));
      return lines;
    },
    invalidate() {
      tui.requestRender();
    },
    handleInput(data: string) {
      if (kb.matches(data, "tui.select.up")) {
        index = index <= 0 ? models.length - 1 : index - 1;
      } else if (kb.matches(data, "tui.select.down")) {
        index = (index + 1) % models.length;
      } else if (kb.matches(data, "tui.select.confirm")) {
        done(index);
        return;
      } else if (kb.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }
      tui.requestRender();
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ALAN_connector", {
    description:
      "Deterministic ALAN (UGA) service <> pi connector. Probes https://alan.univ-grenoble-alpes.fr/api/models, " +
      "shows a scrollable model picker below the prompt (↑/↓ navigate, Enter select, Esc cancel — the picker " +
      "disappears once a model is chosen), then writes providers.alan into ~/.pi/agent/models.json + settings.json " +
      "(backup first, .bak_yyyyMMdd_HHmmss), sets the picked model as pi default WITHOUT asking, and HOT-APPLIES it " +
      "to the running session (live models.json reload + active-model switch — no restart). API key is " +
      "optional: the probe uses config.local.ps1 (both live in the extension folder); only when Alan requires one " +
      "does the command ask for it (or take it as the single argument). ALL output is written to " +
      "alan_connector.log in the extension folder — the session only shows a one-line summary. No subcommands " +
      "(--list/--model/--dry-run/--restore/--help deleted). Never requires an LLM; never prints the API key.",
    getArgumentCompletions: () => {
      // The only argument is a raw API key (a secret) — nothing meaningful to complete.
      return [];
    },
    handler: async (args, ctx) => {
      logSection("Session start");
      logLine(`invoked with args: ${args.trim() === "" ? "(none)" : "(apiKey token)"}`);

      const parts = args.trim().split(/\s+/).filter(Boolean);
      let apiKey: string | undefined =
        parts.length === 1 && !parts[0].startsWith("-") ? parts[0] : undefined;
      if (parts.length > 1 || (parts.length === 1 && apiKey === undefined)) {
        logLine("usage error: " + JSON.stringify(parts));
        logLine(usage());
        throw new Error("no arguments accepted — /ALAN_connector [<apiKey>]");
      }

      requireScripts();

      // 1) Probe. Key is OPTIONAL: try config.local.ps1 first; ask interactively only
      //    when Alan actually requires a key (HTTP 401/403 contract message).
      let probeArgs = apiKey !== undefined ? ["--apiKey", apiKey] : [];
      let pRes = await execPs(pi, ALAN_PROBE_PS1, probeArgs, PROBE_TIMEOUT_MS);
      relayOutput(pRes, "probe");
      if ((pRes.killed || pRes.code !== 0) && !apiKey && ctx.hasUI && /API key required/.test(probeText(pRes))) {
        logLine("Alan requires an API key — asking the user interactively (key itself is never logged).");
        const key = await ctx.ui.input("ALAN (UGA) API key", "");
        if (!key) {
          logLine("no API key provided by the user — nothing written");
          ctx.ui.notify("/ALAN_connector: no API key provided — nothing written", "warning");
          return;
        }
        apiKey = key.trim();
        pRes = await execPs(pi, ALAN_PROBE_PS1, ["--apiKey", apiKey], PROBE_TIMEOUT_MS);
        relayOutput(pRes, "probe(key)");
      }
      if (pRes.killed || pRes.code !== 0) {
        const text = probeText(pRes);
        if (/API key required/.test(text)) {
          throw new Error("API key required — paste it as the only argument: /ALAN_connector <apiKey>");
        }
        throw new Error(
          `[alan-connector] alan_probe.ps1 failed (exit ${pRes.code}${pRes.killed ? ", killed/timeout" : ""}). ` +
            `Script: ${ALAN_PROBE_PS1}. Details: ${CONNECTOR_LOG} (probe log: ${join(EXT_DIR, "alan_connector_probe.log")}).`
        );
      }
      const probe = loadProbeResult();
      if (probe.models.length === 0) {
        throw new Error(`[alan-connector] probe returned no models (${PROBE_RESULT_JSON})`);
      }

      // 2) Choose the model below the prompt (arrow keys; the picker auto-disappears once chosen).
      let modelIndex: number | undefined;
      if (ctx.hasUI && probe.models.length > 1) {
        const startIndex = Math.max(0, probe.models.findIndex((m) => m.id === probe.selectedModelId));
        modelIndex = await ctx.ui.custom<number | undefined>((tui, theme, kb, done) =>
          modelPicker(probe.models, theme, kb, tui, startIndex, done)
        );
        if (modelIndex === undefined) {
          logLine("cancelled by the user — nothing written");
          ctx.ui.notify("/ALAN_connector: cancelled — nothing written", "warning");
          return;
        }
      } else {
        modelIndex = Math.max(0, probe.models.findIndex((m) => m.id === probe.selectedModelId));
      }

      const selected = probe.models[modelIndex];
      if (!selected) {
        throw new Error(`[alan-connector] selected model index ${modelIndex} not in probe list (${PROBE_RESULT_JSON}).`);
      }
      logLine(`selected model: ${selected.id} (contextWindow=${selected.contextWindow}, maxTokens=${selected.maxTokens})`);

      // 3) Set as default WITHOUT asking: re-probe with the forced model so
      //    probe_result.json.selectedModelId = the picked id, then write.
      const forceArgs = ["--model", selected.id, ...(apiKey !== undefined ? ["--apiKey", apiKey] : [])];
      const p2 = await execPs(pi, ALAN_PROBE_PS1, forceArgs, PROBE_TIMEOUT_MS);
      relayOutput(p2, "probe(force)");
      if (p2.killed || p2.code !== 0) {
        throw new Error(
          `[alan-connector] forced probe for '${selected.id}' failed (exit ${p2.code}${p2.killed ? ", killed/timeout" : ""}). ` +
            `Script: ${ALAN_PROBE_PS1}. Details: ${CONNECTOR_LOG} (probe log: ${join(EXT_DIR, "alan_connector_probe.log")}).`
        );
      }
      const probe2 = loadProbeResult();

      const wRes = await execPs(pi, ALAN_WRITER_PS1, [], WRITER_TIMEOUT_MS);
      relayOutput(wRes, "writer");
      if (wRes.killed || wRes.code !== 0) {
        throw new Error(
          `[alan-connector] alan_config_writer.ps1 failed (exit ${wRes.code}${wRes.killed ? ", killed/timeout" : ""}). ` +
            `Script: ${ALAN_WRITER_PS1}. Config was backed up first (restore manually from the .bak pair). ` +
            `Details: ${CONNECTOR_LOG} (writer log: ${join(EXT_DIR, "alan_config_writer.log")}).`
        );
      }

      printBackupHashes(wRes.stdout);

      // 4) HOT-APPLY to the running session — the fix for "must restart pi".
      //    pi re-reads models.json only when /model is opened, and
      //    defaultProvider/defaultModel only apply to NEW sessions. Reload the
      //    live catalog now and switch the CURRENT session to the picked model so
      //    the harness comes back usable immediately. Non-fatal: the config write
      //    already happened; worst case the user opens /model.
      let applied = false;
      try {
        await ctx.modelRegistry.refresh();
        const live = ctx.modelRegistry.find("alan", probe2.selectedModelId);
        if (live) {
          applied = await pi.setModel(live);
          logLine(
            applied
              ? `hot-apply: session switched to alan/${probe2.selectedModelId} — no restart needed`
              : `hot-apply: alan/${probe2.selectedModelId} in the live catalog but not selectable (auth not resolved?)`
          );
        } else {
          logLine(`hot-apply: alan/${probe2.selectedModelId} not found in the live catalog after refresh`);
        }
      } catch (e) {
        logLine(`hot-apply failed (non-fatal, config already written — open /model): ${(e as Error).message}`);
      }

      logLine(
        `summary: providers.alan written with ${probe2.models.length} model(s), ` +
          `defaultProvider=alan, defaultModel=${probe2.selectedModelId}` +
          (applied ? " — active in the current session (no restart)" : " — open /model to activate")
      );
      logLine(`logs: ${join(EXT_DIR, "alan_connector_probe.log")} and ${join(EXT_DIR, "alan_config_writer.log")}`);
      const resultLine = `[alan-connector] ${applied ? `ALAN active: ${probe2.selectedModelId} — no restart needed` : `ALAN config written: ${probe2.selectedModelId} — open /model to select`}`;
      logLine(`${resultLine} — full output: ${CONNECTOR_LOG}`);
      logLine("Session end — done.");
      if (ctx.hasUI) {
        // "Comment below the footer": a widget line UNDER the editor, never inside
        // the message/prompt area (console.log and ctx.ui.notify both land there).
        // Replaced on the next /ALAN_connector run.
        ctx.ui.setWidget("alan-connector", [`${resultLine} — full output in alan_connector.log`], {
          placement: "belowEditor",
        });
      } else {
        console.log(`${resultLine}. Full output: ${CONNECTOR_LOG}`);
      }
    },
  });
}

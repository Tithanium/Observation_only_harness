// src/extensions.js
// Round 20 → ROUND 21: extension autoloading — the dot-folder's extensions/ dir,
// pi's ~/.pi/agent/extensions kind (dist/core/extensions/loader.js), so that PI'S
// OWN REAL extension files load and run UNCHANGED through this harness's loader.
// Discovered = top-level *.ts/*.js FILES plus subdirs with index.ts/index.js
// (pi's discoverExtensionsInDir, minus the package.json "pi.extensions" manifest
// rule that only serves installed pi packages — a flow the harness does not run).
// One carve-out: *.mjs is EXCLUDED on purpose — pi's own extensions dir carries
// validate-verified-facts.mjs whose top level runs `process.exit(1/0/2)`
// (verified on this machine: importing it force-exits the host with code 1); the
// harness must survive loading the pi dir. TypeScript is loaded NATIVELY — Node
// ≥ 22.19 strips types (the dev node is 24.x): no jiti, no build step, extension
// files must use ERASABLE syntax (no enums/namespaces/parameter properties).
//
// ROUND 21 extension API (pi's loader.js ExtensionAPI, COMMANDS + TOOLS + EVENTS):
//   registerCommand(name, options)     → commands (name WITHOUT the leading "/")
//   registerTool(tool)                 → LLM-callable tools merged into the session
//   on(event, handler)                 → socket-style event subscription
//   exec(cmd, args, options)           → child process, { stdout, stderr, code, killed }
//   sendUserMessage(text, options)     → a user message for the running session
//   sendMessage(message, options)      → a full message object (same queue)
// plus the harne's OWN additions reachable by real pi files: the loader relies on
//   ui.notify (handler ctx) and the "clear report" semantics of /reload.
//
// Two pi-faithful load semantics:
//  * STAGED COMMIT — each file registers into a per-file staging area; only a
//    file whose factory returns successfully is committed (commands AND tools);
//    a mid-factory throw leaves NOTHING half-registered (pi's per-file commit);
//  * CACHE-BUST — every load runs FRESH module copies (module URL key carries a
//    per-load nonce → the unavoidable pi port of clearExtensionCache, invoked by
//    /reload). Stale first-import code never survives a reload.
// Events are committed per-load as well: the previous load's handlers are
// replaced by this load's (a reload re-subscribes, never stacks). Never prints
// secrets.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import { userDotDir } from "./config.js";
import { COLOR, MD_CODE } from "./pi_output.js"; // ROUND 24: the ctx.ui theme shim — pi's palette strings for the belowEditor component/widget bands

/** A pi extension ENTRY FILE name (pi's isExtensionFile). ".mjs" is deliberately
 *  NOT matched: pi's own extensions dir holds validate-verified-facts.mjs whose
 *  top-level `process.exit(...)` would force-exit this harness mid-load. */
function isExtensionFile(name) {
  return (name.endsWith(".ts") || name.endsWith(".js")) && !name.endsWith(".mjs");
}

/** The extensions dir at the harness dot-folder — ~/.Observation_only/extensions
 *  (pi's ~/.pi/agent/extensions kind); env override OBSERVATION_ONLY_DIR
 *  honoured at CALL time, like userDotDir. */
export function userExtensionsDir() {
  return join(userDotDir(), "extensions");
}

/** Discover extension entry points under <dir> the way pi's loader does
 *  (discoverExtensionsInDir + resolveExtensionEntries minus the package.json
 *  "pi.extensions" manifest): top-level *.ts/*.js FILES (never *.mjs — see
 *  isExtensionFile), then first-level SUBDIRECTORIES holding an index.ts /
 *  index.js. Missing/unreadable dir → [] (no error, like pi). Returns absolute
 *  paths in readdir order. */
export function discoverExtensions(dir = userExtensionsDir()) {
  if (!existsSync(dir)) return [];
  const discovered = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        for (const indexName of ["index.ts", "index.js"]) {
          const indexPath = join(entryPath, indexName);
          if (existsSync(indexPath)) {
            discovered.push(indexPath);
            break;
          }
        }
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

/** The extension registry (committed at the end of loadExtensions): command name
 *  WITHOUT the leading "/" → the registration record
 *  { name, description, handler, path }. */
const extensionCommands = new Map();
/** Tool registry: tool name → { name, label, description, promptSnippet,
 *  parameters, execute, path } (pi's registerTool — merged into the session's
 *  LLM tool list by src/session.js). */
const extensionTools = new Map();
/** Event bus: event name → Set<handler> — the CURRENT load's subscriptions only
 *  (a reload replaces the whole bus, like pi's /reload re-subscribes fresh). */
const extensionEventHandlers = new Map();
/** Messages queued by sendUserMessage / sendMessage — drained by the session
 *  after a handler runs (pi delivers them to the running session's transcript). */
const pendingSends = [];
let loadedFromDir = null;

/** A fresh-load nonce: appended to the module URL key of every extension import
 *  so each load runs a FRESH copy of the module (pi's clearExtensionCache —
 *  /reload must re-run the LATEST file code, never the stale first import). */
let loadNonce = 0;
let shimLoaderRegistered = false;

/** The commands registered by the loaded extensions, in registration order —
 *  { name (WITHOUT the "/"), description, handler, path }. */
export function extensionCommandsList() {
  return Array.from(extensionCommands.values()).map((c) => ({ ...c }));
}

/** The registered extension command for <name> (WITHOUT the leading "/"), or
 *  undefined — the dispatch route for handleCommand's default branch. */
export function extensionCommand(name) {
  return extensionCommands.get(name) ? { ...extensionCommands.get(name) } : undefined;
}

/** The tools the loaded extensions registered (pi's registerTool), in
 *  registration order — merged into buildHarnessTools for the LLM by session.js. */
export function extensionToolsList() {
  return Array.from(extensionTools.values()).map((t) => ({ ...t }));
}

/** Message-renderer names the loaded extensions registered (pi's
 *  registerMessageRenderer — subagent/index.ts registers "agent-command-result").
 *  Line mode renders text directly, so the renderer FUNCTIONS are validated and
 *  staged/committed but never invoked; the names prove the call survived. */
const extensionRenderers = new Map();
export function extensionMessageRenderersList() {
  return Array.from(extensionRenderers.keys());
}

/** The directory the current registry was loaded from (null before the first
 *  load — the "none yet" rendering says so). */
export function extensionsLoadedFrom() {
  return loadedFromDir;
}

/** Queued user messages/sends from extension handlers, in order —
 *  { kind: "sendUserMessage"|"sendMessage", content, message, options, path }. */
export function extensionPendingSends() {
  return pendingSends.map((s) => ({ ...s }));
}

/** Drain (take-and-clear) the queued extension sends — the interactive session
 *  calls this after each extension-handler run. */
export function drainExtensionPendingSends() {
  return pendingSends.splice(0).map((s) => ({ ...s }));
}

/** Drop all registered extension commands, tools, events and queued sends (a
 *  fresh load replaces the registry, like pi's /reload). */
export function clearExtensionRegistry() {
  extensionCommands.clear();
  extensionTools.clear();
  extensionEventHandlers.clear();
  pendingSends.length = 0;
  loadedFromDir = null;
}

/** pi's clearExtensionCache, unavoidable port: the NEXT loadExtensions() imports
 *  FRESH copies of every extension module (its URL key carries a new nonce).
 *  /reload calls both this and loadExtensions(). */
export function clearExtensionCache() {
  loadNonce += 1;
}

/** Emit an extension event into the current load's bus (client.js fires
 *  message_start / message_update / message_end; extensions subscribe with
 *  pi.on — token-rate.ts). A throwing handler is isolated, never fatal. */
export function emitExtensionEvent(event, payload) {
  for (const handler of [...(extensionEventHandlers.get(event) ?? [])]) {
    try {
      handler(payload);
    } catch (error) {
      console.warn(`extension event handler '${event}' threw: ${error?.message ?? error}`);
    }
  }
}

/** How many handlers the current load has for <event> (0 when none) — lets the
 *  round suites assert that pi.on subscriptions made it through the staged
 *  commit. */
export function extensionEventListeners(event) {
  return extensionEventHandlers.get(event)?.size ?? 0;
}

/** The extension-statuses store (pi's footer-data-provider.js:139-146,
 *  verbatim semantics): key → text, cleared (the key deleted) on undefined.
 *  The interactive ctx.ui surface routes into it; the headless surface stays a
 *  no-op. The footer's line 3 renders whatever is here (renderFooter's
 *  `statuses`, pi's footer.js:213-221). */
const extensionStatuses = new Map();
export function setExtensionStatus(key, text) {
  if (text === undefined) {
    extensionStatuses.delete(key);
  } else {
    extensionStatuses.set(key, text);
  }
}
export function getExtensionStatuses() {
  return extensionStatuses;
}

/** The UI surface handed to extension HANDLERS (pi's ctx.ui — git_it.ts and
 *  alan-connector.ts call ctx.ui.notify; alan-connector.ts ALSO calls
 *  ctx.ui.input / ctx.ui.custom / ctx.ui.setWidget). WITH NO surface (headless /
 *  deterministic line mode → ctx.hasUI:false) every method is a safe no-op — the
 *  line mode prints the handler's RETURN value instead (pi's headless modes get
 *  console.log; the connector's picker and belowEditor widget are TUI-only).
 *  WITH the interactive surface (the chart → ctx.hasUI:true) the pi behaviors
 *  are implemented exactly:
 *   - ctx.ui.custom(cb) — a TUI component (factory (tui, theme, kb, done) →
 *     { render, invalidate, handleInput }) rendered in the chart's DIALOG BAND
 *     (the same belowEditor rows alan-connector's model picker uses; ↑/↓ move,
 *     Enter confirms, Esc/Ctrl+C cancels → undefined);
 *   - ctx.ui.setWidget(id, lines, { placement: "belowEditor" }) — keeps a
 *     persistent line UNDER THE EDITOR afterwards (alan-connector parks its
 *     run's one-line summary THERE — the summary's LOCALISATION under the
 *     editor, replaced on the next /ALAN_connector run, never inside the
 *     message area — via the same dialog band);
 *   - ctx.ui.input(title, def) — an under-editor line read (alan-connector's
 *     API-key prompt when Alan requires one).
 * Never prints secrets. */
export function extensionHandlerUi(surface = null) {
  if (!surface) {
    return { notify() {}, setStatus() {}, setWorkingMessage() {}, renderMarkdown() {} };
  }
  const theme = {
    fg(color, text) {
      const code = color === "accent" ? MD_CODE : COLOR[color] ?? ""; // pi's theme.fg — accent/mdCode teal, text/dim from the pi palette
      const s = String(text ?? "");
      return code ? `${code}${s}${COLOR.fgReset}` : s;
    },
    bold(text) {
      return `\x1b[1m${String(text ?? "")}\x1b[22m`;
    },
  };
  const kb = {
    matches(data, binding) {
      // pi's KeybindingsManager.matches(data, id): the SELECTION bindings map the
      // pi-tui data strings (tui.select.up → "\x1b[A", confirm → "\r", cancel →
      // "\x1b") — the same data the harness's key-driven pickers forward.
      return Array.isArray(EXT_SELECTION_KEY_DATA[binding]) && EXT_SELECTION_KEY_DATA[binding].includes(data);
    },
  };
  /** Translate a readline keypress (str, key) into the pi-tui data string the
   *  component's handleInput expects (pi-tui keys.js data: "\x1b[A" up,
   *  "\x1b[B" down, "\x1b[5~" pageUp, "\x1b[6~" pageDown, "\r" enter,
   *  "\x1b" escape, bare chars as typed). */
  const keyData = (str, key) => {
    if (str === "\r" || str === "\n" || key?.name === "return") return "\r";
    if (key?.name === "up" || str === "\x1b[A" || str === "\x1bOA") return "\x1b[A";
    if (key?.name === "down" || str === "\x1b[B" || str === "\x1bOB") return "\x1b[B";
    if (key?.name === "pageup" || str === "\x1b[5~") return "\x1b[5~";
    if (key?.name === "pagedown" || str === "\x1b[6~") return "\x1b[6~";
    if (key?.name === "escape") return "\x1b";
    if (typeof str === "string" && str.length > 0) return str;
    return key?.name ?? "";
  };
  return {
    notify() {},
    setStatus: (key, text) => setExtensionStatus(key, text), // pi's ctx.ui.setStatus → the footer's extension-statuses line (footer-data-provider.js:139-146)
    setWorkingMessage() {},
    renderMarkdown() {},
    /** pi: ctx.ui.input(title, default) — the interactive text input (the ALAN
     *  API-key prompt). The prompt rides the belowEditor band, the answer is the
     *  next read line. */
    input: (title, def) => (typeof surface.ask === "function" ? surface.ask(String(title ?? ""), String(def ?? "")) : Promise.resolve(String(def ?? ""))),
    /** pi: ctx.ui.custom(cb) — a component factory rendered under the editor
     *  (the dialog band); resolves with done(value), undefined on cancel. */
    custom: (cb) => runExtensionCustom(surface, cb, { theme, kb, keyData }),
    /** pi: ctx.ui.setWidget(id, lines, { placement }) — the id's lines stay under
     *  the editor (belowEditor) until the next setWidget(id) — the summary's
     *  LOCALISATION afterward, replaced on the next run, never in the transcript. */
    setWidget: (id, lines, options = {}) => {
      if (typeof surface.setWidget === "function") surface.setWidget(id, lines, options);
    },
  };
}

/** The pi-tui SELECTION key data the shim kb.matches() interprets (pi-tui
 *  keys.js — the data strings for up/down/pageUp/pageDown/confirm/cancel). */
const EXT_SELECTION_KEY_DATA = {
  "tui.select.up": ["\x1b[A"],
  "tui.select.down": ["\x1b[B"],
  "tui.select.pageUp": ["\x1b[5~"],
  "tui.select.pageDown": ["\x1b[6~"],
  "tui.select.confirm": ["\r"],
  "tui.select.cancel": ["\x1b"],
};

/** ctx.ui.custom driver (pi's ExtensionUI.custom — a TUI component rendered in
 *  the belowEditor band; the component OWNS the keys while open — ↑/↓/Enter/Esc
 *  through ITS handleInput, the session's picker latch steps the reader chain
 *  aside, Esc/Ctrl+C cancels → undefined). Keeps the TUI contract: the factory
 *  gets (tui, theme, kb, done) and returns { render, invalidate, handleInput };
 *  the render() lines land in the DIALOG BAND under the editor and the band
 *  closes the moment done() runs (pi: "the picker disappears as soon as a model
 *  is chosen, then the write runs and control returns to the prompt"). */
function runExtensionCustom(surface, cb, shims) {
  const { screen, input, out } = surface;
  return new Promise((resolve) => {
    let settled = false;
    let component = null;
    const release = () => {
      try {
        input.removeListener?.("keypress", on);
      } catch {
        /* a closed stream must never take a turn down */
      }
      try {
        surface.releasePicker?.();
      } catch {
        /* idempotent */
      }
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      release();
      if (screen) screen.setDialog(null); // the picker disappears the moment done() runs — the band re-opens for the summary via setWidget immediately after
      resolve(value);
    };
    const render = () => {
      if (settled) return;
      try {
        const lines = typeof component?.render === "function" ? component.render(surface.cols?.() ?? 80) : [];
        if (screen) screen.setDialog(Array.isArray(lines) ? lines.map((l) => String(l)) : []);
        else if (Array.isArray(lines)) for (const l of lines) out(String(l));
      } catch {
        done(undefined);
      }
    };
    const tui = { requestRender: render };
    const on = (str, key) => {
      if (settled) return;
      try {
        component?.handleInput?.(shims.keyData(str, key));
      } catch {
        done(undefined);
      }
    };
    surface.claimPicker?.(done); // the session's picker slot owns the keys while open (same latch + Ctrl+C/Esc cancel as /resume /tree)
    try {
      component = cb(tui, shims.theme, shims.kb, done);
    } catch {
      done(undefined);
      return;
    }
    if (typeof component?.handleInput !== "function") {
      done(undefined);
      return;
    }
    input.on("keypress", on);
    render();
  });
}

/** The pi.exec implementation (alan-connector.ts calls
 *  `pi.exec(cmd, args, { timeout })` and reads { stdout, stderr, code, killed }):
 *  a real child process, killed on timeout, never marked async-blocking. */
function execExtensionCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = typeof options.timeout === "number" && options.timeout > 0
        ? setTimeout(() => { killed = true; child.kill(); }, options.timeout)
        : null;
      const settle = (done) => {
        if (timer) clearTimeout(timer);
        done();
      };
      child.stdout?.on("data", (d) => { stdout += d; });
      child.stderr?.on("data", (d) => { stderr += d; });
      child.on("error", (err) => settle(() => resolve({ stdout, stderr: stderr || err?.message || String(err), code: -1, killed })));
      child.on("close", () => settle(() => resolve({ stdout, stderr, code: child.exitCode ?? -1, killed })));
      options.signal?.addEventListener?.("abort", () => { killed = true; child.kill(); }, { once: true });
    } catch (error) {
      resolve({ stdout: "", stderr: error?.message || String(error), code: -1, killed: false });
    }
  });
}

/** Load every discovered extension under <dir>: for each file a dynamic import
 *  ((Node's native type stripping runs .ts directly), then its DEFAULT EXPORT —
 *  a factory called with the per-file extension API. Registration is STAGED per
 *  file: only a file whose factory returns successfully is committed (pi's
 *  per-file loadExtension commit — a mid-factory throw leaves nothing
 *  half-registered, and one failing extension does not stop the others). The
 *  import URL key carries a per-load nonce → every load re-runs the LATEST file
 *  code (pi's clearExtensionCache; the /reload path relies on it). Returns the
 *  freshly registered commands as extensionCommandsList(). */
export async function loadExtensions(dir = userExtensionsDir()) {
  ensureShimLoader();
  clearExtensionCache(); // fresh module copies per load (see pi/cache-bust contract)
  const replacements = { commands: new Map(), tools: new Map(), events: new Map(), renderers: new Map() };
  for (const filePath of discoverExtensions(dir)) {
    const staged = { commands: new Map(), tools: new Map(), events: [], renderers: [] };
    const api = {
      /** Register a command (pi's registerCommand): name WITHOUT the leading
       *  "/"; options { description, handler(args, ctx), getArgumentCompletions? }
       *  — the handler receives the text AFTER the command name and the
       *  interactive context (ctx.ui included), and may return a string (or
       *  string[]) that the session prints. */
      registerCommand(name, options) {
        if (typeof name !== "string" || name === "" || typeof options?.handler !== "function") {
          console.warn(`extension registration skipped for ${filePath}: registerCommand needs a name + a handler function`);
          return;
        }
        staged.commands.set(name, {
          name,
          description: typeof options.description === "string" ? options.description : "",
          handler: options.handler,
          getArgumentCompletions: typeof options.getArgumentCompletions === "function" ? options.getArgumentCompletions : undefined,
          path: filePath,
        });
      },
      /** Register an LLM-callable tool (pi's registerTool): { name, label,
       *  description, promptSnippet?, promptGuidelines?, parameters?, execute } —
       *  merged into the session tools by src/session.js, so extensions can
       *  hand the model real capabilities (bash-to-powershell.ts's shell tool). */
      registerTool(tool) {
        if (!tool || typeof tool.name !== "string" || typeof tool?.execute !== "function") {
          console.warn(`extension registration skipped for ${filePath}: registerTool needs a name + an execute function`);
          return;
        }
        staged.tools.set(tool.name, { ...tool, path: filePath });
      },
      /** Accept a message renderer registration (pi's registerMessageRenderer —
       *  subagent/index.ts calls it at factory time with a type-parameterized
       *  name). Line mode never renders custom components: the name is validated
       *  and committed, the function is only ever called by pi's own TUI. */
      registerMessageRenderer(name, renderer) {
        if (typeof name !== "string" || name === "" || typeof renderer !== "function") {
          console.warn(`extension registration skipped for ${filePath}: registerMessageRenderer needs a name + a renderer function`);
          return;
        }
        staged.renderers.push(name);
      },
      /** Subscribe to an extension event (pi's on — token-rate.ts watches
       *  message_start/message_update/message_end). Handlers are committed with
       *  this load and REPLACED by the next load's — a reload never stacks. */
      on(event, handler) {
        if (typeof event !== "string" || typeof handler !== "function") return () => {};
        staged.events.push([event, handler]);
        return () => {
          const live = extensionEventHandlers.get(event);
          if (live) live.delete(handler);
        };
      },
      /** Execute a command: { stdout, stderr, code, killed } (alan-connector.ts
       *  checks stdout/stderr/exit code and kills on its timeout). */
      exec: execExtensionCommand,
      /** Queue a user TEXT message for the running session (git_it.ts calls
         `pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })`). */
      sendUserMessage(content, options) {
        pendingSends.push({ kind: "sendUserMessage", content, options: options ?? {}, path: filePath });
      },
      /** Queue a full message object (pi's sendMessage — subagent/index.ts calls
       *  it from handlers to deliver its own answer). */
      sendMessage(message, options) {
        pendingSends.push({ kind: "sendMessage", message, options: options ?? {}, path: filePath });
      },
    };
    let module;
    try {
      module = await import(`${pathToFileURL(filePath).href}?obsreload=${loadNonce}`);
    } catch (error) {
      console.warn(`extension skipped — failed to import ${filePath}: ${error?.message ?? error}`);
      continue;
    }
    const factory = module?.default;
    if (typeof factory !== "function") {
      console.warn(`extension skipped — does not export a valid factory function: ${filePath}`); // pi's exact check + wording
      continue;
    }
    try {
      await factory(api);
    } catch (error) {
      console.warn(`extension failed to load — ${filePath}: ${error?.message ?? error}`);
      continue;
    }
    // COMMIT: only a fully-successful factory lands — commands, tools AND events
    for (const [name, record] of staged.commands) replacements.commands.set(name, record);
    for (const [name, tool] of staged.tools) replacements.tools.set(name, tool);
    for (const [event, handler] of staged.events) {
      if (!replacements.events.has(event)) replacements.events.set(event, new Set());
      replacements.events.get(event).add(handler);
    }
    for (const name of staged.renderers) replacements.renderers.set(name, filePath);
  }
  // SWAP: the committed registry becomes the live one atomically
  extensionCommands.clear();
  for (const [name, record] of replacements.commands) extensionCommands.set(name, record);
  extensionTools.clear();
  for (const [name, tool] of replacements.tools) extensionTools.set(name, tool);
  extensionEventHandlers.clear();
  for (const [event, handlers] of replacements.events) extensionEventHandlers.set(event, handlers);
  extensionRenderers.clear();
  for (const [name, fromPath] of replacements.renderers) extensionRenderers.set(name, fromPath);
  pendingSends.length = 0;
  loadedFromDir = dir;
  return extensionCommandsList();
}

/** Register the @earendil-works/pi-* + typebox alias hook ONCE (ROUND 21 — see
 *  src/pi-shims/loader.mjs). register() needs Node ≥ 22.19; on an older node the
 *  harness keeps working with a warning and extensions that import pi packages
 *  fail with the usual MODULE_NOT_FOUND. */
function ensureShimLoader() {
  if (shimLoaderRegistered) return;
  shimLoaderRegistered = true;
  try {
    register(new URL("./pi-shims/loader.mjs", import.meta.url));
  } catch (error) {
    console.warn(`pi-package alias loader unavailable (node >= 22.19 required): ${error?.message ?? error}`);
  }
}

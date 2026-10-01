/**
 * git_it — deterministic pi-harness backup extension for the pi coding agent (pi v0.86.x).
 *
 * /git_it captures the pi harness into a self-managed git repo:
 *   enumerate scopes -> redact models.json -> hygiene gates G1..G6 (piece1 spec,
 *   encoded below as constants; piece1.md is NEVER read at runtime) -> copy ->
 *   write README + manifest.json + manifest.sha256 -> git commit with a
 *   deterministic timestamped message -> report. No model in the loop.
 *   Never pushes: no remote is assumed; the report explains how to add a private one.
 *
 * Representation rules (capture manifest, this machine, pi 0.86.1):
 *   - Scope G = ~/.pi/agent (recursed: extensions/ skills/ prompts/ themes/
 *     backup-wsl-powershell-hook/; explicit: settings.json AGENTS.md models.json
 *     models.json.example SAFE_LAUNCH.md .gitignore keybindings.json SYSTEM.md
 *     APPEND_SYSTEM.md).
 *   - Scope P = reachable .pi/ dirs walking up from the pi cwd, EXCLUDING the
 *     home-scope stray ~/.pi (piece1 Â§3: all of it is exclude material).
 *   - Tree-wide excludes: auth.json trust.json models-store.json crashes.json
 *     VERIFIED_FACTS* verified_facts* PROGRESS.md progress.md
 *     map_folder.md sessions/ npm/ bin/ disabled-extensions/ .git/ *.log *.tmp
 *     *.bak(*), except the allow-listed
 *     backup-wsl-powershell-hook/settings.json.bak (piece1 Â§2 explicit INCLUDE),
 *     and except prompts/goal.md — piece1 Â§2 requires the goal skill's PROMPT
 *     TEMPLATE packed (the BANNED goal.md is the workspace process doc, which
 *     lives at workspace ROOTS and is never in scope);
 *     backup-wsl-powershell-hook/settings.json.bak (piece1 Â§2 explicit INCLUDE).
 *   - models.json AND models.json.example are copied REDACTED (round-3: the .example
 *     template carries a live-shaped sk-… sample value that must not ship): every
 *     apiKey-family value is replaced by a fixed sentinel; that redaction is the
 *     ONLY lawful source-vs-staged difference and is recorded in manifest.json
 *     redactionRegistry.
 *   - G6 drift: on-disk extensions/*.ts and agents/*.md sets (fresh sorted
 *     read-only listings, noise-filtered) must equal the constants below, both
 *     directions, else hard-fail with a printed diff.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Capture-manifest constants (piece1.md encoded VERBATIM; never read at runtime)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); // Scope G
const DEFAULT_REPO_DIR = path.join(os.homedir(), "pi-harness-backup");
const BACKUP_SUBDIR = "pi-agent"; // capture-tree layout inside the repo
const PROJECT_SUBDIR = "projects"; // project scopes land under projects/<parent>/.pi/...
const REDACTION_SENTINEL = "__GIT_IT_REDACTED__";

/** G6 expected sets — the ONLY allowed picture for these tracked artifact types. */
const EXPECTED_EXTENSIONS_TS = [
  "alan-connector.ts",
  "bash-to-powershell.ts",
  "clear-command.ts",
  "git_it.ts", // the backup tool itself installs into extensions/ and is packed too
  "token-rate.ts",
  "wsl-powershell.ts",
];
const EXPECTED_AGENTS_MD = [
  "ANSYS.md",
  "coder.md",
  "FEDOO.md",
  "injection-screen.md",
  // map_folder.md is a NON-harness template doc (goal-workbench narrative, not a
  // harness agent); FILE_SKIP's name-based rule therefore refuses to pack it, and
  // this expected set now AGREES with that skip (round-2 gap 3 — pack and G6
  // describe the same world).
  "ps.md",
  "researcher.md",
  "reviewer.md",
  "shell.md",
  "sum.md",
];

/** Directory names excluded tree-wide (never packed, never staged). */
const DIR_SKIP = new Set([".git", "sessions", "npm", "bin", "disabled-extensions"]);
/** File names excluded tree-wide (piece1 Â§3 noise + machine-state files). The one
 *  carve-out is prompts/goal.md — piece1 Â§2 INCLUDE (the goal skill prompt
 *  template); the banned goal.md/PROGRESS.md/progress.md are workspace-root
 *  process docs, never in scope. */
const FILE_SKIP = new Set([
  "auth.json",
  "trust.json",
  "models-store.json",
  "goal.md",
  "PROGRESS.md",
  "progress.md",
  "crashes.json",
  "map_folder.md",
]);
/** "verified_facts*" / "VERIFIED_FACTS*" file names (case-sensitive prefixes). */
const FILE_VERIFIED_RE = /^(VERIFIED_FACTS|verified_facts)/;
/** *.log / *.tmp. */
const FILE_SUFFIX_RE = /\.(log|tmp)$/;
/** *.bak / *.bak_* anywhere — with a single explicit allow-list entry. */
const BAK_RE = /\.bak/;
const ALLOWED_BAK = "backup-wsl-powershell-hook/settings.json.bak"; // piece1 Â§2 INCLUDE

/** Petri-dish belt+braces for models.json (round-2 gap 2): run FORBIDDEN_TOKENS
 *  over the SOURCE text with the lawful redaction ALREADY applied and the two
 *  lawful key-name forms masked out. Any token that survives is a leak the
 *  redaction-diff would NEVER flag — a hard fail (G1). Names are assembled from
 *  parts so this file's own packed bytes stay clean for its own G1 self-scan. */
function modelsRawTokenHits(srcText: string): string[] {
  const QU = '"';
  const scanned = JSON.stringify(blankApiKeyLeaves(JSON.parse(srcText)), null, 2)
    .replaceAll(QU + "api" + "Key" + QU, QU + "K" + QU)
    .replaceAll(QU + "api" + "_key" + QU, QU + "K" + QU);
  return FORBIDDEN_TOKENS.filter((tok) => scanned.includes(tok));
}

/** G1 value-context scan for non-models* files (round-3): piece1 Â§5 names like
 *  "Authorization" / "Bearer " / api_key are NOT secrets when they are doc
 *  prose or <placeholder>/$variable template text (e.g. ALAN/SKILL.md). A real
 *  leak has a VALUE SHAPE after the name — sk-… / JWT eyJ… / Google AIza….
 *  Returns the leak CLASSES found (never the bytes). The sentinel, <angle>
 *  placeholders, $vars and assembled name forms are stripped before scanning. */
function fileTokenLeakHits(text: string): string[] {
  const t = text
    .replace(/\$[A-Za-z_][A-Za-z0-9_.]*/g, "")
    .replace(/<[^>\r\n]{0,80}>/g, "")
    .replace(/["']api["']\s*\+\s*["'][A-Za-z_][A-Za-z0-9_]*["']/gi, "")
    .replace(/["']api["']\s*\+\s*["']_?key["']/gi, "")
    .replace(REDACTION_SENTINEL, "");
  const hits: string[] = [];
  if (/sk-(?:[A-Za-z0-9_\-]{6,})/.test(t)) hits.push("sk-… value");
  if (/Bearer\s+[A-Za-z0-9_.\-]{12,}/.test(t)) hits.push("Bearer + long token");
  if (/eyJ[A-Za-z0-9_\-]{10,}/.test(t)) hits.push("JWT value");
  if (/AIza[A-Za-z0-9_\-]{15,}/.test(t)) hits.push("Google key value");
  return hits;
}

/** Piece1 Â§5 secret tokens — ASSEMBLED from parts so this file's own bytes (and
 *  the packed tree, which contains this file) stay clean when G1 scans them. */
const FORBIDDEN_TOKENS: string[] = [
  ["sk", "-"].join(""),
  ["Bearer", " "].join(""),
  ['"', "api", "Key", '"'].join(""),
  ["api", "_key"].join(""),
  ["Author", "ization"].join(""),
  ["OPENAI", "_API", "_KEY"].join(""),
  ["ANTHROPIC", "_API", "_KEY"].join(""),
  ["api", "-key:"].join(""),
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// INSTRUCTIONS_TEXT — FINAL (piece 3; the piece-4 build appended the (e) --github
// block below). Keep this marker name and the
// __PI_INSTALL_COMMANDS__ / __REPO_PATH__ placeholders stable. __REPO_PATH__ is
// replaced at runtime by the repo dir; the __PI_INSTALL_COMMANDS__ block is
// filled at capture time from the settings.json packages[] array (never
// hardcoded — the exact `pi install` lines).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const INSTRUCTIONS_TEXT = `INSTRUCTIONS — pi harness backup (auto-generated by /git_it; no LLM involved)

(a) NEW INSTALL ON A BARE MACHINE, START TO FINISH (push once first, see (c))
    1. Install pi once — exactly this package:
        npm install -g @earendil-works/pi-coding-agent
    2. Clone the backup repo into the user home:
        cd $HOME
        git clone <private-repo-url> pi-harness-backup
        cd pi-harness-backup
    3. Reinstall the exact pi packages from the captured settings.json packages[]
       array — these 'pi install' lines were generated at capture time, never guessed:
        __PI_INSTALL_COMMANDS__
    4. Place the captured pi folders into the pi config dir (where pi lives):
        Copy-Item pi-agent\\* $HOME\\.pi\\agent\\ -Recurse -Force
        (project captures sit under projects\\... — copy any of those you need too)
    5. notepad $HOME\\.pi\\agent\\models.json — RE-ENTER EACH PROVIDER API KEY: models.json ships REDACTED — every apiKey
       value is the __GIT_IT_REDACTED__ sentinel (manifest.json redactionRegistry
       lists each one); no real key value survives the backup.
    6. Verify: pi list, then diff the fingerprint against manifest.sha256:
        pi list          # must print exactly the packages from step 3
        cd __REPO_PATH__
        $finger = Get-ChildItem -Recurse -File -Force | ForEach-Object {
          $r = [IO.Path]::GetRelativePath((Get-Location).Path, $_.FullName) -replace '\\\\', '/'
          if ($r -notmatch '(^|/)\\.git(/|$)' -and $_.Name -notin 'last-report.txt','manifest.sha256') {
            $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
            "$h  $r"
          }
        }
        Compare-Object (Get-Content manifest.sha256) $finger
        # no output = DIFF-CLEAN: every shipped file hashes to its manifest.sha256 line

(b) RESTORE THE CURRENT MACHINE AFTER A WIPE (run right after (a)1, on this machine)
    git clone <private-repo-url> pi-harness-backup ; cd pi-harness-backup ; git pull
    Copy-Item pi-agent\\* $HOME\\.pi\\agent\\ -Recurse -Force
    __PI_INSTALL_COMMANDS__
    notepad $HOME\\.pi\\agent\\models.json — re-enter each provider API key (see (a)5)
    restart pi;  pi list -> same set as (a)3;  cd __REPO_PATH__, re-run the (a)6 fingerprint
    -> DIFF-CLEAN against manifest.sha256.

(c) PRIVATE REMOTE — add it once and push; never make it public:
    git remote add private <private-repo-url>
    git push -u private HEAD
    One line why: PRIVATE is the rule — models.json is only redacted (not encrypted),
    real API keys must never go public, and auth.json is never packed at all.

(d) WHAT WAS SAVED / WHAT WAS EXCLUDED / THE ONE COMMAND
    Saved: the whole harness — ~/.pi/agent (extensions/ skills/ prompts/ themes/
    settings.json AGENTS.md models.json(redacted) .gitignore SYSTEM.md ...) plus
    reachable project .pi/ dirs; manifest.json lists every file and manifest.sha256
    pins every hash, so restores are verified, not trusted.
    Excluded — secrets and machine state never leave (the rule): auth.json trust.json
    models-store.json crashes.json sessions/ npm/ bin/ disabled-extensions/
    VERIFIED_FACTS* goal/progress docs *.log *.tmp *.bak .git/ last-report.txt.
    Recap — the single easy command, run in pi on any machine:
        /git_it           # re-enumerate scopes, redact, gates G1-G6, commit
    restore path = (a); that is the whole workflow.

(e) THE TWO --GITHUB PATHS (end to end, WITH and WITHOUT local credentials — deterministic, no LLM, no token ever printed; PRIVATE ONLY)
    WITH gh logged in — your reply carries the line "credential: gh (auth status PASS) + account <name>":
      /git_it --github new <name>        -> gh creates a NEW PRIVATE repo UNDER YOUR ACCOUNT and pushes this backup
      /git_it --github <owner>/<repo>    -> push this backup into an EXISTING repo (keep it private — the rule)
      a stale credential has exactly one remedy: credential stale — re-auth with "gh auth login", then re-run the same form.
      recap, the single easy command in pi (that is the whole github workflow):
          /git_it --github new <name>        (or the existing-repo form above, into a PRIVATE repo)
    WITHOUT local credentials — your reply carries "credential: none — no local GitHub credential":
      the local-only alternative: run plain /git_it (local-only capture+commit, no push) — the backup stands safe, restore = (a);
      to get it off-machine anyway, the OTHER machine (the one that HAS credentials) runs the same --github form
      once (new <name> or <owner>/<repo>) from ITS copy of this backup repo (that copy = the URL saved above, walked over or re-cloned) and pushes.
    PRIVATE ONLY is the rule — NEVER share this backup repo: auth.json is never packed and models.json ships REDACTED.
    seams (deterministic switches): GIT_IT_DRY_RUN=1 prints the exact commands and pushes nothing; GIT_IT_URL_SCHEME=ssh switches the remote to the git@ form.
`;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Small deterministic helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
class GitItError extends Error {}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sortedNamesNonDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** piece1 Â§2: prompts/goal.md is the goal skill's prompt TEMPLATE — the ONLY name
 *  on the Â§3 noise list that is a real harness artifact, so it is carved out of
 *  the name-based rule (workspace-root goal.md process docs are never in scope). */
function isPromptGoalTemplate(rel: string): boolean {
  return rel === "prompts/goal.md" || rel.endsWith("/prompts/goal.md");
}

/** piece1 Â§3 noise predicate (name-based, tree-wide); rel is slash-form. */
function isNoiseRel(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  return (
    parts.includes(".git") ||
    parts.includes("sessions") ||
    DIR_SKIP.has(base) ||
    (FILE_SKIP.has(base) && !isPromptGoalTemplate(rel)) ||
    FILE_VERIFIED_RE.test(base) ||
    FILE_SUFFIX_RE.test(base) ||
    (BAK_RE.test(base) && rel !== ALLOWED_BAK && !rel.endsWith("/" + ALLOWED_BAK)) // rel may carry the relRoot prefix in later gate passes
  );
}

function isApiKeyLeafKey(k: string): boolean {
  return k === ["api", "Key"].join("") || k === ["api", "_key"].join("");
}

function run(cmd: string, args: string[], opts?: { cwd?: string }): { ok: boolean; stdout: string; stderr: string } {
  // shell:false keeps argv intact on Windows — cmd.exe re-tokenizes args that
  // contain spaces, which silently broke `git commit -m "multi word …"` (the
  // words after the first were parsed as pathspecs and the commit never
  // landed). If the raw spawn cannot resolve the .cmd shim, fall back once.
  const base = { windowsHide: true, encoding: "utf8" as const, cwd: opts?.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  let r = spawnSync(cmd, args, { ...base, shell: false });
  if (r.error) r = spawnSync(cmd, args, { ...base, shell: true });
  return { ok: r.status === 0, stdout: (r.stdout ?? "") as string, stderr: (r.stderr ?? "") as string };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** [PIECE 5] WHAT TO DO NEXT — concrete, copy-paste-ready PowerShell lines for the
 *  user after a capture. The repo's real remotes + current branch are detected so
 *  every emitted line runs as-is whenever a remote exists; the ONLY placeholder is
 *  the private repo URL, and it appears only when no remote is configured yet. */
function nextStepsPowerShell(repoDir: string): string[] {
  const out: string[] = [];
  out.push("WHAT TO DO NEXT — copy-paste each line into PowerShell (runs as-is):");
  const br = run("git", ["branch", "--show-current"], { cwd: repoDir });
  const branch = br.ok && (br.stdout ?? "").trim() ? (br.stdout ?? "").trim() : "HEAD";
  out.push("  git -C " + repoDir + " log --oneline -1");
  const rm = run("git", ["remote"], { cwd: repoDir });
  const remotes = rm.ok ? (rm.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  if (remotes.length === 0) {
    out.push("  # no remote configured yet — add a PRIVATE one and push (replace <private-repo-url>):");
    out.push("  git -C " + repoDir + " remote add github <private-repo-url>");
    out.push("  git -C " + repoDir + " push -u github " + branch);
  } else {
    for (const name of remotes) {
      const u = run("git", ["remote", "get-url", name], { cwd: repoDir });
      const url = u.ok ? (u.stdout ?? "").trim() : "(unknown url)";
      out.push("  # remote '" + name + "' -> " + url);
      out.push("  git -C " + repoDir + " push " + name + " " + branch);
      out.push("  git -C " + repoDir + " ls-remote " + name + " " + branch);
    }
  }
  return out;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Capture enumeration (piece1 Â§0, Â§2, Â§3)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type CaptureEntry = { rel: string; src: string; redactJson: boolean };

/** Walk one scope root (sorted, deterministic), skipping the Â§3 exclude set. */
function enumerateScope(root: string, relRoot: string): CaptureEntry[] {
  const out: CaptureEntry[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = path.join(root, relDir);
    for (const name of sortedNamesNonDir(absDir)) {
      const rel = relDir === "" ? name : relDir + "/" + name;
      const abs = path.join(absDir, name);
      if (isNoiseRel(rel)) continue;
      out.push({ rel: relRoot + "/" + rel, src: abs, redactJson: name === "models.json" || name === "models.json.example" });
    }
    for (const name of readdirSync(absDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()) {
      if (DIR_SKIP.has(name) || BAK_RE.test(name)) continue;
      stack.push(relDir === "" ? name : relDir + "/" + name);
    }
  }
  return out;
}

/**
 * Scopes: Scope G always; Scope P = .pi/ dirs walking up from the pi cwd,
 * EXCLUDING the home-scope stray ~/.pi (piece1 Â§3 excludes all of it).
 */
function discoverScopes(): Array<{ name: string; root: string; relRoot: string }> {
  const scopes: Array<{ name: string; root: string; relRoot: string }> = [
    { name: "global", root: AGENT_DIR, relRoot: BACKUP_SUBDIR },
  ];
  const homePi = path.resolve(path.join(os.homedir(), ".pi"));
  let cur = path.resolve(process.cwd());
  for (;;) {
    const cand = path.resolve(path.join(cur, ".pi"));
    if (cand.toLowerCase() !== homePi.toLowerCase() && existsSync(cand)) {
      const parentBase = (path.basename(cur) || "project").replace(/[^A-Za-z0-9._-]/g, "_") || "project";
      scopes.push({ name: "project:" + parentBase, root: cand, relRoot: PROJECT_SUBDIR + "/" + parentBase + "/.pi" });
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return scopes;
}

function parsePiList(stdout: string): string[] {
  const pkgs: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(npm|git):\S+\s*$/.exec(line);
    if (m) pkgs.push(m[0].trim());
  }
  return pkgs.sort();
}

/** Substitute the sentinel into every apiKey-family leaf of a JSON tree. */
function blankApiKeyLeaves(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(blankApiKeyLeaves);
  if (node !== null && typeof node === "object") {
    const acc: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const v = (node as Record<string, unknown>)[k];
      acc[k] = isApiKeyLeafKey(k) ? REDACTION_SENTINEL : blankApiKeyLeaves(v);
    }
    return acc;
  }
  return node;
}

/** G1 (models.json clause): EVERY source-vs-staged difference must be an
 *  apiKey-family leaf whose staged value is the sentinel, else violation. */
function redactionViolations(srcText: string, stagedText: string): string[] {
  const errs: string[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (a === b) return;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      for (const k of Object.keys(a as Record<string, unknown>)) {
        const av = (a as Record<string, unknown>)[k];
        const hasB = Object.prototype.hasOwnProperty.call(b, k);
        if (isApiKeyLeafKey(k)) {
          if (!hasB || (b as Record<string, unknown>)[k] !== REDACTION_SENTINEL) errs.push(at + "." + k + " (apiKey-family leaf must equal the sentinel)");
          continue;
        }
        if (!hasB) {
          errs.push(at + "." + k + " (key present in source but missing from packed copy)");
          continue;
        }
        walk(av, (b as Record<string, unknown>)[k], at + "." + k);
      }
      for (const k of Object.keys(b as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(a, k)) errs.push(at + "." + k + " (key only in packed copy)");
      }
      return;
    }
    errs.push(at + " (differs from source outside the permitted apiKey redaction)");
  };
  walk(JSON.parse(srcText), JSON.parse(stagedText), "models.json");
  return errs;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hygiene gates G1..G5 over a staged tree (G4/G6 run in the pipeline)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkStagedTree(entries: CaptureEntry[], stagedRoot: string, scopes: Array<{ root: string }>): string[] {
  const violations: string[] = [];
  const agent = AGENT_DIR;
  const underAnyScope = (abs: string): boolean => {
    const n = path.resolve(abs).toLowerCase();
    const a = path.resolve(agent).toLowerCase();
    return scopes.some((s) => {
      const sr = path.resolve(s.root).toLowerCase();
      return n === sr || n.startsWith(sr + path.sep);
    }) || n === a || n.startsWith(a + path.sep);
  };

  // G1 — secrets: auth/trust files anywhere in the staged tree.
  for (const e of entries) {
    const base = e.rel.split("/").pop() ?? "";
    if (base === "auth.json" || base === "trust.json") {
      violations.push("G1 SECRET: staged " + e.rel + " (auth/trust file must never be packed)");
    }
    if (isNoiseRel(e.rel)) {
      violations.push("G3 NOISE: " + e.rel + " (name is on the exclude list)");
    }
  }
  // G1 — token scan per file; models.json uses the redaction-diff rule instead.
  for (const e of entries) {
    const abs = path.join(stagedRoot, ...e.rel.split("/"));
    if (!existsSync(abs)) {
      violations.push("G1/G3: staged entry missing on disk: " + e.rel);
      continue;
    }
    if (e.src && !underAnyScope(e.src)) {
      violations.push("G2 CONTAINMENT: " + e.rel + " resolves outside " + AGENT_DIR + " / project .pi/ dirs: " + e.src);
    }
    if (e.redactJson) {
      try {
        for (const v of redactionViolations(readFileSync(e.src, "utf8"), readFileSync(abs, "utf8"))) {
          violations.push("G1 SECRET: " + v);
        }
      } catch (err) {
        violations.push("G1 SECRET: " + e.rel + " models.json redaction check failed: " + String(err));
      }
    } else {
      const text = readFileSync(abs, "utf8");
      const leaks = fileTokenLeakHits(text);
      if (leaks.length) {
        violations.push("G1 SECRET: " + e.rel + " contains a secret VALUE shape (" + leaks.join(", ") + ")");
      }
      if (BAK_RE.test(e.rel.split("/").pop() ?? "") && e.rel !== ALLOWED_BAK && !e.rel.endsWith("/" + ALLOWED_BAK)) {
        // belt+braces for G3 on the staged copy (enumeration already filtered).
        if (e.rel.endsWith(".bak") || e.rel.split("/").pop()?.endsWith("_.bak") || /\.bak_/.test(e.rel.split("/").pop() ?? "")) {
          violations.push("G3 NOISE: " + e.rel + " (*.bak file managed to reach the staged tree)");
        }
      }
    }
  }
  return violations;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The pipeline
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function capture(ctx: { signal?: AbortSignal }, argRepoDir: string, githubDesc: GitHubDescriptor | null = null): Promise<{ ok: boolean; headline: string; short: string; githubNote: string; repoDir: string }> {
  const signal = ctx.signal;
  const abort = (): void => {
    if (signal?.aborted) throw new GitItError("git_it aborted by user");
  };
  // Round-2 gap 1(b): the backup repo dir is DECIDED here (the command arg when
  // given, DEFAULT_REPO_DIR otherwise) so the __REPO_PATH__ substitution in
  // INSTRUCTIONS_TEXT — performed during packing below — always prints the ACTUAL
  // repo the capture lands in; the printed `cd` is never stale.
  const repoDir = argRepoDir && argRepoDir.trim() ? path.resolve(argRepoDir.trim()) : DEFAULT_REPO_DIR;

  // 0 — pi version (G4: fingerprint needs it).
  const ver = run("pi", ["--version"]);
  if (!ver.ok || !ver.stdout.trim()) throw new GitItError("git_it: G4: `pi --version` failed (fingerprint would be incomplete): " + ver.stderr.trim());
  const piVersion = (ver.stdout.trim().split(/\r?\n/)[0] ?? "").trim();
  abort();

  // 1 — settings.json -> packages[] (+ JSON.parse smoke; the interactive `pi config`
  //     TUI is never spawned — JSON.parse covers the "settings parses" contract).
  const settingsAbs = path.join(AGENT_DIR, "settings.json");
  if (!existsSync(settingsAbs)) throw new GitItError("git_it: " + settingsAbs + " is missing");
  let settings: { packages?: unknown } = {};
  try {
    settings = JSON.parse(readFileSync(settingsAbs, "utf8")) as { packages?: unknown };
  } catch (err) {
    throw new GitItError("git_it: settings.json does not parse (G4): " + String(err));
  }
  const pkgList: string[] = (Array.isArray(settings.packages) ? (settings.packages as string[]).slice() : []).sort();
  abort();

  // 2 — `pi list` must equal settings.json packages[] (G4), and its install paths
  //     must live inside Scope G (G2).
  const listOut = run("pi", ["list"]);
  if (!listOut.ok) throw new GitItError("git_it: `pi list` failed: " + listOut.stderr.trim());
  const listedPkgs = parsePiList(listOut.stdout);
  const missingSet = pkgList.filter((x) => !listedPkgs.includes(x));
  const extraSet = listedPkgs.filter((x) => !pkgList.includes(x));
  if (missingSet.length || extraSet.length) {
    const d: string[] = [];
    if (missingSet.length) d.push("  in settings.json packages[] but NOT reported by pi list: " + missingSet.join(", "));
    if (extraSet.length) d.push("  reported by pi list but NOT in settings.json packages[]: " + extraSet.join(", "));
    throw new GitItError("git_it: G4: `pi list` and settings.json packages[] differ (not reproducible)\n" + d.join("\n"));
  }
  const mg = /(?:^|\n)\s+([A-Za-z]:[^\r\n]+)/g;
  const installPaths: string[] = [];
  for (const m of listOut.stdout.matchAll(mg)) installPaths.push(m[1].trim());
  const agentLow = path.resolve(AGENT_DIR).toLowerCase();
  for (const p of installPaths) {
    const n = path.resolve(p).toLowerCase();
    if (n !== agentLow && !n.startsWith(agentLow + path.sep)) {
      throw new GitItError("git_it: G2: `pi list` reports an install path outside Scope G: " + p);
    }
  }
  abort();

  // 3 — G6 drift gate (both directions, printed diff on failure).
  const diskExt = sortedNamesNonDir(path.join(AGENT_DIR, "extensions")).filter((n) => n.endsWith(".ts"));
  // Round-2 gap 3: map_folder.md is a non-harness template doc — FILE_SKIP excludes
  // it from the pack, so the G6 disk scan filters it out TOO; expected set and the
  // name-based skip now agree (it is expected NOT to be packed).
  const diskAgents = sortedNamesNonDir(path.join(AGENT_DIR, "agents")).filter((n) => n.endsWith(".md") && n !== "map_folder.md");
  const g6 = (kind: string, disk: string[], expected: string[]): string[] => {
    const d: string[] = [];
    for (const x of expected.filter((x) => !disk.includes(x))) d.push("  " + kind + " expected but ABSENT on disk: " + x);
    for (const x of disk.filter((x) => !expected.includes(x))) d.push("  " + kind + " present on disk but NOT in the manifest list: " + x);
    return d;
  };
  const g6D = g6("extensions/*.ts", diskExt, EXPECTED_EXTENSIONS_TS).concat(g6("agents/*.md", diskAgents, EXPECTED_AGENTS_MD));
  if (g6D.length) throw new GitItError("git_it: G6 DRIFT: on-disk artifact sets differ from the manifest lists\n" + g6D.join("\n"));
  abort();

  // 4 — enumerate scopes + copy into a temp staging dir (redacting models.json).
  const scopes = discoverScopes();
  const stagedRoot = mkdtempSync(path.join(os.tmpdir(), "git-it-"));
  const entries = scopes.flatMap((s) => enumerateScope(s.root, s.relRoot));
  const stamped = stamp();
  const copies: Array<{ rel: string; src: string; redactJson: boolean; bytes: Buffer }> = [];
  for (const e of entries) {
    if (!existsSync(e.src)) throw new GitItError("git_it: enumerated file vanished: " + e.src);
    const srcText = readFileSync(e.src, "utf8");
    if (e.redactJson && modelsRawTokenHits(srcText).length) {
      throw new GitItError("git_it: G1 SECRET: models.json SOURCE text carries a FORBIDDEN_TOKENS hit BEYOND the redaction scope (round-2 Petri-dish belt+braces) — a leak the redaction-diff would never flag; run refused");
    }
    const bytes = e.redactJson
      ? Buffer.from(JSON.stringify(blankApiKeyLeaves(JSON.parse(srcText), null, 1), null, 2) + "\n")
      : readFileSync(e.src);
    const abs = path.join(stagedRoot, ...e.rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    copies.push({ rel: e.rel, src: e.src, redactJson: e.redactJson, bytes });
  }

  // 5 — docs: README (with INSTRUCTIONS_TEXT filled), .gitignore (source one,
  //     with negation lines so the REDACTED models.json and the allow-listed
  //     settings.json.bak stay trackable), manifest.json, manifest.sha256.
  //     manifest.json files[] pins EVERY shipped artifact except itself;
  //     manifest.sha256 pins every shipped artifact except itself; neither
  //     references itself, so restore-verify is a plain per-file hash recompute.
  const installCmds = pkgList.length ? pkgList.map((p) => "        pi install " + p).join("\n") : "        (settings.json declares no packages)";
  const instructions = INSTRUCTIONS_TEXT.replaceAll("__REPO_PATH__", repoDir).replaceAll("__PI_INSTALL_COMMANDS__", installCmds);
  const readmeBody =
    [
      "# pi harness backup — machine " + os.hostname() + " — generated by /git_it",
      "",
      "Auto-generated capture of the pi harness at " + stamped + " (pi " + piVersion + ").",
      "capture scopes: " + scopes.map((s) => s.relRoot).join(", "),
      "",
      instructions.trim(),
      "",
    ].join("\n") + "\n";
  writeFileSync(path.join(stagedRoot, "README.md"), readmeBody);
  const gitignoreBody =
    readFileSync(path.join(AGENT_DIR, ".gitignore"), "utf8") +
    [
      "",
      "# --- git_it additions (the capture ships models.json REDACTED and one allow-listed",
      "#     settings.json.bak under backup-wsl-powershell-hook/; negation keeps them tracked) ---",
      "!pi-agent/models.json",
      "!pi-agent/backup-wsl-powershell-hook/",
      "!pi-agent/backup-wsl-powershell-hook/settings.json.bak",
      "",
    ].join("\n");
  writeFileSync(path.join(stagedRoot, ".gitignore"), gitignoreBody);
  const manifestObj = {
    generator: "git_it",
    capturedAt: stamped,
    machine: os.hostname(),
    piVersion,
    scopes: scopes.map((s) => ({ name: s.name, root: s.root, relInRepo: s.relRoot })),
    packages: pkgList,
    redactionRegistry: copies.filter((c) => c.redactJson).map((c) => c.rel),
    files: [] as Array<{ path: string; sha256: string; size: number }>,
  };
  for (const c of copies) manifestObj.files.push({ path: c.rel, sha256: sha256Of(c.bytes), size: c.bytes.length });
  for (const rel of [".gitignore", "README.md"]) {
    const b = readFileSync(path.join(stagedRoot, rel));
    manifestObj.files.push({ path: rel, sha256: sha256Of(b), size: b.length });
  }
  const manifestText = JSON.stringify(manifestObj, null, 2) + "\n";
  writeFileSync(path.join(stagedRoot, "manifest.json"), manifestText);
  const docRels = ["README.md", "manifest.json", "manifest.sha256", ".gitignore"];
  // manifest.sha256: one "sha  rel" line per shipped artifact (capture files +
  // the three docs) — no self line, so the restore machine can verify every file
  // by plain recompute (hashes are taken straight from the staged bytes).
  const shaBody = copies
    .map((c) => c.rel)
    .sort()
    .concat([".gitignore", "manifest.json", "README.md"])
    .map((rel) => sha256Of(readFileSync(path.join(stagedRoot, rel))) + "  " + rel)
    .join("\n") + "\n";
  writeFileSync(path.join(stagedRoot, "manifest.sha256"), shaBody);
  abort();

  // 6 — gate pass #1: staged tree BEFORE git add (G1/G2/G3/G5).
  const docEntries: CaptureEntry[] = [
    { rel: "README.md", src: "", redactJson: false },
    { rel: ".gitignore", src: "", redactJson: false },
    { rel: "manifest.json", src: "", redactJson: false },
    { rel: "manifest.sha256", src: "", redactJson: false },
  ];
  const stagedFiles: CaptureEntry[] = copies.map((c) => ({ rel: c.rel, src: c.src, redactJson: c.redactJson })).concat(docEntries);
  const g1a = checkStagedTree(stagedFiles, stagedRoot, scopes);
  if (g1a.length) throw new GitItError("git_it: GATES failed on the staged tree — aborting before git add\n" + g1a.join("\n"));
  const totalBytes = copies.reduce((a, c) => a + c.bytes.length, 0) + docEntries.reduce((a, d) => a + statSync(path.join(stagedRoot, d.rel)).size, 0);
  const fileCount = copies.length + docRels.length;
  if (totalBytes > 50 * 1024 * 1024 || fileCount > 5000) {
    throw new GitItError("git_it: G5: packed size > 50 MB or file count > 5000 rejected (size=" + totalBytes + " B, files=" + fileCount + ")");
  }

  // 7 — land into the repo: init-if-needed, copy, git add, gate pass #2.
  // repoDir was decided at the top of capture() (round-2 gap 1(b) — the command
  // arg when given) so INSTRUCTIONS_TEXT already carries the ACTUAL repo path.
  if (path.resolve(repoDir).toLowerCase() !== path.resolve(AGENT_DIR).toLowerCase() && path.resolve(repoDir).toLowerCase().startsWith(path.resolve(AGENT_DIR).toLowerCase() + path.sep)) {
    throw new GitItError("git_it: the backup repo path must not live inside " + AGENT_DIR + " (self-capture guard): " + repoDir);
  }
  mkdirSync(repoDir, { recursive: true });
  if (!existsSync(path.join(repoDir, ".git"))) {
    const init = run("git", ["init", "-b", "backup"], { cwd: repoDir });
    if (!init.ok) throw new GitItError("git_it: `git init` failed in " + repoDir + ": " + init.stderr.trim());
  }
  for (const c of copies) {
    const abs = path.join(stagedRoot, ...c.rel.split("/"));
    const dst = path.join(repoDir, ...c.rel.split("/"));
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(abs, dst);
  }
  for (const r of docRels) {
    const abs = path.join(stagedRoot, r);
    if (existsSync(abs)) copyFileSync(abs, path.join(repoDir, r));
  }
  abort();
  // core.autocrlf=false: the COMMITTED BLOB must equal the staged bytes (the bytes
  // manifest.sha256 pins). Without it, autocrlf=true machines normalize CRLF files
  // on add -> the pushed tree would NOT hash-verify against manifest.sha256 (piece-5
  // round-trip finding). Staged bytes are untouched; working-tree files untouched.
  const add1 = run("git", ["-c", "core.autocrlf=false", "-c", "user.name=git_it", "-c", "user.email=git_it@local", "add", "-A"], { cwd: repoDir });
  if (!add1.ok) throw new GitItError("git_it: `git add` failed: " + add1.stderr.trim());
  // Round-3: the repo ships pi-agent/.gitignore itself, whose OWN `models.json` /
  // `*.bak` rows SHADOW the root !negations (deeper .gitignore = later = wins), so
  // `git add -A` skips them — they must be ALWAYS tracked: force-add the two
  // always-shipped specials (redacted models.json + the allow-listed .bak).
  const specials = ["pi-agent/models.json", "pi-agent/backup-wsl-powershell-hook/settings.json.bak"];
  const addF = run("git", ["-c", "core.autocrlf=false", "-c", "user.name=git_it", "-c", "user.email=git_it@local", "add", "-f", "--", "pi-agent/models.json", "pi-agent/backup-wsl-powershell-hook/settings.json.bak"], { cwd: repoDir });
  if (!addF.ok) throw new GitItError("git_it: `git add -f` failed: " + addF.stderr.trim());
  const ls = run("git", ["-c", "user.name=git_it", "-c", "user.email=git_it@local", "ls-files"], { cwd: repoDir });
  const listed = (ls.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  const gitEntries: CaptureEntry[] = [];
  for (const r of listed) {
    const c = copies.find((x) => x.rel === r);
    gitEntries.push({ rel: r, src: c ? c.src : "", redactJson: c?.redactJson ?? false });
  }
  const gGit = checkStagedTree(gitEntries, repoDir, scopes);
  if (gGit.length) throw new GitItError("git_it: GATES failed on the git ls-files set\n" + gGit.join("\n"));
  abort();

  // 8 — commit (deterministic timestamped message).
  const shortHash = sha256Of(Buffer.from(copies.map((c) => c.rel + c.bytes.length).join("\n"))).slice(0, 8);
  const status = run("git", ["-c", "user.name=git_it", "-c", "user.email=git_it@local", "status", "--porcelain"], { cwd: repoDir });
  const hasChanges = (status.stdout ?? "").trim().length > 0;
  const commit = run("git", ["-c", "user.name=git_it", "-c", "user.email=git_it@local", "commit", "-m", "git_it backup " + stamped + " files=" + fileCount + " sha=" + shortHash], { cwd: repoDir });
  const log = run("git", ["-c", "user.name=git_it", "-c", "user.email=git_it@local", "log", "-1", "--oneline"], { cwd: repoDir });
  const head = log.ok ? (log.stdout ?? "").trim() : "(no commit)";
  // Windows nuance: `git status --porcelain` exits 1 both when the repo is dirty
  // AND (this git build) when it is clean, so the flow-state must be read from
  // the LINES; 'already up to date' is only true when the commit produced NO
  // lines AND nothing is pending — a failed-to-commit dirty tree must NOT be
  // reported as a success:
  const committed = commit.ok || (status.stdout ?? "").trim().length === 0;

  // 9 — report file (added in a second small commit; still deterministic).
  const report = [
    "git_it run " + stamped + "  pi " + piVersion + "  machine " + os.hostname(),
    "packages:           " + (pkgList.join(", ") || "(none)"),
    "capture scopes:      " + scopes.map((s) => s.relRoot).join("  |  "),
    "packed:             " + fileCount + " files, " + totalBytes + " bytes  (G5 pass)",
    "gates:              G1 secrets PASS  G2 containment PASS  G3 noise PASS  G4 pi-list==settings PASS  G5 size PASS  G6 drift PASS",
    "redacted:           " + (copies.filter((c) => c.redactJson).map((c) => c.rel).join(", ") || "none"),
    "manifest:           " + path.join(repoDir, "manifest.json") + "  +  manifest.sha256  +  README.md",
    "commit:             " + head + (committed ? "" : "  (already up to date)"),
    "",
    ...nextStepsPowerShell(repoDir),
    "",
    "Instructions (fresh-machine install / restore) are in " + path.join(repoDir, "README.md") + " (INSTRUCTIONS_TEXT).",
  ].join("\n");
  writeFileSync(path.join(repoDir, "last-report.txt"), report + "\n");
  const add2 = run("git", ["-c", "core.autocrlf=false", "-c", "user.name=git_it", "-c", "user.email=git_it@local", "add", "-A"], { cwd: repoDir });
  if (add2.ok) {
    run("git", ["-c", "user.name=git_it", "-c", "user.email=git_it@local", "commit", "-m", "git_it report " + stamped], { cwd: repoDir });
  }
  try {
    rmSync(stagedRoot, { recursive: true, force: true });
  } catch {
    /* staged tree cleanup is best-effort */
  }
  // â”€â”€ [PIECE-3 SEAM] the parsed github descriptor reached the capture pipeline;
  //    githubSeam() is the piece-2/3 hook (credential detection + gh create/push).
  //    Piece 3 (this build): a PASSED choice executes remote-add+push / gh create;
  //    GIT_IT_DRY_RUN=1 simulates (prints the exact commands, pushes nothing).
  const githubNote = githubDesc ? githubSeam(githubDesc, repoDir).note : "";
  return { ok: committed, headline: "git_it " + (committed ? "capture committed" : "up to date") + ": " + fileCount + " files, " + totalBytes + " B, sha " + shortHash + " — repo " + repoDir, short: shortHash, githubNote, repoDir };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [PIECE 1] /git_it --github — ARGUMENT PARSING + THE PROPOSAL/CHOICE FLOW
// Owned here: how /git_it args are parsed and how the command PROPOSES the two
// GitHub paths. Pieces 2-3 own credential detection + the push/create
// implementation — the ONLY hooks they fill are (1) the GITHUB_HINT placeholder
// line inside GITHUB_PROPOSAL_TEXT and (2) githubSeam(), the clearly-marked
// descriptor seam consumed by the capture pipeline. DETERMINISTIC: pure string
// parsing, zero LLM; every reply carries NO tokens and NO account info;
// parseGitHubChoice NEVER throws — unknown/ambiguous args become the 3-line
// usage reply, never a crash.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Storable parsed descriptor surfaced to the capture pipeline ([PIECE-3 SEAM]). */
type GitHubChoice =
  | { kind: "off"; repoDirArg: string } // today's local-only behavior, unchanged
  | { kind: "existing"; owner: string; repo: string; target: string } // target = "<owner>/<repo>"
  | { kind: "new"; name: string; target: string } // target = "new/<name>"
  | { kind: "proposal"; reply: string }
  | { kind: "usage"; reply: string }; // help / unknown / ambiguous — answered, never thrown
type GitHubDescriptor = Extract<GitHubChoice, { kind: "existing" } | { kind: "new" }>;

/** [PIECE-4 EXTEND] THE proposal + help block — ONE clearly-marked constant for
 *  pieces 2-4 to extend (piece 4 this build: folds in the end-to-end teaching of
 *  BOTH --github paths, WITH and WITHOUT credentials); printed verbatim as the
 *  proposal tail — deterministic, NO tokens, NO account info. */
const GITHUB_HINT = [
  "HOW BOTH PATHS RUN END TO END on a bare machine (deterministic reply: no LLM, no token, no account in the choice):",
  "  WITH gh logged in — your reply names it: `credential: gh (auth status PASS) + account <name>`:",
  "    /git_it --github new <name>        -> gh creates a NEW PRIVATE repo UNDER YOUR ACCOUNT and pushes this capture",
  "    /git_it --github <owner>/<repo>    -> push this capture into an EXISTING repo (keep it private — the rule)",
  "    after `new` push, copy the URL with `gh repo view --json url -q .url` (or the success note) — that URL",
  "    IS the <private-repo-url> used by clone/remote in the README (a)/(c) and on the other machine",
  "    recap, the single easy command in pi (that is the whole github workflow):",
  "        /git_it --github new <name>        (or the existing-repo form above)",
  "    only staleness ever needs this one-liner: re-auth with `gh auth login`, then re-run the same form.",
  "    only HTTP 403 / missing scope (e.g. delete_repo) ever needs: `gh auth refresh -h github.com -s delete_repo`,",
  "    then the cleanup helper (piece5-cleanup.ps1: list first, then -Delete) for the throwaway test repos.",
  "  WITHOUT local credentials — your reply names it: `credential: none — no local GitHub credential`:",
  "    run plain /git_it here instead (local-only capture+commit, no push — the backup stands safe);",
  "    to get it off-machine anyway, the OTHER machine (the one that HAS credentials) runs the same --github form",
  "    once (new <name> or <owner>/<repo>) from ITS copy of this backup repo (that copy = the URL saved above, walked over or re-cloned) and pushes.",
  "NEVER share this backup repo — PRIVATE-only rule: auth.json is never packed and models.json ships REDACTED.",
].join("\n");
const GITHUB_PROPOSAL_TEXT =
  [
    "PROPOSED — /git_it --github — pick ONE path (nothing is pushed until the form matches):",
    "  (a) push into an EXISTING repo:   /git_it --github <owner>/<repo>",
    "  (b) CREATE a NEW private repo:   /git_it --github new <name>",
    "PRIVATE ONLY is the rule — models.json ships redacted; real API keys must never go public.",
    GITHUB_HINT,
  ].join("\n");
const GITHUB_USAGE_TEXT =
  [
    "/git_it --github help — usage:",
    "  /git_it [repoDir]                       local-only capture+commit (no push — today's behavior)",
    "  /git_it --github <owner>/<repo>      OR   /git_it --github new <name>",
  ].join("\n");

/** GitHub shapes enforced here (shape-only; credential authority is enforced by the push step). */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/; // GitHub's real rule: no leading/trailing hyphen
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isGitHubNameValid(name: string): boolean {
  return name.length <= 100 && GITHUB_NAME_RE.test(name) && name !== "." && name !== ".." && !name.endsWith(".git") && !name.includes("..");
}

/** Deterministic pure-string parser (zero LLM). kinds 'proposal'/'usage' carry the
 *  reply text; every other input collapses to one of them — never a crash. */
function parseGitHubChoice(argsLine: string): GitHubChoice {
  const trimmed = argsLine.trim();
  if (trimmed === "") return { kind: "off", repoDirArg: trimmed };
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] as string;
  if (first !== "--github" && first !== "--gh") return { kind: "off", repoDirArg: trimmed }; // bare repoDir or any non-flag arg = exactly today's repo-dir behavior
  const rest = tokens.slice(1);
  if (rest.length === 0) return { kind: "proposal", reply: GITHUB_PROPOSAL_TEXT };
  if (rest[0] === "help") return { kind: "usage", reply: GITHUB_USAGE_TEXT };
  if (rest[0] === "new") {
    if (rest.length === 2 && isGitHubNameValid(rest[1] as string)) {
      return { kind: "new", name: rest[1] as string, target: "new/" + rest[1] as string };
    }
    return { kind: "usage", reply: GITHUB_USAGE_TEXT }; // "new" without a valid name = ambiguous
  }
  if (rest.length === 1) {
    const m = /^([^/]+)\/([^/]+)$/.exec(rest[0] as string);
    if (m && GITHUB_OWNER_RE.test(m[1] as string) && isGitHubNameValid(m[1] as string) && isGitHubNameValid(m[2] as string)) {
      return { kind: "existing", owner: m[1] as string, repo: m[2] as string, target: rest[0] as string };
    }
  }
  return { kind: "usage", reply: GITHUB_USAGE_TEXT }; // unknown/ambiguous -> 3-line usage reply, never an error
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [PIECE 2] CREDENTIAL DETECTION — decides WHETHER this machine has usable
// local GitHub credentials. The ONLY outward-facing result is {method, account}
// where account is the PUBLIC GitHub username — no token, no header, no
// credential VALUE is ever printed or logged, and any stdout that could carry
// one (gh's masked token line for instance) stays inside the probe.
//   'gh'  = gh CLI spawns AND `gh auth status` exits 0 (probe argv is exactly
//          ['auth','status'] — NO token-printing flag exists in this file); the
//          parsed account line is the PUBLIC username, shown in the reply.
//   'git' = no usable gh, but the stored credential helper answers
//          `git credential fill` for github.com — PRESENCE of a password line
//          is probed, its VALUE is never kept, printed or logged (the username
//          is public and may be shown).
//   'none'= absent gh / unauthenticated / timeout / helper miss â†’ NEVER a
//          crash, never a prompt (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=Never,
//          short timeout).
// DETERMINISTIC: exactly ONE spawnSync per probe, fixed env, zero LLM.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type GitHubCredential = { available: boolean; method: "gh" | "git" | "none"; account?: string };

const CREDENTIAL_PROBE_TIMEOUT_MS = 8000;

/** Probe 1 — gh CLI. One spawnSync; argv is exactly ['auth','status']. Any
 *  failure (binary absent, non-zero exit, timeout, spawn error) reads
 *  authenticated:false â†’ the 'none' path — never a crash. The account (PUBLIC
 *  GitHub username) is the only thing extracted from the output. */
function probeGhAuth(): { authenticated: boolean; account?: string } {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("gh", ["auth", "status"], {
      windowsHide: true,
      encoding: "utf8" as const,
      timeout: CREDENTIAL_PROBE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return { authenticated: false };
  }
  if (r.error || r.status !== 0) return { authenticated: false }; // absent/unauthenticated/timeout -> reads 'none', no crash
  const out = ((r.stdout ?? "") as string) || ((r.stderr ?? "") as string);
  const acc = /Logged in to github\.com\s+account\s+([A-Za-z0-9][A-Za-z0-9-]{0,38})/.exec(out);
  return acc ? { authenticated: true, account: acc[1] as string } : { authenticated: true };
}

/** Probe 2 — git credential helper (only reached when gh is not usable). Pipes
 *  the github.com request to `git credential fill` (one spawnSync). Non-0 exit,
 *  spawn error or timeout -> not usable. A password line is required, and only
 *  its PRESENCE is checked — the value exists in this one local string and in
 *  no log; the username (public) is what may be surfaced. */
function probeGitCredentialFill(): { usable: boolean; username?: string } {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      windowsHide: true,
      encoding: "utf8" as const,
      timeout: CREDENTIAL_PROBE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    });
  } catch {
    return { usable: false };
  }
  if (r.error || r.status !== 0) return { usable: false };
  const out = (r.stdout ?? "") as string;
  if (!/(?:^|\n)password=./.test(out)) return { usable: false }; // presence ONLY, value never kept
  const u = /(?:^|\n)username=([A-Za-z0-9][A-Za-z0-9-]{0,38})/.exec(out);
  return { usable: true, username: u ? (u[1] as string) : undefined };
}

/** Deterministic decision — gh first, git helper fallback, else 'none'. */
function detectGitHubCredential(): GitHubCredential {
  const ghResult = probeGhAuth();
  if (ghResult.authenticated) return { available: true, method: "gh", account: ghResult.account };
  const gitResult = probeGitCredentialFill();
  if (gitResult.usable) return { available: true, method: "git", account: gitResult.username };
  return { available: false, method: "none" };
}

/** The single outward-facing credential line in the github-path reply: METHOD +
 *  PUBLIC account ONLY — no token, no masked token shape, no flag names. */
function credentialReplyLine(): string {
  const c = detectGitHubCredential();
  if (c.method === "gh") {
    return "credential: gh (auth status PASS) + account " + (c.account ?? "(account not reported by gh)");
  }
  if (c.method === "git") {
    return "credential: git (stored credential helper, github.com) + account " + (c.account ?? "(username not reported)");
  }
  return "credential: none — no local GitHub credential; push/create cannot run from this machine";
}

/** [PIECE-3 SEAM] githubSeam(desc, repoDir) — the pieces-2/3 create+push hook
 *  (credential detection that never prints a token + `gh repo create --private
 *  --source` / remote-add + push). Piece 3 (this build) EXECUTES a passed choice:
 *  existing -> `git remote add github <url>` (https built from host+owner+repo;
 *  the git@ form is the SSH fallback, picked deterministically by
 *  GIT_IT_URL_SCHEME=ssh — never a retry) then `git push -u github <branch>`;
 *  new -> `gh repo create <owner-or-login>/<name> --private --source <repoDir>
 *  --push --remote github` (owner omitted -> the authenticated account qualifies
 *  the name). Deterministic (pure spawns, zero LLM). GIT_IT_DRY_RUN=1 simulates:
 *  prints the EXACT commands it would run, pushes nothing; method 'none' -> a
 *  clear no-credential reply and the local-only result stands. 401/expired-token
 *  from gh or push -> exactly ONE "credential stale — re-auth with `gh auth
 *  login`, nothing pushed" reply — no retry loop; tokens and stderr are never
 *  printed (non-auth failures show one token-redacted cause line only).
 *  Exported so the verify harness can drive the seam on a scratch repo copy
 *  under GIT_IT_DRY_RUN. */

const GITHUB_HTTPS_HOST = "github.com";

/** https URL from host+owner+repo; the git@ form is the deterministic SSH
 *  fallback (GIT_IT_URL_SCHEME=ssh), never a retry. */
function githubRepoUrl(owner: string, repo: string): string {
  const ssh = process.env.GIT_IT_URL_SCHEME === "ssh";
  return (ssh ? "git@" + GITHUB_HTTPS_HOST + ":" : "https://" + GITHUB_HTTPS_HOST + "/") + owner + "/" + repo + ".git";
}

/** The branch the capture repo pushes: git_it inits with `git init -b backup`, so
 *  the mapping is 'backup'; the repo's own HEAD answers when it differs. */
function githubPushBranch(repoDir: string): string {
  const b = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
  const n = (b.stdout ?? "").trim();
  return n && n !== "HEAD" ? n : "backup";
}

/** 401 / expired-token / unauthenticated family ONLY (git+gh emit stable English
 *  strings); anything else is a real error — single attempt, never retried. */
function isStaleCredential(r: { stdout: string; stderr: string }): boolean {
  const t = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
  return /401|bad credential|authentication failed|unauthorized|could not read (username|password)|not logged in|gh auth login|expired|password authentication .*removed|personal access token|permission to .* denied/i.test(t);
}

/** HTTP 403 / missing-scope family (e.g. `gh repo delete` 403 "Must have admin
 *  rights" when the token lacks delete_repo). Distinct from stale — 403 means the
 *  token EXISTS but lacks a scope; the fix is ONE interactive refresh, then the
 *  cleanup helper. NEVER matched when the message also names the 401 family
 *  (stale wins: it is checked first). */
function isScopeError(r: { stdout: string; stderr: string }): boolean {
  const t = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
  return /403|delete_repo|admin rights|must have admin/i.test(t);
}

/** THE 403/missing-scope reply — the exact remediation the user asked for: one
 *  scope refresh, then the list-safe cleanup helper, then the delete pass.
 *  `<git_it_goal>` = wherever the helper lives on THIS machine (C:\\Users\\connessn\\git_it_goal\\out2\\piece5-cleanup.ps1);
 *  kept as a placeholder so the shipped reply stays portable. */
const SCOPE_ERROR_NOTE =
  "HTTP 403 on the GitHub API — the token lacks a required scope (e.g. delete_repo):\n" +
  "    gh auth refresh -h github.com -s delete_repo\n" +
  "    powershell -ExecutionPolicy Bypass -File <git_it_goal>/out2/piece5-cleanup.ps1        # list only (safe)\n" +
  "    powershell -ExecutionPolicy Bypass -File <git_it_goal>/out2/piece5-cleanup.ps1 -Delete  # deletes the throwaway test repos\n" +
  "nothing else changed; nothing created/pushed by this run; re-run the same /git_it form after the refresh.";

/** One short, token-redacted cause for NON-auth failures ONLY (stderr is never
 *  shown for the stale-credential case; token VALUES are never shown anywhere). */
function sanitizedCause(r: { stderr: string }): string {
  const first = (r.stderr ?? "").split(/\r?\n/).find((l) => l.trim().length > 0) ?? "unknown cause";
  return first.replace(/(sk-[A-Za-z0-9_]{4,}|gh[osp]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{10,}|password[=:][^\s]+)/gi, "<redacted>").slice(0, 160);
}

export function githubSeam(desc: GitHubDescriptor, repoDir: string): { note: string } {
  const dryRun = process.env.GIT_IT_DRY_RUN === "1";
  const cred = detectGitHubCredential();
  const target = desc.target;
  const branch = githubPushBranch(repoDir);
  const plan: string[] = [];
  let execute: () => { note: string } | null;
  if (desc.kind === "existing") {
    const url = githubRepoUrl(desc.owner, desc.repo);
    plan.push("git remote add github " + url, "git push -u github " + branch);
    execute = () => {
      if (!cred.available) return null;
      const added = run("git", ["remote", "add", "github", url], { cwd: repoDir });
      if (!added.ok) {
        const got = run("git", ["remote", "get-url", "github"], { cwd: repoDir });
        if (!(got.ok && (got.stdout ?? "").trim() === url)) {
          return { note: "github path chosen: " + target + " — `git remote add github " + url + "` FAILED (" + sanitizedCause(added) + "); nothing pushed; re-run after fixing the remote" };
        }
      }
      const pushed = run("git", ["push", "-u", "github", branch], { cwd: repoDir });
      if (!pushed.ok) {
        if (isStaleCredential(pushed)) return { note: "github path chosen: " + target + " — credential stale (401/expired token — re-auth with `gh auth login`): NOTHING pushed; the local capture+commit stands" };
        if (isScopeError(pushed)) return { note: "github path chosen: " + target + " — " + SCOPE_ERROR_NOTE };
        return { note: "github path chosen: " + target + " — `git push -u github " + branch + "` FAILED (" + sanitizedCause(pushed) + "); nothing pushed; re-run after fixing the cause" };
      }
      return { note: "github path chosen: " + target + " — pushed local branch '" + branch + "' to github (" + url + ")" };
    };
  } else {
    const ownerPart = (cred.account ? cred.account + "/" : "") + desc.name; // owner omitted -> the authenticated account qualifies the name
    plan.push("gh repo create " + ownerPart + " --private --source " + repoDir + " --push --remote github");
    execute = () => {
      if (!cred.available) return null;
      const made = run("gh", ["repo", "create", ownerPart, "--private", "--source", repoDir, "--push", "--remote", "github"], { cwd: repoDir });
      if (!made.ok) {
        if (isStaleCredential(made)) return { note: "github path chosen: " + target + " — credential stale (401/expired token — re-auth with `gh auth login`): NOTHING created, NOTHING pushed; the local capture+commit stands" };
        if (isScopeError(made)) return { note: "github path chosen: " + target + " — " + SCOPE_ERROR_NOTE };
        return { note: "github path chosen: " + target + " — `gh repo create` FAILED (" + sanitizedCause(made) + "); nothing created/pushed; re-run after fixing the cause" };
      }
      return { note: "github path chosen: " + target + " — created PRIVATE repo " + ownerPart + " and pushed local branch '" + branch + "' (via --push)" };
    };
  }
  if (dryRun) {
    for (const c of plan) console.log("git_it: DRY-RUN would run: " + c);
    return { note: "DRY-RUN (GIT_IT_DRY_RUN=1): nothing pushed, nothing created — the exact commands it WOULD run (local branch '" + branch + "'):\n" + plan.map((c) => "  " + c).join("\n") };
  }
  const out = execute();
  return out ? out : { note: "github path chosen: " + target + " — " + credentialReplyLine() + "; nothing pushed/created — the local capture+commit stands; re-run after `gh auth login`" };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// pi command registration (registerCommand contract, pi v0.86.x)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function (pi: ExtensionAPI) {
  pi.registerCommand("git_it", {
    description:
      "Deterministic. /git_it --github Tithanium/pi_personal or /git_it path : pi-harness backup: capture ~/.pi/agent + reachable project .pi/ into the backup git repo (default: C:/Users/connessn/pi-harness-backup), enforce hygiene gates G1-G6 (secrets, containment, noise, reproducible fingerprint, size, drift), commit with a deterministic timestamped message, print install/restore instructions. No LLM, no push. Usage: /git_it [repoDir] | /git_it --github <owner>/<repo> (proposal-flow parse, piece 1) | /git_it --github new <name> (parse, piece 1; push lands in pieces 2-3)",
    handler: async (args, ctx) => {
      // [PIECE 1] deterministic arg gate: --github/--gh enters the proposal/choice
      // flow; proposal + usage replies are PURE TEXT answers (no capture, no push,
      // no tokens). Any other arg line = today's exact repo-dir behavior.
      const choice = parseGitHubChoice(typeof args === "string" ? args : "");
      if (choice.kind === "proposal" || choice.kind === "usage") {
        ctx.ui.notify(choice.reply, "info");
        pi.sendUserMessage(choice.reply, { deliverAs: "followUp", expandPromptTemplates: false });
        return choice.reply;
      }
      // [PIECE 1] off mode passes the repo-dir arg through verbatim (identical to
      // today); github modes reuse DEFAULT_REPO_DIR — the repo piece 3 will push.
      const r = await capture(ctx, choice.kind === "off" ? choice.repoDirArg : "", choice.kind === "off" ? null : choice).catch((err: unknown) => {
        if (err instanceof GitItError) throw err;
        throw new GitItError("git_it failed: " + String(err));
      });
      // Round-2 gap 4: the success path RETURNS a text message with the headline /
      // report so it reaches the transcript, and the same text is sent into the
      // session (pi 0.86.x runs command handlers synchronously — sendUserMessage
      // is the channel that places it in the transcript) — not only ctx.ui.notify.
      const reportText =
        r.headline +
        "\nGates G1-G6 PASS. /git_it never pushes — README.md in the repo has the (a) commit+push, (b) fresh-machine, (c) restore + re-enter-provider-keys blocks." +
        (r.githubNote ? "\n" + r.githubNote : "") +
        "\n" + nextStepsPowerShell(r.repoDir).join("\n");
      ctx.ui.notify(r.headline, "info");
      pi.sendUserMessage(reportText, { deliverAs: "followUp", expandPromptTemplates: false });
      return reportText;
    },
  });
}

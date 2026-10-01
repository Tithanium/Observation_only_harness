// src/find_tool.js
// Imported pi tool — the find tool (pi v0.86.1 dist/core/tools/find.js, read
// 2026-10-01), ported to the harness's tool contract: same name, same
// parameters (pattern/path/limit), same default (limit 1000), same output
// (file paths relative to the search directory, posix separators, via pi's
// relativizeFindResultPath), same zero-match answer ("No files found matching
// pattern" — a SUCCESS result, not an error), same notices ("N results limit
// reached. Use limit=…", "50.0KB limit reached"), same error shapes ("Path
// not found: …", "fd is not available and could not be downloaded", the
// abort).
//
// ENGINE ADAPTATION (documented deviation from pi, verified 2026-10-01): pi
// hands the glob to fd (`--glob` + its Windows `--full-path` rewrite). On this
// machine (fd 10.4.2, Windows) that path is empirically BROKEN for the most
// common path patterns: pi's exact rewrite of `sub/**/*.py`
// (`**[/\\]sub[/\\]**[/\\]*.py` with --full-path) MATCHES files in sub/'s
// SUBDIRECTORIES but MISSES the direct children (`sub/c.py` never returned —
// probed: work/_fd_probe.ps1..4, all 16 fd invocations recorded). The cause is
// fd 10.x's globstar separator semantics in --full-path mode, not a port bug —
// pi's own find has the same gap here. So the port keeps fd for what it is
// good at (fast enumeration, .gitignore awareness, --hidden, no
// symlink-follow, pi's --no-require-git git-repo detection loop kept
// verbatim) and applies the GLOB ITSELF in Node with gitignore-style
// semantics ("**" = zero or more path segments; pattern without "/" matches
// the basename; pattern with "/" matches the relative posix path) — the same
// semantics rg's --glob (the grep tool's engine) implements, so find and grep
// agree on what a pattern means. Enumeration is capped (100k files) with a
// notice when the cap is hit.
//
// pi's test-injection branch (options.operations.glob) is NOT ported — the
// harness has no ops-injection flow (its tests drive execute() directly, like
// this file's own probes do).
//
// TWO deliberate harness additions (everything else is pi):
//  1. THE SCOPE GUARD — fail-closed: the resolved search path must be the
//     working folder or inside it (src/scope_guard.js), checked BEFORE any fs
//     work or spawn. pi's find is unrestricted.
//  2. THE BINARY SOURCE — pi's ensureTool ported to src/bin_tools.js with one
//     extra resolution step: pi's OWN bin dir (~/.pi/agent/bin) is checked
//     before PATH so an existing pi install's fd.exe is reused (present on
//     this machine).
//
// Symlink note: fd does not follow directory symlinks by default — a
// junction INSIDE the working folder pointing outside it cannot leak outside
// paths through this tool (see grep_tool.js's symlink note).
import { access as fsAccess, constants } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { typeboxType } from "./pi-ai.js";
import { ensureTool } from "./bin_tools.js";
import { assertWithinRoots, assertRealPathWithinRoots } from "./scope_guard.js";
import { DEFAULT_MAX_BYTES, formatSize, resolveReadPath, truncateHead } from "./read_tool.js";
import { compileGlob, globMatches } from "./glob_match.js";

/** pi's path-utils.js pathExists (the harness's read_tool.js keeps its copy
 *  internal) — F_OK access probe. */
async function pathExists(filePath) {
  try {
    await fsAccess(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Relativize a find result against the search root and normalize it to posix
 *  separators. (pi's relativizeFindResultPath, verbatim.) */
export function relativizeFindResultPath(resultPath, searchPath, pathModule = path) {
  const hadTrailingSeparator = resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
  const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
  const posixPath = relativePath.split(pathModule.sep).join("/");
  return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const DEFAULT_LIMIT = 1000;
/** fd enumeration cap (files) for the Node-side glob filter — bounds memory
 *  on giant trees; a hit is announced in the output ("…narrow the path or
 *  pattern"). The user's `limit` still caps the RESULTS. */
const ENUM_CAP = 100_000;

// The gitignore-style glob matcher (compileGlob/globMatches) lives in
// src/glob_match.js — SHARED with the grep tool so both agree on what a
// pattern means (see that file's header for the semantics + the empirical
// reasons the engines' own --glob filtering is bypassed on this machine).

export async function createFindTool(cwd) {
  const Type = await typeboxType();
  // pi's schema, verbatim.
  const findSchema = Type.Object({
    pattern: Type.String({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
  });
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). SCOPED: the search path must be the working folder or inside it — paths outside are refused (this harness is observation-only).`,
    promptSnippet: "Find files by glob pattern (respects .gitignore, working-folder scoped)",
    parameters: findSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, { pattern, path: searchDir, limit }, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let settled = false;
        let stopChild;
        const settle = (fn) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          stopChild = undefined;
          fn();
        };
        const onAbort = () => {
          stopChild?.();
          settle(() => reject(new Error("Operation aborted")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        (async () => {
          try {
            const searchPath = await resolveReadPath(searchDir || ".", cwd);
            // THE scope guard (harness addition): fail-closed, before any fs
            // work or spawn — working folder only. The realpath re-check closes
            // the symlink/junction-escape class (2026-10-01 audit §4.1): an
            // explicit search path that IS a link is followed by fd, so the
            // REAL target must be in scope too (links to targets inside pass;
            // a missing path returns silently here — fd produces the error).
            assertWithinRoots(searchPath, [cwd], "find");
            await assertRealPathWithinRoots(searchPath, [cwd], "find");
            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            const fdPath = await ensureTool("fd");
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            if (!fdPath) {
              settle(() => reject(new Error("fd is not available and could not be downloaded")));
              return;
            }
            // pi's fd args, verbatim — including the git-repo detection loop
            // (fd normally ignores .gitignore outside git repos, so keep
            // --no-require-git there; inside repos use fd's default git-aware
            // behavior so parent .gitignore rules stop at nested repo
            // boundaries: https://github.com/earendil-works/pi/issues/5960).
            // NOTE: no --glob (the engine adaptation — see below): fd runs in
            // its default REGEX mode with pattern "." (every non-empty name =
            // enumerate all files).
            const args = ["--color=never", "--hidden"];
            let insideGitRepo = false;
            for (let current = searchPath;;) {
              if (await pathExists(path.join(current, ".git"))) {
                insideGitRepo = true;
                break;
              }
              const parent = path.dirname(current);
              if (parent === current) break;
              current = parent;
            }
            if (!insideGitRepo) args.push("--no-require-git");
            // THE ENGINE ADAPTATION (see file header): NO glob is passed to fd
            // (its 10.x --full-path globbing is broken on Windows for the
            // common path patterns). fd only ENUMERATES (pattern "." = every
            // non-empty name; capped at ENUM_CAP); the glob is applied in Node
            // with gitignore-style semantics.
            const compiled = compileGlob(pattern);
            args.push("--max-results", String(ENUM_CAP));
            args.push("--", ".", searchPath);
            const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            const lines = [];
            stopChild = () => {
              if (!child.killed) child.kill();
            };
            const cleanup = () => {
              rl.close();
            };
            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            rl.on("line", (line) => {
              lines.push(line);
            });
            child.on("error", (error) => {
              cleanup();
              settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
            });
            child.on("close", (code) => {
              cleanup();
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const output = lines.join("\n");
              if (code !== 0) {
                const errorMsg = stderr.trim() || `fd exited with code ${code}`;
                if (!output) {
                  settle(() => reject(new Error(errorMsg)));
                  return;
                }
              }
              if (!output) {
                settle(() => resolve({ content: [{ type: "text", text: "No files found matching pattern" }], details: undefined }));
                return;
              }
              // Relativize paths against the search root for stable output (pi
              // — kept), then apply the Node-side gitignore-style glob filter
              // (the engine adaptation — fd enumerated, Node selects).
              const matched = [];
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "").trim();
                if (!line) continue;
                const relativizedPath = relativizeFindResultPath(line, searchPath);
                // "./x/y" → "x/y" (fd emits a "./" prefix for relative search
                // roots; the matcher anchors at the search root).
                const clean = relativizedPath.replace(/^\.\//, "").replace(/\/$/, "");
                const basename = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
                if (globMatches(compiled, clean, basename)) matched.push(relativizedPath);
                if (matched.length >= effectiveLimit) break;
              }
              // Enumerated files exist but NONE match the pattern → the same
              // zero-result contract as fd returning nothing (a SUCCESS text,
              // not an error — pi's "No files found matching pattern").
              if (matched.length === 0) {
                settle(() => resolve({ content: [{ type: "text", text: "No files found matching pattern" }], details: undefined }));
                return;
              }
              const resultLimitReached = matched.length >= effectiveLimit;
              const rawOutput = matched.join("\n");
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let resultOutput = truncation.content;
              const details = {};
              const notices = [];
              if (resultLimitReached) {
                notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.resultLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (lines.length >= ENUM_CAP) {
                notices.push(`${ENUM_CAP} file enumeration cap reached — results may be incomplete; narrow the path or pattern`);
                details.enumCapReached = ENUM_CAP;
              }
              if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;
              settle(() => resolve({ content: [{ type: "text", text: resultOutput }], details: Object.keys(details).length > 0 ? details : undefined }));
            });
          } catch (e) {
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            const error = e instanceof Error ? e : new Error(String(e));
            settle(() => reject(error));
          }
        })();
      });
    },
  };
}

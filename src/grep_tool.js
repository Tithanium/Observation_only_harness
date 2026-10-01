// src/grep_tool.js
// Imported pi tool — the grep tool (pi v0.86.1 dist/core/tools/grep.js, read
// 2026-10-01), ported 1:1 to the harness's tool contract: same name, same
// parameters (pattern/path/glob/ignoreCase/literal/context/limit), same
// defaults (limit 100), same engine (spawn ripgrep `--json --line-number
// --color=never --hidden`), same match formatting (`relPath:line: text`,
// context lines `relPath-line- text`), same long-line truncation (500 chars,
// the shared truncateLine), same notices ("N matches limit reached. Use
// limit=…", "50.0KB limit reached", "Some lines truncated…"), same zero-match
// answer ("No matches found" — a SUCCESS result, not an error), same
// error shapes ("Path not found: …", "ripgrep (rg) is not available and could
// not be downloaded", the abort).
//
// TWO deliberate harness additions (everything else is pi):
//  1. THE SCOPE GUARD — fail-closed: the resolved search path must be the
//     working folder or inside it (src/scope_guard.js). pi's grep is
//     unrestricted; the observation-only harness refuses paths outside the
//     working folder BEFORE any fs work or spawn.
//  2. THE BINARY SOURCE — pi's ensureTool (own bin → PATH → GitHub download)
//     ported to src/bin_tools.js with one extra resolution step: pi's OWN bin
//     dir (~/.pi/agent/bin) is checked before PATH so an existing pi install's
//     rg.exe is reused (present on this machine).
//
// Symlink note: rg does not follow directory symlinks by default — a
// junction INSIDE the working folder pointing outside it therefore cannot leak
// outside content through this tool (the scope guard is a path-prefix check,
// not a realpath check; the engine's no-symlink-follow closes that gap — same
// effective guarantee as the walk-skip the pure-Node fallback would use).
//
// THIRD harness addition — .gitignore OUTSIDE git repos (verified 2026-10-01,
// rg 15.1.0): modern ripgrep respects .gitignore only INSIDE a git repo by
// default (probe: work/_rg_probe.ps1 — outside a repo the .gitignore'd file
// WAS searched; with --no-require-git it is excluded, exactly like inside one).
// pi's grep args predate that default, so pi's grep silently loses its
// "Respects .gitignore" contract outside repos on this machine. The port adds
// the SAME git-repo detection loop find uses + `--no-require-git` outside a
// repo, keeping the description's contract true everywhere and grep/find in
// agreement. (Inside a repo the args stay pi-verbatim.)
//
// FOURTH harness addition — the `glob` parameter is applied in NODE
// (src/glob_match.js, the SAME matcher the find tool uses) instead of rg's
// --glob: verified 2026-10-01 (rg 15.1.0, work/_rg_probe3.ps1) that rg's
// --glob matches ANCHORED against the absolute slash-normalized path — a
// path-prefixed pattern (sub + "/" + "*.md") NEVER matches (the candidate
// starts at the drive letter), and the dir-globstar shape misses the direct
// children (the same double-separator gap as fd 10.x's --full-path). rg
// keeps its content search + binary skip + .gitignore; the file filter moves
// to the shared Node matcher, so grep and find agree on patterns.

/** pi's path-utils.js pathExists (find_tool.js keeps its own copy). */
async function pathExists(filePath) {
  try {
    await fsAccess(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
import { access as fsAccess, constants } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { typeboxType } from "./pi-ai.js";
import { ensureTool } from "./bin_tools.js";
import { assertWithinRoots, assertRealPathWithinRoots } from "./scope_guard.js";
import { compileGlob, globMatches } from "./glob_match.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, resolveReadPath, truncateHead, truncateLine } from "./read_tool.js";

const DEFAULT_LIMIT = 100;
const defaultGrepOperations = {
  isDirectory: async (p) => (await fsStat(p)).isDirectory(),
  readFile: (p) => fsReadFile(p, "utf-8"),
};

export async function createGrepTool(cwd) {
  const Type = await typeboxType();
  // pi's schema, verbatim (parameter names + descriptions are the model's
  // contract — pi's wording, kept).
  const grepSchema = Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
  });
  const ops = defaultGrepOperations;
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. SCOPED: the search path must be the working folder or inside it — paths outside are refused (this harness is observation-only).`,
    promptSnippet: "Search file contents for patterns (respects .gitignore, working-folder scoped)",
    parameters: grepSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let settled = false;
        const settle = (fn) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        (async () => {
          try {
            const rgPath = await ensureTool("rg");
            if (!rgPath) {
              settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
              return;
            }
            const searchPath = await resolveReadPath(searchDir || ".", cwd);
            // THE scope guard (harness addition): fail-closed, before any fs
            // work or spawn — working folder only.
            assertWithinRoots(searchPath, [cwd], "grep");
            let isDirectory;
            try {
              isDirectory = await ops.isDirectory(searchPath);
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }
            // Symlink/junction escape (2026-10-01 audit §4.1): an engine given
            // an explicit search path that IS a link follows it — require the
            // REAL target to be in scope too (links to targets inside pass).
            await assertRealPathWithinRoots(searchPath, [cwd], "grep");
            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
            const formatPath = (filePath) => {
              if (isDirectory) {
                const relative = path.relative(searchPath, filePath);
                if (relative && !relative.startsWith("..")) {
                  return relative.replace(/\\/g, "/");
                }
              }
              return path.basename(filePath);
            };
            const fileCache = new Map();
            const getFileLines = async (filePath) => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await ops.readFile(filePath);
                  lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };
            // pi's rg args, verbatim — plus the .gitignore-outside-repo fix
            // (see file header): the git-repo detection loop find uses, and
            // `--no-require-git` when the search root is outside a repo.
            const args = ["--json", "--line-number", "--color=never", "--hidden"];
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
            if (ignoreCase) args.push("--ignore-case");
            if (literal) args.push("--fixed-strings");
            // NO --glob to rg (the FOURTH addition — see file header): the
            // gitignore-style file filter runs in Node, shared with find.
            const compiledGlob = glob ? compileGlob(glob) : undefined;
            args.push("--", pattern, searchPath);
            const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            let aborted = false;
            let killedDueToLimit = false;
            const outputLines = [];
            const cleanup = () => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
            };
            const stopChild = (dueToLimit = false) => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit;
                child.kill();
              }
            };
            const onAbort = () => {
              aborted = true;
              stopChild();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            const formatBlock = async (filePath, lineNumber) => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
              const block = [];
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
              const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const isMatchLine = current === lineNumber;
                // Truncate long lines so grep output stays compact. (pi)
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
                else block.push(`${relativePath}-${current}- ${truncatedText}`);
              }
              return block;
            };
            // Collect matches during streaming, then format them after rg exits. (pi)
            const matches = [];
            rl.on("line", (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) return;
              let event;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              if (event.type === "match") {
                const filePath = event.data?.path?.text;
                const lineNumber = event.data?.line_number;
                if (!filePath || typeof lineNumber !== "number") return;
                // THE NODE-SIDE GLOB FILTER (gitignore-style — shared with the
                // find tool): skip matches in files the glob excludes. For a
                // single-file search the candidate is the file's basename.
                if (compiledGlob) {
                  const rel = isDirectory ? path.relative(searchPath, filePath) : "";
                  const clean = (rel || path.basename(filePath)).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
                  const baseName = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
                  if (!globMatches(compiledGlob, clean, baseName)) return;
                }
                matchCount++;
                const lineText = event.data?.lines?.text;
                matches.push({ filePath, lineNumber, lineText });
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  stopChild(true);
                }
              }
            });
            child.on("error", (error) => {
              cleanup();
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            child.on("close", async (code) => {
              cleanup();
              if (aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                settle(() => reject(new Error(errorMsg)));
                return;
              }
              if (matchCount === 0) {
                settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }));
                return;
              }
              // Format matches after streaming finishes (pi's comment, kept).
              for (const match of matches) {
                if (contextValue === 0 && match.lineText !== undefined) {
                  const relativePath = formatPath(match.filePath);
                  const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
                  const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                  if (wasTruncated) linesTruncated = true;
                  outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
                } else {
                  const block = await formatBlock(match.filePath, match.lineNumber);
                  outputLines.push(...block);
                }
              }
              const rawOutput = outputLines.join("\n");
              // Apply byte truncation. There is no line limit here because the
              // match limit already capped rows. (pi)
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let output = truncation.content;
              const details = {};
              // Build actionable notices for truncation and match limits. (pi)
              const notices = [];
              if (matchLimitReached) {
                notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                details.matchLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (linesTruncated) {
                // pi's notice says "Use read tool…" — this harness's read tool
                // is named fetch (the read+fetch consolidation), so the hint is
                // adapted; everything else in the notice is pi's wording.
                notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use fetch to see full lines`);
                details.linesTruncated = true;
              }
              if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
              settle(() => resolve({ content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined }));
            });
          } catch (err) {
            settle(() => reject(err));
          }
        })();
      });
    },
  };
}

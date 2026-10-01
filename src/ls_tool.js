// src/ls_tool.js
// Imported pi tool — the ls tool (pi v0.86.1 dist/core/tools/ls.js, read
// 2026-10-01), ported to the harness's tool contract: same name, same
// parameters (path/limit), same default (limit 500), same listing logic —
// REUSED from the fetch tool (listFolderLikeLs, exported 2026-10-01): the
// harness's fetch tool already carried pi's ls logic verbatim in its folder
// branch, so the import reuses that ONE implementation instead of duplicating
// it (one code path, two entry points — pi's own ls and fetch coexist the
// same way). Same output (entries sorted case-insensitively, "/" suffix on
// directories, dotfiles included, "(empty directory)"), same error shapes
// ("Path not found: …", "Not a directory: …", "Cannot read directory: …"),
// same notices ("N entries limit reached. Use limit=…", "50.0KB limit
// reached").
//
// THE ONE deliberate harness addition: THE SCOPE GUARD — fail-closed: the
// resolved directory must be the working folder or inside it
// (src/scope_guard.js), checked BEFORE any fs work. pi's ls is unrestricted.
import { typeboxType } from "./pi-ai.js";
import { assertWithinRoots, assertRealPathWithinRoots } from "./scope_guard.js";
import { listFolderLikeLs } from "./fetch_tool.js";
import { resolveReadPath, DEFAULT_MAX_BYTES } from "./read_tool.js";

const DEFAULT_LIMIT = 500;

export async function createLsTool(cwd) {
  const Type = await typeboxType();
  // pi's schema, verbatim.
  const lsSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  });
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). SCOPED: the directory must be the working folder or inside it — paths outside are refused (this harness is observation-only).`,
    promptSnippet: "List directory contents (working-folder scoped)",
    parameters: lsSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, { path, limit }, signal) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const dirPath = await resolveReadPath(path || ".", cwd);
      // THE scope guard (harness addition): fail-closed, before any fs work —
      // working folder only.
      assertWithinRoots(dirPath, [cwd], "ls");
      // Symlink/junction escape (2026-10-01 audit §4.1): a link inside the work
      // folder pointing outside passes the lexical guard — require the REAL
      // target directory to be in scope too (links to targets inside pass).
      await assertRealPathWithinRoots(dirPath, [cwd], "ls");
      return listFolderLikeLs(dirPath, limit, cwd);
    },
  };
}

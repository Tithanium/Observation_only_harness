// src/scope_guard.js
// THE working-folder scope guard — the observation-only harness's path policy,
// shared by the fetch tool (round 3/4) and the imported pi tools grep/find/ls
// (2026-10-01). A RESOLVED path is allowed only if it is one of the allowed
// roots or inside one of them. Fail-closed: anything outside throws, and the
// thrown Error's message becomes the tool result's text (isError true) — the
// model sees the refusal and adapts.
//
// Semantics:
//  - comparison is CASE-INSENSITIVE (Windows fs is; the harness runs on Windows
//    and must not let "C:\X" escape the "c:\x" root by letter case);
//  - a root's trailing separator is tolerated ("C:\work\" == "C:\work");
//  - the root ITSELF is allowed (grep/find/ls on the working folder root);
//  - separators are checked in BOTH directions ("/" and "\") because resolved
//    paths are backslashed on win32 while a hand-built root could carry "/".
//
// The guard is a PREFIX check on the RESOLVED path (pi's tools resolve before
// any fs work; so do we — `..` that escapes the root is caught because
// path.resolve normalizes it away from the root prefix). The lexical check is
// NOT a symlink check: a link/junction INSIDE the root that points outside it
// has a link path that is inside the root. assertRealPathWithinRoots (below)
// closes that class — each tool entry point re-checks the path's REAL location
// (following links) against the roots, so a link to a target inside the root
// still passes while a link out is refused with the same fail-closed error.
// The walking engines additionally skip symlinked entries during traversal
// (rg/fd do not follow directory symlinks without --follow/-L — same behavior).

import { resolve as nodeResolve } from "node:path";
import { realpath as fsRealpath } from "node:fs/promises";

/** Normalize a root for prefix comparison: absolute, no trailing separator,
 *  lowercased. */
export function normalizeRoot(root) {
  return nodeResolve(root).replace(/[/\\]+$/, "").toLowerCase();
}

/** True when `resolved` is one of `roots` or inside one of them. */
export function isWithinRoots(resolved, roots) {
  const lower = String(resolved).toLowerCase();
  return (roots ?? []).some((root) => {
    const r = normalizeRoot(root);
    return lower === r || lower.startsWith(r + "/") || lower.startsWith(r + "\\");
  });
}

/** Throw a fail-closed refusal for a path outside the allowed roots. The
 *  message names the offending path AND the boundary, so the model can fix its
 *  next call (pi's error-shape philosophy: actionable, not a bare "denied"). */
export function assertWithinRoots(resolved, roots, label) {
  if (!isWithinRoots(resolved, roots)) {
    throw new Error(
      `${label}: path '${resolved}' is outside the allowed folder(s) [${roots.join(", ")}] — ` +
        `this harness is observation-only and scoped to them; refusing`
    );
  }
}

/** Close the symlink class the lexical prefix check cannot see (2026-10-01
 *  read-only audit, §4.1): resolve `p`'s REAL location (following
 *  symlinks/junctions) and require IT to be within the roots as well. A link
 *  whose target is inside a root passes (legitimate behavior preserved); a
 *  link out throws the same fail-closed refusal as a direct outside path.
 *  ENOENT → return (the path does not exist — the caller's own existence
 *  check produces the proper "Path not found" error shape); any other
 *  realpath failure (EACCES, ELOOP, …) → rethrow (fail-closed). */
export async function assertRealPathWithinRoots(p, roots, label) {
  let real;
  try {
    real = await fsRealpath(p);
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  assertWithinRoots(real, roots, label);
}

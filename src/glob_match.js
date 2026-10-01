// src/glob_match.js
// Shared gitignore-style glob matcher — used by BOTH imported pi tools
// (grep_tool.js and find_tool.js, 2026-10-01) so they agree on what a pattern
// means. Why Node-side matching instead of rg's --glob / fd's --glob (the
// engines' own filtering): verified 2026-10-01 on this machine (rg 15.1.0,
// fd 10.4.2, probes work/_rg_probe3.ps1 + work/_fd_probe.ps1..4):
//   - fd 10.x --full-path: pi's exact rewrite of the common pattern
//     "dir-globstar-ext" (e.g. sub/** + / + *.py) matches files in the
//     directory's SUBDIRECTORIES but misses the DIRECT children;
//   - rg 15 --glob: matched ANCHORED against the absolute (slash-normalized)
//     path, so a path-prefixed pattern (e.g. sub/*.md) never matches at all
//     (the candidate starts at the drive letter), and the dir-globstar form
//     misses direct children for the same double-separator reason.
// Both engines' own globbing is therefore broken for the pattern shapes the
// schema advertises ("*.ts", "dir-globstar/*.json", "src/dir-globstar/*.spec.ts").
// The engines keep their jobs (rg: content search + binary skip +
// .gitignore; fd: fast enumeration + .gitignore + hidden); the GLOB is
// applied here, in Node, with the gitignore semantics the models expect.
//
// Semantics (the gitignore `**` rules — documented in both tools' descriptions
// and this header):
//   - "**" as a whole segment = ZERO OR MORE path segments (so the pattern
//     "sub/" + "**" + "/*.py" matches sub/c.py AND sub/deep/c.py);
//   - "*" = any run of non-separator characters (never crosses "/");
//   - "?" = one non-separator character;
//   - "[!abc]" / "[abc]" = character classes (gitignore negation is "!");
//   - a pattern WITHOUT "/" is matched against the BASENAME; a pattern WITH
//     "/" against the full relative path (posix, anchored, whole-string).
// The matcher covers the shapes models actually emit; exotic patterns degrade
// to a literal-ish match rather than an error (never a false match of
// separators).

/** Escape a literal character for embedding in a RegExp. */
function escapeLiteral(c) {
  return c.replace(/\\/, "\\\\").replace(/[$().|{}+^]/g, "\\$&");
}

/** Compile a gitignore-style glob pattern to { regex, hasSlash } (see the
 *  file header for the semantics). */
export function compileGlob(pattern) {
  let p = String(pattern).replace(/^\.\//, "");
  let re = "^";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // globstar: "**/" (or a leading bare "**") = zero or more full segments
        re += "(?:[^/]+/)*";
        i += 2;
        if (p[i] === "/") i += 1; // swallow the following separator if present
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      let j = i + 1;
      let cls = "";
      if (p[j] === "!") { cls = "^"; j += 1; }
      let closed = false;
      while (j < p.length) {
        if (p[j] === "]") { closed = true; break; }
        cls += p[j].replace(/\^/g, "\\^");
        j += 1;
      }
      if (closed) { re += `[${cls}]`; i = j + 1; }
      else { re += "\\["; i += 1; } // unterminated class → literal "["
    } else {
      re += escapeLiteral(c);
      i += 1;
    }
  }
  re += "$";
  return { regex: new RegExp(re), hasSlash: String(pattern).includes("/") };
}

/** True when the candidate matches the compiled pattern. `relativePosix` is
 *  the file path relative to the search root (posix separators, no leading
 *  "./"); `basename` its last segment. Slash-less patterns match the
 *  basename, patterns with a slash match the full relative path. */
export function globMatches(compiled, relativePosix, basename) {
  const target = compiled.hasSlash ? relativePosix : basename;
  return compiled.regex.test(target);
}

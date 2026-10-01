// work/probe-grep-find-ls.mjs — probe suite for the imported pi tools
// (grep/find/ls, src/{grep_tool,find_tool,ls_tool}.js) + the fetch scope guard
// (src/scope_guard.js via src/fetch_tool.js) + the binary resolution
// (src/bin_tools.js). Run: node work/probe-grep-find-ls.mjs
//
// The temp tree lives OUTSIDE the git repo (C:\Users\connessn\probe_gfl_tree)
// so .gitignore behavior is deterministic: the tree carries its OWN .gitignore
// (ignoring ignored.txt) and no enclosing repo rules interfere. The probe
// asserts the tree's parent chain is NOT inside any git repo and FAILS loudly
// otherwise. Self-cleans (tree + dot dir removed) in `finally`.
//
// The find engine adaptation (Node-side gitignore-style glob over fd's
// enumeration) is verified here: "sub/**/*.py" must return the DIRECT child
// sub/c.py (the case fd 10.4.2's --full-path rewrite misses — see
// src/find_tool.js header) AND the deep file sub/deep/e.py.
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.USERPROFILE ?? "C:\\Users\\connessn";
const TREE = join(HOME, "probe_gfl_tree");
const DOT = join(HOME, "probe_gfl_dot");
const OUTSIDE = join(HOME, "probe_gfl_outside"); // junction target OUTSIDE the tree (symlink-escape fixture)
process.env.OBSERVATION_ONLY_DIR = DOT; // isolated dot dir — userDotDir() honours it at call time

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL ${name} ${extra}`);
  }
}
const text = (r) => (r?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
async function expectTool(name, tool, args, { ctx = { cwd: TREE }, signal } = {}) {
  try {
    const r = await tool.execute("probe-id", args, signal, undefined, ctx);
    return { ok: true, r };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Build the deterministic temp tree. */
function buildTree() {
  rmSync(TREE, { recursive: true, force: true });
  rmSync(DOT, { recursive: true, force: true });
  const R = TREE;
  const dirs = [
    join(R, "sub", "deep"),
    join(R, "node_modules"),
    join(DOT, "skills", "test-skill"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const files = {
    [join(R, "a.txt")]: "hello world\nsecond line\n",
    [join(R, "sub", "b.md")]: "alpha beta\nGamma\n",
    [join(R, "sub", "c.py")]: "def f():\n    return 'alpha alpha'\n",
    [join(R, "sub", "deep", "d.json")]: "line1\n{\"key\": \"delta\"}\nline3\n",
    [join(R, ".hidden.txt")]: "hidden alpha\n",
    [join(R, "ignored.txt")]: "alpha ignored\n",
    [join(R, ".gitignore")]: "ignored.txt\n",
    [join(R, "node_modules", "skip.js")]: "alpha in node_modules\n",
    [join(R, "sub", "deep", "e.py")]: "deep py\n",
    [join(R, "longline.txt")]: `pre ${"x".repeat(600)} longneedle\n`,
    [join(DOT, "skills", "test-skill", "SKILL.md")]: "---\nname: test-skill\ndescription: probe skill\n---\nSKILL BODY alpha\n",
  };
  for (const [p, c] of Object.entries(files)) writeFileSync(p, c, "utf-8");
  // A real binary (NUL bytes): rg must classify it as binary and NOT match.
  writeFileSync(join(R, "data.bin"), Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from("alpha binary\n"), Buffer.from([0x00])]));
  // Escape target OUTSIDE the tree (fetch guard negative).
  writeFileSync(join(HOME, "probe_gfl_escape.txt"), "outside alpha\n");
  // Symlink/junction-escape fixtures (2026-10-01 audit §4.1): a junction
  // INSIDE the tree pointing OUTSIDE it (must be refused by every tool) and
  // one pointing to a dir INSIDE the tree (must keep working).
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(OUTSIDE, "outside.txt"), "outside alpha\n");
  symlinkSync(OUTSIDE, join(R, "link_out"), "junction");
  symlinkSync(join(R, "sub"), join(R, "link_in"), "junction");
}

/** The tree's PARENT chain must NOT be inside a git repo (deterministic
 *  --no-require-git mode). Starts at the parent — the tree itself carries a
 *  .git FIXTURE on purpose (rg never searches inside .git; we assert that). */
function assertNotInGitRepo() {
  for (let p = TREE.replace(/[\\/][^/\\]+$/, ""); p.length >= 3; p = p.replace(/[\\/][^/\\]+$/, "")) {
    if (existsSync(join(p, ".git"))) return false;
    if (!p.includes("\\")) break;
  }
  return true;
}

buildTree();
try {
  if (!assertNotInGitRepo()) throw new Error("probe tree is inside a git repo — results would not be deterministic; move the tree");

  // Import AFTER env + tree are ready (userDotDir honours OBSERVATION_ONLY_DIR at call time).
  const { createGrepTool } = await import("../src/grep_tool.js");
  const { createFindTool } = await import("../src/find_tool.js");
  const { createLsTool } = await import("../src/ls_tool.js");
  const { createFetchTool } = await import("../src/fetch_tool.js");
  const { getToolPath } = await import("../src/bin_tools.js");

  const grepTool = await createGrepTool(TREE);
  const findTool = await createFindTool(TREE);
  const lsTool = await createLsTool(TREE);
  const fetchTool = await createFetchTool(TREE);

  // ── binary resolution (pi's ensureTool chain, no download expected) ──────
  const rgPath = getToolPath("rg");
  const fdPath = getToolPath("fd");
  check("bin: rg resolves", typeof rgPath === "string" && rgPath.length > 0, `got ${rgPath}`);
  check("bin: fd resolves", typeof fdPath === "string" && fdPath.length > 0, `got ${fdPath}`);
  console.log(`INFO rg=${rgPath} fd=${fdPath}`);

  // ── ls ────────────────────────────────────────────────────────────────────
  {
    const r = await expectTool("ls", lsTool, {});
    const t = text(r.r);
    check("ls: root lists files+dirs", r.ok && t.includes("a.txt") && t.includes("sub/") && t.includes("node_modules/") && t.includes(".hidden.txt"), t.slice(0, 200));
    const r2 = await expectTool("ls", lsTool, { path: "sub" });
    const t2 = text(r2.r);
    check("ls: subdir", r2.ok && t2.includes("b.md") && t2.includes("c.py") && t2.includes("deep/"), t2);
    const r3 = await expectTool("ls", lsTool, { path: "sub", limit: 2 });
    const t3 = text(r3.r);
    check("ls: limit notice", r3.ok && t3.includes("2 entries limit reached. Use limit=4 for more"), t3);
    const r4 = await expectTool("ls", lsTool, { path: ".." });
    check("ls: scope guard (..)", !r4.ok && r4.error.includes("outside the allowed folder(s)"), r4.error ?? text(r4.r));
    const r5 = await expectTool("ls", lsTool, { path: "C:\\Windows" });
    check("ls: scope guard (absolute outside)", !r5.ok && r5.error.includes("outside the allowed folder(s)"), r5.error ?? text(r5.r));
    const r6 = await expectTool("ls", lsTool, { path: "a.txt" });
    check("ls: not a directory", !r6.ok && r6.error.startsWith("Not a directory:"), r6.error ?? text(r6.r));
    const r7 = await expectTool("ls", lsTool, { path: "nope" });
    check("ls: path not found", !r7.ok && r7.error.startsWith("Path not found:"), r7.error ?? text(r7.r));
  }

  // ── grep ──────────────────────────────────────────────────────────────────
  {
    const r = await expectTool("grep", grepTool, { pattern: "alpha", literal: true });
    const t = text(r.r);
    const has = (s) => t.includes(s);
    check(
      "grep: literal root matches (hidden + node_modules, gitignore respected)",
      r.ok && has(".hidden.txt:1: hidden alpha") && has("node_modules/skip.js:1: alpha in node_modules") && has("sub/b.md:1: alpha beta") && has("sub/c.py:2:     return 'alpha alpha'") && !t.includes("ignored.txt"),
      t
    );
    const rG = await expectTool("grep", grepTool, { pattern: "alpha", glob: "sub/**/*.md" });
    const tG = text(rG.r);
    // rg --glob gitignore semantics: "**" = zero or more segments → the DIRECT
    // child sub/b.md must match (this is the case fd 10.x's --full-path misses).
    check("grep: glob sub/**/*.md direct child", rG.ok && tG.includes("sub/b.md:1: alpha beta") && !tG.includes("c.py") && !tG.includes("skip.js"), tG);
    const r2 = await expectTool("grep", grepTool, { pattern: "alpha", glob: "*.md" });
    const t2 = text(r2.r);
    check("grep: glob *.md", r2.ok && t2.includes("sub/b.md:1: alpha beta") && !t2.includes("c.py") && !t2.includes("skip.js"), t2);
    const r3 = await expectTool("grep", grepTool, { pattern: "GAMMA", ignoreCase: true });
    const t3 = text(r3.r);
    check("grep: ignoreCase matches Gamma", r3.ok && t3.includes("sub/b.md:2: Gamma"), t3);
    const r3b = await expectTool("grep", grepTool, { pattern: "GAMMA" });
    check("grep: control — GAMMA without ignoreCase = no match", r3b.ok && text(r3b.r) === "No matches found", r3b.error ?? text(r3b.r));
    const r4 = await expectTool("grep", grepTool, { pattern: "delta", context: 1, path: "sub/deep" });
    const t4 = text(r4.r);
    // pi's formatPath relativizes against the SEARCH PATH → paths are relative
    // to sub/deep (bare file name at the search root).
    check("grep: context lines (relative to search root)", r4.ok && t4.includes("d.json-1- line1") && t4.includes("d.json:2: {\"key\": \"delta\"}") && t4.includes("d.json-3- line3"), t4);
    const r5 = await expectTool("grep", grepTool, { pattern: "nonexistent-word-xyz" });
    check("grep: zero matches = success text", r5.ok && text(r5.r) === "No matches found", r5.error ?? text(r5.r));
    const r6 = await expectTool("grep", grepTool, { pattern: "[invalid(" });
    check("grep: invalid regex = error", !r6.ok && /regex/i.test(r6.error), r6.error ?? text(r6.r));
    const r7 = await expectTool("grep", grepTool, { pattern: "alpha", limit: 2 });
    const t7 = text(r7.r);
    const matchLines = t7.split("\n").filter((l) => /:\d+: /.test(l)).length;
    check("grep: limit notice", r7.ok && t7.includes("2 matches limit reached. Use limit=4 for more, or refine pattern") && matchLines <= 2, t7);
    const r8 = await expectTool("grep", grepTool, { pattern: "longneedle", path: "longline.txt" });
    const t8 = text(r8.r);
    check("grep: single-file basename + line truncation", r8.ok && t8.includes("longline.txt:1: ") && t8.includes("... [truncated]") && t8.includes("Some lines truncated to 500 chars"), t8.slice(0, 300));
    const r9 = await expectTool("grep", grepTool, { pattern: "alpha", path: ".." });
    check("grep: scope guard (..)", !r9.ok && r9.error.includes("outside the allowed folder(s)"), r9.error ?? text(r9.r));
    const r10 = await expectTool("grep", grepTool, { pattern: "alpha", path: "C:\\Windows" });
    check("grep: scope guard (absolute outside)", !r10.ok && r10.error.includes("outside the allowed folder(s)"), r10.error ?? text(r10.r));
    const ac = new AbortController();
    ac.abort();
    const r11 = await expectTool("grep", grepTool, { pattern: "alpha" }, { signal: ac.signal });
    check("grep: pre-aborted signal", !r11.ok && r11.error === "Operation aborted", r11.error ?? text(r11.r));
  }

  // ── find ──────────────────────────────────────────────────────────────────
  {
    const r = await expectTool("find", findTool, { pattern: "*.md" });
    const t = text(r.r);
    check("find: *.md at any depth (gitignore respected: no ignored.md noise)", r.ok && t.split("\n").filter(Boolean).length === 1 && t.includes("sub/b.md"), t);
    const r2 = await expectTool("find", findTool, { pattern: "**/*.json" });
    const t2 = text(r2.r);
    check("find: **/*.json", r2.ok && t2.includes("sub/deep/d.json"), t2);
    const r3 = await expectTool("find", findTool, { pattern: "sub/**/*.py" });
    const t3 = text(r3.r);
    // "**" = zero or more segments: BOTH the direct child (sub/c.py — the case
    // fd 10.x's --full-path misses) AND the deep file (sub/deep/e.py).
    check("find: path pattern sub/**/*.py (direct child + deep)", r3.ok && t3.includes("sub/c.py") && t3.includes("sub/deep/e.py"), t3);
    const r3b = await expectTool("find", findTool, { pattern: "*.py" });
    const t3b = text(r3b.r);
    check("find: *.py at any depth", r3b.ok && t3b.includes("sub/c.py") && t3b.includes("sub/deep/e.py") && !t3b.includes("a.txt"), t3b);
    const r4 = await expectTool("find", findTool, { pattern: "*.txt" });
    const t4 = text(r4.r);
    check("find: *.txt (hidden included, gitignored excluded)", r4.ok && t4.includes("a.txt") && t4.includes(".hidden.txt") && t4.includes("longline.txt") && !t4.includes("ignored.txt"), t4);
    const r5 = await expectTool("find", findTool, { pattern: "zzz-nope" });
    check("find: zero results = success text", r5.ok && text(r5.r) === "No files found matching pattern", r5.error ?? text(r5.r));
    const r6 = await expectTool("find", findTool, { pattern: "*.txt", path: ".." });
    check("find: scope guard (..)", !r6.ok && r6.error.includes("outside the allowed folder(s)"), r6.error ?? text(r6.r));
    const r7 = await expectTool("find", findTool, { pattern: "*.js" });
    const t7 = text(r7.r);
    check("find: node_modules searched (not gitignored)", r7.ok && t7.includes("node_modules/skip.js"), t7);
  }

  // ── fetch scope guard ─────────────────────────────────────────────────────
  {
    const r = await expectTool("fetch", fetchTool, { url: "a.txt" });
    check("fetch: in-scope file still works", r.ok && text(r.r).includes("hello world"), r.error ?? text(r.r));
    const r2 = await expectTool("fetch", fetchTool, { url: "../probe_gfl_escape.txt" });
    check("fetch: guard blocks .. escape", !r2.ok && r2.error.includes("outside the allowed folder(s)"), r2.error ?? text(r2.r));
    const r3 = await expectTool("fetch", fetchTool, { url: "C:\\Windows\\System32\\drivers\\etc\\hosts" });
    check("fetch: guard blocks absolute outside", !r3.ok && r3.error.includes("outside the allowed folder(s)"), r3.error ?? text(r3.r));
    const r4 = await expectTool("fetch", fetchTool, { url: join(DOT, "skills", "test-skill", "SKILL.md") });
    check("fetch: dot-folder skill file allowed", r4.ok && text(r4.r).includes("SKILL BODY alpha"), r4.error ?? text(r4.r));
    const r5 = await expectTool("fetch", fetchTool, { url: "C:\\Users\\connessn\\VERIFIED_FACTS_PROBE_NOPE.md" });
    check("fetch: guard blocks another user file", !r5.ok && r5.error.includes("outside the allowed folder(s)"), r5.error ?? text(r5.r));
  }

  // ── symlink/junction escape (2026-10-01 audit §4.1 fix) ───────────────────
  {
    const r1 = await expectTool("fetch", fetchTool, { url: "link_out/outside.txt" });
    check("symlink: fetch file via junction-outside refused", !r1.ok && r1.error.includes("outside the allowed folder(s)"), r1.error ?? text(r1.r));
    const r2 = await expectTool("ls", lsTool, { path: "link_out" });
    check("symlink: ls via junction-outside refused", !r2.ok && r2.error.includes("outside the allowed folder(s)"), r2.error ?? text(r2.r));
    const r3 = await expectTool("grep", grepTool, { pattern: "outside", path: "link_out" });
    check("symlink: grep via junction-outside refused", !r3.ok && r3.error.includes("outside the allowed folder(s)"), r3.error ?? text(r3.r));
    const r4 = await expectTool("find", findTool, { pattern: "*.txt", path: "link_out" });
    check("symlink: find via junction-outside refused", !r4.ok && r4.error.includes("outside the allowed folder(s)"), r4.error ?? text(r4.r));
    const r5 = await expectTool("ls", lsTool, { path: "link_in" });
    check("symlink: ls via junction-inside still works", r5.ok && text(r5.r).includes("b.md"), r5.error ?? text(r5.r));
    const r6 = await expectTool("fetch", fetchTool, { url: "link_in/c.py" });
    check("symlink: fetch file via junction-inside still works", r6.ok && text(r6.r).includes("def f():"), r6.error ?? text(r6.r));
    const r7 = await expectTool("fetch", fetchTool, { url: "link_in" });
    check("symlink: fetch folder via junction-inside still works", r7.ok && text(r7.r).includes("b.md"), r7.error ?? text(r7.r));
  }

  // ── subagent tmp-path sanitization (2026-10-01 audit §3 fix) ─────────────
  {
    const { sanitizeAgentFileName } = await import("../src/subagent_tool.js");
    const s = sanitizeAgentFileName("x\\..\\..\\..\\..\\..\\evil");
    check("sanitize: traversal name neutralized to a single path segment", !s.includes("\\") && !s.includes("/") && !s.includes("..") && /^[A-Za-z0-9_-]{1,64}$/.test(s), s);
    check("sanitize: plain name unchanged", sanitizeAgentFileName("worker") === "worker");
    check("sanitize: empty falls back to 'agent'", sanitizeAgentFileName("") === "agent" && sanitizeAgentFileName(undefined) === "agent");
    check("sanitize: long name capped at 64", sanitizeAgentFileName("a".repeat(200)).length === 64);
  }

  // ── session wiring ────────────────────────────────────────────────────────
  {
    const { buildHarnessTools, toolsPromptLines } = await import("../src/session.js");
    const { tools, toolByName } = await buildHarnessTools(TREE);
    const names = tools.map((t) => t.name);
    check("wiring: buildHarnessTools carries the 5 core tools", names.includes("fetch") && names.includes("subagent") && names.includes("grep") && names.includes("find") && names.includes("ls"), names.join(","));
    check("wiring: toolByName resolves the new tools", toolByName.get("grep") === grepTool || (toolByName.get("grep")?.name === "grep"));
    const prompt = toolsPromptLines().join("\n");
    check("wiring: prompt lists five tools + new lines", prompt.includes("You have five tools:") && prompt.includes("- grep —") && prompt.includes("- find —") && prompt.includes("- ls —"), prompt.slice(0, 300));
  }

  // ── subagent worker wiring ────────────────────────────────────────────────
  {
    const { discoverAgents } = await import("../src/agents.js");
    const { agents } = discoverAgents("both");
    const worker = agents.find((a) => a.name === "worker");
    check("worker agent: tools frontmatter = fetch,grep,find,ls", worker && Array.isArray(worker.tools) && worker.tools.join(",") === "fetch,grep,find,ls", JSON.stringify(worker?.tools));
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`FAILED: ${failures.join(" | ")}`);
} finally {
  // Remove the junctions explicitly first (a junction is a link — removing it
  // never touches the target), then the tree itself.
  try { rmSync(join(TREE, "link_out"), { force: true }); } catch { /* best effort */ }
  try { rmSync(join(TREE, "link_in"), { force: true }); } catch { /* best effort */ }
  rmSync(TREE, { recursive: true, force: true });
  rmSync(DOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  try {
    rmSync(join(HOME, "probe_gfl_escape.txt"), { force: true });
  } catch { /* best effort */ }
}
process.exit(fail > 0 ? 1 : 0);

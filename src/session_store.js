// src/session_store.js
// ROUND 17 feature: session saving in the USER DOT-FOLDER — pi's
// `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl` store ported ONTO
// THE HARNESS'S OWN dot-folder (`~/.Observation_only/sessions/...`, env override
// OBSERVATION_ONLY_DIR honoured via userDotDir() — see src/config.js). Same JSONL
// TREE format (header line + one entry per message, id/parentId links, active
// leaf = last appended id), same per-work-dir path encoding (`--` + cwd stripped
// of its leading separator with [/\\:] → '-' + `--`, e.g. C:\Users\x →
// `--C--Users--x--`), and the same append-after-every-turn auto-save with pi's
// EXACT deferred rule: no file is written until the FIRST ASSISTANT message
// (entries buffer in memory; the header + all buffered entries are written at
// that point, then every later entry appends). One entry per message:
//   {type:"session", version:3, id, timestamp, cwd}
//   {type:"message", id (8-hex randomUUID slice), parentId (the previous entry),
//    timestamp (ISO), message:{role, content:[...blocks], timestamp (ms)}}
//   {type:"model_change", id, parentId, timestamp, provider, modelId}
// Reload rebuilds the entries + the active leaf from the file; branch(entryId)
// moves the leaf inside the SAME file (pi's /tree). loadSessionStore() opens an
// existing file for continuation (flushed — appends go straight to disk). The
// one-shot path never touches this module. Never prints secrets.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { userDotDir } from "./config.js";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "./compaction.js";

export const SESSION_VERSION = 3;

/** pi's EXACT cwd → sessions-subdir encoding (dist/core/session-manager.js:
 *  getDefaultSessionDirPath): `--` + cwd stripped of its leading separator with
 *  [/\\:] mapped to '-' + `--`. Windows C:\Users\x → `--C--Users--x--`;
 *  POSIX /home/x → `--home-x--`. */
export function encodeWorkDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** The sessions root under the harness's dot-folder: <userDotDir()>/sessions
 *  (pi: <agentDir>/sessions — this harness's agent dir IS its user dot-folder). */
export function sessionsBaseDir() {
  return join(userDotDir(), "sessions");
}

/** The per-work-dir sessions folder (encoding at call time; the env override
 *  OBSERVATION_ONLY_DIR therefore works from tests and CLI alike). */
export function sessionDirFor(workDir) {
  return join(sessionsBaseDir(), encodeWorkDir(workDir));
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The saved sessions of the CURRENT work dir: one descriptor per <file>.jsonl
 *  under the encoded dir, newest first (the filename's leading ISO timestamp
 *  sorts recency), each with the file's first user-message preview so the picker
 *  can show what the saved conversation is about. Missing/empty sessions dir →
 *  [] (never an error — '/resume: no sessions'). */
export function listSessions(workDir) {
  const dir = sessionDirFor(workDir);
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // timestamp-prefixed names, newest first
  return names.map((name) => {
    const file = join(dir, name);
    let preview = "";
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const raw of lines) {
        const e = parseLine(raw);
        if (e?.type === "message" && e.message?.role === "user") {
          preview = textOfBlocks(e.message.content) || preview;
          break;
        }
      }
    } catch {
      /* an unreadable session file still lists by name */
    }
    return { file, name, preview };
  });
}

function textOfBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => b?.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

/** The stored message is TRANSCRIPT-safe JSON: role + a content array of blocks +
 *  the tool fields the harness transcript uses. The user message stored is the
 *  RAW typed line (pi stores the actual user message — the harness's map door is
 *  added to the in-memory transcript per turn, never to the stored line). */
function normalizeMessage(m) {
  const raw = m ?? {};
  const content = Array.isArray(raw.content) ? raw.content : [{ type: "text", text: String(raw.content ?? "") }];
  const out = { role: raw.role, content, timestamp: raw.timestamp ?? Date.now() };
  const extras = ["toolCallId", "toolName", "isError", "details", "usage", "stopReason", "responseId", "api", "provider", "model"];
  for (const k of extras) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function newEntryId(byId) {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID();
}

/** Shared factory. `file` undefined → a FRESH session (deferred header — nothing
 *  touches the disk until the first assistant message); `file` given → an OPEN
 *  session (resume): already flushed, further entries append to that very file. */
function makeStore(state) {
  const { dir, file, header, sessionId, entries, byId } = state;
  let leafId = state.leafId ?? null;
  let rootId = state.rootId ?? null; // the HEAD entry's id (round 19): the file's ROOT — pi's first line is {type:"message", parentId:null, message:{role:"system", …sections+toolsAdded…}} — the payload of the launch; the first real message is its child; it is NEVER LLM context again (getMessages filters role "system")
  let flushed = Boolean(state.flushed);

  function persist(next) {
    const hasAssistant = entries.some((e) => e.type === "message" && e.message?.role === "assistant");
    if (!hasAssistant) return; // pi's rule: no file is created until the FIRST ASSISTANT message
    if (!flushed) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
      flushed = true;
    } else {
      appendFileSync(file, JSON.stringify(next) + "\n");
    }
  }

  function appendEntry(entry) {
    const e = {
      ...entry,
      id: entry.id ?? newEntryId(byId),
      parentId: entry.parentId ?? leafId ?? rootId, // pi: the first real entry is the HEAD's child (rootId); afterwards the active leaf
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    entries.push(e);
    byId.set(e.id, e);
    leafId = e.id;
    persist(e);
    return e.id;
  }

  /** One message appended as the child of the active leaf (the FIRST one is the
   *  HEAD's child — pi: a fresh session's first user message has parentId =
   *  the head id); the leaf advances. */
  function appendMessage(message) {
    return appendEntry({ type: "message", message: normalizeMessage(message) });
  }

  function appendModelChange(provider, modelId) {
    return appendEntry({ type: "model_change", provider, modelId });
  }

  /** Append a COMPACTION entry as the child of the current leaf, then advance
   *  the leaf (pi's SessionManager.appendCompaction — the exact same shape:
   *  {type:"compaction", summary, firstKeptEntryId, tokensBefore, details,
   *  usage}). The compacted messages stay in the file (history is never
   *  deleted — /tree can navigate back into it); only the LLM CONTEXT they
   *  contribute is cut (getMessages below). */
  function appendCompaction(summary, firstKeptEntryId, tokensBefore, details, usage) {
    return appendEntry({
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      ...(usage !== undefined ? { usage } : {}),
    });
  }

  /** The HEAD entry (round 19): written when the session starts — pi's first
   *  message line is the payload ROOT: role "system" with the harness system
   *  sections + the DECLARED tool schemas (the payload the LLM round trip began
   *  with). It attaches as the root (parentId null), NEVER advances the leaf (the
   *  first real message becomes its child instead), and never counts as the
   *  deferring "assistant" message. A store that already has entries (an
   *  injected store in the suites, a resumed session) stays untouched. */
  function appendHead({ sections = {}, toolsAdded = [] } = {}) {
    if (entries.length > 0 || rootId) return; // only the VERY FIRST entry of a fresh store
    const e = {
      type: "message",
      id: newEntryId(byId),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "system", content: "", sections, toolsAdded, timestamp: Date.now() },
    };
    entries.push(e);
    byId.set(e.id, e);
    rootId = e.id; // leafId stays null — the first real message links to the HEAD (pi's user-message parentId = head id)
  }
  /** Move the active leaf (pi's branch — /tree stays in the SAME file). */
  function branch(targetId) {
    leafId = targetId ?? null;
    return leafId;
  }

  function getEntries() {
    return entries.slice();
  }

  function getEntry(id) {
    return byId.get(id) ?? null;
  }

  function getBranch() {
    const path = [];
    let cur = leafId ? byId.get(leafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  /** The session as a TREE (pi's SessionManager.getTree, dist/core/session-manager.js
   *  ported): one node per entry ({ entry, children: [] }), roots = entries whose
   *  parentId is null/undefined — plus ORPHANS (a broken parent chain) which pi
   *  also returns as roots, so no entry can silently vanish from the tree. Children
   *  are sorted by TIMESTAMP (oldest first, newest at the bottom) — pi's exact
   *  ordering (iterative, deep-tree safe). The /tree picker flattens THIS once:
   *  row and entry id are born in the same walk (pi's TreeList.flattenTree).
   *  NOTE the old harness code walked this tree for DISPLAY but zipped the rows
   *  against getEntries() (append order) — the two orders diverge on any branched
   *  session and the picker selected the wrong entry. */
  function getTree() {
    const nodes = new Map();
    const roots = [];
    for (const e of entries) nodes.set(e.id, { entry: e, children: [] });
    for (const e of entries) {
      const node = nodes.get(e.id);
      if (e.parentId === null || e.parentId === undefined) {
        roots.push(node);
      } else {
        const parent = nodes.get(e.parentId);
        if (parent) parent.children.push(node);
        else roots.push(node); // orphan — broken parent chain (pi: treated as a root)
      }
    }
    const ts = (n) => new Date(n.entry.timestamp ?? 0).getTime();
    const stack = [...roots]; // iterative, post-order sort (pi avoids recursion on deep trees)
    while (stack.length > 0) {
      const node = stack.pop();
      node.children.sort((a, b) => ts(a) - ts(b));
      stack.push(...node.children);
    }
    return roots;
  }

  /** The active, COMPACTION-AWARE context entry list (pi's buildContextEntries,
   *  dist/core/session-manager.js:194-231, ported): follow the root→leaf path;
   *  when it carries compaction entries the LATEST one is represented by the
   *  entry itself, followed by the kept entries starting at firstKeptEntryId
   *  (up to the compaction) and ALL entries after the compaction; older
   *  summarized entries are omitted. No compaction on the path → the whole
   *  path (pi's non-compacted branch). */
  function contextEntries() {
    const path = getBranch();
    let compaction = null;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].type === "compaction") {
        compaction = path[i];
        break;
      }
    }
    if (!compaction) return path;
    const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
    if (compactionIdx < 0) return path;
    const firstKeptIdx = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    const start = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx + 1;
    return [compaction, ...path.slice(start, compactionIdx), ...path.slice(compactionIdx + 1)];
  }

  /** One context entry as LLM message(s): a compaction entry becomes the
   *  head USER message carrying the summary (pi's convertToLlm for role
   *  "compactionSummary": COMPACTION_SUMMARY_PREFIX + summary + SUFFIX) with
   *  the entry's tokensBefore/details on the `compaction` marker (the driver
   *  carries them into the next compaction like pi's entry details); a message
   *  entry keeps its tool fields. The head (the file's payload root, role
   *  "system") and model_change/other entries produce NOTHING (pi: model_change
   *  entries are not LLM context). */
  function entryToMessage(e) {
    if (e.type === "compaction") {
      return {
        role: "user",
        content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + e.summary + COMPACTION_SUMMARY_SUFFIX }],
        timestamp: new Date(e.timestamp ?? 0).getTime(),
        compaction: { tokensBefore: e.tokensBefore, details: e.details },
      };
    }
    if (e.type !== "message" || e.message?.role === "system") return null;
    const m = e.message;
    const out = { role: m.role, content: m.content };
    if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId;
    if (m.toolName !== undefined) out.toolName = m.toolName;
    if (m.isError !== undefined) out.isError = m.isError;
    return out;
  }

  /** The transcript to CONTINUE with: the compaction-aware context entries
   *  reduced to what the LLM round trip accepts (/resume and /tree rebuild the
   *  live transcript from this — a compacted session resumes COMPACTED, exactly
   *  like pi's reload-after-compaction). */
  function getMessages() {
    return contextEntries()
      .map(entryToMessage)
      .filter((m) => m !== null);
  }

  /** The store entry ids BEHIND getMessages() (1:1, same order, minus the
   *  synthesized summary message which IS the compaction entry itself — it has
   *  no message entry of its own). The compaction driver uses this to translate
   *  the flat transcript's firstKeptIndex into pi's firstKeptEntryId. */
  function getContextEntryIds() {
    return contextEntries().filter((e) => e.type === "message" && e.message?.role !== "system").map((e) => e.id);
  }

  return { dir, file, header, sessionId, appendMessage, appendHead, appendModelChange, appendCompaction, branch, getEntries, getEntry, getBranch, getMessages, getContextEntryIds, getTree, leafId: () => leafId };
}

/** A FRESH session for the interactive launch (/new re-creates one): pi's deferred
 *  header — mkdir + the <fileTimestamp>_<sessionId>.jsonl file happen at the
 *  first ASSISTANT message. No I/O here. */
export function createSessionStore({ workDir }) {
  const dir = sessionDirFor(workDir);
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: SESSION_VERSION, id: sessionId, timestamp, cwd: workDir };
  const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const entries = [];
  const byId = new Map();
  return makeStore({ dir, file, header, sessionId, entries, byId, leafId: null, flushed: false });
}

/** REOPEN a saved session (the /resume picker's Enter): parse the file, rebuild
 *  the entries + the active leaf (last appended id), keep appending to THE SAME
 *  file (the conversation continues at its active leaf). A missing/unreadable or
 *  non-session file throws (the caller turns it into a message line). */
export function loadSessionStore(filePath) {
  const lines = existsSync(filePath) ? readFileSync(filePath, "utf8").split("\n") : [];
  const entries = [];
  const byId = new Map();
  let header = null;
  let leafId = null;
  for (const raw of lines) {
    const e = parseLine(raw);
    if (!e) continue;
    if (e.type === "session") {
      if (header) continue;
      header = e;
      continue;
    }
    if (e.id !== undefined && e.id !== null) {
      entries.push(e);
      byId.set(e.id, e);
      leafId = e.id;
    }
  }
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`Not a harness session file: ${filePath}`);
  }
  return makeStore({
    dir: dirname(filePath),
    file: filePath,
    header,
    sessionId: header.id,
    entries,
    byId,
    leafId,
    flushed: true,
  });
}

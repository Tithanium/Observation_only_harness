// src/fetch_tool.js
// Round 4 feature, CONSOLIDATED: the fetch tool — the harness's single
// observation tool, same contract as the read tool (same {content, details}
// envelope, same parameter style, same truncation, same error style: a thrown
// Error whose .message becomes the tool result's text, isError true), applied
// to a FILE (the round-3 read tool's branch, merged here), a FOLDER (pi-ls-exact
// listing) or a user-provided http(s) HTML link.
//
// Pi has NO URL fetch tool (only read/bash/grep/find/ls/...; "WebFetch" is just a
// name pi relays for the Anthropic server). The documented contract is read's:
// text shaped by truncateHead (2000 lines / 50KB, complete lines only) and pi's
// HTTP behavior (the undici global fetch: redirects followed like fetch, terminal
// AbortSignal.timeout, error strings "…failed with HTTP <status>: <url>").
//   url = LINK  — GET with the global fetch; HTML returned VERBATIM (pi performs
//                 no HTML→content transformation — no DOM parser anywhere in pi),
//                 then shaped exactly like read (offset/limit slice + truncation +
//                 read's banners). Binary bodies are sniffed BEFORE utf-8 decode
//                 (read's magic-byte sniff + PDF/zip/gzip + NUL probe): PNG/PDF & co.
//                 answer a read-style note (type + size), never raw control bytes.
//                 Byte cap 5.0MB with a clear error (pi's own
//                 downloads have NO byte guard — our cap closes that gap).
//   url = FILE  — read exactly like the round-3 read tool: read's path resolution,
//                 the same binary sniff as the link branch (read's image sniff +
//                 PDF/zip/gzip + NUL probe — an image/PDF file answers a read-style
//                 note, type + size, never a binary dump), then the same offset/limit
//                 slice + truncateHead + banners (shapeLinkResult) as the link branch.
//   url = FOLDER — a pi-ls-exact listing (pi's folder handling, dist/core/tools/ls.js):
//                 names with "/" suffix on directories, case-insensitive alphabetical
//                 order, dotfiles included, 500-entry-cap notice / 50KB notice,
//                 "(empty directory)", "Path not found" / "Not a directory" /
//                 "Cannot read directory".
//
// SCOPE GUARD (2026-10-01): the LOCAL branch is now fail-closed — a resolved
// file/folder path must be inside the working folder OR the harness dot-folder
// (<userDotDir()> — skills/AGENTS.md live there and the system prompt tells the
// model to load SKILL.md files via fetch). Anything else is refused BEFORE any
// fs work. The URL branch is untouched (an http(s) GET is a read, not a path).
// (Before this, fetch was only prompt-steered toward map_folder.md — the
// `url` parameter accepted ANY existing file on the disk; pi parity had no
// guard. The imported pi tools grep/find/ls use the same guard, work-folder
// only — src/scope_guard.js.)
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { typeboxType } from "./pi-ai.js";
import { userDotDir } from "./config.js";
import { assertWithinRoots, assertRealPathWithinRoots } from "./scope_guard.js";
import { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, detectSupportedImageMimeType, formatSize, resolveReadPath, truncateHead } from "./read_tool.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_FETCH_BODY = 5 * 1024 * 1024; // 5.0MB download cap (curl --max-filesize style)
const DEFAULT_LIST_LIMIT = 500;

/** A link = an http(s) URL; anything else is treated as a folder path (read's path
 *  resolution: relative to the working dir, absolute, "~", file://). */
function looksLikeUrl(target) {
  return /^https?:\/\//i.test(target);
}

/** Shape a fetched link's text EXACTLY like the read tool shapes a file's text:
 *  offset/limit line slice, truncateHead (2000 lines / 50KB), read's banners,
 *  read's "beyond end" error. */
function shapeLinkResult(textContent, url, offset, limit) {
  const allLines = textContent.split("\n");
  const startLine = offset ? Math.max(0, offset - 1) : 0; // offset is 1-indexed, like read
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of content (${allLines.length} lines total)`);
  }
  let selectedContent;
  let userLimitedLines;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  let outputText;
  let details;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return { content: [{ type: "text", text: outputText }], details };
}

/** Detects non-image binaries by magic bytes — read's detectSupportedImageMimeType
 *  covers the image families; this catches PDF/zip/gzip and (via the NUL probe) any
 *  other binary that would otherwise utf-8-decode into mojibake. */
function sniffBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buffer[i] !== bytes[i]) return false;
  return true;
}
function detectOtherBinaryMimeType(buffer) {
  if (sniffBytes(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // "%PDF-"
  if (sniffBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"; // PK\x03\x04
  if (sniffBytes(buffer, [0x1f, 0x8b])) return "application/gzip";
  if (buffer.subarray(0, 512).includes(0)) return "application/octet-stream"; // NUL byte = never UTF-8 text
  return null;
}

/** Read-style note for a detected binary body (read's "[Image …]" shape + the size),
 *  so the model sees type + size — never raw control/replacement characters. */
function shapeBinaryNote(mimeType, totalBytes) {
  if (mimeType.startsWith("image/")) {
    return `Read image file [${mimeType}] (${formatSize(totalBytes)})` + `\n[Image omitted: could not be converted to a supported inline image format.]`;
  }
  return `[${mimeType}] binary content (${formatSize(totalBytes)}): omitted — not a text document.`;
}

/** GET `url` with the global fetch (the same undici stack pi's HTTP layer is built
 *  on): redirects followed like fetch, AbortSignal.timeout, 5.0MB byte cap,
 *  pi-shaped errors ("Fetch failed with HTTP <status>: <url>"); HTML is returned
 *  verbatim — pi performs no HTML→content transformation. Returns the raw body
 *  Buffer UNDECODED — the binary sniff runs before any utf-8 decode (see execute).
 *  The harness abort signal is listened to for the WHOLE fetch (pi's read.js/ls.js
 *  pattern: signal?.addEventListener('abort', onAbort, {once:true})) and rejects
 *  "Operation aborted". */
async function httpFetch(url, timeoutMs, signal) {
  const chunks = [];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      redirect: "follow", // fetch's default: follow, up to 20 hops
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]), // timeout + harness abort, first wins
      headers: {
        "user-agent": `observation-only (${process.platform} ${osRelease()}; ${process.arch})`,
        accept: "*/*",
      },
    });
    if (!res.ok) {
      throw new Error(`Fetch failed with HTTP ${res.status}: ${url}`); // pi's shape: "Download failed with HTTP ${status}: ${url}"
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FETCH_BODY) {
      throw new Error(`Fetch failed: response body exceeds ${formatSize(MAX_FETCH_BODY)}: ${url}`);
    }
    if (!res.body) {
      throw new Error(`Fetch failed: no response body: ${url}`);
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      if (chunks.reduce((n, c) => n + c.length, 0) > MAX_FETCH_BODY) {
        await reader.cancel().catch(() => {});
        throw new Error(`Fetch failed: response body exceeds ${formatSize(MAX_FETCH_BODY)}: ${url}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && /^Fetch failed/.test(error.message)) throw error; // ours — HTTP status / byte cap / no body
    if (error?.name === "TimeoutError") {
      throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    if (error?.name === "AbortError") {
      throw new Error("Operation aborted"); // harness abort mid-fetch (the listener above)
    }
    throw new Error(`Fetch failed: ${error?.cause?.message ?? error?.message ?? String(error)}: ${url}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks); // raw bytes — decoded only after the binary sniff
}

/** List a folder the way pi's ls does (dist/core/tools/ls.js): names one per line,
 *  "/" suffix on directories, case-insensitive alphabetical order, dotfiles
 *  included, 500-entry-cap notice / 50KB notice, "(empty directory)",
 *  "Path not found" / "Not a directory" / "Cannot read directory". */
/** Exported (2026-10-01) so the imported pi ls tool reuses this EXACT logic
 *  instead of duplicating pi's ls (one implementation, two entry points). */
export async function listFolderLikeLs(path, limit, cwd) {
  const resolved = await resolveReadPath(path, cwd);
  try {
    await fsAccess(resolved, constants.F_OK);
  } catch {
    throw new Error(`Path not found: ${resolved}`);
  }
  const stat = await fsStat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  let entries;
  try {
    entries = await fsReaddir(resolved);
  } catch (e) {
    throw new Error(`Cannot read directory: ${e.message}`);
  }
  // Sort alphabetically, case-insensitive (pi's ls comparator).
  entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
  const results = [];
  let entryLimitReached = false;
  for (const entry of entries) {
    if (results.length >= effectiveLimit) {
      entryLimitReached = true;
      break;
    }
    const fullPath = join(resolved, entry);
    let suffix = "";
    try {
      const entryStat = await fsStat(fullPath);
      if (entryStat.isDirectory()) suffix = "/";
    } catch {
      continue; // entries we cannot stat are skipped, like pi
    }
    results.push(entry + suffix);
  }
  if (results.length === 0) {
    return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
  }
  const rawOutput = results.join("\n");
  // Byte truncation only — entry count is already capped (pi's ls does the same).
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details = {};
  const notices = [];
  if (entryLimitReached) {
    notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
    details.entryLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) {
    output += `\n\n[${notices.join(". ")}]`;
  }
  return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/** The fetch tool definition (read's contract: same envelope, same parameters
 *  style, same execution entry; cwd is the working dir relative paths resolve
 *  against — the read tool's). */
export async function createFetchTool(cwd) {
  const Type = await typeboxType();
  // THE scope guard's roots (2026-10-01): the working folder + the harness
  // dot-folder (skills/AGENTS.md). userDotDir() honours OBSERVATION_ONLY_DIR at
  // call time — the test rigs' isolated dot dirs stay isolated.
  const allowedRoots = [cwd, userDotDir()];
  const fetchSchema = Type.Object({
    url: Type.String({ description: "The target — a file path to read, a folder path to list (both relative to the working directory, absolute, ~ or file://), or an http(s) URL to fetch" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed, file or link)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read (file or link), or maximum number of entries to return for a folder (default: 500)" })),
    timeout: Type.Optional(Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` })),
  });
  return {
    name: "fetch",
    label: "fetch",
    description: `Read a local file, list a folder, or fetch a user-provided http(s) HTML link. For a file: output truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); an image (jpg, png, gif, webp, bmp) or other binary (PDF, zip, gzip, …) answers a type + size note, never raw bytes. For a folder: entries listed pi-ls style — names with "/" suffix on directories, case-insensitive alphabetical order, dotfiles included, truncated to ${DEFAULT_LIST_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB, "(empty directory)" when empty. For a link: GET the URL (redirects followed, ${DEFAULT_TIMEOUT_MS / 1000}s timeout, body capped at ${formatSize(MAX_FETCH_BODY)}); HTML is returned as-is (no HTML parsing) and shaped exactly like a file. Use offset/limit for large results. Local paths are SCOPED to the working folder and the harness dot-folder — paths outside are refused (this harness is observation-only and read-only).`,
    promptSnippet: "Read a file, list a folder, or fetch a URL",
    promptGuidelines: ["Use fetch to read a file, list a folder, or fetch a user-provided HTML link."],
    parameters: fetchSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    /** Execute a fetch; resolves { content, details }; a thrown Error's message is
     *  the tool-result text (isError true), like pi's createErrorToolResult. */
    async execute(_toolCallId, { url, offset, limit, timeout }, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const raw = String(url ?? "").trim();
      if (looksLikeUrl(raw)) {
        const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
        const buffer = await httpFetch(raw, timeoutMs, signal); // signal is listened to for the WHOLE fetch
        // Read's magic-byte sniff BEFORE utf-8 decode: a PNG/PDF link answers a
        // read-style note (type + size), never mojibake/control chars.
        const mimeType = detectSupportedImageMimeType(buffer) ?? detectOtherBinaryMimeType(buffer);
        if (mimeType) {
          return { content: [{ type: "text", text: shapeBinaryNote(mimeType, buffer.length) }] };
        }
        return shapeLinkResult(buffer.toString("utf-8"), raw, offset, limit);
      }
      // Not a link: a local path (read's resolution: relative to the working
      // dir, absolute, "~", file://) — a FILE is read exactly like the
      // round-3 read tool (merged here), a FOLDER is listed pi-ls style.
      const resolved = await resolveReadPath(raw, ctx?.cwd || cwd);
      // Scope guard (2026-10-01): fail-closed BEFORE any fs work — the working
      // folder + the dot-folder only (see the file header's SCOPE GUARD note).
      assertWithinRoots(resolved, allowedRoots, "fetch");
      try {
        await fsAccess(resolved, constants.F_OK);
      } catch {
        throw new Error(`Path not found: ${resolved}`);
      }
      const stat = await fsStat(resolved);
      // Symlink/junction escape (2026-10-01 audit §4.1): the lexical guard
      // passed on the LINK's path — require the REAL target to be in scope too
      // (covers the file branch below AND the folder branch's listing).
      await assertRealPathWithinRoots(resolved, allowedRoots, "fetch");
      if (stat.isDirectory()) {
        return listFolderLikeLs(resolved, limit, ctx?.cwd || cwd);
      }
      const fileBuffer = await fsReadFile(resolved);
      // The same binary sniff the link branch runs: an image/PDF file answers a
      // read-style note (type + size), never a binary dump or mojibake.
      const fileMimeType = detectSupportedImageMimeType(fileBuffer) ?? detectOtherBinaryMimeType(fileBuffer);
      if (fileMimeType) {
        return { content: [{ type: "text", text: shapeBinaryNote(fileMimeType, fileBuffer.length) }] };
      }
      return shapeLinkResult(fileBuffer.toString("utf-8"), resolved, offset, limit);
    },
  };
}

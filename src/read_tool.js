// src/read_tool.js
// Round 3 feature: the read tool — pi's contract (pi's dist/core/tools/read.js).
// CONSOLIDATED: the read tool was merged into the fetch tool — fetch's non-URL
// branch now reads files with this exact logic (read's sniff + truncation +
// shape). This file is the shared core (path resolution, image sniff,
// truncation — imported by fetch_tool.js) and keeps createReadTool for the
// legacy round3/round4 entry points.
// INTENT (goal.md): "the LLM emits the proper output, the harness executes the read
// and returns the file's content." Same parameters (path/offset/limit, offset is
// 1-indexed), same path resolution (relative to the working dir; ~, file://,
// WSL/MSYS-style, unicode-space normalization, "@" prefix strip; no allowlist —
// the only guard is an OS fs.access(R_OK), exactly like pi), same {content, details}
// envelope, same truncation (2000 lines or 50KB, whichever is hit first; complete
// lines only), same error shapes (a thrown Error whose .message becomes the tool
// result's text, isError true). Images are detected by magic bytes like pi; this
// harness ships no inline-image pipeline, so a detected image answers with pi's
// "could not be converted" text note (isError false), never a binary dump.
import { constants } from "node:fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { typeboxType } from "./pi-ai.js";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line (pi's truncate.js)

// --- path resolution, replicating pi's utils/paths.js -------------------------

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Convert Git Bash / MSYS / Cygwin / WSL drive paths to a form Windows accepts. */
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** pi's normalizePath: unicode spaces, "@" strip, WSL-style, "~", file://. */
function normalizePath(input) {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

async function pathExists(filePath) {
  try {
    await fsAccess(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** pi's resolveReadPathAsync: resolve to cwd, then the macOS filename-fallback
 *  variants (AM/PM narrow no-break-space, NFD, curly-quote, NFD+curly). */
export async function resolveReadPath(input, cwd) {
  const normalized = normalizePath(input);
  const baseDir = normalizePath(cwd);
  const resolved = isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(baseDir, normalized);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const variant of variants) {
    if (variant !== resolved && (await pathExists(variant))) return variant;
  }
  return resolved;
}

// --- magic-byte image sniff, replicating pi's utils/mime.js --------------------

const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buffer[i] !== bytes[i]) return false;
  return true;
}
function startsWithAscii(buffer, offset, ascii) {
  if (buffer.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
  return true;
}
function readUint32BE(buffer, offset) {
  return buffer.readUInt32BE(offset);
}
function readUint16BE(buffer, offset) {
  return buffer.readUInt16BE(offset);
}
function readUint32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}
function readUint16LE(buffer, offset) {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}
function isPng(buffer) {
  return buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR");
}
function isAnimatedPng(buffer) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    if (startsWithAscii(buffer, offset + 4, "acTL")) return true;
    if (startsWithAscii(buffer, offset + 4, "IDAT")) return false;
    if (offset + 8 + chunkLength + 4 <= offset || offset + 8 + chunkLength + 4 > buffer.length) return false;
    offset = offset + 8 + chunkLength + 4;
  }
  return false;
}
function isBmp(buffer) {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes, bitsPerPixel;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && (bitsPerPixel === 1 || bitsPerPixel === 4 || bitsPerPixel === 8 || bitsPerPixel === 16 || bitsPerPixel === 24 || bitsPerPixel === 32);
}
/** Detects the 5 image types pi supports (static png only); else null -> text path. */
export function detectSupportedImageMimeType(buffer) {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : "image/jpeg";
  if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return null;
}
async function detectSupportedImageMimeTypeFromFile(filePath) {
  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
    return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}

// --- truncation, replicating pi's core/tools/truncate.js -----------------------

/** Format bytes like pi (58.6KB, 50.0KB, 1.2MB). */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function splitLinesForCounting(content) {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
/** Truncate from the head: complete lines only; line or byte limit first wins. */
export function truncateHead(content, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes };
  }
  const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
  if (firstLineBytes > maxBytes) {
    return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, outputLines: 0, outputBytes: 0, lastLinePartial: false, firstLineExceedsLimit: true, maxLines, maxBytes };
  }
  const outputLinesArr = [];
  let outputBytesCount = 0;
  let truncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(lines[i]);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines";
  const outputContent = outputLinesArr.join("\n");
  return { content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, "utf-8"), lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes };
}

/** Truncate a single line to max chars, adding a [truncated] suffix (pi's
 *  truncateLine, verbatim semantics — used by the grep tool's match lines). */
export function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

// --- the tool ----------------------------------------------------------------

function getNonVisionImageNote(model) {
  if (!model || model.input.includes("image")) return undefined;
  return "[Current model does not support images. The image will be omitted from this request.]";
}

/** The read tool definition (pi's name/description/parameters/execute contract).
 *  `cwd` is the working dir relative paths resolve against (pi: the session cwd). */
export async function createReadTool(cwd) {
  const Type = await typeboxType();
  const readSchema = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  });
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    /** Execute a read; resolves { content, details }; a thrown Error's message is the
     *  tool-result text (isError true), like pi's createErrorToolResult. */
    async execute(_toolCallId, { path, offset, limit }, _signal, _onUpdate, ctx) {
      const absolutePath = await resolveReadPath(path, ctx?.cwd || cwd);
      await fsAccess(absolutePath, constants.R_OK); // the only guard, exactly like pi
      const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
      let content;
      let details;
      const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
      if (mimeType) {
        // Detected image. pi would attach an inline image block; this harness has no
        // inline-image pipeline, so it answers with pi's "could not be converted"
        // text note (isError stays false) — never a binary dump.
        const textNote =
          `Read image file [${mimeType}]` +
          `\n[Image omitted: could not be converted to a supported inline image format.]` +
          (nonVisionImageNote ? `\n${nonVisionImageNote}` : "");
        content = [{ type: "text", text: textNote }];
      } else {
        const buffer = await fsReadFile(absolutePath);
        const textContent = buffer.toString("utf-8");
        const allLines = textContent.split("\n");
        const startLine = offset ? Math.max(0, offset - 1) : 0;
        const startLineDisplay = startLine + 1;
        if (startLine >= allLines.length) {
          throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
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
        if (truncation.firstLineExceedsLimit) {
          const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
          outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
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
        content = [{ type: "text", text: outputText }];
      }
      return { content, details };
    },
  };
}

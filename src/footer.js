// src/footer.js
// Round 7 feature: footer indicators — INPUT token count, OUTPUT token count,
// CONTEXT SIZE, MAX CONTEXT SIZE, MODEL NAME and TOKEN SPEED (tokens/second),
// sourced pi-style. The numbers ARE pi's numbers: token counts come from the
// provider-reported usage object of each round trip (pi-ai's parseChunkUsage — the
// exact object pi's footer totals) ACCUMULATED session-cumulatively across every
// round trip of the exchange (pi's addUsageToTotals: input/output/cacheRead/
// cacheWrite/cost + totalTokens), max context from the model config (contextWindow,
// the models.json/catalog value pi's modelFromJson resolves, default 128000),
// model name = the active model, context size = the tokens actually used in this
// exchange (the accumulated usage.totalTokens), and tok/s is measured the way pi's
// token-rate.ts extension does: every streamed partial assistant message is sampled
// in >=300ms windows, usage.output deltas are preferred (chars/4 estimate otherwise
// — pi's compaction estimateTokens), an exponential moving average (alpha=0.3)
// smooths the live rate, and the round-trip final = total output tokens / total
// wall time when the round trip lasted >= 1s. THE RENDERING is pi's footer layout
// (dist/modes/interactive/components/footer.js — the FooterComponent's render,
// reproduced 1:1 with the ⚡ speed element where pi-tps-live's custom footer
// put it) — a footer BLOCK of two+ dim (#666666, dark.json dimGray) lines at the
// BOTTOM:
//   ~ (branch)                        ⚡ 88.4 tok/s   (the speed, RIGHT-aligned,
//   ↑1.2k ↓315 R2.3k 0.0%/128k                (mock) my-model • thinking off
//   ↑/↓ = session-cumulative tokens, ctx = PERCENT of the context window (>70%
//   warning #ffff00, >90% error #cc6666), the (provider) prefix appears when the
//   dot-folder models.json has >1 provider — and the speed shows ONLY when a
//   reading exists (pi-tps-live: no reading → no ⚡, never "n/a"). A client
//   without a live model degrades field by field pi's way: `0.0%/0` (the window
//   fallback is 0, not "?"), the model "no-model". The meter's `now`/`elapsedMs` arguments default to
//   Date.now() like token-rate.ts; tests pass explicit times to drive the windows
//   deterministically. ALL fields are session-cumulative by default (pi's footer);
//   a per-turn view exists ONLY via footerLine's explicit { perTurn: true } flag.
//   Never prints secrets.

import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadProviders } from "./config.js";
import { getExtensionStatuses } from "./extensions.js";

export const MIN_WINDOW_MS = 300; // token-rate.ts: ignore sampling windows shorter than this
export const EMA_ALPHA = 0.3; // token-rate.ts: EMA weight (higher = snappier)

/** pi's formatTokens (footer.js): compact token counts for footer display. */
export function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** pi's estimateTokens counting approach (compaction.js: Math.ceil(chars / 4)) —
 *  the same token estimate pi applies to messages the provider reports no usage
 *  for (and token-rate.ts's fallback token source while chars stream in). */
export function estimateTokens(text) {
  return Math.ceil((text ?? "").length / 4);
}

/** Provider-reported output tokens of a (partial) assistant message
 *  (token-rate.ts outputTokens). */
function outputTokens(msg) {
  const o = msg?.usage?.output;
  return typeof o === "number" && o > 0 ? o : 0;
}

/** text + thinking chars of one (partial) assistant message (token-rate.ts
 *  contentChars). */
function contentChars(msg) {
  return (msg?.content ?? []).reduce((sum, block) => {
    if (block?.type === "text" && block.text) return sum + block.text.length;
    if (block?.type === "thinking" && block.thinking) return sum + block.thinking.length;
    return sum;
  }, 0);
}

/** The tok/s meter, token-rate.ts's measurement (sampling window + interval):
 *  sample() is called on every streamed partial assistant message; the first
 *  sample of a message seeds the window (message_start), sample windows shorter
 *  than MIN_WINDOW_MS are ignored, real usage.output deltas are preferred over the
 *  chars/4 estimate, an EMA(0.3) smooths the live rate, and finish() keeps the
 *  round-trip final = total output tokens / total wall time when it lasted >= 1s.
 *  `now` (sample) and `elapsedMs` (finish) default to Date.now(); both accept
 *  explicit values so tests can drive the windows deterministically. */
export function createTokenRateMeter({ minWindowMs = MIN_WINDOW_MS, alpha = EMA_ALPHA } = {}) {
  let streamStart = null; // { time, startOut } of the current message
  let last = null; // { time, out, chars } of the last sample window
  let emaRate = 0; // live EMA while streaming
  let totalOut = 0; // exchange output tokens (all round trips — session-cumulative)
  let totalMs = 0; // exchange wall time (all round trips — session-cumulative)
  let lastOut = 0; // LAST round trip's own output tokens (opt-in per-turn view)
  let lastMs = 0; // LAST round trip's own wall time (opt-in per-turn view)

  return {
    /** One streamed partial assistant message (token-rate.ts message_start/update). */
    sample(msg, now = Date.now()) {
      const out = outputTokens(msg);
      const chars = contentChars(msg);
      if (!last) {
        streamStart = { time: now, startOut: out };
        last = { time: now, out, chars };
        return;
      }
      if (now - last.time < minWindowMs) return; // window too short → noisy rate
      const dOut = out - last.out;
      const tokens = dOut > 0 ? dOut : (chars - last.chars) / 4; // usage delta preferred, chars/4 fallback
      if (tokens > 0) {
        const instRate = tokens / ((now - last.time) / 1000);
        emaRate = emaRate > 0 ? (1 - alpha) * emaRate + alpha * instRate : instRate;
      }
      last = { time: now, out, chars };
    },
    /** End of a message (token-rate.ts message_end): the total over the round trip
     *  becomes the rate when it lasted >= 1s and produced output. */
    finish(msg, elapsedMs = Date.now() - (streamStart?.time ?? Date.now())) {
      const out = outputTokens(msg);
      lastOut = Math.max(0, out - (streamStart?.startOut ?? 0));
      lastMs = typeof elapsedMs === "number" ? elapsedMs : 0;
      totalOut += lastOut;
      totalMs += lastMs;
      if (totalMs >= 1000 && totalOut > 0) emaRate = totalOut / (totalMs / 1000); // final: average over the whole exchange
      streamStart = null;
      last = null;
      return this.rate;
    },
    /** Per-turn rate: the LAST round trip's own average (its own >= 1s gate), or
     *  null. Only the opt-in per-turn footer view uses this — the default view is
     *  session-cumulative like pi's footer. */
    get lastRate() {
      if (lastMs >= 1000 && lastOut > 0) return lastOut / (lastMs / 1000);
      return null;
    },
    /** The tok/s number to display: the round-trip average when it lasted >= 1s and
     *  produced output, else the live EMA, else null (nothing known → "n/a"). */
    get rate() {
      if (totalMs >= 1000 && totalOut > 0) return totalOut / (totalMs / 1000);
      return emaRate > 0 ? emaRate : null;
    },
    get totalTokens() {
      return totalOut;
    },
    get totalMs() {
      return totalMs;
    },
    reset() {
      streamStart = null;
      last = null;
      emaRate = 0;
      totalOut = 0;
      totalMs = 0;
      lastOut = 0;
      lastMs = 0;
    },
  };
}

/** The one footer line, all six fields. `usage` is the round trip's provider-reported
 *  usage object {input, output, totalTokens, …}; `model` the pi-ai model config
 *  {name, id, contextWindow, …}; `rate` the tok/s number (or null when unknown).
 *  A missing usage/model degrades field by field: counts "n/a", max context "?",
 *  speed "n/a tok/s", model "unknown". (No live model degrades pi's way:
 *  `0.0%/0` — pi's no-model window fallback is 0, not `?`.) */
/** pi's footer.js sanitizeStatusText — pi strips ONLY the three whitespace
 *  control bytes ([\r\n\t], then collapses space runs and trims). The OLD
 *  [\u0000-\u001f] class was wrong: 0x1b (ESC) is a control character, so it
 *  destroyed EVERY escape sequence the footer itself renders — every `\x1b[38;2;…m`
 *  dim/reset turned into literal `[38;2;102;102;102m…` text. Pi keeps the ANSI
 *  codes whole (its sanitizer exists ONLY for the extension-statuses line). */
export function sanitizeStatusText(text) {
  return String(text ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}
/** ANSI-aware display width of a styled string (pi-tui's visibleWidth: escape
 *  sequences count 0 cells; the pi footer's right-alignment is cell-exact). */
export function visibleWidth(s) {
  let cells = 0;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; ) {
    if (t.charCodeAt(i) === 27) {
      const e = t.indexOf("m", i);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    cells += t.codePointAt(i) === 0x26a1 ? 2 : 1; // pi-tui's RGI-emoji rule (utils.js:161-163) applied to the footer's single emoji: ⚡ (U+26A1) = 2 cells
    i += 1;
  }
  return cells;
}

// ---- pi-tui's truncateToWidth port (pi-tui dist/utils.js) — the piece-2
// ---- policy: verbatim copy + minimal adaptation. The ellipsis gets its cells
// ---- RESERVED up front (content cut to `w - visibleWidth(ellipsis)`, marker
// ---- appended → total exactly `w` — the old hand-rolled loop filled `w` THEN
// ---- appended the marker → w+3 cells, 3 too wide at terminal widths ≤ ~52).
// ---- Adaptations (the only two, both documented at the use site):
// ----   (1) graphemeWidth without pi's CJK table (the get-east-asian-width
// ----       package): obs's footer emits no CJK/fullwidth text (ASCII paths +
// ----       model ids + ↑↓⚡•), a visible non-emoji base counts 1 cell — the
// ----       same rule as this file's visibleWidth (ANSI=0, ⚡=2, else 1, tab=3);
// ----   (2) finalizeTruncatedResult without the OSC8 hyperlink close (the
// ----       footer never emits OSC 8).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" }); // pi-tui utils.js:3
/** pi-tui utils.js isPrintableAscii (verbatim). */
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}
/** pi-tui utils.js extractAnsiCode (verbatim): one CSI/OSC/APC sequence at
 *  `pos`, or null. */
function extractAnsiCode(str, pos) {
  if (pos >= str.length || str[pos] !== "\x1b")
    return null;
  const next = str[pos + 1];
  // CSI sequence: ESC [ ... m/G/K/H/J
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j]))
      j++;
    if (j < str.length)
      return { code: str.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }
  // OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
  if (next === "]") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07")
        return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\")
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  // APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
  if (next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07")
        return { code: str.substring(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\")
        return { code: str.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  return null;
}
/** pi-tui utils.js couldBeEmoji (verbatim): the fast RGI-emoji pre-filter that
 *  avoids running the RGI_Emoji regex on every grapheme. */
function couldBeEmoji(segment) {
  const cp = segment.codePointAt(0);
  return ((cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
    (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
    (cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
    segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
    segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
  );
}
// pi-tui utils.js classification regexes (verbatim).
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;
/** pi-tui utils.js graphemeWidth — verbatim EXCEPT the two CJK-only parts:
 *  the terminalSpacingMark/Indic/Thai trailing loop and the final
 *  eastAsianWidth(cp) lookup (pi: the get-east-asian-width package). The obs
 *  footer never emits CJK/fullwidth text, so a visible non-emoji base counts 1
 *  cell — the same rule as this file's visibleWidth (ANSI=0, ⚡=2, else 1,
 *  tab=3), which keeps the truncation loop and the layout arithmetic in lockstep. */
function footerGraphemeWidth(segment) {
  if (segment === "\t") {
    return 3;
  }
  // Zero-width clusters
  if (zeroWidthRegex.test(segment)) {
    return 0;
  }
  // Emoji check with pre-filter
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
    return 2;
  }
  // Get base visible codepoint
  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === undefined) {
    return 0;
  }
  // Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
  // full-width emoji in terminals, even when isolated during streaming.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    return 2;
  }
  return 1; // pi: eastAsianWidth(cp) — 1 for every non-CJK code point the footer can emit
}
/** pi-tui utils.js truncateFragmentToWidth (verbatim; graphemeWidth →
 *  footerGraphemeWidth). Clips a fragment to a width — used by truncateStyled
 *  to clamp an ellipsis that is itself wider than `w` (tiny widths). */
function truncateFragmentToWidth(text, maxWidth) {
  if (maxWidth <= 0 || text.length === 0) {
    return { text: "", width: 0 };
  }
  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth);
    return { text: clipped, width: clipped.length };
  }
  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");
  if (!hasAnsi && !hasTabs) {
    let result = "";
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const w = footerGraphemeWidth(segment);
      if (width + w > maxWidth) {
        break;
      }
      result += segment;
      width += w;
    }
    return { text: result, width };
  }
  let result = "";
  let width = 0;
  let i = 0;
  let pendingAnsi = "";
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    if (text[i] === "\t") {
      if (width + 3 > maxWidth) {
        break;
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += "\t";
      width += 3;
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] !== "\t") {
      const nextAnsi = extractAnsiCode(text, end);
      if (nextAnsi) {
        break;
      }
      end++;
    }
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const w = footerGraphemeWidth(segment);
      if (width + w > maxWidth) {
        return { text: result, width };
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += segment;
      width += w;
    }
    i = end;
  }
  return { text: result, width };
}
/** pi-tui utils.js finalizeTruncatedResult (verbatim EXCEPT the OSC8
 *  hyperlink close — the footer never emits OSC 8). The cut is closed with
 *  `\x1b[0m` BEFORE the ellipsis and again AFTER it: a styled chunk cut
 *  mid-attribute can't leak a style past the cut, and the marker always renders
 *  in its own style. */
function finalizeTruncatedResult(prefix, prefixWidth, ellipsis, ellipsisWidth, maxWidth, pad) {
  const reset = "\x1b[0m";
  const visibleWidth = prefixWidth + ellipsisWidth;
  let result;
  if (ellipsis.length > 0) {
    result = `${prefix}${reset}${ellipsis}${reset}`;
  }
  else {
    result = `${prefix}${reset}`;
  }
  return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}
/** ANSI-aware truncate at `w` cells — pi-tui's truncateToWidth
 *  (dist/utils.js) ported verbatim (`pad` pinned to false, the footer pads
 *  itself). The ellipsis budget is RESERVED: content is cut to
 *  `w - visibleWidth(ellipsis)` cells and the marker appended → a cut result is
 *  EXACTLY `w` cells (the old loop filled `w` then appended the marker → w+3).
 *  Edge behavior is pi's: an already-fitting string comes back untouched (no
 *  cut, no marker, no reset); an ellipsis wider than `w` is itself clamped to
 *  `w` (tiny widths); a styled chunk cut mid-attribute drops the pending escape
 *  run (pendingAnsi) and the cut is closed with `\x1b[0m` (finalizeTruncatedResult)
 *  so no dangling ESC can corrupt the pinned row. `w <= 0` → "" (pi's). */
export function truncateStyled(s, w, ellipsis = "") {
  const text = String(s ?? "");
  if (w <= 0) {
    return "";
  }
  if (text.length === 0) {
    return "";
  }
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= w) {
    const textWidth = visibleWidth(text);
    if (textWidth <= w) {
      return text;
    }
    const clippedEllipsis = truncateFragmentToWidth(ellipsis, w);
    if (clippedEllipsis.width === 0) {
      return "";
    }
    return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, w, false);
  }
  if (isPrintableAscii(text)) {
    if (text.length <= w) {
      return text;
    }
    const targetWidth = w - ellipsisWidth;
    return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, w, false);
  }
  const targetWidth = w - ellipsisWidth;
  let result = "";
  let pendingAnsi = "";
  let visibleSoFar = 0;
  let keptWidth = 0;
  let keepContiguousPrefix = true;
  let overflowed = false;
  let exhaustedInput = false;
  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");
  if (!hasAnsi && !hasTabs) {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = footerGraphemeWidth(segment);
      if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
        result += segment;
        keptWidth += width;
      }
      else {
        keepContiguousPrefix = false;
      }
      visibleSoFar += width;
      if (visibleSoFar > w) {
        overflowed = true;
        break;
      }
    }
    exhaustedInput = !overflowed;
  }
  else {
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        pendingAnsi += ansi.code;
        i += ansi.length;
        continue;
      }
      if (text[i] === "\t") {
        if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += "\t";
          keptWidth += 3;
        }
        else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += 3;
        if (visibleSoFar > w) {
          overflowed = true;
          break;
        }
        i++;
        continue;
      }
      let end = i;
      while (end < text.length && text[end] !== "\t") {
        const nextAnsi = extractAnsiCode(text, end);
        if (nextAnsi) {
          break;
        }
        end++;
      }
      for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
        const width = footerGraphemeWidth(segment);
        if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += segment;
          keptWidth += width;
        }
        else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += width;
        if (visibleSoFar > w) {
          overflowed = true;
          break;
        }
      }
      if (overflowed) {
        break;
      }
      i = end;
    }
    exhaustedInput = i >= text.length;
  }
  if (!overflowed && exhaustedInput) {
    return text;
  }
  return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, w, false);
}

/** pi's formatCwdForFooter (footer.js:31-43, verbatim): the cwd with the home
 *  prefix folded into `~` when it lives inside home (pi: `~` for the home itself,
 *  `~\sub` inside on Windows — the PLATFORM sep, not a hardcoded "/"). */
export function formatCwdForFooter(cwd, home) {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome = relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
/** The current git branch for a directory (pi's findGitPaths + resolveBranchWithGitSync
 *  → the footer's `(branch)` suffix), cached per path — null outside a repo or on a
 *  detached HEAD, pi's rules. */
export function gitBranch(cwd) {
  const q = String(cwd ?? "");
  if (!q) return null;
  if (gitBranchCache.has(q)) return gitBranchCache.get(q);
  let b = null;
  try {
    const r = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: q, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
    b = r && r.status === 0 && r.stdout ? r.stdout.trim() || null : null;
  } catch {
    b = null;
  }
  gitBranchCache.set(q, b);
  return b;
}
const gitBranchCache = new Map();
/** dark.json colors the footer dims (theme/theme.js fg → 24-bit): dimGray #666666,
 *  error #cc6666, warning #ffff00 — the ONLY colors the footer carries (pi's
 *  FooterComponent; the ctx percent crosses into error/warning past 90%/70%). */
const FG_DIM = "\x1b[38;2;102;102;102m";
const FG_ERROR = "\x1b[38;2;204;102;102m";
const FG_WARNING = "\x1b[38;2;255;255;0m";
const FG_RESET = "\x1b[39m"; // terminal-colors.js reset-only-foreground
const dim = (s) => FG_DIM + s + FG_RESET;
/** pi's FooterComponent.render(width) — the footer BLOCK (reproduced 1:1, with the
 *  ⚡ speed RIGHT-aligned on line 1 where pi-tps-live's custom footer put it):
 *  line 1 = the dim cwd (home → `~`) (+ ` (branch)`) with the speed at the right
 *  edge (ONLY when a reading exists); line 2 = the dim STATS on the left —
 *  `↑input ↓output` (+ cache R/W, `CH%`, `$cost` when present) and the ctx
 *  PERCENT of the context window (`0.0%/128k`; >90% error, >70% warning; an
 *  unknown max `?`) — and the MODEL RIGHT-aligned (`(provider) ` prefix when the
 *  dot-folder has >1 provider, ` • thinking off` on reasoning models, `no-model`
 *  when none). Truncation rules are pi's: the right side keeps ≥ 2 cells of
 *  padding, both sides truncate cell-exact, and a too-wide line keeps the left and
 *  drops the right. Returns a "\n"-joined STRING — the chart splits it into its
 *  bottom-pinned rows, the line mode prints it as its footer lines. */
export function renderFooter({ usage, model, rate, lastUsage, statuses, providers = 0, cwd, width = 120, contextUsage } = {}) {
  const known = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const W = Math.max(40, width);
  // line 1 — the dim cwd (home-folded) + ` (branch)`, the ⚡ speed right-aligned
  let pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
  const branch = gitBranch(cwd);
  if (branch) pwd = `${pwd} (${branch})`;
  let line1 = truncateStyled(dim(pwd), W, dim("...")); // pi's truncation marker: 3-char "..." (footer.js:210)
  const tps = known(rate) ? `${rate.toFixed(1)} tok/s` : null; // pi-tps-live: a reading exists → `⚡ x tok/s`, NO reading → NOTHING (never "n/a")
  if (tps) {
    const speedText = dim(`⚡ ${tps}`);
    const speedWidth = visibleWidth(speedText);
    if (12 + speedWidth <= W) {
      const left = truncateStyled(dim(pwd), W - speedWidth - 1, dim("..."));
      line1 = left + " ".repeat(Math.max(1, W - visibleWidth(left) - speedWidth)) + speedText;
    }
  }
  // line 2 — pi's STATS left, the MODEL right (right-aligned, ≥ 2 cells padding)
  const parts = [];
  if (known(usage?.input)) parts.push(`↑${formatTokens(usage.input)}`);
  if (known(usage?.output)) parts.push(`↓${formatTokens(usage.output)}`);
  if (known(usage?.cacheRead)) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (known(usage?.cacheWrite)) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  // pi's latestCacheHitRate (footer.js:86-88): the LAST assistant usage's
  // cacheRead / (input + cacheRead + cacheWrite) * 100 — obs's "last assistant
  // message" is the LAST round trip's usage (client.usage, passed as lastUsage).
  let latestCacheHitRate;
  if (lastUsage) {
    const latestPromptTokens = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite;
    latestCacheHitRate = latestPromptTokens > 0 ? (lastUsage.cacheRead / latestPromptTokens) * 100 : undefined;
  }
  if ((usage?.cacheRead > 0 || usage?.cacheWrite > 0) && latestCacheHitRate !== undefined) {
    parts.push(`CH${latestCacheHitRate.toFixed(1)}%`); // pi's CH field (footer.js:125-127)
  }
  // pi's cost push (footer.js:129-134) — usingSubscription is the kimi-coding
  // provider-name check only: pi's isUsingSubscription half (OAuth +
  // auth.oauth.isSubscription) is constant false here (API-key auth only).
  const usingSubscription = model?.provider === "kimi-coding";
  const usageCost = usage?.cost ?? 0;
  if (usageCost > 0 || usingSubscription) parts.push(`$${usageCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
  // pi's context display (footer.js:99-101, 137-151, fed by
  // agent-session.getContextUsage): the window falls back to 0 (NOT "?" — pi's
  // no-model case renders `0.0%/0`). THE PERCENT comes from the session's live
  // CONTEXT-USAGE state when one exists (the compaction driver, src/compaction.js,
  // sets client.contextUsage after every turn and compaction — pi's footer reads
  // session.getContextUsage() every frame): right after a compaction there is
  // no post-compaction assistant usage yet → percent null → `?/<window>` until
  // the next LLM response (pi's exact display); afterwards the pi-style estimate
  // (last valid assistant usage + trailing chars/4). NO state (legacy paths:
  // the injected suites, clients without the driver) → the historical
  // session-cumulative totalTokens formula, byte-identical to before.
  // ` (auto)` is pi's default (autoCompactEnabled true at startup, i-mode:365);
  // the harness auto-compacts by default too (settings.json "compaction"
  // can disable it — the indicator stays (auto), pi's toggle is a settings
  // menu the harness does not port).
  const contextWindow = model?.contextWindow ?? 0;
  let percent;
  if (contextUsage && typeof contextUsage.percent === "number") {
    percent = Math.min(100, contextUsage.percent);
  } else if (contextUsage && contextUsage.percent === null) {
    percent = null; // pi: post-compaction — unknown until the next response
  } else {
    const total = known(usage?.totalTokens) ? usage.totalTokens : null;
    percent = total === null ? 0 : Math.min(100, (total / (contextWindow || 1)) * 100);
  }
  const contextPercent = percent === null ? "?" : percent.toFixed(1);
  const autoIndicator = " (auto)";
  const contextPercentDisplay = contextPercent === "?"
    ? `?/${formatTokens(contextWindow)}${autoIndicator}`
    : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
  parts.push(percent > 90 ? `${FG_ERROR}${contextPercentDisplay}${FG_RESET}` : percent > 70 ? `${FG_WARNING}${contextPercentDisplay}${FG_RESET}` : contextPercentDisplay);
  if (process.env.PI_EXPERIMENTAL === "1") {
    // pi's `• xp` (footer.js:152-153; bytes verified with pi's chalk:
    // theme.fg("dim","•") + " " + theme.bold(theme.fg("warning","xp")))
    parts.push(dim("•") + " " + "\x1b[1m" + FG_WARNING + "xp" + FG_RESET + "\x1b[22m");
  }
  let statsLeft = parts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);
  // If statsLeft is too wide, truncate it (pi: plain "..." marker, footer.js:161)
  if (statsLeftWidth > W) {
    statsLeft = truncateStyled(statsLeft, W, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }
  // pi's model = the ID, not the name (footer.js:157)
  const minPadding = 2;
  const modelName = model?.id || "no-model";
  let rightSideWithoutProvider = modelName;
  if (model?.reasoning) rightSideWithoutProvider = `${modelName} • thinking off`; // pi: the thinking LEVEL rides the model name on reasoning models (`off` default — obs has no /thinking, so the default never differs)
  // Prepend the provider in parentheses when there are multiple providers — with
  // pi's FIT-CHECK fallback (footer.js:175-180): a too-wide prefixed name drops
  // the prefix instead of truncating the name. The count stays the models.json
  // provider count (no model-availability snapshot capability).
  let modelSide = rightSideWithoutProvider;
  if (providers > 1 && model?.provider) {
    modelSide = `(${model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(modelSide) > W) modelSide = rightSideWithoutProvider;
  }
  const rightWidth = visibleWidth(modelSide);
  let statsLine;
  if (statsLeftWidth + minPadding + rightWidth <= W) {
    statsLine = statsLeft + " ".repeat(W - statsLeftWidth - rightWidth) + modelSide;
  } else {
    const available = W - statsLeftWidth - minPadding;
    if (available > 0) {
      const truncated = truncateStyled(modelSide, available, "");
      statsLine = statsLeft + " ".repeat(Math.max(0, W - statsLeftWidth - visibleWidth(truncated))) + truncated;
    } else {
      statsLine = statsLeft;
    }
  }
  // dim the halves SEPARATELY — the colored ctx chunk ends with its own reset, which
  // would clear an outer wrapper (pi's footer.js dimStatsLeft + dimRemainder); each
  // line closes with the fg reset so no color can ever leak into the pinned rows.
  const line2 = dim(statsLine.slice(0, statsLeft.length)) + dim(statsLine.slice(statsLeft.length));
  const lines = [line1, line2];
  // pi's extension-statuses line (footer.js:213-221): only when non-empty —
  // keys sorted alphabetically, each value through sanitizeStatusText, joined
  // with one space, truncated to the width with a dim "..." marker.
  if (statuses && statuses.size > 0) {
    const sortedStatuses = Array.from(statuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(text));
    const statusLine = sortedStatuses.join(" ");
    lines.push(truncateStyled(statusLine, W, dim("...")));
  }
  // pi NEVER runs the composed lines through sanitizeStatusText — pi's sanitizer is
  // for the EXTENSION statuses line ONLY; feeding line1/line2 to it DOWN TO ITS
  // `.replace(/ +/g, " ")` collapsed the right-alignment padding (75 pad cells → 1)
  // — after a /model the model name jumped beside the stats instead of resting at
  // the right edge. The composed lines carry no control chars but ESC: neutralize a
  // stray newline/tab ONLY, then return — padding and escape codes ride along.
  return lines.map((l) => String(l ?? "").replace(/[\r\n\t]/g, " ")).join("\n");
}

/** The footer BLOCK for the exchange completed on a client — SAME scope for all five
 *  token fields, pi-style: usage from the client's session-cumulative totals (pi's
 *  addUsageToTotals over every round trip, like pi's footer) and tok/s from the
 *  client's meter (average over the whole exchange). A per-turn view exists ONLY
 *  via the explicit { perTurn: true } flag (last round trip's usage + the last
 *  round trip's own average); it defaults to cumulative to match pi. `providers`
 *  (the dot-folder models.json provider count — >1 → the footer's (provider)
 *  prefix) and `cwd` (footer line 1's path) default to the live config / the
 *  running directory. */
export function footerLine(client, { perTurn = false, cwd, providers, width } = {}) {
  return renderFooter({
    usage: perTurn ? client?.usage : client?.totals,
    lastUsage: client?.usage, // pi's CH% = the LAST assistant message's usage (obs: the last round trip's)
    model: client?.model,
    contextUsage: client?.contextUsage, // pi's getContextUsage state (the compaction driver) — the ctx % of a compacted session
    rate: perTurn ? client?.meter?.lastRate : client?.meter?.rate,
    statuses: getExtensionStatuses(), // pi's line-3 extension statuses (empty Map → no line)
    providers: typeof providers === "number" ? providers : Object.keys(loadProviders()).length || 1,
    cwd: cwd ?? process.cwd(),
    // pi's FooterComponent.render(width): the footer is ALWAYS rendered at the
    // TRUE terminal width — the hardcoded 120 was the second bug's half: the
    // chart paints at cols() and its wrapStyled chop dropped the RIGHT-aligned
    // model name on narrower terminals. Real runs fall back to actual stdout
    // columns; piped/injected widths stay 120 → the deterministic suites keep
    // their captured bytes.
    width: width ?? process.stdout?.columns ?? 120,
  });
}

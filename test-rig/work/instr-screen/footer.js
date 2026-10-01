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
//   without a live model degrades field by field: an unknown max context "?", the
//   model "no-model". The meter's `now`/`elapsedMs` arguments default to
//   Date.now() like token-rate.ts; tests pass explicit times to drive the windows
//   deterministically. ALL fields are session-cumulative by default (pi's footer);
//   a per-turn view exists ONLY via footerLine's explicit { perTurn: true } flag.
//   Never prints secrets.

import { spawnSync } from "node:child_process";
import { loadProviders } from "./config.js";

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
 *  speed "n/a tok/s", model "unknown". */
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
    cells += 1;
    i += 1;
  }
  return cells;
}

/** ANSI-aware truncate at `w` cells, keeping every escape run whole (pi-tui's
 *  truncateToWidth — a cut mid-sequence would corrupt the pinned row). An
 *  optional `ellipsis` is appended AFTER a real cut (pi passes
 *  theme.fg("dim", "...") — the truncated content ends with the marker, never
 *  mid-sequence). */
export function truncateStyled(s, w, ellipsis = "") {
  const W = Math.max(0, w);
  let out = "";
  let cells = 0;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; ) {
    if (t.charCodeAt(i) === 27) {
      const e = t.indexOf("m", i);
      if (e < 0) {
        out += t.slice(i);
        break;
      }
      out += t.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (cells >= W) {
      if (ellipsis) out += ellipsis;
      break;
    }
    out += t[i];
    cells += 1;
    i += 1;
  }
  return out;
}

/** pi's formatCwdForFooter (footer.js): the cwd with the home prefix folded into
 *  `~` when it lives inside home (pi: `~` for the home itself, `~\sub` inside). */
export function formatCwdForFooter(cwd, home) {
  if (!home) return String(cwd ?? "");
  const sep = "/";
  const rc = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const rh = home.replace(/\\/g, "/").replace(/\/+$/, "");
  if (rc === rh) return "~";
  if (rc.startsWith(`${rh}${sep}`)) return `~${rc.slice(rh.length)}`;
  return rc;
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
export function renderFooter({ usage, model, rate, name, providers = 0, cwd, width = 120 } = {}) {
  const known = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const W = Math.max(40, width);
  // line 1 — the dim cwd (home-folded) + ` (branch)`, the ⚡ speed right-aligned
  let pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
  const branch = gitBranch(cwd);
  if (branch) pwd = `${pwd} (${branch})`;
  let line1 = truncateStyled(dim(pwd), W, dim("…"));
  const tps = known(rate) ? `${rate.toFixed(1)} tok/s` : null; // pi-tps-live: a reading exists → `⚡ x tok/s`, NO reading → NOTHING (never "n/a")
  if (tps) {
    const speedText = dim(`⚡ ${tps}`);
    const speedWidth = visibleWidth(speedText);
    if (12 + speedWidth <= W) {
      const left = truncateStyled(dim(pwd), W - speedWidth - 1, dim("…"));
      line1 = left + " ".repeat(Math.max(1, W - visibleWidth(left) - speedWidth)) + speedText;
    }
  }
  // line 2 — pi's STATS left, the MODEL right (right-aligned, ≥ 2 cells padding)
  const parts = [];
  if (known(usage?.input)) parts.push(`↑${formatTokens(usage.input)}`);
  if (known(usage?.output)) parts.push(`↓${formatTokens(usage.output)}`);
  if (known(usage?.cacheRead)) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (known(usage?.cacheWrite)) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  const window = known(model?.contextWindow) ? formatTokens(model.contextWindow) : "?";
  const total = known(usage?.totalTokens) ? usage.totalTokens : null;
  // pi's getContextUsage: a fresh session estimates ~0 → `0.0%/window`; "?" is ONLY
  // the no-model / unknown-window case (after compaction with no new response).
  const pct = total === null ? 0 : Math.min(100, (total / (model?.contextWindow || 1)) * 100);
  const pctDisplay = `${pct.toFixed(1)}%/${window}`; // ctx = PERCENT of the window, pi's footer
  parts.push(pct === null ? pctDisplay : pct > 90 ? `${FG_ERROR}${pctDisplay}${FG_RESET}` : pct > 70 ? `${FG_WARNING}${pctDisplay}${FG_RESET}` : pctDisplay);
  let statsLeft = parts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > W) {
    statsLeft = truncateStyled(statsLeft, W - 0, "…");
    statsLeftWidth = visibleWidth(statsLeft);
  }
  let modelSide = (name ?? model?.name ?? model?.id) || "no-model";
  if (model?.reasoning) modelSide = `${modelSide} • thinking off`; // pi: the thinking LEVEL rides the model name on reasoning models (`off` default)
  if (providers > 1 && model?.provider) modelSide = `(${model.provider}) ${modelSide}`;
  const rightWidth = visibleWidth(modelSide);
  const minPadding = 2;
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
  // pi NEVER runs the composed lines through sanitizeStatusText — pi's sanitizer is
  // for the EXTENSION statuses line ONLY; feeding line1/line2 to it DOWN TO ITS
  // `.replace(/ +/g, " ")` collapsed the right-alignment padding (75 pad cells → 1)
  // — after a /model the model name jumped beside the stats instead of resting at
  // the right edge. The composed lines carry no control chars but ESC: neutralize a
  // stray newline/tab ONLY, then return — padding and escape codes ride along.
  return [line1, line2].map((l) => String(l ?? "").replace(/[\r\n\t]/g, " ")).join("\n");
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
    model: client?.model,
    rate: perTurn ? client?.meter?.lastRate : client?.meter?.rate,
    name: client?.model?.name ?? client?.model?.id,
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

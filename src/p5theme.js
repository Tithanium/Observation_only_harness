// src/p5theme.js — PIECE 5 (A18, A21, B3, B4): the pi DARK-THEME port.
// Source: pi 0.86.1, `@earendil-works/pi-coding-agent/dist`:
//   • `modes/interactive/theme/dark.json` — the color values (vars resolved as in
//     the file: e.g. "mdCode": "accent" → accent #8abeb7).
//   • `modes/interactive/theme/theme.js`:
//       - `hexToRgb` (:26-39) VERBATIM;
//       - `fgAnsi`/`bgAnsi` (:118-150) — the TRUECOLOR branch only (spec §6:
//         win32 ⇒ trueColor, `getCapabilities().trueColor` is true on this
//         machine — tui:terminal-image.js:80-83; the 256-color fallback is not
//         exercised and is dropped, consistent with every existing constant in
//         this harness, which are all `\x1b[38;2;r;g;bm`);
//       - the `Theme` class fg/bg forms (:197-204) VERBATIM — `fg(c, text)` =
//         `${ansi}${text}\x1b[39m` (FOREGROUND-ONLY reset), `bg(c, text)` =
//         `${ansi}${text}\x1b[49m` (BACKGROUND-ONLY reset);
//       - `buildCliHighlightTheme` (:798-825) VERBATIM — the scope→color map
//         that drives highlight.js per-scope coloring (A18);
//       - `getMarkdownTheme` (:925-962) VERBATIM — the Markdown-component theme
//         (heading/link/code/codeBlock/quote/hr/listBullet styles +
//         highlightCode with the `supportsLanguage` gate).
// Adaptation note (the only one): pi's `theme.bold/italic/underline/
// strikethrough` delegate to `chalk` (theme.js:207-220). chalk at FORCE_COLOR=3
// emits the level-independent SGRs `\x1b[1m…\x1b[22m` / `\x1b[3m…\x1b[23m` /
// `\x1b[4m…\x1b[24m` / `\x1b[9m…\x1b[29m` — byte-identical to the forms below,
// which are emitted directly so the harness does not take a chalk dependency
// (the authorized deps for piece 5 are marked + highlight.js only, spec §4
// dependency note). The SGR forms are quoted in spec §2 ("Chalk attributes
// (level-independent SGRs)").

import { highlight, supportsLanguage } from "./p5highlight.js";

// ============================================================================
// dark.json — the color values (vars resolved)
// ============================================================================
const DARK_FG_HEX = {
  accent: "#8abeb7", // :14
  border: "#5f87ff", // vars.blue
  borderAccent: "#00d7ff", // vars.cyan
  borderMuted: "#505050", // darkGray
  success: "#b5bd68", // green
  error: "#cc6666", // red
  warning: "#ffff00", // yellow
  muted: "#808080", // gray
  dim: "#666666", // dimGray
  text: "#d4d4d4", // :10
  thinkingText: "#808080", // gray
  scrollbarTrack: "#505050", // darkGray (:36)
  scrollbarThumb: "#d4d4d4", // text (:37)
  searchMatchText: "#d4d4d4", // text
  userMessageText: "#d4d4d4", // text
  customMessageText: "#d4d4d4", // text
  customMessageLabel: "#9575cd",
  toolTitle: "#d4d4d4", // text
  toolOutput: "#808080", // gray
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  mdLinkUrl: "#666666", // dimGray
  mdCode: "#8abeb7", // accent
  mdCodeBlock: "#b5bd68", // green
  mdCodeBlockBorder: "#808080", // gray
  mdQuote: "#808080", // gray
  mdQuoteBorder: "#808080", // gray
  mdHr: "#808080", // gray
  mdListBullet: "#8abeb7", // accent
  toolDiffAdded: "#b5bd68", // green
  toolDiffRemoved: "#cc6666", // red
  toolDiffContext: "#808080", // gray
  syntaxComment: "#6A9955",
  syntaxKeyword: "#569CD6",
  syntaxFunction: "#DCDCAA",
  syntaxVariable: "#9CDCFE",
  syntaxString: "#CE9178",
  syntaxNumber: "#B5CEA8",
  syntaxType: "#4EC9B0",
  syntaxOperator: "#D4D4D4",
  syntaxPunctuation: "#D4D4D4",
  thinkingOff: "#505050", // darkGray
  thinkingMinimal: "#6e6e6e",
  thinkingLow: "#5f87af",
  thinkingMedium: "#81a2be",
  thinkingHigh: "#b294bb",
  thinkingXhigh: "#d183e8",
  thinkingMax: "#ff5fff",
  bashMode: "#b5bd68", // green
};
const DARK_BG_HEX = {
  selectedBg: "#3a3a4a", // :15
  searchMatchBg: "#3a3a4a", // selectedBg
  userMessageBg: "#343541", // userMsgBg
  customMessageBg: "#2d2838", // customMsgBg
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
};

// ============================================================================
// Color Utilities (theme.js — truecolor path only)
// ============================================================================
function hexToRgb(hex) {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r, g, b };
}
function fgAnsi(color) {
  if (color === "") return "\x1b[39m";
  if (typeof color === "number") return `\x1b[38;5;${color}m`;
  if (color.startsWith("#")) {
    const { r, g, b } = hexToRgb(color);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  throw new Error(`Invalid color value: ${color}`);
}
function bgAnsi(color) {
  if (color === "") return "\x1b[49m";
  if (typeof color === "number") return `\x1b[48;5;${color}m`;
  if (color.startsWith("#")) {
    const { r, g, b } = hexToRgb(color);
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  throw new Error(`Invalid color value: ${color}`);
}

// ============================================================================
// Theme (theme.js:168-243 — fg/bg maps + the fg()/bg()/attribute forms)
// ============================================================================
export class Theme {
  name;
  mode;
  fgColors;
  bgColors;
  constructor(fgHexColors, bgHexColors) {
    this.name = "dark";
    this.mode = "truecolor"; // win32 ⇒ trueColor (terminal-image.js:80-83)
    this.fgColors = new Map();
    for (const [key, value] of Object.entries(fgHexColors)) {
      this.fgColors.set(key, fgAnsi(value));
    }
    this.bgColors = new Map();
    for (const [key, value] of Object.entries(bgHexColors)) {
      this.bgColors.set(key, bgAnsi(value));
    }
  }
  fg(color, text) {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`; // Reset only foreground color
  }
  bg(color, text) {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1b[49m`; // Reset only background color
  }
  bold(text) {
    if (text === "") return ""; // chalk returns "" for empty input (verified: chalk.bold("") === "")
    return `\x1b[1m${text}\x1b[22m`; // chalk.bold at level 3
  }
  italic(text) {
    if (text === "") return ""; // chalk.italic(""), as above — matters for blank quoted lines (spec §2.8)
    return `\x1b[3m${text}\x1b[23m`; // chalk.italic
  }
  underline(text) {
    if (text === "") return ""; // chalk.underline("")
    return `\x1b[4m${text}\x1b[24m`; // chalk.underline
  }
  strikethrough(text) {
    if (text === "") return ""; // chalk.strikethrough("")
    return `\x1b[9m${text}\x1b[29m`; // chalk.strikethrough
  }
  getFgAnsi(color) {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return ansi;
  }
  getBgAnsi(color) {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
  }
  getColorMode() {
    return this.mode;
  }
}

/** THE dark theme instance (pi's `initTheme("dark")` result for this machine). */
export const theme = new Theme(DARK_FG_HEX, DARK_BG_HEX);

// ============================================================================
// buildCliHighlightTheme (theme.js:798-825 VERBATIM) — the scope→color map the
// highlight.js output is post-processed through (renderHighlightedHtml).
// ============================================================================
function buildCliHighlightTheme(t) {
  return {
    keyword: (s) => t.fg("syntaxKeyword", s),
    built_in: (s) => t.fg("syntaxType", s),
    literal: (s) => t.fg("syntaxNumber", s),
    number: (s) => t.fg("syntaxNumber", s),
    regexp: (s) => t.fg("syntaxString", s),
    string: (s) => t.fg("syntaxString", s),
    comment: (s) => t.fg("syntaxComment", s),
    doctag: (s) => t.fg("syntaxComment", s),
    meta: (s) => t.fg("muted", s),
    function: (s) => t.fg("syntaxFunction", s),
    title: (s) => t.fg("syntaxFunction", s),
    class: (s) => t.fg("syntaxType", s),
    type: (s) => t.fg("syntaxType", s),
    tag: (s) => t.fg("syntaxPunctuation", s),
    name: (s) => t.fg("syntaxKeyword", s),
    attr: (s) => t.fg("syntaxVariable", s),
    variable: (s) => t.fg("syntaxVariable", s),
    params: (s) => t.fg("syntaxVariable", s),
    operator: (s) => t.fg("syntaxOperator", s),
    punctuation: (s) => t.fg("syntaxPunctuation", s),
    emphasis: (s) => t.italic(s),
    strong: (s) => t.bold(s),
    link: (s) => t.underline(s),
    addition: (s) => t.fg("toolDiffAdded", s),
    deletion: (s) => t.fg("toolDiffRemoved", s),
  };
}
let cachedHighlightThemeFor;
let cachedCliHighlightTheme;
function getCliHighlightTheme(t) {
  if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
    cachedHighlightThemeFor = t;
    cachedCliHighlightTheme = buildCliHighlightTheme(t);
  }
  return cachedCliHighlightTheme;
}

// ============================================================================
// getMarkdownTheme (theme.js:925-962 VERBATIM) — the Markdown-component theme.
// `highlightCode`: skip highlight when the lang is not among the 21 eager
// highlight.js languages (uniform mdCodeBlock green instead, A17), else
// per-scope truecolor spans (A18).
// ============================================================================
export function getMarkdownTheme() {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
    highlightCode: (code, lang) => {
      // Validate language before highlighting to avoid stderr spam from cli-highlight
      const validLang = lang && supportsLanguage(lang) ? lang : undefined;
      // Skip highlighting when no valid language is specified. cli-highlight's
      // auto-detection is unreliable and can misidentify prose as AppleScript,
      // LiveCodeServer, etc., coloring random English words as keywords.
      if (!validLang) {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
      const opts = {
        language: validLang,
        ignoreIllegals: true,
        theme: getCliHighlightTheme(theme),
      };
      try {
        return highlight(code, opts).split("\n");
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    },
  };
}

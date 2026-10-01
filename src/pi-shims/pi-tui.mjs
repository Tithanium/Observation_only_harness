// src/pi-shims/pi-tui.mjs — the "@earendil-works/pi-tui" import target for
// extension files (ROUND 21). subagent/index.ts imports Container/Markdown/
// Spacer/Text at module scope and uses them INSIDE tool DISPLAY renderers, which
// only ever run in pi's TUI; in the harness's line mode they never render. The
// classes exist (the import must resolve), each with a minimal render surface so
// a stray render call degrades to plain text instead of a crash. The harness
// itself has no pi-tui package.
/** A positioned text element. */
export class Text {
  constructor(text = "", x = 0, y = 0) {
    this.text = text;
    this.x = x;
    this.y = y;
  }
  addString(s) {
    this.text += s;
  }
  get render() {
    return { rows: [[{ text: this.text }]] };
  }
}
/** A vertical spacer. */
export class Spacer {
  constructor(height = 1) {
    this.height = height;
  }
  addChild() {}
}
/** A row/column container of children. */
export class Container {
  constructor() {
    this.children = [];
  }
  addChild(child) {
    this.children.push(child);
  }
}
/** Markdown renderer (no-op in line mode) — callable with or without new. */
export class Markdown {
  constructor(markdownText, options) {
    this.text = typeof markdownText === "string" ? markdownText : "";
    this.rows = [[{ text: this.text }]];
  }
}

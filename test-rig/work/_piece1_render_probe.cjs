// TEMP probe: unit-check the new pi-ported prompt rendering (screen.js) at the byte level
const path = require("path");
process.chdir("C:/Users/connessn/Observation_only");
const E = "\x1b";
async function main() {
  const m = await import(require("url").pathToFileURL("C:/Users/connessn/Observation_only/src/screen.js").href);
  const mkOut = () => {
    const o = { buf: "", write(s) { this.buf += String(s); }, columns: 100, rows: 30 };
    return o;
  };
  const fail = (name, cond, extra) => {
    if (!cond) { console.log("FAIL:", name, extra ? JSON.stringify(extra).slice(0, 300) : ""); process.exitCode = 1; }
    else console.log("ok  :", name);
  };

  // --- T1: idle prompt (empty line) at 100x30, 1-line footer
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter();
    s.setFooter("footer-line"); // boot paint
    const buf = out.buf;
    // writing row = 30-1-1 = 28
    fail("T1 idle: bar above row 27", buf.includes(`${E}[27;1H${E}[38;2;80;80;80m` + "\u2500".repeat(100)));
    const idleRow = `${E}[28;1H${E}[7m ${E}[0m` + " ".repeat(99) + `${E}[K`;
    fail("T1 idle: block-space + 99 pad at row 28", buf.includes(idleRow), buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 60));
    const bufEnd = buf.slice(buf.indexOf(`${E}[29;1H`), buf.indexOf(`${E}[29;1H`) + 20);
    fail("T1 idle: bottom bar row 29", buf.includes(`${E}[29;1H${E}[38;2;80;80;80m` + "\u2500".repeat(100)));
    fail("T1 idle: footer row 30", buf.includes(`${E}[30;1Hfooter-line${E}[K`));
    fail("T1 idle: sync burst", buf.includes(`${E}[?2026h`) && buf.includes(`${E}[?2026l`));
  }

  // --- T2: "hello" typed at the end
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    s.setPromptLine("hello", 5);
    s.writePromptBox();
    const buf = out.buf;
    const row = `${E}[28;1Hhello${E}[7m ${E}[0m` + " ".repeat(94) + `${E}[K`;
    fail("T2 'hello@end': row = hello + block-space + 94 pad", buf.includes(row), buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 60));
  }

  // --- T3: cursor mid-line "hello" cursor=2 → block the 'l'
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    s.setPromptLine("hello", 2);
    s.writePromptBox();
    const buf = out.buf;
    const row = `${E}[28;1Hhe${E}[7ml${E}[0mlo` + " ".repeat(95) + `${E}[K`;
    fail("T3 mid-cursor: he[l]lo + 95 pad", buf.includes(row), buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 60));
  }

  // --- T4: word wrap — a 150-char line of words at 100 cols (layoutWidth 99)
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    const line = "the quick brown fox jumps over the lazy dog near the river bank in the morning light";
    // 88 chars — fits one row. Make a longer one:
    const line2 = "the quick brown fox jumps over the lazy dog near the river bank in the morning light above the tall dark tree line";
    // 128 chars → wraps at 99
    s.setPromptLine(line2, line2.length);
    s.writePromptBox();
    const buf = out.buf;
    // box = 2 rows: rows 27 (top bar 26), writing rows 27-28, bottom bar 29, footer 30
    fail("T4 wrapped: top bar at row 26", buf.includes(`${E}[26;1H${E}[38;2;80;80;80m`));
    const row27 = buf.slice(buf.indexOf(`${E}[27;1H`), buf.indexOf(`${E}[27;1H`) + 200);
    const row28 = buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 200);
    // pi word wrap: the SPACE ITSELF is a segment — when the line is exactly
    // full (99) and the next char is a space, the break falls back to the
    // previous wrap opportunity: chunk1 keeps the trailing space, chunk2 starts
    // at the next word. line2: "…above the" = 94, +" tall" = 99 (full), the
    // following space overflows → break at the space before "tall".
    const firstChunk = "the quick brown fox jumps over the lazy dog near the river bank in the morning light above the ";
    const secondChunk = "tall dark tree line";
    fail("T4 wrapped: row27 = chunk1 (word break, trailing space in chunk1)", row27.startsWith(`${E}[27;1H` + firstChunk), { firstChunk, row27: row27.slice(0, 120) });
    fail("T4 wrapped: row28 starts chunk2 + block at end", row28.includes(secondChunk + `${E}[7m ${E}[0m`), { secondChunk: secondChunk.slice(0, 60), row28: row28.slice(0, 120) });
    fail("T4 wrapped: bottom bar row 29", buf.includes(`${E}[29;1H${E}[38;2;80;80;80m`));
  }

  // --- T5: huge prompt (2000 chars of words) → box capped at maxVisibleLines=9,
  //         cursor at end → scroll offset = 2000/99 - 9 ≈ 11, top bar shows " ↑ N more "
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda".split(" ");
    let line = "";
    while (line.length < 2000) line += words[(line.length * 7) % words.length] + " ";
    line = line.trimEnd();
    s.setPromptLine(line, line.length);
    s.writePromptBox();
    const buf = out.buf;
    // box = 9 rows → writingTopRow = 30-1-1-(9-1) = 20 → top bar row 19, box 20..28, bottom bar 29
    const topBar = buf.slice(buf.indexOf(`${E}[19;1H`), buf.indexOf(`${E}[19;1H`) + 160);
    fail("T5 capped: box 9 rows (top bar row 19)", buf.includes(`${E}[19;1H${E}[38;2;80;80;80m`), topBar);
    fail("T5 capped: top bar carries ' more ' label", / \u2191 \d+ more /.test(topBar), topBar);
    // cursor at end → last visible chunk is the last chunk; bottom bar has no label
    const b29 = buf.slice(buf.indexOf(`${E}[29;1H`), buf.indexOf(`${E}[29;1H`) + 160);
    fail("T5 capped: bottom bar plain (cursor at end)", b29.includes("\u2500".repeat(50)), b29.slice(0, 120));
  }

  // --- T6: wide glyph (CJK) at the wrap boundary — 50 x '世' (2 cells each = 100 cells)
  //         at layoutWidth 99 → chunks of 49 (98 cells) + 1
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    const line = "\u4e16".repeat(50);
    s.setPromptLine(line, 50);
    s.writePromptBox();
    const buf = out.buf;
    // CJK: pi's wordWrapLine allows a break between any adjacent CJK chars →
    // chunk 0 = 49 chars (98 cells), chunk 1 = 1 char
    const row27 = buf.slice(buf.indexOf(`${E}[27;1H`), buf.indexOf(`${E}[27;1H`) + 160);
    const row28 = buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 160);
    fail("T6 CJK: row27 has 49 glyphs", row27.includes("\u4e16".repeat(49)), row27.slice(0, 80));
    fail("T6 CJK: row28 = 1 glyph + block space", row28.includes(`\u4e16${E}[7m ${E}[0m`), row28.slice(0, 80));
  }

  // --- T7: single-line gate — 99-char line (== layoutWidth) stays ONE row;
  //         100-char line wraps to TWO rows
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    out.buf = "";
    s.setPromptLine("a".repeat(99), 99);
    s.writePromptBox();
    let buf = out.buf;
    fail("T7 99 chars: one row (writing row 28)", buf.includes(`${E}[28;1H${"a".repeat(99)}${E}[7m ${E}[0m${E}[K`), buf.slice(buf.indexOf(`${E}[28;1H`), buf.indexOf(`${E}[28;1H`) + 40));
    // bottom bar at 29, top bar at 27 → box height 1
    fail("T7 99 chars: top bar row 27", buf.includes(`${E}[27;1H${E}[38;2;80;80;80m`));
    out.buf = "";
    s.setPromptLine("a".repeat(100), 100);
    s.writePromptBox();
    buf = out.buf;
    fail("T7 100 chars: two rows (top bar row 26)", buf.includes(`${E}[26;1H${E}[38;2;80;80;80m`), buf.slice(0, 120));
  }

  // --- T8: view() / viewHeight / writingTopRow geometry + setPromptLine API surface
  {
    const out = mkOut();
    const s = m.createScreen({ output: out });
    s.enter(); s.setFooter("f");
    fail("T8 writingTopRow N=1 = 28", s.writingTopRow() === 28, s.writingTopRow());
    s.setPromptLine("a".repeat(200), 199);
    fail("T8 writingTopRow N=3 = 26 (200 chars = 3 chunks)", s.writingTopRow() === 26, s.writingTopRow());
    fail("T8 viewHeight N=3 = 24", s.viewHeight() === 24, s.viewHeight());
  }
  process.exit(process.exitCode ?? 0);
}
main();

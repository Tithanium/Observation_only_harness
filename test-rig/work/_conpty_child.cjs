// TEMP child: verify the PLANNED fix pattern survives ConPTY
const E = "\x1b";
const D100 = "\u2500".repeat(100);
const w = (s) => process.stdout.write(s);
w(E + "[2J" + E + "[H");
// P1: PLANNED bar — CUP + 2K + color + 100 dashes + SGR39 (no trailing EL), then the writing row (CUP + block + SGR27 + pads + EL)
w("P1|" + E + "[2;1H" + E + "[2K" + E + "[38;2;80;80;80m" + D100 + E + "[39m" + E + "[3;1H" + E + "[7m" + " " + E + "[27m" + " ".repeat(97) + E + "[K");
// P2: PLANNED bar followed by ANOTHER full bar (top bar -> bottom bar adjacency)
w("P2|" + E + "[5;1H" + E + "[2K" + E + "[38;2;80;80;80m" + D100 + E + "[39m" + E + "[6;1H" + E + "[2K" + E + "[38;2;80;80;80m" + D100 + E + "[39m");
// P3: PLANNED label bar (with " ↑ 3 more " centered) — 2K + color + border(100) + SGR39
const label = " \u2191 3 more ";
const left = 44, right = 100 - left - label.length;
w("P3|" + E + "[8;1H" + E + "[2K" + E + "[38;2;80;80;80m" + "\u2500".repeat(left) + label + "\u2500".repeat(right) + E + "[39m");
// P4: clearing pass then a new shorter bar (menu narrowing simulation): 2K on rows 9-14, then a 3-row band
w("P4|" + E + "[9;1H" + E + "[2K" + E + "[10;1H" + E + "[2K" + E + "[11;1H" + E + "[2K" + E + "[12;1H" + E + "[2K" + E + "[13;1H" + E + "[2K" + E + "[14;1H" + E + "[2K" + E + "[11;1H" + E + "[2m" + "slash commands header" + E + "[22m" + E + "[K");
w("END\r\n");

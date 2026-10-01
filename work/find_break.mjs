import fs from "fs";
const s = fs.readFileSync("src/screen.js", "utf8");
const st = [];
let line = 1, i = 0;
while (i < s.length) {
  const c = s[i], n = s[i + 1];
  if (c === "\n") line++;
  if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
  if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { if (s[i] === "\n") line++; i++; } i += 2; continue; }
  if (c === "'") { i++; while (i < s.length) { if (s[i] === "\\") i += 2; else if (s[i] === "'") { i++; break; } else i++; } continue; }
  if (c === "\"") { i++; while (i < s.length) { if (s[i] === "\\") i += 2; else if (s[i] === "\"") { i++; break; } else i++; } continue; }
  if (c === "`") { i++; while (i < s.length) { if (s[i] === "\\") i += 2; else if (s[i] === "`") { i++; break; } else i++; } continue; }
  if (c === "{" || c === "(" || c === "[") st.push([c, line]);
  if (c === "}" || c === ")" || c === "]") {
    const e = { ")": "(", "}": "{", "]": "[" }[c];
    if (st.length) { const t = st.pop(); if (t[0] !== e) console.log("MISMATCH", t, "vs", c, line); }
    else console.log("EXTRA CLOSE", c, line);
  }
  i++;
}
const closers = st.slice().reverse().map(([k]) => (k === "{" ? "}" : k === "[" ? "]" : ")"));
console.log("stack@EOF:", st.length, JSON.stringify(st));
fs.writeFileSync("src/screen.js", s + closers.join("") + "\n");
console.log("APPENDED", closers.join(""));

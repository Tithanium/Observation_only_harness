// TEMP: examine the raw (un-decoded) capture content for escape-sequence variants
const fs = require("fs");
const txt = fs.readFileSync("C:/Users/connessn/Observation_only/dev_rounds/piece1_ours.txt", "utf8");
const start = txt.indexOf("--- FULL PTY CAPTURE");
const end = txt.indexOf("--- END CAPTURE ---");
const sec = txt.slice(start, end);
const s = sec.slice(sec.indexOf('"') + 1, sec.lastIndexOf('"'));
// count backslash variants
let single = 0, double = 0;
let firstDouble = -1;
for (let j = 0; j < s.length; j++) {
  if (s[j] === "\\") {
    if (s[j + 1] === "\\") { double++; if (firstDouble === -1) firstDouble = j; j += 1; }
    else single++;
  }
}
console.log("single backslash:", single, "double backslash:", double, "first double at:", firstDouble);
if (firstDouble !== -1) console.log("context:", JSON.stringify(s.slice(firstDouble - 30, firstDouble + 30)));
// show the exact first 120 chars
console.log("head120:", JSON.stringify(s.slice(0, 120)));

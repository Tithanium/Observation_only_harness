// TEMP: print doRender from tui-alt-screen.js
const fs = require("fs");
const p = "C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js";
const s = fs.readFileSync(p, "utf8");
const i = s.indexOf("doRender() {");
// find matching end: print 4000 chars
console.log(s.slice(i, i + 5000));

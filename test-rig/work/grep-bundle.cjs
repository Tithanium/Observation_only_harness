// Helper: find snippets around a pattern in pi's bundled source. Usage:
//   node test-rig/work/grep-bundle.cjs "agent/models.json"
const p = 'C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-CMRUVXTE.js';
const s = require('fs').readFileSync(p, 'utf8');
const pat = process.argv[2];
let i = 0, n = 0;
while ((i = s.indexOf(pat, i)) >= 0 && n < 6) {
  console.log('### @' + i + ' (' + pat + ')');
  console.log(s.slice(Math.max(0, i - 260), i + 260).replace(/\n/g, '\u2424'));
  console.log('');
  i += pat.length; n++;
}

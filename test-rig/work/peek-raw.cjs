// peek-raw.cjs <logfile> [win:N] [mocklog] — window mode: raw.slice(raw.length-N).
const fs = require('fs');
const c = fs.readFileSync(process.argv[2], 'utf8');
const i = c.indexOf('"\\u001b');
const j = c.indexOf('"\n', i);
const raw = JSON.parse(c.slice(i, j + 1));
const arg3 = process.argv[3] || '1500';
if (String(arg3).startsWith('win:')) {
  const n = Number(String(arg3).slice(4));
  console.log('RAW WINDOW (last ' + n + ' of ' + raw.length + '):');
  console.log(raw.slice(-n).replace(/\u001b/g, '<ESC>'));
} else {
  console.log('RAW TAIL (' + arg3 + '):');
  console.log(raw.slice(-Number(arg3)).replace(/\u001b/g, '<ESC>'));
}
const mlog = process.argv[4] ? fs.readFileSync(process.argv[4], 'utf8').split('\n').filter(Boolean) : [];
console.log('=== MOCK LOG === entries=' + mlog.length);
for (const x of mlog) {
  try { const r = JSON.parse(x); console.log(' ', r.method, r.path, 'model=' + ((r.body || '').match(/"model":"[^"]*"/) || ['?'])[0] || '?', 'resp=' + (r.responsePayload || '').length + 'B'); } catch (e) { console.log('  BAD:', x.slice(0, 120)); }
}

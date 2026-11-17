// A witness for full-screen agent TUIs such as OpenCode: the alternate screen, SGR mouse reporting (the
// terminal sends wheel notches to the program, which scrolls its own conversation view) and bracketed
// paste. It draws 200 numbered items from an offset, shows "offset=N" and the last paste in its status
// row, and starts at the bottom like a conversation does.
// Usage: node alt-screen-witness.mjs [churn] [v2]
//   churn  writes more than the 2 MiB a replay keeps;
//   v2     the modes OpenCode 2 also sets (focus reports 1004, synchronized output 2026 around each frame,
//          grapheme clusters 2027, colour scheme reports 2031), as seen in a real OpenCode 2.3.0 session.
import fs from 'node:fs';

const TOTAL = 200;
const rows = () => process.stdout.rows || 24;
let offset = Math.max(0, TOTAL - rows() + 1);
let pasted = '-';
let submitted = 0;
let carry = '';

const churn = process.argv.includes('churn');
const v2 = process.argv.includes('v2');

function draw() {
  const lines = [];
  for (let row = 0; row < rows() - 1; row += 1) lines.push(`item ${offset + row + 1}`);
  const status = `offset=${offset} pasted=[${pasted}] submitted=${submitted}`;
  const frame = `\x1b[H\x1b[2J${lines.join('\r\n')}\r\n${status}`;
  fs.writeSync(1, v2 ? `\x1b[?2026h${frame}\x1b[?2026l` : frame);
}

function wheel(delta) {
  offset = Math.min(Math.max(0, TOTAL - rows() + 1), Math.max(0, offset + delta));
  draw();
}

fs.writeSync(1, `${v2 ? '\x1b[?2031h\x1b[?2027h' : ''}\x1b[?1049h\x1b[?1000h${v2 ? '\x1b[?1002h' : ''}\x1b[?1003h\x1b[?1006h\x1b[?2004h${v2 ? '\x1b[?1004h' : ''}`);
draw();
if (churn) {
  // More than the 2 MiB a replay keeps, as a long OpenCode session produces by redrawing: the mode
  // sequences above are then no longer in the replay of a browser that attaches afterwards.
  const start = offset;
  for (let frame = 0; frame < 9000; frame += 1) { offset = start - (frame % 2); draw(); }
  offset = start;
  draw();
}
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  carry += chunk.toString('utf8');
  for (;;) {
    const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(carry);
    if (paste) {
      pasted = paste[1].replace(/\n/g, '\\n');
      carry = carry.slice(0, paste.index) + carry.slice(paste.index + paste[0].length);
      draw();
      continue;
    }
    const mouse = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(carry);
    if (mouse) {
      if (mouse[0].endsWith('M') && mouse[1] === '64') wheel(-3);
      if (mouse[0].endsWith('M') && mouse[1] === '65') wheel(3);
      carry = carry.slice(0, mouse.index) + carry.slice(mouse.index + mouse[0].length);
      continue;
    }
    if (carry.includes('\r')) {
      submitted += 1;
      carry = carry.replace('\r', '');
      draw();
      continue;
    }
    break;
  }
  if (carry.length > 4096) carry = '';
});

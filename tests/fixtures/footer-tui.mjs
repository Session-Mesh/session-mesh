// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A witness program for the terminal resize tests: a main-screen renderer that keeps a status
// footer under its transcript the way Claude Code's renderer does (no alternate screen).
// - Its screen is the transcript, hard-wrapped at the PTY width, then a three-row footer
//   truncated (or right-aligned) to that width.
// - A frame rewrites the screen from its first changed row: cursor up from the parked cursor
//   (the empty row under the screen), erase and write each row. A changed row the cursor
//   cannot reach (above the viewport) repaints the viewport instead.
// - On SIGWINCH, when the width changes or the height decreases, it erases every viewport row
//   from the top (CSI H, then CSI 2K CSI B per row) and repaints the screen's last rows; rows
//   already in the terminal's scrollback are not touched.
// Usage: node footer-tui.mjs TAG [PARAGRAPHS]; it prints DONE-TAG in its last transcript row
// and keeps the footer alive until killed.
import fs from 'node:fs';

const tag = process.argv[2] ?? 'T';
const paragraphs = Number(process.argv[3] ?? 40);
const words = ('the program wraps its own transcript at the width it reads and keeps a footer of '
  + 'three rows under it, redrawn in place at every frame').split(' ');
const ESC = '\x1b[';
let cols = process.stdout.columns, rows = process.stdout.rows;
const transcript = []; // logical paragraphs
let screen = []; // the rows last drawn
let tick = 0;

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  out.push(line);
  return out;
}

function fit(text, width) {
  return [...text].length <= width ? text : `${[...text].slice(0, width - 1).join('')}…`;
}

function footer() {
  const update = '✔ Update installed · /restart to apply';
  return [
    fit('Reset: 41m | 5h: 0.0% | Weekly: 67.0%', cols),
    fit(`⏵⏵ auto mode on · 16 shells · esc to interrupt · ${tag} tick ${tick} · ← 2 agents`, cols),
    ' '.repeat(Math.max(0, cols - update.length)) + fit(update, cols),
  ];
}

function build() {
  return [...transcript.flatMap(text => wrap(text, cols)), ...footer()];
}

function write(text) {
  fs.writeSync(1, text);
}

// The viewport shows the screen's last rows; the cursor is parked on the empty row under it.
function repaintViewport(next) {
  let out = `${ESC}H${`${ESC}2K${ESC}B`.repeat(rows)}${ESC}H`;
  out += next.slice(Math.max(0, next.length - (rows - 1))).map(row => `${row}\r\n`).join('');
  write(out);
  screen = next;
}

function frame() {
  const next = build();
  let first = 0;
  while (first < screen.length && first < next.length && screen[first] === next[first]) first += 1;
  if (first === screen.length && first === next.length) return;
  const up = screen.length - first;
  if (up > rows - 1) return repaintViewport(next); // the changed row is out of reach
  // Rows it drew before are erased and rewritten; a row past its previous screen is assumed
  // blank, as a cell-diffing renderer does, so only its text is written. Rows it no longer
  // has are erased.
  let out = `\r${up ? `${ESC}${up}A` : ''}`;
  next.slice(first).forEach((row, index) => {
    out += `${first + index < screen.length ? `${ESC}2K` : ''}${row}\r\n`;
  });
  const gone = screen.length - next.length;
  if (gone > 0) out += `${`${ESC}2K${ESC}B`.repeat(gone)}${gone ? `${ESC}${gone}A` : ''}`;
  write(out);
  screen = next;
}

process.on('SIGWINCH', () => {
  const width = process.stdout.columns, height = process.stdout.rows;
  const reset = width !== cols || height < rows;
  cols = width;
  rows = height;
  if (reset) repaintViewport(build());
  else frame();
});

let added = 0;
setInterval(() => { tick += 1; frame(); }, 50);
const feeder = setInterval(() => {
  added += 1;
  const n = added;
  transcript.push(added === paragraphs ? `DONE-${tag}`
    : `${tag}-${n}: ${words.slice(0, 8 + (n % 12)).join(' ')} (${n})`);
  if (added === paragraphs) clearInterval(feeder);
  frame();
}, 120);
frame();

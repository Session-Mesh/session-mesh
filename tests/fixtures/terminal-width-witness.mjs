// A witness program for the terminal width tests: a streaming main-screen renderer that
// appends words to the current text row with relative cursor moves (up, right, write, down),
// the way a diff renderer patches a live area, and wraps at the PTY width it reads when it
// starts. Interpreted at another width than the one it read, its words land on the wrong rows.
// Its text is terminal-width-witness.json. Usage: node terminal-width-witness.mjs TAG
import fs from 'node:fs';

const {paragraphs} = JSON.parse(fs.readFileSync(new URL('terminal-width-witness.json', import.meta.url), 'utf8'));
const BELOW = 3; // rows between the text row and the parked cursor
const pause = new Int32Array(new SharedArrayBuffer(4));
const width = process.stdout.columns;

function put(text) {
  fs.writeSync(1, text);
  Atomics.wait(pause, 0, 0, 4); // separate writes, as a live renderer's frames are
}

const liveTail = tick => `\r\n\r\n* Working... (${tick})\x1b[K\r\n`;

function stream({first, rest, indent}) {
  let line = first;
  put(line + liveTail(0));
  rest.split(' ').forEach((word, index) => {
    if (line.length + 1 + word.length <= width - 1) {
      // patch: up to the text row, right to its end, write the word, come back down
      put(`\r\x1b[${BELOW}A\x1b[${line.length}C ${word}\r\x1b[${BELOW}B`);
      line += ` ${word}`;
    } else {
      // the program wraps: a new text row, and the live tail rewritten under it
      line = ' '.repeat(indent) + word;
      put(`\r\x1b[${BELOW - 1}A\x1b[J${line}${liveTail(index + 1)}`);
    }
  });
  put(`\r\x1b[${BELOW - 1}A\x1b[J\r\n`);
}

const tag = process.argv[2];
put(`\r\nwitness ${tag}: the program sees ${width} columns\r\n\r\n`);
for (const paragraph of paragraphs) stream(paragraph);
put(`FIN-${tag}\r\n`);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The diff viewer of the side panel: a `.diff` or `.patch` file opened in a pane (mesh-open, a
// clicked path) is rendered by static/diff.html with this module (built into static/diff-view.js,
// served under /viewlib/). It reads unified diffs, `git diff` output (several files, renames,
// new, deleted and binary files) or plain `diff -u`, and shows them unified or side by side, with
// the changed words of a modified line highlighted.
//
// The page runs in the panel's sandbox (view.py: SANDBOX_DOC, no network, no storage). The diff
// is data: every piece of it reaches the DOM as text (textContent), never as markup.

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  // "\ No newline at end of file" followed this line
  noNewline: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  added: number;
  deleted: number;
}

export interface ParsedDiff {
  files: FileDiff[];
  // lines before the first file (a commit message from `git show`, `git format-patch` headers)
  preamble: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// `--- a/src/x.ml\t2026-01-01 ...` -> `src/x.ml`; `/dev/null` -> null.
function headerPath(raw: string, prefix: string, gitStyle: boolean): string | null {
  let value = raw.split('\t')[0] ?? '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
  if (value === '/dev/null') return null;
  if (gitStyle && value.startsWith(prefix)) return value.slice(prefix.length);
  return value;
}

function newFile(): FileDiff {
  return {oldPath: null, newPath: null, status: 'modified', hunks: [], added: 0, deleted: 0};
}

// `diff --git a/x b/y`: the paths, when they can be split without ambiguity (no rename header follows).
function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  const match = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return [match[1], match[2]];
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const files: FileDiff[] = [];
  const preamble: string[] = [];
  let file: FileDiff | null = null;
  let gitStyle = false;
  let i = 0;

  const startFile = (): FileDiff => {
    const created = newFile();
    files.push(created);
    return created;
  };

  while (i < lines.length) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = startFile();
      gitStyle = true;
      const paths = gitHeaderPaths(line);
      if (paths) [file.oldPath, file.newPath] = paths;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // a plain `diff -u` file starts here; in git output, the file was opened by `diff --git`
      if (!file || file.hunks.length > 0 || (!gitStyle && file.oldPath !== null)) {
        file = startFile();
        gitStyle = gitStyle || /^--- (a\/|\/dev\/null)/.test(line);
      }
      file.oldPath = headerPath(line.slice(4), 'a/', gitStyle);
      file.newPath = headerPath((lines[i + 1] ?? '').replace(/\r$/, '').slice(4), 'b/', gitStyle);
      if (file.oldPath === null && file.status === 'modified') file.status = 'added';
      if (file.newPath === null && file.status === 'modified') file.status = 'deleted';
      i += 2;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk && file) {
      i = readHunk(lines, i, hunk, file);
      continue;
    }
    if (file && file.hunks.length === 0) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.oldPath = line.slice('rename from '.length); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { file.newPath = line.slice('rename to '.length); file.status = 'renamed'; }
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.status = 'binary';
    } else if (!file) {
      preamble.push(line);
    }
    i += 1;
  }
  return {files, preamble};
}

// Reads the hunk whose header is lines[start]; returns the index of the first line after it.
// The line counts of the header bound the hunk, so a deleted line reading "-- x" is not taken for
// the next file's "--- " header.
function readHunk(lines: string[], start: number, match: RegExpExecArray, file: FileDiff): number {
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  const hunk: Hunk = {header: (lines[start] ?? '').replace(/\r$/, ''), oldStart, newStart, lines: []};
  file.hunks.push(hunk);
  let oldNo = oldStart;
  let newNo = newStart;
  let i = start + 1;
  while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] ?? '').startsWith('\\'))) {
    const raw = (lines[i] ?? '').replace(/\r$/, '');
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '\\') {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (sign === '+' && newLeft > 0) {
      hunk.lines.push({kind: 'add', text, oldNo: null, newNo: newNo++, noNewline: false});
      newLeft -= 1;
      file.added += 1;
    } else if (sign === '-' && oldLeft > 0) {
      hunk.lines.push({kind: 'del', text, oldNo: oldNo++, newNo: null, noNewline: false});
      oldLeft -= 1;
      file.deleted += 1;
    } else if ((sign === ' ' || raw === '') && oldLeft > 0 && newLeft > 0) {
      // an empty line is a context line whose leading space was stripped (some editors do it)
      hunk.lines.push({kind: 'context', text, oldNo: oldNo++, newNo: newNo++, noNewline: false});
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      break;    // a malformed hunk: stop here rather than swallow what follows
    }
    i += 1;
  }
  return i;
}

// ---------------------------------------------------------------- changed words

export interface Segment {
  text: string;
  changed: boolean;
}

// Above this many token pairs the LCS table is not built: the whole line is marked as changed.
export const WORD_DIFF_LIMIT = 40_000;

export function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.changed === segment.changed) last.text += segment.text;
    else if (segment.text !== '') out.push({...segment});
  }
  return out;
}

// The two sides of a modified line, cut into unchanged and changed runs (an LCS on words).
export function wordDiff(before: string, after: string): [Segment[], Segment[]] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > WORD_DIFF_LIMIT) {
    return [[{text: before, changed: true}], [{text: after, changed: true}]];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) {
      table[x * width + y] = a[x] === b[y]
        ? (table[(x + 1) * width + y + 1] ?? 0) + 1
        : Math.max(table[(x + 1) * width + y] ?? 0, table[x * width + y + 1] ?? 0);
    }
  }
  const left: Segment[] = [];
  const right: Segment[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length) {
    if (a[x] === b[y]) {
      left.push({text: a[x] ?? '', changed: false});
      right.push({text: b[y] ?? '', changed: false});
      x += 1;
      y += 1;
    } else if ((table[(x + 1) * width + y] ?? 0) >= (table[x * width + y + 1] ?? 0)) {
      left.push({text: a[x++] ?? '', changed: true});
    } else {
      right.push({text: b[y++] ?? '', changed: true});
    }
  }
  while (x < a.length) left.push({text: a[x++] ?? '', changed: true});
  while (y < b.length) right.push({text: b[y++] ?? '', changed: true});
  return [merge(left), merge(right)];
}

// ---------------------------------------------------------------- rows

export interface Row {
  // 'change' pairs a deleted line with the added line that replaces it (either may be missing)
  kind: 'context' | 'change';
  left: DiffLine | null;
  right: DiffLine | null;
}

// A hunk as rows: each run of deleted lines followed by added lines is paired line by line, the
// i-th deleted line with the i-th added one.
export function hunkRows(hunk: Hunk): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    const line = hunk.lines[i];
    if (!line) break;
    if (line.kind === 'context') {
      rows.push({kind: 'context', left: line, right: line});
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (hunk.lines[i]?.kind === 'del') dels.push(hunk.lines[i++] as DiffLine);
    while (hunk.lines[i]?.kind === 'add') adds.push(hunk.lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({kind: 'change', left: dels[k] ?? null, right: adds[k] ?? null});
    }
  }
  return rows;
}

export function displayPath(file: FileDiff): string {
  if (file.status === 'renamed' && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.newPath ?? file.oldPath ?? '(unnamed)';
}

// ---------------------------------------------------------------- DOM

export type Mode = 'unified' | 'split';

export interface Options {
  mode: Mode;
  words: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function number(value: number | null, extra = ''): HTMLTableCellElement {
  const cell = el('td', `ln${extra}`);
  if (value !== null) cell.dataset['n'] = String(value);   // drawn by CSS, so not copied with the code
  return cell;
}

function code(segments: Segment[], kind: string, noNewline: boolean): HTMLTableCellElement {
  const cell = el('td', `code ${kind}`);
  for (const segment of segments) {
    if (segment.changed) cell.append(el('span', 'w', segment.text));
    else cell.append(document.createTextNode(segment.text));
  }
  if (noNewline) cell.append(el('span', 'eof', ' ⏎̸'));
  return cell;
}

function sides(row: Row, words: boolean): [Segment[], Segment[]] {
  const left = row.left?.text ?? '';
  const right = row.right?.text ?? '';
  if (row.kind === 'change' && words && row.left && row.right) return wordDiff(left, right);
  return [[{text: left, changed: false}], [{text: right, changed: false}]];
}

// Fixed column widths: with table-layout: fixed, the first row (a hunk header spanning every
// column) would otherwise share the width out evenly.
function columns(table: HTMLTableElement, kinds: ('ln' | 'code')[]): void {
  const group = el('colgroup');
  for (const kind of kinds) group.append(el('col', kind));
  table.append(group);
}

function hunkHeader(hunk: Hunk, span: number): HTMLTableRowElement {
  const tr = el('tr', 'hunk');
  const cell = el('td', 'hunk', hunk.header);
  cell.colSpan = span;
  tr.append(cell);
  return tr;
}

// The segments of every line of a hunk: the changed words of each paired line, the whole text otherwise.
export function lineSegments(hunk: Hunk, words: boolean): Map<DiffLine, Segment[]> {
  const segments = new Map<DiffLine, Segment[]>();
  for (const row of hunkRows(hunk)) {
    const [left, right] = sides(row, words);
    if (row.left) segments.set(row.left, left);
    if (row.right) segments.set(row.right, right);
  }
  return segments;
}

// Unified: the lines in the order of the diff, each with its old and new number.
function unifiedTable(file: FileDiff, words: boolean): HTMLTableElement {
  const table = el('table', 'unified');
  columns(table, ['ln', 'ln', 'code']);
  for (const hunk of file.hunks) {
    table.append(hunkHeader(hunk, 3));
    const segments = lineSegments(hunk, words);
    for (const line of hunk.lines) {
      const extra = line.kind === 'context' ? '' : ` ${line.kind}`;
      const tr = el('tr', line.kind);
      tr.append(number(line.oldNo, extra), number(line.newNo, extra),
        code(segments.get(line) ?? [{text: line.text, changed: false}], line.kind, line.noNewline));
      table.append(tr);
    }
  }
  return table;
}

function splitTable(file: FileDiff, words: boolean): HTMLTableElement {
  const table = el('table', 'split');
  columns(table, ['ln', 'code', 'ln', 'code']);
  for (const hunk of file.hunks) {
    table.append(hunkHeader(hunk, 4));
    for (const row of hunkRows(hunk)) {
      const [left, right] = sides(row, words);
      const tr = el('tr', row.kind);
      if (row.kind === 'context') {
        tr.append(number(row.left?.oldNo ?? null), code(left, 'context', row.left?.noNewline ?? false),
          number(row.right?.newNo ?? null, ' sep'), code(right, 'context', row.right?.noNewline ?? false));
      } else {
        tr.append(
          row.left ? number(row.left.oldNo, ' del') : number(null, ' empty'),
          row.left ? code(left, 'del', row.left.noNewline) : el('td', 'code empty'),
          row.right ? number(row.right.newNo, ' add sep') : number(null, ' empty sep'),
          row.right ? code(right, 'add', row.right.noNewline) : el('td', 'code empty'));
      }
      table.append(tr);
    }
  }
  return table;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  modified: '', added: 'new', deleted: 'deleted', renamed: 'renamed', binary: 'binary',
};

function stat(added: number, deleted: number): HTMLSpanElement {
  const span = el('span', 'stat');
  span.append(el('span', 'a', `+${added}`), document.createTextNode(' '), el('span', 'd', `−${deleted}`));
  return span;
}

function fileBlock(file: FileDiff, options: Options): HTMLDetailsElement {
  const details = el('details', 'file');
  details.open = true;
  const summary = el('summary');
  summary.append(el('span', 'path', displayPath(file)));
  if (STATUS_LABEL[file.status]) summary.append(el('span', `badge ${file.status}`, STATUS_LABEL[file.status]));
  summary.append(stat(file.added, file.deleted));
  details.append(summary);
  if (file.hunks.length === 0) {
    details.append(el('p', 'note', file.status === 'binary' ? 'binary file, not shown' : 'no change in the content'));
  } else {
    const scroll = el('div', 'scroll');
    scroll.append(options.mode === 'split' ? splitTable(file, options.words) : unifiedTable(file, options.words));
    details.append(scroll);
  }
  return details;
}

function button(label: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const node = el('button', '', label);
  node.type = 'button';
  node.setAttribute('aria-pressed', String(pressed));
  node.addEventListener('click', onClick);
  return node;
}

// Renders `text` into `root`, with its toolbar. Returns the parsed diff (for tests and callers).
export function mount(root: HTMLElement, text: string, initial: Partial<Options> = {}): ParsedDiff {
  const parsed = parseUnifiedDiff(text);
  const options: Options = {mode: initial.mode ?? 'unified', words: initial.words ?? true};
  const draw = (): void => {
    const open = [...root.querySelectorAll('details.file')].map(node => (node as HTMLDetailsElement).open);
    root.replaceChildren();
    const bar = el('div', 'toolbar');
    const added = parsed.files.reduce((sum, file) => sum + file.added, 0);
    const deleted = parsed.files.reduce((sum, file) => sum + file.deleted, 0);
    const count = el('span', 'summary', `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'} `);
    count.append(stat(added, deleted));
    const modes = el('span', 'seg');
    modes.append(
      button('unified', options.mode === 'unified', () => { options.mode = 'unified'; draw(); }),
      button('split', options.mode === 'split', () => { options.mode = 'split'; draw(); }));
    const words = button('words', options.words, () => { options.words = !options.words; draw(); });
    bar.append(count, modes, words);
    root.append(bar);
    if (parsed.preamble.some(line => line.trim() !== '')) {
      root.append(el('pre', 'preamble', parsed.preamble.join('\n').replace(/\s+$/, '')));
    }
    if (parsed.files.length === 0) root.append(el('p', 'note', 'no unified diff found in this file'));
    parsed.files.forEach((file, index) => {
      const block = fileBlock(file, options);
      if (open[index] === false) block.open = false;
      root.append(block);
    });
  };
  draw();
  return parsed;
}

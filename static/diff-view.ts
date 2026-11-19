// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The diff viewer of the side panel: a `.diff` or `.patch` file opened in a pane (mesh-open, a
// clicked path) is rendered by static/diff.html with this module (built into static/diff-view.js,
// served under /viewlib/). It reads unified diffs, `git diff` output (several files, renames,
// new, deleted and binary files, quoted path names) or plain `diff -u`, and shows them unified or
// side by side, with the changed words of a modified line highlighted.
//
// The page runs in the panel's sandbox (view.py: SANDBOX_DOC, no network, no storage). The diff
// is data: every piece of it reaches the DOM as text (textContent), never as markup.
//
// The work is bounded for large diffs (view.py renders up to 4 MiB): word alignment has a budget
// per document and is computed once per line, rows are built in chunks behind "show more", the
// files past the first screens start folded and are built when unfolded, and switching views
// rebuilds only the rows already shown.

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  // the line's content, carriage return included when it belongs to the file (shown as ␍)
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
  // opened by a `diff --git` header: its `a/` and `b/` prefixes are Git's, and are dropped
  git: boolean;
}

export interface ParsedDiff {
  files: FileDiff[];
  // lines before the first file (a commit message from `git show`, `git format-patch` headers)
  preamble: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// ---------------------------------------------------------------- path names

const ESCAPES: Record<string, number> = {a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92};

// A C-style quoted name as Git writes it (`"caf\303\251.sh"`), from its opening quote at `start`:
// the decoded name and the index after its closing quote, or null when it is not one.
export function readQuoted(text: string, start = 0): [string, number] | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '"') return [new TextDecoder().decode(new Uint8Array(bytes)), i + 1];
    if (c === '\\') {
      const next = text[i + 1] ?? '';
      const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
      if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += 4; continue; }
      const escaped = ESCAPES[next];
      if (escaped === undefined) return null;
      bytes.push(escaped);
      i += 2;
      continue;
    }
    const point = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(point);
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return null;
}

// A name that may be quoted, as the whole of `raw` (rename from/to, copy from/to).
function unquoteWhole(raw: string): string {
  const quoted = readQuoted(raw);
  return quoted && quoted[1] === raw.length ? quoted[0] : raw;
}

function dropPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// `diff --git a/x b/y`, either name possibly quoted: the two names without their prefixes, or
// null when they cannot be split. Unquoted names with spaces are split where both halves name
// the same file (the case without a rename, whose rename lines give the names otherwise).
export function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  let first: string;
  let second: string;
  const quoted = readQuoted(rest);
  if (quoted) {
    if (rest[quoted[1]] !== ' ') return null;
    first = quoted[0];
    second = unquoteWhole(rest.slice(quoted[1] + 1));
  } else if (rest.endsWith('"') && rest.lastIndexOf(' "') > 0) {
    const at = rest.lastIndexOf(' "');
    first = rest.slice(0, at);
    second = unquoteWhole(rest.slice(at + 1));
  } else {
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) {
      first = rest.slice(0, half);
      second = rest.slice(half + 1);
    } else {
      const match = /^(a\/.*) (b\/.*)$/.exec(rest);
      if (!match || match[1] === undefined || match[2] === undefined) return null;
      first = match[1];
      second = match[2];
    }
  }
  if (!first.startsWith('a/') || !second.startsWith('b/')) return null;
  return [first.slice(2), second.slice(2)];
}

// The name of a `--- ` or `+++ ` line: quoted (Git), or up to a tab (`diff -u` adds a date).
// `/dev/null` is no file. Git's `a/` or `b/` is dropped only in a file opened by `diff --git`:
// a plain `diff -u a/x b/x` keeps its directory names.
function headerPath(raw: string, prefix: string, git: boolean): string | null {
  const quoted = readQuoted(raw);
  const value = quoted ? quoted[0] : (raw.split('\t')[0] ?? '');
  if (value === '/dev/null') return null;
  return git ? dropPrefix(value, prefix) : value;
}

// ---------------------------------------------------------------- parser

function newFile(git: boolean): FileDiff {
  return {oldPath: null, newPath: null, status: 'modified', hunks: [], added: 0, deleted: 0, git};
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // A patch saved with CRLF line ends has a CR on every line, its own header lines included:
  // that CR is framing and is dropped. In an LF patch, a CR at the end of a hunk line belongs to
  // the file (a CRLF to LF change) and is kept, so that the change is visible.
  const first = lines.find(line => line !== '') ?? '';
  if (first.endsWith('\r')) {
    for (let k = 0; k < lines.length; k++) lines[k] = (lines[k] ?? '').replace(/\r$/, '');
  }
  const files: FileDiff[] = [];
  const preamble: string[] = [];
  let file: FileDiff | null = null;
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = newFile(true);
      files.push(file);
      const paths = gitHeaderPaths(line);
      if (paths) [file.oldPath, file.newPath] = paths;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // a plain `diff -u` file starts here; in Git output, its `diff --git` line opened it
      if (!file || file.hunks.length > 0 || !file.git) {
        file = newFile(false);
        files.push(file);
      }
      const oldPath = headerPath(line.slice(4), 'a/', file.git);
      const newPath = headerPath((lines[i + 1] ?? '').replace(/\r$/, '').slice(4), 'b/', file.git);
      // a renamed file keeps the names of its rename lines
      if (file.status !== 'renamed') { file.oldPath = oldPath; file.newPath = newPath; }
      if (oldPath === null && file.status === 'modified') file.status = 'added';
      if (newPath === null && file.status === 'modified') file.status = 'deleted';
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
      else if (line.startsWith('rename from ')) { file.oldPath = unquoteWhole(line.slice('rename from '.length)); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { file.newPath = unquoteWhole(line.slice('rename to '.length)); file.status = 'renamed'; }
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
// the next file's "--- " header. A hunk cut short (its counts not reached when it stops) gives
// back the `--- `/`+++ ` pair it took in just before stopping: that pair starts the next file.
function readHunk(lines: string[], start: number, match: RegExpExecArray, file: FileDiff): number {
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  const hunk: Hunk = {header: (lines[start] ?? '').replace(/\r$/, ''), oldStart, newStart, lines: []};
  file.hunks.push(hunk);
  const origin: number[] = [];   // the index in `lines` of each line of the hunk
  let oldNo = oldStart;
  let newNo = newStart;
  let i = start + 1;
  while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] ?? '').startsWith('\\'))) {
    const raw = lines[i] ?? '';
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '\\') {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (sign === '+' && newLeft > 0) {
      hunk.lines.push({kind: 'add', text, oldNo: null, newNo: newNo++, noNewline: false});
      origin.push(i);
      newLeft -= 1;
      file.added += 1;
    } else if (sign === '-' && oldLeft > 0) {
      hunk.lines.push({kind: 'del', text, oldNo: oldNo++, newNo: null, noNewline: false});
      origin.push(i);
      oldLeft -= 1;
      file.deleted += 1;
    } else if ((sign === ' ' || raw === '') && oldLeft > 0 && newLeft > 0) {
      // an empty line is a context line whose leading space was stripped (some editors do it)
      hunk.lines.push({kind: 'context', text, oldNo: oldNo++, newNo: newNo++, noNewline: false});
      origin.push(i);
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      break;    // a malformed hunk: stop here rather than swallow what follows
    }
    i += 1;
  }
  if (oldLeft > 0 || newLeft > 0) {
    for (const k of [i - 2, i - 1]) {
      if (k > start && (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) {
        while (origin.length > 0 && (origin[origin.length - 1] ?? 0) >= k) {
          origin.pop();
          const dropped = hunk.lines.pop();
          if (dropped?.kind === 'add') file.added -= 1;
          if (dropped?.kind === 'del') file.deleted -= 1;
        }
        return k;
      }
    }
  }
  return i;
}

// ---------------------------------------------------------------- changed words

export interface Segment {
  text: string;
  changed: boolean;
}

// Above this many token pairs the LCS table of one line pair is not built: the line is marked
// whole as changed.
export const WORD_DIFF_LIMIT = 40_000;
// The token pairs aligned in a whole document; past it, modified lines are marked whole.
export const DOCUMENT_WORD_BUDGET = 4_000_000;

export interface Budget {
  cells: number;
}

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

const whole = (before: string, after: string): [Segment[], Segment[]] =>
  [before === '' ? [] : [{text: before, changed: true}], after === '' ? [] : [{text: after, changed: true}]];

// The two sides of a modified line, cut into unchanged and changed runs (an LCS on words). The
// work is charged to `budget` when one is given.
export function wordDiff(before: string, after: string, budget?: Budget): [Segment[], Segment[]] {
  if (before === '' || after === '') return whole(before, after);
  const a = tokenize(before);
  const b = tokenize(after);
  const cells = a.length * b.length;
  if (cells > WORD_DIFF_LIMIT || (budget && cells > budget.cells)) return whole(before, after);
  if (budget) budget.cells -= cells;
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

// The changed words of every paired line of `file`, computed once and kept: switching views
// does not align the words again. Lines without a pair are absent (shown whole).
export function fileSegments(file: FileDiff, budget: Budget): Map<DiffLine, Segment[]> {
  const segments = new Map<DiffLine, Segment[]>();
  for (const hunk of file.hunks) {
    for (const row of hunkRows(hunk)) {
      if (row.kind !== 'change' || !row.left || !row.right) continue;
      const [left, right] = wordDiff(row.left.text, row.right.text, budget);
      segments.set(row.left, left);
      segments.set(row.right, right);
    }
  }
  return segments;
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

// Past this many lines, the diff is not rendered: the page says so and links to the plain text
// (?raw=1). The byte limit (view.py: 4 MiB) alone would let a diff of a million short lines through.
export const MAX_DIFF_LINES = 50_000;

export function countLines(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  return text.endsWith('\n') || text === '' ? count : count + 1;
}

// Diff lines built at a time, per file ("show more" builds the next ones). Counted in lines of
// the diff, not in table rows, so that a file keeps the same extent loaded in both views.
export const ROW_CHUNK = 2_000;
// Diff lines built when the page opens, over all files: the files past them start folded and are
// built when unfolded.
export const INITIAL_ROWS = 4_000;

// The lines of a file's hunks (without the hunk headers).
export function fileLines(file: FileDiff): number {
  return file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
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

// A carriage return is part of the line (a CRLF to LF change): shown as ␍, in the same text node
// (one node per run, however many it holds).
const visible = (text: string): string => text.replaceAll('\r', '␍');

function code(line: DiffLine | null, segments: Segment[] | undefined, kind: string): HTMLTableCellElement {
  const cell = el('td', `code ${kind}`);
  if (!line) return cell;
  for (const segment of segments ?? [{text: line.text, changed: false}]) {
    if (segment.changed) cell.append(el('span', 'w', visible(segment.text)));
    else cell.append(document.createTextNode(visible(segment.text)));
  }
  if (line.noNewline) cell.append(el('span', 'eof', ' ⏎̸'));
  return cell;
}

// Fixed column widths: with table-layout: fixed, the first row (a hunk header spanning every
// column) would otherwise share the width out evenly.
function columns(table: HTMLTableElement, kinds: ('ln' | 'code')[]): void {
  const group = el('colgroup');
  for (const kind of kinds) group.append(el('col', kind));
  table.append(group);
}

type Item = {type: 'hunk'; hunk: Hunk} | {type: 'line'; line: DiffLine} | {type: 'row'; row: Row};

// The diff lines a row shows: a context row of the split view shows one line on both sides.
export function itemLines(item: Item): number {
  if (item.type === 'hunk') return 0;
  if (item.type === 'line') return 1;
  if (item.row.kind === 'context') return 1;
  return (item.row.left ? 1 : 0) + (item.row.right ? 1 : 0);
}

// The rows of a file in one view, in order: unified lists the lines as the diff does, split
// pairs them.
export function fileItems(file: FileDiff, mode: Mode): Item[] {
  const items: Item[] = [];
  for (const hunk of file.hunks) {
    items.push({type: 'hunk', hunk});
    if (mode === 'unified') for (const line of hunk.lines) items.push({type: 'line', line});
    else for (const row of hunkRows(hunk)) items.push({type: 'row', row});
  }
  return items;
}

function itemRow(item: Item, mode: Mode, segments: Map<DiffLine, Segment[]> | null): HTMLTableRowElement {
  if (item.type === 'hunk') {
    const tr = el('tr', 'hunk');
    const cell = el('td', 'hunk', item.hunk.header);
    cell.colSpan = mode === 'unified' ? 3 : 4;
    tr.append(cell);
    return tr;
  }
  const words = (line: DiffLine | null): Segment[] | undefined => (line && segments?.get(line)) || undefined;
  if (item.type === 'line') {
    const line = item.line;
    const extra = line.kind === 'context' ? '' : ` ${line.kind}`;
    const tr = el('tr', line.kind);
    tr.append(number(line.oldNo, extra), number(line.newNo, extra), code(line, words(line), line.kind));
    return tr;
  }
  const {row} = item;
  const tr = el('tr', row.kind);
  if (row.kind === 'context') {
    tr.append(number(row.left?.oldNo ?? null), code(row.left, undefined, 'context'),
      number(row.right?.newNo ?? null, ' sep'), code(row.right, undefined, 'context'));
  } else {
    tr.append(
      row.left ? number(row.left.oldNo, ' del') : number(null, ' empty'),
      code(row.left, words(row.left), row.left ? 'del' : 'empty'),
      row.right ? number(row.right.newNo, ' add sep') : number(null, ' empty sep'),
      code(row.right, words(row.right), row.right ? 'add' : 'empty'));
  }
  return tr;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  modified: '', added: 'new', deleted: 'deleted', renamed: 'renamed', binary: 'binary',
};

function stat(added: number, deleted: number): HTMLSpanElement {
  const span = el('span', 'stat');
  span.append(el('span', 'a', `+${added}`), document.createTextNode(' '), el('span', 'd', `−${deleted}`));
  return span;
}

function button(label: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const node = el('button', '', label);
  node.type = 'button';
  node.setAttribute('aria-pressed', String(pressed));
  node.addEventListener('click', onClick);
  return node;
}

// One file of the page: its rows are built in chunks, only while it is unfolded.
class FileView {
  readonly details = el('details', 'file');
  private readonly body = el('div', 'body');
  // diff lines loaded: the extent shown, the same whatever the view
  private loaded: number;
  // the view the body was built for ('' before it is built)
  private builtFor = '';
  private segments: Map<DiffLine, Segment[]> | null = null;
  private readonly file: FileDiff;
  private readonly view: Viewer;
  private table: HTMLTableElement | null = null;
  private items: Item[] = [];
  private next = 0;          // the first item not built yet
  private built = 0;         // the diff lines of the items built

  constructor(file: FileDiff, view: Viewer, open: boolean, loaded: number) {
    this.file = file;
    this.view = view;
    this.loaded = loaded;
    const summary = el('summary');
    summary.append(el('span', 'path', displayPath(file)));
    if (STATUS_LABEL[file.status]) summary.append(el('span', `badge ${file.status}`, STATUS_LABEL[file.status]));
    summary.append(stat(file.added, file.deleted));
    this.details.append(summary, this.body);
    this.details.open = open;
    if (open) this.render();
    // built when unfolded, unless already built for the current view (the toggle event follows
    // the change of `open`, including the one above)
    this.details.addEventListener('toggle', () => { if (this.details.open && this.builtFor !== this.view.key()) this.render(); });
  }

  get remaining(): number {
    return this.details.open && this.builtFor !== '' ? this.items.length - this.next : 0;
  }

  private wordSegments(): Map<DiffLine, Segment[]> | null {
    if (!this.view.options.words) return null;
    this.segments ??= fileSegments(this.file, this.view.budget);
    return this.segments;
  }

  // (Re)builds the rows of the lines loaded, in the current view: when unfolded with a view it was
  // not built for, and on a view change.
  render(): void {
    this.builtFor = this.view.key();
    this.body.replaceChildren();
    this.table = null;
    if (this.file.hunks.length === 0) {
      this.body.append(el('p', 'note', this.file.status === 'binary' ? 'binary file, not shown' : 'no change in the content'));
      this.items = [];
      return;
    }
    const {mode} = this.view.options;
    this.items = fileItems(this.file, mode);
    this.next = 0;
    this.built = 0;
    this.table = el('table', mode);
    columns(this.table, mode === 'unified' ? ['ln', 'ln', 'code'] : ['ln', 'code', 'ln', 'code']);
    const scroll = el('div', 'scroll');
    scroll.append(this.table);
    this.body.append(scroll);
    this.extend();
  }

  // Builds the next chunk of lines ("show more").
  more(): void {
    this.loaded = this.built + ROW_CHUNK;
    this.extend();
  }

  // Builds rows until the lines loaded are shown.
  private extend(): void {
    const table = this.table;
    if (!table) return;
    const segments = this.wordSegments();
    const {mode} = this.view.options;
    while (this.next < this.items.length) {
      const item = this.items[this.next] as Item;
      const weight = itemLines(item);
      if (weight > 0 && this.built + weight > this.loaded && this.built > 0) break;
      table.append(itemRow(item, mode, segments));
      this.built += weight;
      this.next += 1;
    }
    this.body.querySelector('button.more')?.remove();
    const left = fileLines(this.file) - this.built;
    if (this.next < this.items.length && left > 0) {
      const more = button(`show ${Math.min(left, ROW_CHUNK)} more lines (${left} left)`, false, () => this.more());
      more.className = 'more';
      more.removeAttribute('aria-pressed');
      this.body.append(more);
    }
  }
}

// The page, for diff.html: `growTo` loads rows until the page reaches a height (a watched reload
// restores the scroll position of rows loaded with "show more" before it).
export interface DiffPage {
  parsed: ParsedDiff;
  growTo(height: number): void;
}

class Viewer {
  readonly budget: Budget = {cells: DOCUMENT_WORD_BUDGET};
  readonly files: FileView[] = [];
  private readonly buttons: Record<'unified' | 'split' | 'words', HTMLButtonElement>;
  readonly options: Options;

  constructor(root: HTMLElement, parsed: ParsedDiff, options: Options) {
    this.options = options;
    root.replaceChildren();
    // The toolbar stays in place: its buttons keep the keyboard focus across view changes.
    const bar = el('div', 'toolbar');
    const added = parsed.files.reduce((sum, file) => sum + file.added, 0);
    const deleted = parsed.files.reduce((sum, file) => sum + file.deleted, 0);
    const count = el('span', 'summary', `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'} `);
    count.append(stat(added, deleted));
    this.buttons = {
      unified: button('unified', options.mode === 'unified', () => this.set({mode: 'unified'})),
      split: button('split', options.mode === 'split', () => this.set({mode: 'split'})),
      words: button('words', options.words, () => this.set({words: !this.options.words})),
    };
    const modes = el('span', 'seg');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'view');
    modes.append(this.buttons.unified, this.buttons.split);
    bar.append(count, modes, this.buttons.words);
    root.append(bar);
    if (parsed.preamble.some(line => line.trim() !== '')) {
      root.append(el('pre', 'preamble', parsed.preamble.join('\n').replace(/\s+$/, '')));
    }
    if (parsed.files.length === 0) root.append(el('p', 'note', 'no unified diff found in this file'));
    // INITIAL_ROWS lines are shared out over the first files, in order; the others start folded
    let left = INITIAL_ROWS;
    for (const file of parsed.files) {
      const open = left > 0;
      const loaded = open ? Math.min(ROW_CHUNK, left) : ROW_CHUNK;
      if (open) left -= Math.min(fileLines(file), loaded);
      const view = new FileView(file, this, open, loaded);
      this.files.push(view);
      root.append(view.details);
    }
  }

  key(): string {
    return `${this.options.mode}/${this.options.words}`;
  }

  private set(change: Partial<Options>): void {
    Object.assign(this.options, change);
    this.buttons.unified.setAttribute('aria-pressed', String(this.options.mode === 'unified'));
    this.buttons.split.setAttribute('aria-pressed', String(this.options.mode === 'split'));
    this.buttons.words.setAttribute('aria-pressed', String(this.options.words));
    // only the unfolded files are rebuilt, with the lines they had loaded; a folded one is rebuilt
    // when unfolded
    for (const file of this.files) if (file.details.open) file.render();
  }

  // Loads rows ("show more", then the next folded file) until the page is `height` tall.
  growTo(height: number): void {
    const page = document.documentElement;
    for (let step = 0; step < 1000 && page.scrollHeight < height; step++) {
      const open = this.files.find(file => file.remaining > 0);
      if (open) { open.more(); continue; }
      const folded = this.files.find(file => !file.details.open);
      if (!folded) return;
      folded.details.open = true;
      folded.render();
    }
  }
}

// The page for a diff past MAX_DIFF_LINES: a short notice and the way to its plain text.
function tooLarge(root: HTMLElement, lines: number): void {
  const note = el('p', 'note large', `This diff has ${lines} lines, more than the diff viewer shows (${MAX_DIFF_LINES}). `);
  const link = el('a', '', 'Open it as plain text');
  link.href = '?raw=1';
  note.append(link, document.createTextNode('.'));
  root.replaceChildren(note);
}

// Renders `text` into `root`, with its toolbar. Returns the page, or null when the diff has too
// many lines to be rendered.
export function mount(root: HTMLElement, text: string, initial: Partial<Options> = {}): DiffPage | null {
  const lines = countLines(text);
  if (lines > MAX_DIFF_LINES) {
    tooLarge(root, lines);
    return null;
  }
  const parsed = parseUnifiedDiff(text);
  const viewer = new Viewer(root, parsed, {mode: initial.mode ?? 'unified', words: initial.words ?? true});
  return {parsed, growTo: height => viewer.growTo(height)};
}

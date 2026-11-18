// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Public xterm buffer shape used by this matcher; no private renderer/parser APIs.
type CellPosition = [row: number, col: number];
type TerminalCell = { getWidth(): number; getChars(): string };
type TerminalLine = { length: number; isWrapped: boolean; getCell(x: number, cell?: TerminalCell): TerminalCell | undefined };
export type TerminalBuffer = { getLine(y: number): TerminalLine | undefined };
export type TerminalLink = { text: string; start: CellPosition; end: CellPosition; kind: "url" | "doc" | "dir" };
type Continuation = { soft: boolean; lead: number };
type Row = { text: string; cols: number[] };
// What one hard join looks like on the page: the first word of the next row, what
// follows it on that row, and the last word of the row above.
type Shape = { lead: number; head: string; rest: string; tail: string };
// One lookup's view of the buffer. The buffer cannot change during a lookup, so each
// row and each join decision is computed once: a join depends on the joins above it,
// which would otherwise be re-evaluated exponentially often.
type Lookup = {
  buf: TerminalBuffer; cols: number;
  lines: Map<number, TerminalLine | undefined>; rows: Map<number, Row | null>;
  joins: Map<number, Continuation | null>;
};

// ---- links that a terminal or the agent wrapped over several rows
// The terminal soft-wraps a long line (the next row is marked isWrapped). An
// agent's own layout (claude) hard-wraps: a path without spaces is cut at its
// right margin and goes on, indented, on the next row. A row is joined to the
// next only if it reaches near the right edge; the complete bounded candidate
// must then prove it is a path or URL, not just two adjacent words.
const PATH_CHAR = /[\w@%+=.,\/~:?&#-]/;
const NEAR_EDGE = 8;
const MAX_ROWS = 6;
const SCHEME = /https?:\/\//gi;
const URL_SYNTAX = /[/?&#=%]/;

const newLookup = (buf: TerminalBuffer, cols: number): Lookup =>
  ({ buf, cols, lines: new Map(), rows: new Map(), joins: new Map() });

function lineAt(lk: Lookup, y: number): TerminalLine | undefined {
  if (!lk.lines.has(y)) lk.lines.set(y, lk.buf.getLine(y));
  return lk.lines.get(y);
}

// One buffer row as text, and for each UTF-16 unit of it the cell column it
// starts in: a wide character (CJK, emoji) takes two cells, so string
// indices and cell columns differ after it.
function readRow(line: TerminalLine, keepTrailing: boolean): Row {
  let text = "";
  const cols: number[] = [];
  let cell;
  for (let x = 0; x < line.length; x++) {
    cell = line.getCell(x, cell);
    if (!cell || cell.getWidth() === 0) continue;        // second half of a wide character
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) { text += chars[i]; cols.push(x); }
  }
  if (!keepTrailing) {
    while (text.endsWith(" ")) { text = text.slice(0, -1); cols.pop(); }
  }
  return { text, cols };
}

function rowCells(lk: Lookup, y: number, keepTrailing = false): Row | null {
  const key = y * 2 + (keepTrailing ? 1 : 0);
  if (!lk.rows.has(key)) {
    const line = lineAt(lk, y);
    lk.rows.set(key, line ? readRow(line, keepTrailing) : null);
  }
  return lk.rows.get(key) ?? null;
}

const rowText = (lk: Lookup, y: number, keepTrailing = false) => rowCells(lk, y, keepTrailing)?.text ?? null;
const lastWord = (text: string) => text.split(/\s/).pop() ?? "";
const wholeDoc = (word: string) => docMatches(word).some((m) => m.index === 0 && m.text.length === word.length);
const startsDoc = (word: string) => docMatches(word).some((m) => m.index === 0);
const endsDoc = (word: string) => docMatches(word).some((m) => m.index + m.text.length === word.length);
const explicitLocal = (word: string) => /^(?:\/|~\/|\.\.?\/)/.test(word);
const showsUrl = (word: string) => /https?:\/\//i.test(word);
// A bare host with a path ("bank.example/login"): a new address, not the rest of a path.
const hostLike = (word: string) => /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?\//i.test(word);

// The URL a prefix ends in, from its last scheme on, wherever that scheme sits:
// "(https://", "url=https://" and "[t](https://" all begin one. Null without a scheme.
function urlTail(prefix: string): string | null {
  let at = -1;
  for (const m of prefix.matchAll(SCHEME)) at = m.index;
  return at < 0 ? null : prefix.slice(at);
}

// Length of "scheme://" plus the authority (userinfo, host, port) of a URL text.
const authorityEnd = (url: string) => /^https?:\/\/[^/?#]*/i.exec(url)?.[0].length ?? 0;

// A bare word at a hard break is not proof of continuation. Full-width
// intermediate fragments can be followed by a later, syntactic path suffix.
function laterHardSuffix(lk: Lookup, y: number) {
  const { cols } = lk;
  // Inspect the first row beyond the link limit as well: a syntactic suffix
  // there proves the prefix is truncated, but cannot make it clickable.
  for (let row = y + 1; row < y + MAX_ROWS; row++) {
    const text = rowText(lk, row) || "", next = rowText(lk, row + 1) || "";
    const lead = next.length - next.trimStart().length;
    if (!lead || text.length < cols - NEAR_EDGE || !PATH_CHAR.test(text.at(-1) || "")) return false;
    const head = next.slice(lead).split(/\s/)[0] ?? "";
    if (showsUrl(head) || explicitLocal(head) || (head.includes("/") && startsDoc(head))) return false;
    if (URL_SYNTAX.test(head) || startsDoc(head)) return true;
    if (head.length < cols - lead - NEAR_EDGE) return false;
  }
  // An unbroken chain reaching beyond this lookahead cannot be offered as a
  // complete link within MAX_ROWS, even if its final suffix is further away.
  return true;
}

// Layout only: does row y reach the right edge, and does the next row start
// indented with a path character? Nothing here judges what the words are.
function hardShape(lk: Lookup, y: number): Shape | null {
  const row = rowCells(lk, y), above = row?.text ?? "", below = rowText(lk, y + 1) ?? "";
  const lead = below.length - below.trimStart().length;
  if (!lead || (row?.cols.at(-1) ?? -1) < lk.cols - NEAR_EDGE || !PATH_CHAR.test(above.at(-1) ?? "")) return null;
  if (!below.trim() || !PATH_CHAR.test(below[lead] ?? "")) return null;
  const head = below.slice(lead).split(/\s/)[0] ?? "";
  return { lead, head, rest: below.slice(lead + head.length).trim(), tail: lastWord(above) };
}

// The last words of the rows above, as far as their own joins were accepted, so
// that an intermediate row without a slash keeps the rooted context of the path.
function chainPrefix(lk: Lookup, y: number, remaining: number, tail: string) {
  let prefix = tail;
  for (let row = y - 1; row >= Math.max(0, y - remaining + 1); row--) {
    if (!continuation(lk, row, remaining - (y - row))) break;
    prefix = lastWord(rowText(lk, row) || "") + prefix;
  }
  return prefix;
}

// Words that must stay two targets: a new URL (a full address anywhere in the head
// word, "url=https://…" included, or a bare host after a URL slash or "="), an explicit
// local path, or a document already complete on both sides of the break.
function independentTarget({ head, tail }: Shape, prefix: string) {
  if (showsUrl(head) || (head.includes("/") && wholeDoc(head))) return true;
  if (urlTail(prefix) !== null && /[/=]$/.test(prefix) && hostLike(head)) return true;
  if (urlTail(tail) !== null && (explicitLocal(head) || wholeDoc(head))) return true;
  return endsDoc(tail) && startsDoc(head);
}

// A bare alphabetic word proves nothing unless a query delimiter, a rooted
// document or a later syntactic suffix supports it; likewise a word followed by
// more prose needs a path character of its own.
function bareWordUnproven(lk: Lookup, y: number, { head, rest, lead }: Shape) {
  if (/^[a-z]+$/i.test(head) &&
      (rest || head.length < lk.cols - lead - NEAR_EDGE || !laterHardSuffix(lk, y))) return true;
  return !!rest && !URL_SYNTAX.test(head);
}

function provesPath(lk: Lookup, y: number, shape: Shape, prefix: string) {
  const url = urlTail(prefix);
  // Never infer a new authority from a displayed host, including a suffix
  // beginning with a dot or an "@". The authority is judged from the last scheme,
  // so a delimiter before it ("(", a quote, "url=") changes nothing. Hard
  // inference starts only after the URL path slash. A prose tail cannot begin a
  // document path either ("the" + "src/" + "app.js" is not "thesrc/app.js").
  if ((url !== null && authorityEnd(url) === url.length) || !prefix.includes("/")) return false;
  const crosses = docMatches(prefix + shape.head)
    .some((m) => m.index < prefix.length && m.index + m.text.length > prefix.length);
  // A document in the next row is independent unless the preceding token is
  // already a rooted path; prose + app.js must not become theapp.js.
  if (url !== null && crosses) return false;
  const rootedDoc = url === null && crosses;
  const queryValue = url !== null && /[?&=#]$/.test(prefix) && !shape.rest;
  if (!rootedDoc && !queryValue && bareWordUnproven(lk, y, shape)) return false;
  return !independentTarget(shape, prefix);
}

function joinAt(lk: Lookup, y: number, remaining: number): Continuation | null {
  const next = lineAt(lk, y + 1);
  if (!next) return null;
  if (next.isWrapped) return { soft: true, lead: 0 };
  const shape = hardShape(lk, y);
  if (!shape) return null;
  return provesPath(lk, y, shape, chainPrefix(lk, y, remaining, shape.tail)) ? { soft: false, lead: shape.lead } : null;
}

// How row y continues into row y+1, if it does. "remaining" is how many rows
// above may still lend their context; each answer is computed once per lookup.
function continuation(lk: Lookup, y: number, remaining = MAX_ROWS): Continuation | null {
  const key = y * (MAX_ROWS + 1) + remaining;
  if (!lk.joins.has(key)) lk.joins.set(key, remaining > 0 ? joinAt(lk, y, remaining) : null);
  return lk.joins.get(key) ?? null;
}

// The logical line through buffer row y: its text, and for each character
// the [row, col] cell it comes from.
function logicalLine(lk: Lookup, y: number) {
  let top = y;
  while (top > 0 && y - top < MAX_ROWS - 1 && continuation(lk, top - 1)) top--;
  const before = top > 0 ? continuation(lk, top - 1) : null;
  const clippedBefore = !!before && !(before.soft && /\s$/.test(rowText(lk, top - 1, true) || ""));
  let text = "", from = before?.lead ?? 0, clippedAfter = false;
  const cells: CellPosition[] = [];
  const hard: { cut: number; tail: string; head: string }[] = [];
  // A target containing y may start up to five rows before it or finish five
  // rows after it. Read that bounded neighbourhood, not the whole paragraph.
  const last = y + MAX_ROWS - 1;
  for (let row = top; row <= last; row++) {
    const join = continuation(lk, row);
    clippedAfter = !!join && row === last &&
      !(join.soft && /^\s/.test(rowText(lk, row + 1, true) || ""));
    const rc = rowCells(lk, row, join?.soft) ?? { text: "", cols: [] };
    const end = rc.text.length;
    for (let i = from; i < end; i++) {
      const col = rc.cols[i];
      if (col === undefined) throw new Error("buffer row cell mapping unavailable");
      text += rc.text[i]; cells.push([row, col]);
    }
    if (!join || row === last) break;
    if (!join.soft) hard.push({ cut: text.length, tail: lastWord(rc.text.slice(from, end)),
                                head: (rowText(lk, row + 1) || "").trimStart().split(/\s/)[0] ?? "" });
    from = join.lead;
  }
  return { text, cells, hard, clippedBefore, clippedAfter };
}

// A recognized extension on the final row of an over-limit hard-wrapped path
// is not a new relative file. This bounded lookbehind checks only the layout;
// continuation() may rightly refuse the last join after losing the root.
function overLimitHardDocSuffix(lk: Lookup, y: number, col: number) {
  const first = rowCells(lk, y);
  if (!first) return false;
  const lead = first.text.length - first.text.trimStart().length;
  const index = first.cols.indexOf(col);
  // Only the first token can be a suffix of the preceding hard chain. Later
  // whitespace-delimited documents are independent targets on this same row.
  if (index < lead || /\s/.test(first.text.slice(lead, index))) return false;
  for (let row = y; row > y - MAX_ROWS; row--) {
    if (row <= 0 || lineAt(lk, row)?.isWrapped) return false;
    const previous = rowCells(lk, row - 1), current = rowText(lk, row) || "";
    const lead = current.length - current.trimStart().length;
    if (!lead || (previous?.cols.at(-1) ?? -1) < lk.cols - NEAR_EDGE ||
        !PATH_CHAR.test(previous?.text.at(-1) || "") || !PATH_CHAR.test(current[lead] || "")) return false;
  }
  return true;
}

export const cellIn = ([row, col]: CellPosition, start: CellPosition, end: CellPosition): boolean =>
  (row > start[0] || (row === start[0] && col >= start[1])) && (row < end[0] || (row === end[0] && col <= end[1]));

// A URL may span a hard break only if its whole authority lies before every cut
// it crosses, and some crossed break shows URL syntax (a slash or query delimiter).
function urlJoinProven(m: { text: string; index: number }, crossed: { cut: number; tail: string; head: string }[]) {
  const authority = authorityEnd(m.text);
  return crossed.every(({ cut }) => cut - m.index > authority) &&
    crossed.some(({ tail, head }) => URL_SYNTAX.test(head) || URL_SYNTAX.test(tail.slice(-1)));
}

// Document paths and HTTP(S) URLs on buffer row y.
export function linksOnRow(buf: TerminalBuffer, y: number, cols: number): TerminalLink[] {
  const lk = newLookup(buf, cols);
  const { text, cells, hard, clippedBefore, clippedAfter } = logicalLine(lk, y);
  const found: TerminalLink[] = [];
  const urls = [...text.matchAll(URL_RE)].map((m) => ({ text: m[0], index: m.index, kind: "url" as const }));
  const docs = docMatches(text).map((m) => ({ ...m, kind: "doc" as const }));
  // URLs first, then documents, then directories: a later match inside an earlier one is dropped
  for (const m of [...urls, ...docs, ...dirMatches(text)]) {
    const endIndex = m.index + m.text.length;
    const start = cells[m.index], end = cells[endIndex - 1];
    if (!start || !end || y < start[0] || y > end[0] || end[0] - start[0] >= MAX_ROWS) continue;
    // A bounded window may cut through a token, not through an independent
    // link separated by whitespace. Never offer a prefix or suffix of that token.
    if ((clippedBefore && !/\s/.test(text.slice(0, m.index))) ||
        (clippedAfter && !/\s/.test(text.slice(endIndex)))) continue;
    // Judge each candidate against only the hard boundaries it touches.
    // An unconfirmed prefix ending at a cut is not a complete link; an
    // independent target later in the same row must still remain clickable.
    if (hard.some(({ cut }) => m.index < cut && endIndex === cut)) continue;
    const crossed = hard.filter(({ cut }) => m.index < cut && endIndex > cut);
    if (crossed.length && (m.kind === "dir" || (m.kind === "url" && !urlJoinProven(m, crossed)))) continue;
    if (m.kind === "doc" && overLimitHardDocSuffix(lk, start[0], start[1])) continue;
    if (m.kind !== "url" && found.some((l) => cellIn(start, l.start, l.end) || cellIn(l.start, start, end))) continue;
    found.push({ text: m.text, start, end, kind: m.kind });
  }
  return found;
}

// The character classes of the removed xterm WebLinksAddon, so a URL on one row ends
// where it always did ("x|grep", "x{y}", "x!", "x~"); only the scheme's case is looser.
const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/gi;
const DOC_EXT = "html?|md|markdown|svg|pdf|png|jpe?g|gif|webp|"
  // source files, shown in Monaco (codeview.py)
  + "py|pyi|mli?|mll|mly|mligo|[cm]?js|jsx|tsx?|jsonc?|jsonl|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|rs|go|c|h|cc|cpp|hpp|cxx|"
  + "java|kt|scala|rb|php|lua|pl|sql|css|scss|less|swift|dart|jl|tex|diff|patch|txt|log|csv|xml|proto|graphql|"
  + "el|clj|exs?|erl|hs|v|sv|qnt|tla|sol|tz|tf|hcl|rst|vue|svelte";
// A document path in terminal text, with an optional ":line" or ":line:col"
// (src/x.py:42). It may end a sentence ("saved to x.md."), but "x.md.bak" or
// "x.mdx" is not a document.
// No lookbehind (Safari < 16.4 cannot parse one, and the whole page would fail):
// the character before the path is captured in group 1 and skipped by docMatches().
const DOC_RE = new RegExp(String.raw`(^|[^\w:\/~.-])((?:~\/|\/|\.{1,2}\/)?[\w@%+=.,\/-]{0,256}[\w-]\.(?:${DOC_EXT})(?::\d+(?:[:-]\d+)?)?)(?!\w)(?!\.\w)`, "g");
// Product names written like files ("Node.js", "Vue.js") are not paths.
const NOT_A_FILE = /^(?:node|vue|next|nuxt|express|three|d3|chart|react|angular|ember|backbone|socket\.io|moment|deno|bun|alpine|solid|svelte|p5|anime|leaflet|lodash|pixi|jquery|underscore|knockout|meteor|nest|gatsby|remix|preact|htmx|hapi|koa|fastify|electron)\.js$/i;

// Directory paths in a string: explicit ones (~/…, /…, ./…, ../…) or anything
// ending with "/". Whether it really is a directory is checked on click.
const DIR_RE = /(^|[\s"'(\[<=])((?:~|\.{1,2})?\/[\w@%+=.,\/-]*|[\w@%+=.,-]+(?:\/[\w@%+=.,-]+)*\/)(?=$|[\s"')\]>,;:])/g;

function dirMatches(text: string) {
  const out = [];
  for (const m of text.matchAll(DIR_RE)) {
    const path = (m[2] ?? "").replace(/[.,]+$/, "");  // sentence punctuation is not part of it
    if (path.length < 2 || path === "./" || path === "../" || /^\/+$/.test(path)) continue;
    out.push({ text: path, index: m.index + (m[1] ?? "").length, kind: "dir" as const });
  }
  return out;
}

// Document paths in a string: [{ text, index }].
function docMatches(text: string) {
  const out = [];
  for (const m of text.matchAll(DOC_RE)) {
    if (NOT_A_FILE.test(m[2] ?? "")) continue;
    out.push({ text: m[2] ?? "", index: m.index + (m[1] ?? "").length });
  }
  return out;
}

// Copy on select. The per-device preference is stored under COPY_ON_SELECT_KEY (client store);
// only an explicit `false` turns it off, so a missing, malformed or older value keeps the default.
export const COPY_ON_SELECT_KEY = "copyOnSelect";
export const copyOnSelectEnabled = (stored: unknown): boolean => stored !== false;

export type CopyOnSelectState = {
  enabled: boolean;
  selection: string;
  /** the pane is shown and the page is in the foreground: a hidden pane never writes the clipboard */
  visible: boolean;
  /** the program tracks the mouse (xterm's mouseTrackingMode is not "none") */
  mouseTracking: boolean;
  /** the user held Shift or Option to force a text selection */
  forced: boolean;
};

/**
 * Whether the held modifiers force a text selection past a program that tracks the mouse, by
 * xterm's own rule: Shift on Linux and Windows, Option on macOS (macOptionClickForcesSelection).
 * The link handler and copy on select share it, so the two never disagree.
 */
export function forcesSelection(event: {shiftKey: boolean; altKey: boolean}, platform: "mac" | "other"): boolean {
  return platform === "mac" ? event.altKey : event.shiftKey;
}

/** How long a double click waits for a possible third click before its word is copied (ms). */
export const COPY_ON_SELECT_MULTI_CLICK_MS = 350;

/** The wait before a release copies: none for a drag or a triple click, one window for a double click. */
export function copyOnSelectDelay(clickCount: number): number {
  return clickCount === 2 ? COPY_ON_SELECT_MULTI_CLICK_MS : 0;
}

/** Whether the selection that has just settled is written to the clipboard. */
export function shouldCopyOnSelect(state: CopyOnSelectState): boolean {
  if (!state.enabled || !state.visible || state.selection.trim() === "") return false;
  return !state.mouseTracking || state.forced;
}

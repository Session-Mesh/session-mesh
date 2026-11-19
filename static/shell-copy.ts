// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Copy as shell command": rewrite the rows of a terminal selection so that pasting them into
// bash or zsh runs one multi-line command as one command. Pure text in, text out; the usual
// copies go through here only when the per-device preference "copyAsShell" (off by default) is on.
//
// The rules are deliberately few. Whenever the text is not clearly shell, the result is the
// selection unchanged (rows joined by newlines, soft-wrapped rows joined without a break):
//   - a row marked wrapped continues the row above with no break and no backslash;
//   - a hard break gets a trailing ` \` only when the next row is an indented option row (`-x`,
//     `--long`: a dash then a letter or digit) AND every row after the first one in the same block of
//     non-blank rows is itself an option row or follows a row that already ends in `\`. A
//     continuation that does not start with an option is never joined: nothing is guessed from
//     indentation, because a selection that starts mid-line loses the indent of its first row;
//   - a row ending in a backslash followed by blanks (an escaped space) is left as it is;
//   - a row that already ends in `\`, a blank row, a comment, a heredoc and its body, and a row that
//     ends inside a quoted string are never changed;
//   - a row that ends in an operator or block opener (`|`, `&&`, `||`, `;`, `&`, `{`, `(`, `then`,
//     `do`, `else`) or in `:` or `,` is never given a backslash (the shell, or another language,
//     already continues or ends there);
//   - if any row starts with a prompt (`$ `, `user@host:~$ `, `> `), the selection mixes commands
//     and output: it is returned unchanged;
//   - an unterminated quote or heredoc, or a selection over MAX_CHARS, is returned unchanged.

export const MAX_CHARS = 2_000_000;

const PROMPT = /^(?:\S+[$%❯➜]|[$%❯➜]|>)\s/;
const OPERATOR_KEEP_OPEN = /(?:\|\||&&|\|)$/;
const OPERATOR_END_OF_COMMAND = /(?:[;{(:,]|(?<!&)&|(?:^|\s)(?:then|do|else))$/;
const OPTION_ROW = /^[ \t]+-{1,2}[A-Za-z0-9]/;

type Scan = { quote: string | null; heredocs: Heredoc[]; endsInBackslash: boolean; hasComment: boolean };
type Heredoc = { tag: string; stripTabs: boolean };

function readHeredocTag(line: string, from: number): { heredoc: Heredoc; next: number } | null {
  const match = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][\w]*))/.exec(line.slice(from));
  if (!match) return null;
  const tag = match[2] ?? match[3] ?? match[4];
  if (!tag) return null;
  return { heredoc: { tag, stripTabs: match[1] === "-" }, next: from + match[0].length };
}

/** Quote opened by the character at `i` (outside a quote), and how many characters it takes. */
function openingQuote(line: string, i: number): { quote: string; width: number } | null {
  const ch = line[i];
  if (ch === "$" && line[i + 1] === "'") return { quote: "$'", width: 2 };
  if (ch === "'" || ch === '"' || ch === "`") return { quote: ch, width: 1 };
  return null;
}

/** Where a quote that was open at `from` closes on this line, or -1 (it stays open). */
function closeIndex(line: string, from: number, quote: string): number {
  const closer = quote === "$'" ? "'" : quote;
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\" && quote !== "'") i += 1;
    else if (line[i] === closer) return i;
  }
  return -1;
}

/** What one row leaves open: a quote, heredocs to read, a trailing backslash, a comment. */
function scanLine(line: string, quote: string | null): Scan {
  const heredocs: Heredoc[] = [];
  let i = 0;
  let hasComment = false;
  let endsInBackslash = false;
  if (quote) {
    const close = closeIndex(line, 0, quote);
    if (close < 0) return { quote, heredocs, endsInBackslash, hasComment };
    i = close + 1;
    quote = null;
  }
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "\\") {
      if (i === line.length - 1) endsInBackslash = true;
      i += 2;
      continue;
    }
    const opened = openingQuote(line, i);
    if (opened) {
      const close = closeIndex(line, i + opened.width, opened.quote);
      if (close < 0) return { quote: opened.quote, heredocs, endsInBackslash: false, hasComment };
      i = close + 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) { hasComment = true; break; }
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
      const found = readHeredocTag(line, i);
      if (found) { heredocs.push(found.heredoc); i = found.next; continue; }
      i += 2;
      continue;
    }
    i += 1;
  }
  return { quote: null, heredocs, endsInBackslash, hasComment };
}

const isBlank = (line: string): boolean => line.trim() === "";
const isCommentOnly = (line: string): boolean => line.trimStart().startsWith("#");

/** Rows joined into logical lines: a wrapped row continues the one above with no break. */
function joinWrapped(lines: readonly string[], wrapFlags: readonly boolean[]): string[] {
  const logical: string[] = [];
  lines.forEach((raw, index) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (index > 0 && wrapFlags[index] === true && logical.length > 0) logical[logical.length - 1] += text;
    else logical.push(text);
  });
  return logical;
}

const endsInOddBackslashes = (line: string): boolean => ((/\\+$/.exec(line)?.[0].length ?? 0) % 2) === 1;

/**
 * For each row, whether the block of non-blank rows it belongs to may receive added backslashes:
 * every row after the block's first is an option row, or follows a row that already ends in `\`.
 */
function blockOk(logical: readonly string[]): boolean[] {
  const ok: boolean[] = new Array(logical.length).fill(false);
  let from = 0;
  while (from < logical.length) {
    if (isBlank(logical[from] as string)) { from += 1; continue; }
    let to = from;
    while (to < logical.length && !isBlank(logical[to] as string)) to += 1;
    let good = true;
    for (let k = from + 1; k < to; k++) {
      if (!OPTION_ROW.test(logical[k] as string) && !endsInOddBackslashes(logical[k - 1] as string)) good = false;
    }
    for (let k = from; k < to; k++) ok[k] = good;
    from = to;
  }
  return ok;
}

type Walk = { out: string[]; commandActive: boolean; heredocs: Heredoc[]; quote: string | null };

/** Reads heredoc body rows; true when this row was one (it is copied unchanged). */
function consumeHeredocRow(walk: Walk, line: string): boolean {
  const open = walk.heredocs[0];
  if (!open) return false;
  walk.out.push(line);
  const candidate = open.stripTabs ? line.replace(/^\t+/, "") : line;
  if (candidate === open.tag) walk.heredocs.shift();
  walk.commandActive = false;
  return true;
}

function processRow(walk: Walk, line: string, joinNext: boolean): void {
  if (consumeHeredocRow(walk, line)) return;
  const startsHere = !walk.commandActive && walk.quote === null;
  if (isBlank(line) || (startsHere && isCommentOnly(line))) {
    walk.out.push(line);
    walk.commandActive = false;
    return;
  }
  if (startsHere) walk.commandActive = true;
  const scan = scanLine(line, walk.quote);
  walk.quote = scan.quote;
  walk.heredocs = scan.heredocs;
  if (scan.heredocs.length > 0 || scan.quote) { walk.out.push(line); return; }
  if (scan.endsInBackslash) { walk.out.push(line); return; }
  const code = line.trimEnd();
  if (OPERATOR_KEEP_OPEN.test(code) || scan.hasComment) {
    walk.commandActive = OPERATOR_KEEP_OPEN.test(code);
    walk.out.push(line);
    return;
  }
  if (OPERATOR_END_OF_COMMAND.test(code)) { walk.commandActive = false; walk.out.push(line); return; }
  if (code.length !== line.length && code.endsWith("\\")) {
    walk.commandActive = false;
    walk.out.push(line);
    return;
  }
  if (joinNext) {
    walk.out.push(`${code} \\`);
    return;
  }
  walk.commandActive = false;
  walk.out.push(line);
}

/**
 * The selection as a command that pastes and runs as written.
 * @param lines the selected rows, left to right text of each, without line terminators
 * @param wrapFlags `wrapFlags[i]` is true when row i is a soft wrap of row i-1 (xterm `isWrapped`)
 */
export function toShellCommand(lines: readonly string[], wrapFlags: readonly boolean[] = []): string {
  const logical = joinWrapped(lines, wrapFlags);
  const plain = logical.join("\n");
  if (plain.length > MAX_CHARS || logical.some((line) => PROMPT.test(line))) return plain;
  const walk: Walk = { out: [], commandActive: false, heredocs: [], quote: null };
  const ok = blockOk(logical);
  logical.forEach((line, index) =>
    processRow(walk, line, ok[index] === true && OPTION_ROW.test(logical[index + 1] ?? "")));
  if (walk.quote !== null || walk.heredocs.length > 0) return plain;
  return walk.out.join("\n");
}

// ---- the selection of an xterm terminal, as rows

type SelectionLine = { isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string };
export type SelectionTerminal = {
  getSelection(): string;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  buffer: { active: { getLine(y: number): SelectionLine | undefined } };
};

const strip = (text: string): string => text.split("\n").map((row) => row.trimEnd()).join("\n").trimEnd();

/**
 * The selection as a shell command, or null when the rows cannot be rebuilt faithfully (no
 * position, a column selection, a row missing from the buffer): the caller then copies the
 * selection as it is. The rows are checked against `getSelection()`, so a wrong reading of the
 * coordinates never changes what is copied.
 */
export function shellCommandOfSelection(term: SelectionTerminal): string | null {
  const range = term.getSelectionPosition();
  if (!range) return null;
  const { start, end } = range;
  const rows: string[] = [];
  const wrapped: boolean[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const line = term.buffer.active.getLine(y);
    if (!line) return null;
    const continues = y < end.y && term.buffer.active.getLine(y + 1)?.isWrapped === true;
    rows.push(line.translateToString(!continues, y === start.y ? start.x : 0, y === end.y ? end.x : undefined));
    wrapped.push(y > start.y && line.isWrapped);
  }
  if (strip(joinWrapped(rows, wrapped).join("\n")) !== strip(term.getSelection())) return null;
  return toShellCommand(rows, wrapped);
}

// ---- the per-device "copyAsShell" preference (client store), off by default

export const COPY_AS_SHELL_KEY = "copyAsShell";
/** Only an explicit `true` turns it on: a missing, malformed or older value keeps the plain copy. */
export const copyAsShellEnabled = (stored: unknown): boolean => stored === true;

/**
 * What a usual copy (copy keys, right-click, copy on select) writes. With the preference off, when
 * `text` is not the terminal's current selection (a phone selection kept after the terminal cleared
 * its own), or when the rows cannot be rebuilt: `text` itself. Otherwise its shell-command form.
 */
export function copiedText(term: SelectionTerminal & { hasSelection(): boolean }, text: string, asShell: boolean): string {
  if (!asShell || !term.hasSelection() || term.getSelection() !== text) return text;
  return shellCommandOfSelection(term) ?? text;
}

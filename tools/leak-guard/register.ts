// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The CLA register publishes each signatory's commit address on purpose, and the required `cla`
// check ties every row it counts to a commit authored with that address. A row here is exactly
// what tools/cla-check counts as a signature (its own parseRow and rowCandidates), so the e-mail
// rule is never lifted for a line that check ignores (other version, impossible date, blank name,
// unpaired backquote, fenced or commented line).
import {parseRow, rowCandidates} from '../cla-check/cla-check.ts';

// Line numbers (1-based) of a whole register that can hold rows: outside fences and HTML comments.
export function rowLineNumbers(lines: readonly string[]): ReadonlySet<number> {
  return new Set(rowCandidates(lines).map(position => position + 1));
}

// The address of a signatory row (ASCII lower case, as cla-check keeps it) and the index of the
// pipe that ends its name cell; null when the line is not a row.
export type RowAddress = {email: string; nameEnd: number};

export function rowAddress(line: string): RowAddress | null {
  const row = parseRow(line);
  return row && {email: row.email, nameEnd: line.indexOf('|', 1)};
}

// True when `text` at `index` is the row's address. A text equal to it lies in the name cell or in
// the address cell: the version and date cells have fixed forms. The address cell holds only the
// address, blanks and a pair of backquotes, none of which an address contains, so an equal text
// after the name cell is the address itself.
export function isRowAddress(row: RowAddress, index: number, text: string): boolean {
  return index > row.nameEnd && text.replace(/[A-Z]/g, letter => letter.toLowerCase()) === row.email;
}

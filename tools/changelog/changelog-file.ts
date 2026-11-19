// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "## Unreleased" section of CHANGELOG.md and the two operations on it: assembling the
// unreleased entries (the bullets already in the section, then the fragments) and cutting a
// release (moving them under a new version heading). Pure functions over text; the caller reads
// and writes the files.
import type {Fragment} from './fragments.ts';

export const UNRELEASED_HEADING = '## Unreleased';
// A version as release.yml accepts it in a tag name, without the leading "v".
export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export type UnreleasedSection = {
  before: string[]; // the lines up to the heading, the heading excluded
  preamble: string[]; // the text between the heading and the first bullet
  entries: string[]; // the first bullet and everything after it, up to the next "## " heading
  after: string[]; // the next "## " heading and everything below it
};

const trimBlankEdges = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
};

export function splitUnreleased(markdown: string): UnreleasedSection {
  if (markdown.includes('\r')) throw new Error('CHANGELOG.md has carriage returns');
  const lines = markdown.replace(/\n$/, '').split('\n');
  const headings = lines.flatMap((line, index) => (line.trimEnd() === UNRELEASED_HEADING ? [index] : []));
  if (headings.length !== 1) throw new Error(`CHANGELOG.md must have exactly one "${UNRELEASED_HEADING}" heading, it has ${headings.length}`);
  const start = headings[0];
  const nextHeading = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const end = nextHeading < 0 ? lines.length : nextHeading;
  const body = lines.slice(start + 1, end);
  const firstBullet = body.findIndex((line) => line.startsWith('- '));
  const preamble = firstBullet < 0 ? body : body.slice(0, firstBullet);
  const entries = firstBullet < 0 ? [] : body.slice(firstBullet);
  return {before: lines.slice(0, start), preamble: trimBlankEdges(preamble), entries: trimBlankEdges(entries), after: lines.slice(end)};
}

// The entries of the fragments, in the given (already sorted) order.
export const fragmentEntries = (fragments: Fragment[]): string[] => fragments.flatMap((fragment) => fragment.bullet.split('\n'));

// The text of the Unreleased section as it reads with the fragments merged in: the section's
// preamble, its existing bullets, then the fragments' bullets. With `entriesOnly`, the bullets only.
export function assemble(markdown: string, fragments: Fragment[], entriesOnly = false): string {
  const section = splitUnreleased(markdown);
  const entries = [...section.entries, ...fragmentEntries(fragments)];
  if (entriesOnly) return entries.length === 0 ? '' : `${entries.join('\n')}\n`;
  const blocks = [section.preamble, entries].filter((block) => block.length > 0).map((block) => block.join('\n'));
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

export type CutOptions = {
  version: string;
  date?: string; // YYYY-MM-DD, written as "## <version> (<date>)"
  intro?: string; // a paragraph between the heading and the entries
  // true: only the given fragments move, the bullets already under Unreleased stay there (a patch
  // release cut on main, whose Unreleased bullets belong to the next minor version).
  fragmentsOnly?: boolean;
};

// A YYYY-MM-DD string that names a day of the Gregorian calendar (no 2026-02-30, no month 13).
function isCalendarDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function headingOf(options: CutOptions): string {
  if (!VERSION.test(options.version)) throw new Error(`"${options.version}" is not a version such as 0.2.0 or 0.2.0-rc.1`);
  if (options.date !== undefined && !DATE.test(options.date)) throw new Error(`"${options.date}" is not a date YYYY-MM-DD`);
  if (options.date !== undefined && !isCalendarDate(options.date)) throw new Error(`"${options.date}" is not a calendar date`);
  return options.date === undefined ? `## ${options.version}` : `## ${options.version} (${options.date})`;
}

function checkIntro(intro: string | undefined): string[] {
  if (intro === undefined || intro.trim() === '') return [];
  const lines = intro.replace(/\n+$/, '').split('\n');
  // No heading, list item, heading underline or rule: the intro must not open a section of its own.
  if (lines.some((line) => /^\s*(?:#|[-*+] |=+\s*$|(?:[-*_]\s*){3,}$)/.test(line) || line.trim() === '')) {
    throw new Error('the intro is one paragraph: no blank line, heading or bullet');
  }
  return lines;
}

// CHANGELOG.md with the unreleased entries moved under a new version heading, placed right below
// the Unreleased section. The Unreleased heading and its preamble stay.
export function cut(markdown: string, fragments: Fragment[], options: CutOptions): string {
  const heading = headingOf(options);
  const intro = checkIntro(options.intro);
  const section = splitUnreleased(markdown);
  const versionPrefix = `## ${options.version}`;
  const taken = [...section.before, ...section.after].some((line) => line === versionPrefix || line.startsWith(`${versionPrefix} `));
  if (taken) throw new Error(`CHANGELOG.md already has a "${versionPrefix}" heading`);
  const moved = [...(options.fragmentsOnly ? [] : section.entries), ...fragmentEntries(fragments)];
  if (moved.length === 0) throw new Error('nothing to cut: no unreleased entry and no fragment');
  const kept = options.fragmentsOnly ? section.entries : [];
  const unreleased = [UNRELEASED_HEADING, ...[section.preamble, kept].filter((block) => block.length > 0).flatMap((block) => ['', ...block])];
  const release = [heading, '', ...(intro.length > 0 ? [...intro, ''] : []), ...moved];
  const after = section.after.length > 0 ? ['', ...section.after] : [];
  const before = section.before.length > 0 ? [...trimBlankEdges(section.before), ''] : [];
  return `${[...before, ...unreleased, '', ...release, ...after].join('\n')}\n`;
}

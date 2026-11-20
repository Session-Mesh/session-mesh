// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Tracker references in terminal text: a task (T-), project (P-) or question (N-) id, written as a whole word. This
 * module only finds candidates; a candidate becomes a link only when the page knows that id (static/work-references.ts),
 * so ordinary text such as "T-12" stays text. Pure and linear in the length of the text.
 */

export type ReferenceMatch = Readonly<{
  /** The id as the tracker writes it: the prefix letter, a dash, lowercase hex digits. */
  id: string;
  /** Where the id starts in the text, and its length there. */
  index: number;
  length: number;
}>;

// An uppercase prefix, then two to thirty-two hex digits (the form work-read accepts); nothing else in the word.
const REFERENCE = /^([TPN])-([0-9a-fA-F]{2,32})$/;
// Brackets, quotes and emphasis around a word, and sentence punctuation after it. Nothing else is taken off, so an id
// glued to a path, a URL, a file name, an assignment or a hashtag is not one.
const BEFORE = new Set(['(', '[', '{', '<', '"', "'", '`', '*']);
const AFTER = new Set([')', ']', '}', '>', '"', "'", '`', '*', '.', ',', ';', ':', '!', '?']);

/** Every reference candidate of a text, in order. */
export function referenceMatches(text: string): ReferenceMatch[] {
  const found: ReferenceMatch[] = [];
  for (const word of text.matchAll(/\S+/g)) {
    const value = word[0];
    let start = 0, end = value.length;
    while (start < end && BEFORE.has(value[start] ?? '')) start++;
    while (end > start && AFTER.has(value[end - 1] ?? '')) end--;
    // Shorter than "T-xx" or longer than the longest id: not worth a regular expression.
    if (end - start < 4 || end - start > 34) continue;
    const parts = REFERENCE.exec(value.slice(start, end));
    if (!parts) continue;
    found.push({ id: `${parts[1]}-${(parts[2] ?? '').toLowerCase()}`, index: word.index + start, length: end - start });
  }
  return found;
}

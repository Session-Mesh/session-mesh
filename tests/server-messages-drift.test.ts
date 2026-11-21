// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// static/i18n/server-messages.json maps the server's error texts to catalog keys.
// The table drifts silently when a server message is reworded: the client then
// shows the raw English text instead of the translation. This test reads every
// string literal of the server modules (the Python files at the repository root,
// adjacent literals joined as Python joins them, each f-string field replaced by
// a sample value) and requires that every row of the table matches at least one.
// The check also runs the other way: every message the server returns (text=...,
// {"error": ...}, {"note": ...}) must be in the table or in an explicit, justified
// list of messages the interface never shows, and no row may be broader than its
// own message or hidden behind an earlier row.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TABLE = path.join(ROOT, 'static', 'i18n', 'server-messages.json');

type Row = {pattern: string; key: string};
type Literal = {text: string; formatted: boolean};

const serverFiles = () => fs.readdirSync(ROOT).filter(name => name.endsWith('.py')).sort()
  .map(name => path.join(ROOT, name));

// One Python string token: optional prefix, then a single- or triple-quoted body.
const STRING = /([rRbBfFuU]{0,2})('''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/y;

function unquote(token: string): string {
  const triple = token.startsWith('"""') || token.startsWith("'''");
  const body = token.slice(triple ? 3 : 1, triple ? -3 : -1);
  return body.replace(/\\(["'\\])/g, '$1');
}

// Literals in source order; adjacent ones (only blanks, newlines or a line
// continuation between them) are joined into one, as Python does.
export function literals(source: string): Literal[] {
  const out: Literal[] = [];
  let index = 0;
  let previousEnd = -1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    STRING.lastIndex = index;
    const startsWord = index === 0 || !/[A-Za-z0-9_]/.test(source[index - 1]!);
    const match = startsWord ? STRING.exec(source) : null;
    if (!match) { index++; continue; }
    const literal = {text: unquote(match[2]!), formatted: /[fF]/.test(match[1]!)};
    const gap = previousEnd >= 0 ? source.slice(previousEnd, index) : null;
    const last = out[out.length - 1];
    if (last && gap !== null && /^[\s\\]*$/.test(gap)) {
      last.text += literal.text;
      last.formatted ||= literal.formatted;
    } else out.push(literal);
    index = previousEnd = STRING.lastIndex;
  }
  return out;
}

// The texts an f-string can produce, for the purpose of this check: each field
// becomes "1" (fits a number or any text) or, when the field holds quoted
// fallbacks such as {host or 'the mesh'}, one of those.
export function samples(literal: Literal): string[] {
  if (!literal.formatted) return [literal.text];
  const parts = literal.text.replace(/\{\{|\}\}/g, m => m[0]!).split(/(\{[^{}]*\})/);
  let results = [''];
  for (const part of parts) {
    const field = /^\{([^{}]*)\}$/.exec(part);
    const choices = field ? ['1', ...[...field[1]!.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]!)] : [part];
    results = results.flatMap(prefix => choices.map(choice => prefix + choice)).slice(0, 64);
  }
  return results;
}

// Messages the server returns that the interface never shows as such: they answer
// agents, hooks, the pty host or the wake stream, whose callers read the English
// text. No catalog key exists for them; add a row and a key if a screen starts
// displaying one. Each entry states why it has no row.
const NOT_SHOWN: Record<string, string> = {
  'Invalid project issue request': 'issue reader route: the client treats any non-OK reply as "unavailable" and shows its own text',
  'Pi wake stream already connected': 'answer to the Pi extension opening a second wake stream, never a screen',
  'Invalid detail': 'agent event ingestion (hooks post events): validation answer read by the hook',
  'Unknown event field': 'agent event ingestion: validation answer read by the hook',
  'Invalid event version': 'agent event ingestion: validation answer read by the hook',
  'Invalid event type': 'agent event ingestion: validation answer read by the hook',
  'Invalid event date': 'agent event ingestion: validation answer read by the hook',
  'Invalid event ID': 'agent event ingestion: validation answer read by the hook',
  'Only agent sessions can use messaging': 'agent mail API, called by the agent MCP bridge only',
  'Invalid agent recipient': 'agent mail API, called by the agent MCP bridge only',
  'Recipient agent session unavailable': 'agent mail API, called by the agent MCP bridge only',
  'Request ID required': 'session action request poll by an agent session, not by a screen',
  'This route takes no parameter': 'session_accounts read by an agent session through the MCP bridge, not by a screen',
  "The session's account changed since the request": 'outcome of an approved account switch, read by the agent with session_action_status, not by a screen',
  "The exact conversation id is unknown; it cannot be resumed elsewhere": 'outcome of an approved account switch whose conversation is only guessed by then, read by the agent with session_action_status, not by a screen',
  "The conversation is not in the current account's folder": 'outcome of an approved account switch whose transcript is gone by then, read by the agent with session_action_status, not by a screen',
  'Document not opened: its access scope could not be recorded': 'answer to mesh-open run with a session token, read in the terminal',
  'Agent session unavailable': 'agent mail API (read and acknowledge), called by the agent MCP bridge only',
  'Content-Type must be application/json': 'protocol error of the JSON routes: the page always sends JSON, a client that does not is not a screen',
  'Invalid fields': 'request-shape validation of the elevation and configuration routes: the page sends fixed fields, a mismatch is a client bug',
  unwritable: 'machine code of the launch options route, whose message carries the readable reason',
  'stale-options': 'machine code of the session-request decision, handled by static/app.js (the request stays claimed and is asked again with the current options)',
  'too-many-attempts': 'machine code of the elevation route, mapped to its own label by static/config-launch-editor.ts (config.launch.err.tooMany)',
  'wrong-token': 'machine code of the elevation route, mapped to its own label by static/config-launch-editor.ts',
  'elevation-required': 'machine code of the configuration routes, mapped to the elevation prompt by static/config-launch-editor.ts',
  'no release notes': 'GET /api/update/notes: static/update-notes.ts treats any non-OK reply as "unavailable" and shows its own text (update.notesFailed)',
  'a guarded restore is exactly {names: [name], expected: {...}}': 'protocol error of the guarded restore: only a tool sends `expected`, the page never does',
  'names: exactly [expected.name]': 'protocol error of the guarded restore: only a tool sends `expected`, the page never does',
  'invalid': 'machine code of the configuration route, sent with the validation detail in its own field; not a text for a screen',
  'settings-unreadable': 'machine code of POST /api/dirs/recent, a background request of the page that keeps its copy for a later try (static/app.js moveRecentFoldersToRunner); never shown',
};

const MAX_DISTINCT_MESSAGES_PER_ROW = 4;

// The server messages themselves: a literal in a message position, f-strings
// kept as written so a text identifies its source line.
// Also the warnings of a restoration (``warnings.append("...")``, the "mail expired" note, and the mail transfer's
// ``return "agent mail not transferred..."``), which the page shows next to the result.
const MESSAGE_POSITION = /(?:\btext=|["'](?:error|note)["']\s*:\s*|\bwarnings\.append\(|\bnotes\.append\((?=["']mail expired)|\breturn (?=["']agent mail))/g;

// A message kept in a module constant (``RESTORING_REFUSAL = "..."``) and returned by name is a server message too.
export function stringConstants(sources: string[]): Map<string, Literal> {
  const found = new Map<string, Literal>();
  for (const source of sources) {
    for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*) = \(?\s*/gm)) {
      const rest = source.slice(match.index! + match[0].length);
      if (/^[rRbBfFuU]{0,2}['"]/.test(rest)) found.set(match[1]!, literals(rest)[0]!);
    }
  }
  return found;
}

const NAMED_MESSAGE = /(?:\btext=|["'](?:error|note)["']\s*:\s*)([A-Z][A-Z0-9_]+)\b/g;

export function serverMessages(source: string, constants: Map<string, Literal> = new Map()): Literal[] {
  const found: Literal[] = [];
  for (const match of source.matchAll(MESSAGE_POSITION)) {
    const rest = source.slice(match.index! + match[0].length);
    if (!/^[rRbBfFuU]{0,2}['"]/.test(rest)) continue;
    found.push(literals(rest)[0]!);
  }
  for (const match of source.matchAll(NAMED_MESSAGE)) {
    const constant = constants.get(match[1]!);
    if (constant) found.push(constant);
  }
  return found;
}

const trimmedMatch = (row: Row, text: string) => new RegExp(row.pattern, 's').test(text.trim());

export function tableProblems(rows: Row[], texts: string[], messages: Literal[]): string[] {
  const problems: string[] = [];
  const firstRow = (text: string) => rows.findIndex(row => trimmedMatch(row, text));
  rows.forEach((row, index) => {
    const matched = [...new Set(texts.filter(text => trimmedMatch(row, text)))];
    if (matched.length > MAX_DISTINCT_MESSAGES_PER_ROW) {
      problems.push(`${row.key} is too broad: it matches ${matched.length} distinct literals (limit ${MAX_DISTINCT_MESSAGES_PER_ROW})`);
    }
    if (!matched.some(text => firstRow(text) === index)) {
      problems.push(`${row.key} recognizes no literal first: an earlier row takes them all, or none matches`);
    }
  });
  for (const message of messages) {
    if (message.text in NOT_SHOWN) continue;
    const unmatched = samples(message).filter(text => firstRow(text) < 0);
    if (unmatched.length) problems.push(`server message without a row or an exclusion: ${JSON.stringify(message.text)}`);
  }
  return problems;
}

// The server relays the native PTY host's error replies, the only texts the host sends to clients
// (its log lines and other string literals reach no client): the replies it builds as
// {"error": "..."} are both the literals a row may match and server messages that need a row.
const HOST_SOURCE = path.join(ROOT, 'ocaml', 'lib', 'mesh_ptyhost.ml');
const OCAML_STRING = '"((?:[^"\\\\\\n]|\\\\.)*)"';
const ocamlText = (raw: string): string => raw.replace(/\\(["\\])/g, '$1');

export function hostMessages(source: string): Literal[] {
  const reply = new RegExp('\\("error",\\s*`String\\s+' + OCAML_STRING + '\\)', 'g');
  return [...source.matchAll(reply)].map(m => ({text: ocamlText(m[1]!), formatted: false}));
}

describe('server message table', () => {
  const rows = JSON.parse(fs.readFileSync(TABLE, 'utf8')) as Row[];
  const sources = serverFiles().map(file => fs.readFileSync(file, 'utf8'));
  const hostReplies = hostMessages(fs.readFileSync(HOST_SOURCE, 'utf8'));
  const texts = [...sources.flatMap(source => literals(source).flatMap(samples)), ...hostReplies.flatMap(samples)];
  const constants = stringConstants(sources);
  const messages = [...sources.flatMap(source => serverMessages(source, constants)), ...hostReplies];

  test('the literal reader joins adjacent literals and fills f-string fields', () => {
    const found = literals('x = f"a {b} " \\\n  "c"  # "comment"\ny = rb\'d\\\'e\'');
    assert.deepEqual(found, [{text: 'a {b} c', formatted: true}, {text: "d'e", formatted: false}]);
    assert.deepEqual(samples({text: "{agent} runs in {host or 'the mesh'}", formatted: true}),
      ['1 runs in 1', '1 runs in the mesh']);
  });

  test('the server modules were read', () => {
    assert.ok(texts.length > 500, `only ${texts.length} literals read from the server modules`);
  });

  test('the table is not broader than its messages and no row hides another', () => {
    assert.deepEqual(tableProblems(rows, texts, messages), []);
  });

  test('every message position was read and every exclusion is still a server message', () => {
    assert.ok(messages.length > 150, `only ${messages.length} server messages read`);
    const present = new Set(messages.map(message => message.text));
    for (const text of Object.keys(NOT_SHOWN)) {
      assert.ok(present.has(text), `exclusion for a message the server no longer returns: ${text}`);
      assert.ok(!rows.some(row => trimmedMatch(row, text)), `excluded message also has a row: ${text}`);
    }
  });

  // A refused resume reaches the page as an HTTP 409 whose text is str(exc), not a
  // literal in a message position: require a row for each refusal text by hand.
  test('every refused-resume message of resumeargs.py has a row', () => {
    const source = fs.readFileSync(path.join(ROOT, 'resumeargs.py'), 'utf8');
    const refusals = literals(source).filter(literal => literal.text.includes('resume refused'));
    assert.ok(refusals.length >= 5, `only ${refusals.length} refusal messages read`);
    for (const refusal of refusals) {
      const sample = refusal.text.replace(/\{[A-Za-z_]+\}/g, '--x');
      assert.ok(rows.some(row => trimmedMatch(row, sample)), `refused resume without a row: ${refusal.text}`);
    }
  });

  // The note of a session restored as a shell (I6) comes from a dict (NOT_RELAUNCHED in server.py), not
  // from a literal in a message position: require a row for each note by hand.
  test('every note of a session restored as a shell has a row', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.py'), 'utf8');
    const block = /^NOT_RELAUNCHED = \{\n([\s\S]*?)^\}/m.exec(source);
    assert.ok(block, 'NOT_RELAUNCHED read from server.py');
    const notes = literals(block[1]!).filter(literal => literal.text.endsWith(': restarted as a plain shell'));
    assert.equal(notes.length, 3, JSON.stringify(notes));
    for (const note of notes) {
      assert.ok(rows.some(row => trimmedMatch(row, note.text)), `restore note without a row: ${note.text}`);
    }
  });

  test('a catch-all row, a row taking another message pattern and an unlisted message are all caught', () => {
    const pair = [{pattern: '^Alpha failed$', key: 'a'}, {pattern: '^Beta failed$', key: 'b'}];
    const corpus = ['Alpha failed', 'Beta failed', 'x', 'y', 'z', 'w', 'v'];
    const alpha = [{text: 'Alpha failed', formatted: false}, {text: 'Beta failed', formatted: false}];
    assert.deepEqual(tableProblems(pair, corpus, alpha), []);
    assert.match(tableProblems([{pattern: '^.*$', key: 'a'}, pair[1]!], corpus, alpha).join('\n'), /a is too broad/);
    assert.match(tableProblems([{pattern: '^Beta failed$', key: 'a'}, pair[1]!], corpus, alpha).join('\n'), /b recognizes no literal first/);
    assert.match(tableProblems([pair[0]!], corpus, alpha).join('\n'), /without a row or an exclusion: "Beta failed"/);
  });

  for (const row of rows) {
    test(`${row.key} still matches a server message`, () => {
      const pattern = new RegExp(row.pattern, 's');
      assert.ok(texts.some(text => pattern.test(text)),
        `no string literal of the server modules matches ${row.pattern}: reword the row or remove it with the message`);
    });
  }
});

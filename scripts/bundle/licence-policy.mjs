// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The licences a component embedded in a bundle may carry (scripts/bundle-licenses.mjs), with the
// reason for each, and the reviewed exceptions: the components whose licence label is not an SPDX
// expression of this list. The build stops on any other component. The expression parser is the one
// that checks the vendored web libraries (tools/third-party/licenses.mjs); a comma-separated label
// (several licence texts that all apply) is read as an AND of its parts, each part parsed on its own.
import {createHash} from 'node:crypto';
import {disallowedLicenses, parseExpression} from '../../tools/third-party/licenses.mjs';

export const BUNDLE_LICENCES = Object.freeze({
  'AGPL-3.0-or-later': 'session-mesh itself.',
  'Python-2.0': 'the CPython licence stack (PSF, BeOpen, CNRI, CWI); permissive, GPL-compatible per the FSF list.',
  'CNRI-Python': 'part of the CPython licence stack; permissive, GPLv3-compatible per the FSF list.',
  'PSF-2.0': 'the Python Software Foundation licence (Python packages); permissive, GPL-compatible per the FSF list.',
  'Sleepycat': 'Berkeley DB 6.0.19, linked into CPython by python-build-standalone; copyleft on the source of what ' +
    'contains it, met by licenses/SOURCE, which names the complete source of the runtime and of Berkeley DB.',
  'TCL': 'Tcl/Tk (linked into CPython); permissive, GPL-compatible per the FSF list.',
  'X11': 'the X11 licence (libX11, ncurses); permissive, GPL-compatible per the FSF list.',
  'MIT': 'Expat licence; permissive, GPL-compatible per the FSF list.',
  'MIT-0': 'MIT without the attribution condition (cffi); permissive.',
  'BSD-2-Clause': 'FreeBSD licence; permissive, GPL-compatible per the FSF list.',
  'BSD-3-Clause': 'Modified BSD licence; permissive, GPL-compatible per the FSF list.',
  'ISC': 'ISC licence (most OCaml packages); permissive, GPL-compatible per the FSF list.',
  'Apache-2.0': 'compatible with GPLv3 and AGPLv3 per the FSF list (OpenSSL 3, Python and Rust packages); NOTICE texts are kept.',
  'Zlib': 'zlib licence; permissive, GPL-compatible per the FSF list.',
  'bzip2-1.0.6': 'the bzip2 licence, a BSD-style permissive licence.',
  'Unicode-3.0': 'the Unicode data licence (unicode-ident); permissive, with its notice kept.',
  'LGPL-2.1-or-later WITH OCaml-LGPL-linking-exception': 'the OCaml runtime and libraries; the linking exception lets ' +
    'the native programs be distributed under any terms, and the AGPL source offer covers them anyway.',
  'LGPL-3.0-or-later WITH LGPL-3.0-linking-exception': 'Caqti and its SQLite driver (mesh-history); LGPL-3.0 is compatible ' +
    'with the AGPL-3.0, and Caqti\'s own COPYING.LINKING exception waives the Minimal Corresponding Source and ' +
    'installation information of LGPL-3.0 section 4d and 4e for a program that links the library; the AGPL source ' +
    'offer (licenses/SOURCE) covers it anyway.',
  'GPL-3.0-or-later WITH GCC-exception-3.1': 'libgcc_s and libstdc++ copied into lib/; the GCC Runtime Library ' +
    'Exception allows distributing them with a program under any licence.',
});

// Spellings met in package metadata that name a listed licence.
const ALIASES = Object.freeze({'Apache 2.0': 'Apache-2.0', 'Apache License 2.0': 'Apache-2.0'});


const GCC_TEXTS = [/GCC RUNTIME LIBRARY EXCEPTION/i, /GNU GENERAL PUBLIC LICENSE\s+Version 3/i];

// Components whose label is not an expression of the list, reviewed one by one, so that an exception
// stops applying when what it was reviewed for changes. `label` is the label the component must carry;
// `sha256` the SHA-256 of each of its licence texts, in order; `version`, when given, must match its
// version. `licence` replaces the label in the index (and is checked against the list). The GCC
// runtime libraries are the exception to the pinned texts: their texts are those of the build
// system's package, so `text` patterns check them instead.
export const REVIEWED_EXCEPTIONS = Object.freeze({
  'liblzma (XZ Utils) (in CPython)': {label: 'public domain', version: /^5\.2\.12$/,
    sha256: ['828d5b508798d6a95c1c08ce5eee517a84ed1bda14eac58c440b6bce2c5cf1ca'],
    reason: 'liblzma 5.2.12 is in the public domain, as its text says; python-build-standalone links only liblzma.'},
  'SQLite (in CPython)': {label: 'public domain', version: /^3\.47\.1$/,
    sha256: ['38bef3d28b24f145ea293bd3b6eb4b20396982abc8303128fb493986ea5bc719'],
    reason: 'SQLite 3.47.1 is in the public domain, as its text says.'},
  'SQLite (in mesh-history)': {label: 'public domain', version: /^3\.54\.1$/,
    sha256: ['38bef3d28b24f145ea293bd3b6eb4b20396982abc8303128fb493986ea5bc719'],
    reason: 'SQLite 3.54.1 is in the public domain, as its text says; mesh-history links the amalgamation of that version. The text is the public-domain statement published by sqlite.org (the amalgamation holds no licence file).'},
  'Node.js': {label: 'MIT, and the licences of its dependencies listed in the text', version: /^v24\.11\.1$/,
    sha256: ['537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34'],
    reason: 'Node 24.11.1\'s LICENSE is the MIT licence followed by the licence of each library Node embeds ' +
      '(OpenSSL 3, ICU, V8, libuv and others), all permissive.'},
  'Web libraries vendored in static/vendor': {label: 'per file, see THIRD_PARTY.md', checked: 'tools/check-third-party.mjs',
    reason: 'the bundle build runs tools/check-third-party.mjs on app/: every vendored file is covered by ' +
      'THIRD_PARTY.md under a licence of tools/third-party/licenses.mjs, with its text in app/LICENSES/.'},
  // MPL-2.0 is not on the list: it is alternative-only for the web libraries (tools/third-party/licenses.mjs).
  // Under section 3.3 it is compatible with the GNU licences only if no covered file carries the Exhibit B
  // "Incompatible With Secondary Licenses" notice; the pinned text has that sentence once, as the Exhibit B
  // template, and `exhibitB` requires that no other shipped licence text carries it.
  'python-build-standalone (the build recipe)': {label: 'MPL-2.0', exhibitB: true,
    sha256: ['1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5'],
    reason: 'the recipe\'s patches to CPython and its libraries are compiled into the bundled libpython; MPL-2.0 section 3.2 ' +
      'allows that executable form under other terms when the source of the covered files is available (licenses/SOURCE), ' +
      'and section 3.3 makes it compatible with the GNU licences because no file carries the Exhibit B notice.'},
  'Roster CLIs': {licence: 'MIT', label: 'see the text', sha256: ['8d20d775eb1abc98195f0157f080bd15d2ad7866ebd09f2e9ef944fccc790023'],
    reason: 'optional/roster/LICENSE is the MIT licence; its package.json names none.'},
  'openssl (C library in the cryptography wheel)': {licence: 'Apache-2.0', label: 'not stated', version: /^[3-9]\./,
    sha256: ['aac73b3148f6d1d7111dbca32099f68d26c644c6813ae1e4f05f6579aa2663fe'],
    reason: 'OpenSSL 3.0 and later are under Apache-2.0, whose text the wheel ships; the wheel\'s bill of materials ' +
      'states no licence.'},
  'system library libgcc_s.so.1': {licence: 'GPL-3.0-or-later WITH GCC-exception-3.1', label: 'see the text',
    reason: 'the GCC runtime library; its package ships the GPL and the runtime library exception.', text: GCC_TEXTS},
  'system library libstdc++.so.6': {licence: 'GPL-3.0-or-later WITH GCC-exception-3.1', label: 'see the text',
    reason: 'the GNU C++ runtime library; its package ships the GPL and the runtime library exception.', text: GCC_TEXTS},
});

// A label as a tree: a comma joins whole parts, each parsed on its own (so a parenthesis cannot span two
// parts), an alias replaced per part, the parts combined as an AND node: "GPL-2.0-only, MIT OR Apache-2.0"
// is GPL-2.0-only AND (MIT OR Apache-2.0). A part that does not parse is an error.
export function labelTree(label) {
  const trees = String(label).split(/,\s*/).map((part) => parseExpression(ALIASES[part.trim()] ?? part.trim()));
  return trees.length === 1 ? trees[0] : {AND: trees};
}

// SPDX identifiers compare without case.
const ALLOWED = Object.fromEntries(Object.entries(BUNDLE_LICENCES).map(([id, reason]) => [id.toLowerCase(), reason]));
const lowerCase = (tree) => tree.id ? {id: tree.id.toLowerCase()}
  : Object.fromEntries(Object.entries(tree).map(([operator, items]) => [operator, items.map(lowerCase)]));

// Problems of one label, as messages; none when it is an expression of the list.
export function labelProblems(label) {
  let tree;
  try { tree = labelTree(label); } catch { return [`licence "${label}" is not an SPDX expression`]; }
  return [...new Set(disallowedLicenses(lowerCase(tree), ALLOWED))].map((id) => `licence "${id}" is not allowed`);
}

// The Exhibit B notice sentence of the MPL-2.0 (section 1.5): in the licence text itself it appears once, as the template.
const EXHIBIT_B = /This Source Code Form is\s+[“"]Incompatible With Secondary Licenses[”"]/gi;
const count = (text) => (String(text).match(EXHIBIT_B) ?? []).length;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// What differs from what was reviewed: the label, the version, the hash of each licence text, the
// texts' required patterns, or a check the build did not run.
function exceptionProblems(record, exception, read, others = []) {
  const problems = [];
  if (record.licence !== exception.label) problems.push(`label "${record.licence}" is not the reviewed "${exception.label}"`);
  if (exception.version && !exception.version.test(String(record.version))) problems.push(`version ${record.version} is not the reviewed one`);
  const texts = (record.files ?? []).map(read);
  if (exception.sha256 && JSON.stringify(texts.map(sha256)) !== JSON.stringify(exception.sha256)) {
    problems.push('licence text is not the reviewed one (SHA-256)');
  }
  const text = texts.map(String).join('\n');
  for (const pattern of exception.text ?? []) if (!pattern.test(text)) problems.push(`licence text does not match ${pattern}`);
  if (exception.exhibitB) {
    if (count(text) !== 1) problems.push('licence text does not have the Exhibit B template exactly once');
    if (others.some((file) => count(read(file)))) problems.push('a shipped notice carries the "Incompatible With Secondary Licenses" notice');
  }
  if (exception.checked && record.checked !== exception.checked) problems.push(`${exception.checked} did not check it`);
  return problems;
}

// The records with their reviewed licences, and the problems: a component outside the list and without
// a reviewed exception, or an exception that no longer matches what was reviewed. `read` gives a
// licence file's bytes from its bundle path; `exceptions` replaces the reviewed ones (tests).
export function applyLicencePolicy(records, read, exceptions = REVIEWED_EXCEPTIONS) {
  const problems = [];
  const files = (record) => record.files ?? [];
  const reviewed = records.map((record) => {
    const exception = exceptions[record.component];
    if (!exception) {
      for (const problem of labelProblems(record.licence)) problems.push(`${record.component}: ${problem} (scripts/bundle/licence-policy.mjs)`);
      return record;
    }
    const others = [...new Set(records.filter((other) => other !== record).flatMap(files))].filter((file) => !files(record).includes(file));
    const failed = [...exceptionProblems(record, exception, read, others), ...(exception.licence ? labelProblems(exception.licence) : [])];
    for (const problem of failed) problems.push(`${record.component}: reviewed exception: ${problem}`);
    return {...record, licence: exception.licence ?? record.licence,
      note: `${record.note ? `${record.note}; ` : ''}licence reviewed: ${exception.reason}`};
  });
  return {records: reviewed, problems};
}

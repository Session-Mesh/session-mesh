// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Checks that every file under static/vendor/ is covered by a section of
// static/vendor/THIRD_PARTY.md, that each section's license is allowed
// (tools/third-party/licenses.mjs), that each license text it names exists, and that
// the npm packages of the whiteboard bundle are those its `Package:` lines declare.
//
// Usage: node tools/check-third-party.mjs [--strict] [repository-root]
// (`--strict` is accepted for compatibility: what it used to add is now the default.)
// Exit 0: covered and allowed.
// Exit 1: an uncovered file, a stale pattern, a section without `License:`, a license
// outside the allowed list, a section marked "License-Status: unresolved", a missing or
// empty license text, a License-File that is not a regular file (a directory, for
// instance) or lies outside the repository, or a bundled package that does not match
// the `Package:` lines of its section.
import fs from 'node:fs';
import path from 'node:path';
import {licenseExpressionProblems} from './third-party/licenses.mjs';
import {inventoryProblems, parsePackageLine} from './third-party/board-inventory.mjs';

const args = process.argv.slice(2);
const positional = args.filter((arg) => arg !== '--strict');
const root = path.resolve(positional[0] ?? path.join(import.meta.dirname, '..'));
const vendorDir = path.join(root, 'static', 'vendor');
const manifest = path.join(vendorDir, 'THIRD_PARTY.md');
const MANIFEST_NAME = 'THIRD_PARTY.md';

// Glob without brace or class support: `**` crosses directories, `*` and `?` do not.
function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// Machine-read lines of a section, by prefix (`License-File:` before `License:`).
const FIELDS = [
  ['Files:', (section, value) => section.patterns.push(...value.split(',').map((item) => item.trim()).filter(Boolean))],
  ['License-File:', (section, value) => section.licenseFiles.push(value)],
  ['License-Status:', (section, value) => { section.unresolved ||= value === 'unresolved'; }],
  ['License:', (section, value) => section.licenses.push(value)],
  ['Package:', (section, value) => section.packages.push(parsePackageLine(value))],
  ['Inventory:', (section, value) => { section.inventory = value; }],
];

function newSection(title) {
  return {title, patterns: [], licenseFiles: [], licenses: [], packages: [], inventory: null, unresolved: false};
}

function parseSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = newSection(line.slice(3).trim());
      sections.push(current);
      continue;
    }
    const field = current && FIELDS.find(([prefix]) => line.startsWith(prefix));
    if (field) field[1](current, line.slice(field[0].length).trim());
  }
  return sections;
}

function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(path.join(directory, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

// A license text must be a repository file: no `..` escape, no symbolic link leading out.
function insideRoot(target) {
  const within = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!within(root, target)) return false;
  if (!fs.existsSync(target)) return true;
  return within(fs.realpathSync(root), fs.realpathSync(target));
}

function licenseFileProblems(section) {
  const problems = [];
  if (section.licenseFiles.length === 0) problems.push(`section "${section.title}" names no License-File`);
  for (const licenseFile of section.licenseFiles) {
    const target = path.resolve(root, licenseFile);
    if (path.isAbsolute(licenseFile) || !insideRoot(target)) {
      problems.push(`section "${section.title}": license text ${licenseFile} is outside the repository`);
    } else if (!fs.existsSync(target) || (fs.statSync(target).isFile() && fs.statSync(target).size === 0)) {
      problems.push(`section "${section.title}": license text ${licenseFile} is missing or empty`);
    } else if (!fs.statSync(target).isFile()) {
      problems.push(`section "${section.title}": license text ${licenseFile} is not a regular file`);
    }
  }
  return problems;
}

function licenseProblems(section) {
  if (section.unresolved) {
    return [`section "${section.title}": license not established (License-Status: unresolved); such a file is not shipped`];
  }
  if (section.licenses.length !== 1) return [`section "${section.title}" needs exactly one License: line (SPDX expression)`];
  return licenseExpressionProblems(section.licenses[0]).map((problem) => `section "${section.title}": ${problem}`);
}

function readInventory(section) {
  const file = path.resolve(vendorDir, section.inventory);
  if (!file.startsWith(vendorDir + path.sep) || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).packages; } catch { return null; }
}

function packageProblems(section) {
  if (section.packages.length === 0 && !section.inventory) return [];
  if (!section.inventory) return [`section "${section.title}" has Package: lines but no Inventory: line`];
  const inventory = readInventory(section);
  if (!Array.isArray(inventory)) return [`section "${section.title}": inventory ${section.inventory} is missing or unreadable`];
  const problems = inventoryProblems(section.title, section.packages, inventory);
  for (const item of inventory) {
    for (const problem of licenseExpressionProblems(String(item.license))) {
      problems.push(`section "${section.title}": bundled package ${item.name}: ${problem}`);
    }
  }
  return problems;
}

function sectionProblems(section, files) {
  const problems = [];
  if (section.patterns.length === 0) problems.push(`section "${section.title}" has no Files: line`);
  for (const pattern of section.patterns) {
    if (!files.some((file) => globToRegExp(pattern).test(file))) {
      problems.push(`section "${section.title}": pattern "${pattern}" matches no file`);
    }
  }
  return [...problems, ...licenseProblems(section), ...licenseFileProblems(section), ...packageProblems(section)];
}

function check() {
  if (!fs.existsSync(manifest)) return [`${manifest} is missing`];
  const sections = parseSections(fs.readFileSync(manifest, 'utf8'));
  const files = listFiles(vendorDir).filter((file) => file !== MANIFEST_NAME);
  const problems = sections.flatMap((section) => sectionProblems(section, files));
  for (const file of files) {
    const covering = sections.filter((section) => section.patterns.some((pattern) => globToRegExp(pattern).test(file)));
    if (covering.length === 0) problems.push(`${file}: not covered by any section of ${MANIFEST_NAME}`);
  }
  return problems;
}

const problems = check();
for (const problem of problems) console.error(`error: ${problem}`);
if (problems.length === 0) console.log('third-party notices OK');
process.exit(problems.length > 0 ? 1 : 0);

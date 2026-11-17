// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// File helpers of the third-party notices (scripts/bundle-licenses.mjs and its modules).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LICENCE_FILE = /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)/i;

// A bundle path: relative to the bundle's root, with forward slashes.
export const rel = (bundle, file) => path.relative(bundle, file).split(path.sep).join('/');
export const run = (command, args, options = {}) => execFileSync(command, args, {encoding: 'utf8', maxBuffer: 64 << 20, ...options});

export function copyInto(bundle, from, to) {
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
  return rel(bundle, to);
}

// The licence files directly in a directory, by name.
export function licenceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => LICENCE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile()).sort();
}

export function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {recursive: true, withFileTypes: true}).filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

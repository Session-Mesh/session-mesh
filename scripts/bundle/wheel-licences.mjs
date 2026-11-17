// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Python packages of a bundle (scripts/bundle-licenses.mjs): the licence files of each installed
// distribution, kept where they are, and the components a wheel's CycloneDX bills of materials list
// (the Rust crates and the C library statically linked into the cryptography wheel). A bill of
// materials is never a licence text: a component that the wheel's own Apache-2.0 text covers points to
// it, and a Rust crate under other terms gets the texts of its crates.io archive, pinned by SHA-256 in
// scripts/bundle/crates.sha256, in licenses/crates/<crate>/.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {disallowedLicenses} from '../../tools/third-party/licenses.mjs';
import {copyInto, filesUnder, licenceFiles, rel, run} from './licence-files.mjs';
import {labelTree, REVIEWED_EXCEPTIONS} from './licence-policy.mjs';

const PINS = path.join(import.meta.dirname, 'crates.sha256');

function metadataField(text, field) {
  return new RegExp(`^${field}: (.*)$`, 'm').exec(text)?.[1]?.trim();
}

// Whether the Apache-2.0 licence alone is enough for this label (it is one of the choices, or the only one).
function apacheSuffices(label) {
  try { return disallowedLicenses(labelTree(label), {'Apache-2.0': ''}).length === 0; } catch { return false; }
}

export async function downloadCrate(name, version) {
  const response = await fetch(`https://static.crates.io/crates/${name}/${name}-${version}.crate`);
  if (!response.ok || !response.url.startsWith('https://')) throw new Error(`bundle: cannot download the crate ${name} ${version}`);
  return Buffer.from(await response.arrayBuffer());
}

// The licence texts of a crates.io crate, from its archive checked against the pinned SHA-256.
async function crateTexts(bundle, crate, context) {
  const file = `${crate.name}-${crate.version}.crate`;
  const expected = context.pins.get(file);
  if (!expected) throw new Error(`bundle: no pinned SHA-256 for ${file} in scripts/bundle/crates.sha256 (its licence text is needed)`);
  const bytes = await context.fetchCrate(crate.name, crate.version);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`bundle: ${file} does not match its pinned SHA-256`);
  fs.writeFileSync(path.join(context.scratch, file), bytes);
  run('tar', ['-xzf', path.join(context.scratch, file), '-C', context.scratch]);
  const dir = path.join(context.scratch, `${crate.name}-${crate.version}`);
  return licenceFiles(dir).map((name) => copyInto(bundle, path.join(dir, name), path.join(bundle, 'licenses/crates', crate.name, name)));
}

async function bomRecord(bundle, item, wheel, context) {
  const cargo = item.purl?.startsWith('pkg:cargo/');
  const component = cargo ? `Rust crate ${item.name} (in the ${wheel} wheel)` : `${item.name} (C library in the ${wheel} wheel)`;
  const licence = (item.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean).join(', ') || 'not stated';
  const record = {component, version: item.version ?? 'unknown', licence, files: [],
    note: `listed in the ${wheel} wheel's CycloneDX bill of materials (built into the wheel, or used to build it)`};
  if (apacheSuffices(REVIEWED_EXCEPTIONS[component]?.licence ?? licence)) {
    record.files = context.apacheText ? [context.apacheText] : [];
    record.note += '; under Apache-2.0, whose text the wheel ships';
  } else if (cargo) {
    record.files = await crateTexts(bundle, item, context);
    record.note += '; licence text from its crates.io archive';
  }
  return record;
}

// The components of a wheel's bills of materials, but the ones it marks as build tools (scope excluded).
async function bomComponents(bundle, distInfo, name, context) {
  const records = [];
  for (const file of filesUnder(path.join(distInfo, 'sboms')).filter((entry) => entry.endsWith('.json'))) {
    const bom = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of bom.components ?? []) {
      if (item.name !== name && item.scope !== 'excluded') records.push(await bomRecord(bundle, item, name, context));
    }
  }
  return records;
}

function readPins() {
  return new Map(fs.readFileSync(PINS, 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()));
}

async function distribution(bundle, distInfo, context) {
  const text = fs.readFileSync(path.join(distInfo, 'METADATA'), 'utf8');
  const name = metadataField(text, 'Name');
  const files = [...filesUnder(path.join(distInfo, 'licenses')), ...licenceFiles(distInfo).map((file) => path.join(distInfo, file))];
  if (!files.length) throw new Error(`bundle: the Python distribution ${path.basename(distInfo)} ships no licence file`);
  const apache = files.find((file) => /Apache License\s+Version 2\.0/.test(fs.readFileSync(file, 'utf8')));
  const record = {component: `Python package ${name}`, version: metadataField(text, 'Version'),
    licence: metadataField(text, 'License-Expression') ?? metadataField(text, 'License') ?? 'see the text',
    files: files.map((file) => rel(bundle, file)), note: 'runtime/python, installed from its wheel'};
  return [record, ...await bomComponents(bundle, distInfo, name, {...context, apacheText: apache && rel(bundle, apache)})];
}

// fetchCrate(name, version) gives a crate archive's bytes; pins maps "<name>-<version>.crate" to its SHA-256.
export async function wheelComponents(bundle, {fetchCrate = downloadCrate, pins = readPins()} = {}) {
  const libDir = path.join(bundle, 'runtime/python/lib');
  const sitePackages = fs.readdirSync(libDir).filter((name) => /^python3\.\d+$/.test(name))
    .map((name) => path.join(libDir, name, 'site-packages')).filter((dir) => fs.existsSync(dir));
  const context = {pins, fetchCrate, scratch: fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-crates-'))};
  try {
    const records = [];
    for (const dir of sitePackages) {
      for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith('.dist-info')).sort()) {
        records.push(...await distribution(bundle, path.join(dir, entry), context));
      }
    }
    return records;
  } finally { fs.rmSync(context.scratch, {recursive: true, force: true}); }
}

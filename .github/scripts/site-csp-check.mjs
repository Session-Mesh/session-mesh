// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Content Security Policy gate of .github/scripts/site-stage.sh and of the publish job of
// .github/workflows/site-preview.yml:
//   node site-csp-check.mjs <reference index.html> <staged-directory> <reference site/ directory>
// A strict positional whitelist; no HTML or SVG is parsed or scanned, so no parser quirk, encoding or
// naming trick can be used against it.
//   - The reference (the home page and the site/ directory it belongs to) is always the one of the
//     checkout of main in a preview, never the pull request's own copy, so a pull request cannot
//     weaken the policy that it is checked against. (site.yml, which runs after a merge, passes its
//     own site/.)
//   - Every .html page of the staged site must START, byte for byte, with the prefix of the reference
//     home page up to and including its Content-Security-Policy meta tag (doctype, <html>, <head>,
//     charset meta, policy meta). The policy is therefore the first thing a browser parses, and
//     governs everything after the prefix, which may be anything. The prefix itself must be plain
//     ASCII with no control character other than tab, CR and LF.
//   - An SVG, XML or XHTML file can be opened by a browser as a document with no policy, and its
//     content cannot be vetted reliably, so it is accepted only if it is byte-identical to the file at
//     the same path of the reference site/. A new or changed one is refused.
//   - No symbolic link (file or directory), no other file type than ALLOWED, no NUL byte in a page.
//   - Size caps, all decided from lstat before any file is read: at most MAX_FILES entries, no file above
//     MAX_FILE_BYTES, no more than MAX_TOTAL_BYTES in all. GitHub Pages allows 1 GB per site and 100 MB per
//     file; the caps are far below, so an oversized tree is refused here, never read into memory.
// It is conservative on purpose: a false refusal is acceptable, a bypass is not.
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['html', 'css', 'js', 'json', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'woff2', 'webmanifest']);
// File types a browser can run as a document with no policy: accepted only unchanged from the reference.
const UNCHANGED_ONLY = new Set(['svg', 'xml', 'xhtml']);
// GitHub Pages limits: 1 GB per site, 100 MB per file. These are deliberately conservative.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 5000;
const POLICY_TAG = '<meta http-equiv="Content-Security-Policy"';

// The bytes of the home page up to the end of its policy meta tag.
function policyPrefix(home) {
  const text = home.toString('latin1');
  const start = text.indexOf(POLICY_TAG);
  if (start < 0 || text.indexOf(POLICY_TAG, start + 1) >= 0) return null;
  const end = text.indexOf('>', start);
  if (end < 0) return null;
  const prefix = text.slice(0, end + 1);
  if (/<script/i.test(prefix) || /[^\t\r\n\x20-\x7e]/.test(prefix)) return null;
  return Buffer.from(prefix, 'latin1');
}

// Every entry under dir, as [absolute path, lstat], not following links. Stops with a refusal as soon
// as there are more than MAX_FILES entries, so a huge tree is not even listed in full.
function* entries(dir, counter = {n: 0}) {
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const info = fs.lstatSync(full);
    if (++counter.n > MAX_FILES) {
      console.error(`site-stage: more than ${MAX_FILES} files and directories: a site that large cannot be previewed`);
      process.exit(1);
    }
    yield [full, info];
    if (info.isDirectory()) yield* entries(full, counter);
  }
}

function pageProblem(content, prefix) {
  if (content.includes(0)) return 'holds a NUL byte';
  if (content.length < prefix.length || !content.subarray(0, prefix.length).equals(prefix)) {
    return 'does not start with the head of site/index.html up to its Content-Security-Policy meta tag';
  }
  return null;
}

function unchangedProblem(full, size, referenceFile) {
  let info;
  try {
    info = fs.lstatSync(referenceFile);
  } catch {
    return 'is not in main: a new SVG, XML or XHTML file cannot be previewed';
  }
  if (!info.isFile() || info.size !== size || !fs.readFileSync(full).equals(fs.readFileSync(referenceFile))) {
    return 'differs from the file of main: a changed SVG, XML or XHTML file cannot be previewed';
  }
  return null;
}

function fileProblem(full, info, target, prefix, referenceSite) {
  if (info.isSymbolicLink()) return 'is a symbolic link';
  if (info.isDirectory()) return null;
  if (!info.isFile()) return 'is not a regular file';
  const ext = path.extname(full).slice(1).toLowerCase();
  if (info.size > MAX_FILE_BYTES) return `is ${info.size} bytes, above the limit of ${MAX_FILE_BYTES} bytes per file`;
  if (UNCHANGED_ONLY.has(ext)) return unchangedProblem(full, info.size, path.join(referenceSite, path.relative(target, full)));
  if (!ALLOWED.has(ext)) return `has a file type that is not allowed (${ext ? `.${ext}` : 'no extension'})`;
  return ext === 'html' ? pageProblem(fs.readFileSync(full), prefix) : null;
}

const [homePage, target, referenceSite] = process.argv.slice(2);
if (!homePage || !target || !referenceSite) {
  console.error('usage: site-csp-check.mjs <reference index.html> <staged-directory> <reference site/ directory>');
  process.exit(2);
}
const prefix = policyPrefix(fs.readFileSync(homePage));
if (prefix === null) {
  console.error('site-stage: site/index.html has no single Content-Security-Policy meta tag of the expected form');
  process.exit(1);
}
// First pass, lstat only: the count and total caps are decided before any content is read.
const listing = [...entries(target)];
const totalBytes = listing.reduce((sum, [, info]) => sum + (info.isFile() ? info.size : 0), 0);
if (totalBytes > MAX_TOTAL_BYTES) {
  console.error(`site-stage: the site is ${totalBytes} bytes, above the limit of ${MAX_TOTAL_BYTES} bytes in all`);
  process.exit(1);
}
let failed = false;
for (const [full, info] of listing) {
  const problem = fileProblem(full, info, target, prefix, referenceSite);
  if (problem) {
    console.error(`site-stage: ${path.relative(target, full)} ${problem}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);

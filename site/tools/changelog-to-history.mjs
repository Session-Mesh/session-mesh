#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regenerates the History tab of site/index.html: one item per release, whose
// page lists that release's highlights.
//
//   node site/tools/changelog-to-history.mjs           rewrite site/index.html in place
//   node site/tools/changelog-to-history.mjs --check   exit 1 if index.html is out of date
//
// The releases and their highlights are curated in site/releases.json, not
// copied from CHANGELOG.md. Every run checks them against the repository:
// each release names a "## " heading of CHANGELOG.md, and each highlight names
// its sources, a bullet lead of that CHANGELOG section ({ file, lead }) or a
// heading of a Markdown file ({ file, heading }). A source that no longer
// exists stops the script.
//
// A highlight with "requires": "ID" or "unless": "ID" is gated on feature ID
// of the status table, like any data-requires or data-unless element.
//
// It rewrites only what lies between these marker comments in index.html:
//   history-sidebar   the items of the History tab
//   history-toc       the list of releases in the pane on the right
//   history-entries   one <article class="hentry"> per release
// and the count in the History tab button. No dependencies; Node 18 or later.
"use strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SITE, "..");
const INDEX = join(SITE, "index.html");
const RELEASES = join(SITE, "releases.json");
const CHANGELOG_URL = "https://github.com/Session-Mesh/session-mesh/blob/main/CHANGELOG.md";

const context = {};
vm.runInNewContext(readFileSync(join(SITE, "status-core.js"), "utf8"), Object.assign(context, { globalThis: context }));
const { statusCore } = context;

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Highlights are plain text with `code` spans and nothing else.
const inlineHtml = (text) => text.split(/(`[^`]+`)/)
  .map((part) => (part.startsWith("`") ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : escapeHtml(part)))
  .join("");
const label = (release) => `${release.version} — ${release.title}`;

// ---------------------------------------------------------------- source checks

// The bullets of one "## " section of CHANGELOG.md.
function changelogSection(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function sourceProblem(source, section) {
  const file = join(ROOT, source.file);
  if (!existsSync(file)) return `file ${source.file} does not exist`;
  if (source.lead) {
    if (source.file !== "CHANGELOG.md") return `"lead" is only for CHANGELOG.md, not ${source.file}`;
    return section.split("\n").some((line) => line.startsWith(`- **${source.lead}**`))
      ? null : `CHANGELOG.md has no entry "**${source.lead}**" in this release`;
  }
  if (source.heading) {
    const headings = readFileSync(file, "utf8").split("\n").map((line) => line.replace(/^#+\s+/, "").trim());
    return headings.includes(source.heading) ? null : `${source.file} has no heading "${source.heading}"`;
  }
  return `a source needs "lead" or "heading": ${JSON.stringify(source)}`;
}

function checkSources(releases) {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const problems = [];
  for (const release of releases) {
    const section = changelogSection(changelog, release.changelog_heading);
    if (section === null) { problems.push(`${release.version}: CHANGELOG.md has no heading "## ${release.changelog_heading}"`); continue; }
    for (const highlight of release.highlights) {
      if (!highlight.sources || !highlight.sources.length) problems.push(`${release.version}: highlight without sources: "${highlight.text}"`);
      for (const source of highlight.sources || []) {
        const problem = sourceProblem(source, section);
        if (problem) problems.push(`${release.version}: ${problem}`);
      }
    }
  }
  if (problems.length) throw new Error(`releases.json does not match the repository:\n  ${problems.join("\n  ")}`);
}

// ---------------------------------------------------------------- rendering

function readFeatures(html) {
  return [...html.matchAll(/<li data-feature="([^"]+)" data-status="([^"]+)"/g)].map(([, id, status]) => ({ id, status }));
}

function gateAttribute(highlight, features) {
  const kind = highlight.requires ? "requires" : highlight.unless ? "unless" : null;
  if (!kind) return "";
  const id = highlight[kind];
  return ` data-${kind}="${id}"${statusCore.gateHidden(features, kind, id) ? " hidden" : ""}`;
}

function renderSidebar(releases) {
  const items = releases.map((release) => `        <li><a class="item hitem" href="#history/${release.version}" data-hist="${release.version}">
          <span class="top"><span class="dot hist" aria-hidden="true"></span><span class="name">${escapeHtml(label(release))}</span></span>
          <span class="last">${escapeHtml(release.summary)}</span></a></li>\n`).join("");
  return `      <p class="group"><span>Releases</span><span class="count">${releases.length}</span></p>
      <ul class="items">
${items}      </ul>
      <p class="more-gh-row"><a class="more-gh gh-changelog" href="${CHANGELOG_URL}">Full changelog on GitHub</a></p>\n`;
}

function renderToc(releases) {
  return releases.map((release) => `          <li><a href="#history/${release.version}">${escapeHtml(label(release))}</a></li>\n`).join("");
}

function renderArticle(release, features) {
  const highlights = release.highlights
    .map((highlight) => `          <li${gateAttribute(highlight, features)}>${inlineHtml(highlight.text)}</li>`).join("\n");
  return `    <article class="hentry" id="history/${release.version}" data-slug="${release.version}" aria-labelledby="ht-${release.version}">
      <p class="hmeta"><span class="tag">release</span></p>
      <h3 class="htitle" id="ht-${release.version}">${escapeHtml(label(release))}</h3>
      <div class="hbody">
        <p>${inlineHtml(release.summary)}</p>
        <ul class="highlights">
${highlights}
        </ul>
        <p><a class="gh-changelog" href="${CHANGELOG_URL}">Full changelog on GitHub</a></p>
      </div>
      <p class="hnav js-only"><a class="hnav-prev" href="#history"><span aria-hidden="true">←</span> All releases</a></p>
    </article>\n`;
}

function replaceBetween(html, name, content) {
  const pattern = new RegExp(`(<!-- ${name}:begin -->\\n)[\\s\\S]*?(\\s*<!-- ${name}:end -->)`);
  if (!pattern.test(html)) throw new Error(`index.html has no <!-- ${name}:begin/end --> markers`);
  return html.replace(pattern, (_, begin, end) => begin + content.replace(/\n$/, "") + end);
}

function main() {
  const { releases } = JSON.parse(readFileSync(RELEASES, "utf8"));
  checkSources(releases);
  const before = readFileSync(INDEX, "utf8");
  const features = readFeatures(before);
  let html = replaceBetween(before, "history-sidebar", renderSidebar(releases));
  html = replaceBetween(html, "history-toc", renderToc(releases));
  html = replaceBetween(html, "history-entries", releases.map((release) => renderArticle(release, features)).join(""));
  html = html.replace(/(id="tab-hist"[^>]*>History <span class="n">)\d+(<\/span>)/, `$1${releases.length}$2`);
  const count = releases.reduce((sum, release) => sum + release.highlights.length, 0);
  if (process.argv.includes("--check")) {
    if (html !== before) { console.error("site/index.html is out of date: run node site/tools/changelog-to-history.mjs"); process.exit(1); }
    console.log(`History is up to date: ${releases.length} release(s), ${count} highlights, every source found.`);
    return;
  }
  writeFileSync(INDEX, html);
  console.log(`History regenerated: ${releases.length} release(s), ${count} highlights, every source found.`);
}

main();

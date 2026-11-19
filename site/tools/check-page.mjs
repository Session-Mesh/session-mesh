#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Static checks of site/index.html. No dependencies; Node 18 or later.
//
//   node site/tools/check-page.mjs               run every check
//   node site/tools/check-page.mjs --keep DIR    also keep the launch preview in DIR
//
// 1. Links: every "#id" link names an element of the page (or a History
//    route), and every relative file the page links to exists.
// 2. Quotations: the text of each <blockquote class="quote" data-source="FILE">
//    appears in FILE (a path from the repository root), cut by "[…]", once
//    Markdown emphasis, code marks and links are removed.
// 3. Gates: elements with data-requires="ID" are hidden exactly while the
//    status table does not show ID as available, and data-unless the reverse.
// 4. Launch preview: in a scratch copy where every gated feature that is
//    "in progress" is set to available (what the launch releases) and
//    tools/sync-status.mjs has run, the gated elements of those features
//    show, their links resolve and the session counts include them.
// 5. Every gate open: the same with every gated feature set to available,
//    "planned" ones included, so the text that replaces a planned feature's
//    caveat (data-requires="binaries", for example) is checked before it ships.
// 6. Policy: the Content-Security-Policy <meta> tag closes the two directives
//    that default-src does not cover, base-uri 'none' and form-action 'none', and
//    the page and its scripts use neither <base> nor <form>.
"use strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SITE, "..");
const failures = [];
const fail = (message) => failures.push(message);

const decode = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const plainHtml = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const plainMarkdown = (md) => md.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ");
// Typographic spacing differs between HTML and Markdown around code and punctuation.
const squeeze = (text) => text.replace(/\s+/g, "").toLowerCase();

function ids(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function checkLinks(html, label) {
  const known = ids(html);
  for (const [, target] of html.matchAll(/href="#([^"]*)"/g)) {
    if (target === "history" || known.has(target)) continue;
    fail(`${label}: link "#${target}" names no element`);
  }
  for (const [, path] of html.matchAll(/(?:href|src)="(?!https?:|#|data:|mailto:)([^"]+)"/g)) {
    if (!existsSync(join(SITE, path))) fail(`${label}: file "${path}" does not exist`);
  }
}

function checkQuotes(html) {
  let count = 0;
  for (const [, source, body] of html.matchAll(/<blockquote class="quote" data-source="([^"]+)">([\s\S]*?)<\/blockquote>/g)) {
    const file = join(ROOT, source);
    if (!existsSync(file)) { fail(`quotation: source "${source}" does not exist`); continue; }
    const text = squeeze(plainMarkdown(readFileSync(file, "utf8")));
    for (const part of plainHtml(body).split("[…]").map((p) => p.trim()).filter(Boolean)) {
      count += 1;
      if (!text.includes(squeeze(part))) fail(`quotation from ${source} does not match: "${part.slice(0, 70)}…"`);
    }
  }
  return count;
}

function statuses(html) {
  return Object.fromEntries([...html.matchAll(/<li data-feature="([^"]+)" data-status="([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

function gates(html) {
  return [...html.matchAll(/<(\w+)[^>]* data-(requires|unless)="([^"]+)"( hidden)?[^>]*>/g)]
    .map(([tag, , kind, id, hidden]) => ({ tag: tag.slice(0, 80), kind, id, hidden: Boolean(hidden) }));
}

function checkGates(html, label) {
  const status = statuses(html);
  const found = gates(html);
  for (const gate of found) {
    const on = status[gate.id] === "available";
    const shouldHide = gate.kind === "requires" ? !on : on;
    if (gate.hidden !== shouldHide) fail(`${label}: ${gate.tag} should ${shouldHide ? "" : "not "}be hidden`);
  }
  return found;
}

// A scratch copy of the site where the gated features whose status `flip`
// accepts are set to available, then checked as the page itself is.
function preview(name, flip, keep) {
  const dir = keep || mkdtempSync(join(tmpdir(), "site-preview-"));
  cpSync(SITE, dir, { recursive: true });
  const index = join(dir, "index.html");
  const before = readFileSync(index, "utf8");
  const gatedIds = new Set(gates(before).map((g) => g.id));
  const flippedIds = [];
  const flipped = before.replace(/(<li data-feature="([^"]+)" data-status=")([^"]+)"/g, (all, open, id, status) => {
    if (!gatedIds.has(id) || !flip(status)) return all;
    flippedIds.push(id);
    return `${open}available"`;
  });
  writeFileSync(index, flipped);
  execFileSync(process.execPath, [join(SITE, "tools", "sync-status.mjs"), "--site", dir], { stdio: "ignore" });
  const html = readFileSync(index, "utf8");
  const shown = checkGates(html, name).filter((g) => g.kind === "requires" && flippedIds.includes(g.id));
  if (shown.some((g) => g.hidden)) fail(`${name}: a data-requires element is still hidden`);
  checkLinks(html, name);
  const list = html.match(/<nav id="list"[\s\S]*?<\/nav>/)[0];
  const items = [...list.matchAll(/<li( [^>]*)?><a class="item[^"]*" href="#[^"]+" data-session=/g)].filter((m) => !/ hidden/.test(m[1] || "")).length;
  const counted = html.match(/data-session-count>(\d+)/);
  if (!counted || Number(counted[1]) !== items) fail(`${name}: session count ${counted && counted[1]} is not ${items}`);
  return { dir, features: flippedIds, shown: shown.length };
}

// The directives of the page's Content-Security-Policy tag, and what would break under them.
function checkPolicy(html) {
  const tag = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/i);
  if (!tag) { fail("policy: no Content-Security-Policy <meta> tag"); return; }
  const directives = tag[1].split(";").map((part) => part.trim().replace(/\s+/g, " "));
  for (const required of ["base-uri 'none'", "form-action 'none'"]) {
    if (!directives.includes(required)) fail(`policy: the Content-Security-Policy lacks ${required}`);
  }
  if (/<(?:base|form)[\s>/]/i.test(html)) fail("policy: the page uses <base> or <form>, which base-uri and form-action 'none' forbid");
  for (const name of readdirSync(SITE).filter((file) => file.endsWith(".js"))) {
    if (/createElement\(\s*["'](?:base|form)["']\s*\)/.test(readFileSync(join(SITE, name), "utf8"))) fail(`policy: ${name} creates a <base> or <form>`);
  }
}

const keepAt = process.argv.indexOf("--keep");
const html = readFileSync(join(SITE, "index.html"), "utf8");
checkPolicy(html);
checkLinks(html, "page");
const quotes = checkQuotes(html);
const current = checkGates(html, "page");
const launch = preview("launch preview", (status) => status === "in progress", keepAt > 0 ? process.argv[keepAt + 1] : null);
const allOpen = preview("every gate open", () => true, null);
if (failures.length) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  process.exit(1);
}
console.log("Policy closes base-uri and form-action; the page uses no <base> or <form>.");
console.log(`Links resolve. ${quotes} quoted passages match their sources. ${current.length} gated elements follow the status table.`);
console.log(`Launch preview (${launch.features.join(", ")} set to available): ${launch.shown} gated elements shown, links resolve${keepAt > 0 ? `, kept in ${launch.dir}` : ""}.`);
console.log(`Every gate open (${allOpen.features.join(", ")} set to available): ${allOpen.shown} gated elements shown, links resolve.`);

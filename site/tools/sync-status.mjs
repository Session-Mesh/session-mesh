#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Writes the feature statuses of the status table into the static HTML, so a
// reader without JavaScript sees the same chips and sentences as site.js shows.
//
//   node site/tools/sync-status.mjs           rewrite site/index.html in place
//   node site/tools/sync-status.mjs --check   exit 1 if index.html is out of date
//
// The table is <ul id="status-table"> in index.html: one <li data-feature
// data-status data-label> per feature. The texts come from status-core.js, the
// file the page itself uses. No dependencies.
"use strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// --site DIR works on another copy of the site (tools/check-page.mjs uses it).
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > 0 ? process.argv[siteArg + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(SITE, "index.html");

const context = {};
vm.runInNewContext(readFileSync(join(SITE, "status-core.js"), "utf8"), Object.assign(context, { globalThis: context }));
const { statusCore } = context;

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeHtml = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const chip = (status, extra = "") => `<span class="chip-s ${statusCore.CHIP_CLASS[status]}"${extra}>${status}</span>`;

function readFeatures(html) {
  const table = html.match(/<ul class="status-list" id="status-table">([\s\S]*?)<\/ul>/);
  if (!table) throw new Error('index.html has no <ul id="status-table">');
  const features = [...table[1].matchAll(/<li data-feature="([^"]+)" data-status="([^"]+)" data-label="([^"]+)">/g)]
    .map(([, id, status, label]) => ({ id, status, label: unescapeHtml(label) }));
  const unknown = features.filter((f) => !statusCore.STATUSES.includes(f.status));
  if (unknown.length) throw new Error(`unknown status: ${unknown.map((f) => `${f.id}="${f.status}"`).join(", ")}`);
  return features;
}

// Sessions in the sidebar list that are not hidden by a data-requires gate.
function sessionCount(html) {
  const list = html.match(/<nav id="list"[\s\S]*?<\/nav>/)[0];
  return [...list.matchAll(/<li( data-requires="[^"]+")?( hidden)?><a class="item[^"]*" href="#[^"]+" data-session=/g)].filter((m) => !m[2]).length;
}

function sync(html) {
  const features = readFeatures(html);
  const byId = Object.fromEntries(features.map((f) => [f.id, f]));
  const gated = html.replace(/ data-(requires|unless)="([^"]+)"( hidden)?/g,
    (_, kind, id) => ` data-${kind}="${id}"${statusCore.gateHidden(features, kind, id) ? " hidden" : ""}`);
  const count = sessionCount(gated);
  return gated
    .replace(/(data-session-count>)\d+/g, (_, open) => open + count)
    .replace(/(<li data-feature="([^"]+)" data-status="[^"]+" data-label="[^"]+">)<span class="chip-s[^"]*">[^<]*<\/span>/g,
      (_, open, id) => open + chip(byId[id].status))
    .replace(/<span class="chip-s[^"]*" data-status-of="([^"]+)">[^<]*<\/span>/g, (all, id) => {
      if (!byId[id]) throw new Error(`data-status-of="${id}" names no feature of the status table`);
      return chip(byId[id].status, ` data-status-of="${id}"`);
    })
    .replace(/(data-status-summary="([^"]+)">)[^<]*/g, (_, open, ids) => open + escapeHtml(statusCore.summary(features, ids.split(/\s+/))))
    .replace(/(<span data-status-pending>)[^<]*/g, (_, open) => open + escapeHtml(statusCore.pendingSentence(features)));
}

const before = readFileSync(INDEX, "utf8");
const after = sync(before);
if (process.argv.includes("--check")) {
  if (after !== before) { console.error("site/index.html is out of date: run node site/tools/sync-status.mjs"); process.exit(1); }
  console.log("Static statuses match the status table.");
} else {
  writeFileSync(INDEX, after);
  console.log("Static statuses written from the status table.");
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Regenerate the offline configuration labels after changing the English catalog.
import {readFileSync, writeFileSync} from 'node:fs';

const catalog = JSON.parse(readFileSync('static/i18n/en.json', 'utf8')) as Record<string, string>;
const labels = Object.fromEntries(Object.entries(catalog).filter(([key]) =>
  key.startsWith('common.') || key.startsWith('config.')));
const output = `// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (c) 2026 Atacama <contact@atacama.tech>\n// Generated from static/i18n/en.json by tools/generate-config-fallback.ts.\nwindow.MeshConfigFallback = ${JSON.stringify(labels, null, 2)};\ndocument.getElementById('config-translation-unavailable').textContent = window.MeshConfigFallback['config.translationUnavailable'];\n`;
const target = 'static/config-fallback.js';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error(`${target} is stale; regenerate it`);
} else writeFileSync(target, output);

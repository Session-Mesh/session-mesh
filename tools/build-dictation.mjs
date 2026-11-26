// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const output = 'backend/dictation-service.cjs';
const outfile = resolve(root, output);
const result = await build({absWorkingDir: root, entryPoints: ['backend/dictation-main.ts'],
  outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  legalComments: 'none', banner: {js: '// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (c) 2026 Atacama <contact@atacama.tech>'}, write: !check});
if (check && !Buffer.from(result.outputFiles[0].contents).equals(await readFile(outfile))) {
  throw Error(`${output} is stale; run npm run build:dictation`);
}

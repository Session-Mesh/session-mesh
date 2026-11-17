// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { build } from 'esbuild';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const entries = ['project-catalog'];
// Data-only worktrees can build the shared parser before UI integration.
try { await access(join(root, 'static/projects.ts')); entries.push('projects'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function buildEntry(input, relativeOutput, platform) {
  const output = join(root, relativeOutput);
  const result = await build({ absWorkingDir: root, entryPoints: [input], platform,
    bundle: true, format: 'esm', legalComments: 'none', minify: true, outfile: output,
    sourcemap: false, target: ['es2022'], write: !check });
  if (check) {
    const emitted = result.outputFiles.find(file => file.path === output);
    if (!emitted || !Buffer.from(emitted.contents).equals(await readFile(output))) {
      throw new Error(`${relativeOutput} is stale; run npm run build:projects`);
    }
  }
}
for (const entry of entries) {
  await buildEntry(`static/${entry}.ts`, `static/${entry}.js`, 'browser');
}
await buildEntry('tools/project-observation.ts', 'tools/project-observation.mjs', 'node');

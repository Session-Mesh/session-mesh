// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// mesh-board-mcp embeds ocaml/lib/agent-guide.md at build time (ocaml/lib/dune). That file is an
// ordinary copy of docs/agent-guide.md, kept inside the dune project so ocaml/ builds on its own
// (a symbolic link out of it breaks a copied or pinned package). The two must stay identical, byte
// for byte; ocaml/test/agent_guide_test.ml checks that the served text is the embedded file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(REPO, 'docs', 'agent-guide.md');
const EMBEDDED = path.join(REPO, 'ocaml', 'lib', 'agent-guide.md');

test('the embedded agent guide is an ordinary file', () => {
  assert.ok(fs.lstatSync(EMBEDDED).isFile(), `${EMBEDDED} must be a regular file, not a link`);
});

test('the embedded agent guide is docs/agent-guide.md, byte for byte', () => {
  const guide = fs.readFileSync(GUIDE);
  const embedded = fs.readFileSync(EMBEDDED);
  assert.ok(
    guide.equals(embedded),
    `${EMBEDDED} differs from ${GUIDE}: copy docs/agent-guide.md over it`,
  );
});

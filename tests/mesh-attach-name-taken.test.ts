// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// bin/mesh-attach retries under the next free name when ptyhost answers that a name is taken
// (several terminals opening at once race for the same name). The reply it recognises must be the
// one the native host sends for a duplicate name; the two drifted apart when ptyhost's messages moved to
// English. A static check: running mesh-attach needs a live ptyhost and a terminal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('mesh-attach recognises the reply the native host sends for a name already taken', () => {
  const host = fs.readFileSync(path.join(ROOT, 'ocaml', 'lib', 'mesh_ptyhost.ml'), 'utf8');
  const reply = /\("error", `String "(Name already taken)"\)/.exec(host)?.[1];
  assert.ok(reply, 'duplicate-name reply not found in ocaml/lib/mesh_ptyhost.ml');
  const attach = fs.readFileSync(path.join(ROOT, 'bin', 'mesh-attach'), 'utf8');
  const recognised = /^NAME_TAKEN = "([^"]+)"$/m.exec(attach)?.[1];
  assert.equal(recognised, reply);
  assert.match(attach, /if NAME_TAKEN not in str\(reply\.get\("error", ""\)\):/);
});

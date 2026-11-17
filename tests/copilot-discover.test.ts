// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How the mesh recognises a Copilot CLI process and the conversation it names, from its arguments alone.
// The state and the conversation it is in now come from the plugin hooks (copilot-presets.test.ts).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const UUID = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';

function python(code: string): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME}, encoding: 'utf8'});
  return JSON.parse(output);
}

describe('Copilot CLI discovery', () => {
  test('the native binary is the agent; the node launcher and a look-alike are not', () => {
    assert.deepEqual(python(`
import json, discover
native = "/usr/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot"
print(json.dumps([discover._agent_of_argv([native.encode(), b"--no-auto-update"]),
                  discover._agent_of_argv([b"node", b"/usr/bin/copilot"]),
                  discover._agent_of_argv([b"/usr/bin/copilot-helper"])]))
`), ['copilot', null, null]);
  });

  test('the conversation named by --resume or --session-id is read only when it is a UUID', () => {
    assert.deepEqual(python(`
import json, discover
read = lambda *words: discover._argv_copilot_session([w.encode() for w in words])
print(json.dumps([read("copilot", "--resume=${UUID}"), read("copilot", "--resume", "${UUID}"),
                  read("copilot", "--session-id=${UUID}"), read("copilot", "--resume=my-feature"),
                  read("copilot", "--resume"), read("copilot", "--name=${UUID}")]))
`), [UUID, UUID, UUID, null, null, null]);
  });
});

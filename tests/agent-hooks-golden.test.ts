// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The hook configurations Mesh generates are byte for byte those of the release before the agent hook
// model (tests/fixtures/agent-hooks-model/generated-before.json, captured from the generators of that
// revision), except for the project context hook, which is added only where the table wires it, only
// when work-read is installed and only while MESH_PROJECT_HOOKS is not 0.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';

import {claudeSettings, generated, removeTemporary, REPO, stubBin, type Generated} from './agent-hooks-generated-lib.ts';

after(removeTemporary);

const BEFORE = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/agent-hooks-model/generated-before.json'), 'utf8')) as Generated;
const PROJECT = '{"hooks":[{"type":"command","command":"@BIN@/work-read context --format claude","timeout":5}]}';
const VIBE_PROJECT = '[[hooks]]\nname = "session-mesh-project-context"\ntype = "session_start"\n'
  + 'command = "@BIN@/work-read context --format vibe"\ntimeout = 5\n';

function withSessionStart(settings: string, existing: string | null): string {
  const parsed = JSON.parse(settings) as {hooks: Record<string, unknown[]>};
  const hook = JSON.parse(PROJECT);
  parsed.hooks.SessionStart = existing === null ? [hook] : [...(parsed.hooks.SessionStart ?? []), hook];
  return JSON.stringify(parsed);
}

describe('generated hook configurations', () => {
  test('without work-read installed, every agent gets exactly the configuration it got before', () => {
    const {bin} = stubBin(['mesh-event']);
    assert.deepEqual(generated(bin), BEFORE);
  });

  test('with the switch off, every agent gets exactly the configuration it got before', () => {
    const {bin} = stubBin(['mesh-event', 'work-read']);
    for (const value of ['0', 'off', 'false', 'no', ' OFF ']) {
      assert.deepEqual(generated(bin, {MESH_PROJECT_HOOKS: value}), BEFORE, value);
    }
  });

  test('by default, Claude and Vibe get the session-start project hook and nothing else changes', () => {
    const {bin} = stubBin(['mesh-event', 'work-read']);
    const now = generated(bin);
    assert.equal(now.claude_inline, withSessionStart(BEFORE.claude_inline, null));
    assert.equal(now.claude_merge, withSessionStart(BEFORE.claude_merge, 'user'));
    assert.equal(now.vibe, `${BEFORE.vibe}\n${VIBE_PROJECT}`);
    const unchanged = {claude_inline: '', claude_merge: '', vibe: ''};
    assert.deepEqual({...now, ...unchanged}, {...BEFORE, ...unchanged});
  });

  test('a restored command carries one project hook under the switch in force, never a stale one', () => {
    const {bin} = stubBin(['mesh-event', 'work-read']);
    const first = claudeSettings(bin, []).replaceAll('@BIN@', bin);
    const again = claudeSettings(bin, ['--settings', first]);
    assert.equal(again, withSessionStart(BEFORE.claude_inline, null), 'no duplicate on resume');
    const other = first.replaceAll(bin, '/old/install/bin');
    assert.equal(claudeSettings(bin, ['--settings', other]), withSessionStart(BEFORE.claude_inline, null),
      'another installation\'s project hook is replaced');
    assert.equal(claudeSettings(bin, ['--settings', first], {MESH_PROJECT_HOOKS: '0'}), BEFORE.claude_inline,
      'switched off on resume');
  });

  test('a user hook that merely runs a work-read is kept', () => {
    const {bin} = stubBin(['mesh-event']);
    const user = JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: '/home/u/bin/work-read context --format text'}]}]}});
    const kept = JSON.parse(claudeSettings(bin, ['--settings', user])) as {hooks: {SessionStart: unknown[]}};
    assert.equal(kept.hooks.SessionStart.length, 1);
  });
});

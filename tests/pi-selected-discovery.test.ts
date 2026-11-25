// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

test('Pi discovery reads only the selected history and refuses invalid roots', () => {
  const script = String.raw`
import json, os, pathlib, tempfile, time
import discover, server
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    ambient = root / 'ambient' / 'sessions' / 'project'
    selected_root = root / 'selected[work]'
    selected = selected_root
    ambient.mkdir(parents=True); selected.mkdir(parents=True)
    here = str(root / 'work')
    def transcript(folder, ident):
        (folder / (ident + '.jsonl')).write_text(json.dumps({'type':'session','version':3,'cwd':here,'id':ident})+'\n')
    transcript(ambient, '11111111-1111-1111-1111-111111111111')
    transcript(selected, '22222222-2222-2222-2222-222222222222')
    os.environ['PI_CODING_AGENT_DIR'] = str(root / 'ambient')
    discover.cwd = lambda pid: here
    discover.proc_start = lambda pid: time.time() - 1
    discover._another_pi_may_run_in = lambda pid, cwd: False
    assert discover.pi_info(1)['session_id'].startswith('1111')
    assert discover.pi_info(1, str(selected_root))['session_id'].startswith('2222')
    assert discover.pi_session_path('22222222-2222-2222-2222-222222222222', str(selected_root)) == str(selected / '22222222-2222-2222-2222-222222222222.jsonl')
    assert server._selected_pi_transcript(str(selected / '22222222-2222-2222-2222-222222222222.jsonl'), str(selected_root))
    assert not server._selected_pi_transcript(str(ambient / '11111111-1111-1111-1111-111111111111.jsonl'), str(selected_root))
    alias = root / 'history-alias'
    alias.symlink_to(selected_root, target_is_directory=True)
    assert server._selected_pi_transcript(str(alias / '22222222-2222-2222-2222-222222222222.jsonl'), str(alias))
    (selected / 'outside.jsonl').symlink_to(ambient / '11111111-1111-1111-1111-111111111111.jsonl')
    assert not server._selected_pi_transcript(str(selected / 'outside.jsonl'), str(selected_root))
    assert discover.pi_session_path('11111111-1111-1111-1111-111111111111', '') is None
    assert discover.pi_session_path('11111111-1111-1111-1111-111111111111', 'relative') is None
    assert 'session_id' not in discover.pi_info(1, '')
    assert 'session_id' not in discover.pi_info(1, 'relative')
    transcript(selected, '33333333-3333-3333-3333-333333333333')
    assert 'session_id' not in discover.pi_info(1, str(selected_root))
    (selected / 'duplicate.jsonl').write_text((selected / '22222222-2222-2222-2222-222222222222.jsonl').read_text())
    assert not server._selected_pi_transcript(str(selected / '22222222-2222-2222-2222-222222222222.jsonl'), str(selected_root))
`;
  assert.doesNotThrow(() => execFileSync(process.env.MESH_PYTHON || 'python3', ['-c', script], {cwd: process.cwd()}));
});

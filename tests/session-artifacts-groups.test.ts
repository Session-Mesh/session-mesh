// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';

const executable=path.join(REPO,'ocaml/_build/default/bin/mesh_board_mcp_main.exe');
function exchange(notes:boolean) {
  const messages=[
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-scope-test',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:notes?'whiteboard':'notes_create_note',arguments:{}}},
    ...(!notes?[{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'session',arguments:{action:'describe'}}}]:[]),
  ];
  const result=spawnSync(executable,notes?['--notes']:[],{
    env:{PATH:'/usr/bin:/bin',MESH_SESSION_TOKEN:'synthetic-scope-token',MESH_PORT:'1'},
    input:messages.map(m=>JSON.stringify(m)).join('\n')+'\n',encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim().split('\n').map(line=>JSON.parse(line));
}
test('actual grouped board server never exposes Notes tools; Notes server never exposes board groups',()=>{
  const board=exchange(false),notes=exchange(true);
  const names=(replies:ReturnType<typeof exchange>)=>replies.find(r=>r.id===2).result.tools.map((t:{name:string})=>t.name).sort();
  assert.deepEqual(names(board),['agent_guide_read','demo','mail','session','whiteboard']);
  assert.deepEqual(names(notes),['notes_create_note','notes_mint_share','notes_replace_note','notes_revoke_share']);
  assert.ok(board.find(r=>r.id===3).error,'Notes operation on board is unknown, not a routed mutation');
  assert.ok(notes.find(r=>r.id===3).error,'board operation on Notes is unknown');
  const described=board.find(r=>r.id===4);
  assert.equal(described.result?.isError,false,'group describes without contacting the server');
  assert.match(JSON.stringify(described.result),/account_switch_request/);
});

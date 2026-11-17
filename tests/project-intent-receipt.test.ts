// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requestProject,ProjectTransportError} from '../static/project-host.ts';

test('only correlated native success can settle a project write or status query',async()=>{
  const boot='a'.repeat(64),revision='cfg1_'+'b'.repeat(64),request_id='00000000-0000-4000-8000-000000000001';
  for(const op of ['project_create','project_settings','project_status'] as const){
    const project_id=op==='project_create'?request_id:'project';
    const intent={op,version:1 as const,boot,request_id,project_id};
    const good={kind:'mesh-project-reply',version:1,op,boot,status:'ok',revision,machine_id:'machine',request_id,project_id,
      ...(op==='project_status'?{intent_state:'confirmed',intent_kind:'settings'}:{result:op==='project_create'?'created':'updated'})};
    assert.equal((await requestProject(async()=>new Response(JSON.stringify(good)),intent)).status,'ok');
    const changes=[{request_id:'unrelated'},{project_id:'unrelated'},{revision:undefined},{machine_id:undefined},
      ...(op==='project_status'?[{intent_state:'invented'},{intent_kind:null}]:[{boot:'c'.repeat(64)},{result:'unrelated'}])];
    for(const change of changes){let calls=0;
      await assert.rejects(requestProject(async()=>{calls++;return new Response(JSON.stringify({...good,...change}));},intent),
        (error:unknown)=>error instanceof ProjectTransportError&&error.reason===(op==='project_status'?'unavailable':'uncertain'));
      assert.equal(calls,1,'a contradictory receipt must never trigger another send');
    }
    assert.equal((await requestProject(async()=>new Response(JSON.stringify({...good,status:'conflict',request_id:undefined,project_id:undefined})),intent)).status,'conflict');
  }
});

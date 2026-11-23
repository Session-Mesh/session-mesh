// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {removeScratch,REPO} from './mesh-server-lib.ts';

const worker=path.join(REPO,'ocaml/_build/default/bin/mesh_artifacts_main.exe');
const reader=path.join(REPO,'ocaml/_build/default/work_read/bin/work_read_main.exe');
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-tools-native-'));
  const tracker=path.join(root,'tracker'),home=path.join(root,'home'),conf=path.join(root,'conf');
  fs.cpSync(path.join(REPO,'ocaml/worklog/test/fixture'),tracker,{recursive:true});
  for(const p of [home,conf,path.join(tracker,'.git')])fs.mkdirSync(p,{mode:0o700});
  const registration=path.join(root,'instance.json'),st=fs.statSync(tracker),git=fs.statSync(path.join(tracker,'.git'));
  fs.writeFileSync(registration,JSON.stringify({version:1,instance_id:'a'.repeat(64),
    root_dev:String(st.dev),root_ino:String(st.ino),git_dev:String(git.dev),git_ino:String(git.ino)}),{mode:0o600});
  const env={PATH:'/usr/bin:/bin',HOME:home,WL_HOME:tracker,MESH_CONF_DIR:conf,
    MESH_WORK_INSTANCE_REGISTRATION:registration};
  const invoke=(exe:string,value:unknown) => {
    const r=spawnSync(exe,exe===reader?['--request']:[],{env,input:JSON.stringify(value),encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const context=()=> {
    const value=invoke(reader,{op:'attachment-context',args:{project:'P-5e6f',product:'relay'}});
    assert.equal(value.command,'attachment-context',JSON.stringify(value));
    const {instance_id,project_id,product_id,project_created}=value;
    return {instance_id,project_id,product_id,project_created};
  };
  return {root,tracker,conf,registration,env,invoke,context};
}
const session={name:'synthetic-session',created:1.25,machine_id:'synthetic-machine'};

test('canonical tools preserve exact binding, CAS, durable receipt and detach across processes',()=>{
  const f=fixture();try {
    const scope=f.context();
    const request=(action:string,revision:number|null,id:string|null=null,s:unknown=null)=>({
      op:'work-tools',action,context:scope,session:s,request_id:id,revision});
    const initial=f.invoke(worker,request('read',null));assert.equal(initial.status,'confirmed');assert.deepEqual(initial.sessions,[]);
    const localSession={...session,machine_id:initial.machine_id};
    const attach=request('attach',initial.revision,'one',localSession);
    const saved=f.invoke(worker,attach);assert.equal(saved.status,'confirmed');assert.deepEqual(saved.sessions,[localSession]);
    assert.deepEqual(f.invoke(worker,attach),saved,'same receipt, not another mutation');
    assert.equal(f.invoke(worker,{...attach,session:{...session,created:2}}).error,'artifacts-unavailable','request id never changes meaning');
    const status=f.invoke(worker,{...attach,action:'status'});assert.equal(status.receipt.action,'attach');assert.deepEqual(status.receipt.session,localSession);
    const changed=f.invoke(worker,request('detach',saved.revision,'two',localSession));assert.deepEqual(changed.sessions,[]);
    assert.equal(changed.revision,saved.revision+1);
    assert.deepEqual(f.invoke(worker,{...request('status',null,'two')}).receipt.session,localSession);
    assert.equal(f.invoke(worker,request('attach',0,'stale',session)).error,'artifacts-unavailable');
    assert.equal(fs.existsSync(path.join(f.conf,'session-artifacts.json')),false,'no Notes grants/catalogue mutation');
  }finally{removeScratch(f.root);}
});

test('foreign instance/product/project, replaced repository and unsafe registration fail closed',()=>{
  const f=fixture();try {
    const scope=f.context(),request={op:'work-tools',action:'read',context:scope,session:null,revision:null,request_id:null};
    for(const changed of [{instance_id:'b'.repeat(64)},{project_id:'P-ffff'},{product_id:'gateway'},{project_created:'replacement'}])
      assert.equal(f.invoke(worker,{...request,context:{...scope,...changed}}).error,'artifacts-unavailable');
    fs.renameSync(path.join(f.tracker,'.git'),path.join(f.tracker,'.git-old'));fs.mkdirSync(path.join(f.tracker,'.git'));
    assert.equal(f.invoke(worker,request).error,'artifacts-unavailable','replacement is not silently adopted');
    fs.chmodSync(f.registration,0o644);
    assert.equal(f.invoke(worker,request).error,'artifacts-unavailable');
  }finally{removeScratch(f.root);}
});

test('malformed store is unavailable, not an empty or confirmed save',()=>{
  const f=fixture();try {
    const scope=f.context();fs.writeFileSync(path.join(f.conf,'work-session-tools.json'),'{broken',{mode:0o600});
    assert.equal(f.invoke(worker,{op:'work-tools',action:'read',context:scope,session:null,revision:null,request_id:null}).error,'artifacts-unavailable');
    assert.equal(fs.readFileSync(path.join(f.conf,'work-session-tools.json'),'utf8'),'{broken');
  }finally{removeScratch(f.root);}
});

test('deleted/recreated project and absent taxonomy cannot recover old associations',()=>{
  const f=fixture();try {
    const scope=f.context();
    const request={op:'work-tools',action:'read',context:scope,session:null,revision:null,request_id:null};
    const events=path.join(f.tracker,'events','2026-10.hosta.jsonl');
    const original=fs.readFileSync(events,'utf8');
    fs.writeFileSync(events,original.split('\n').filter(line=>!line.includes('"task":"P-5e6f"')).join('\n'));
    assert.equal(f.invoke(worker,request).error,'artifacts-unavailable','deleted project is not empty confirmed');
    fs.writeFileSync(events,original.replace('"2026-10-29T10:05:00Z","task":"P-5e6f","type":"project_created"',
      '"2026-10-29T10:04:00Z","task":"P-5e6f","type":"project_created"'));
    assert.equal(f.invoke(worker,request).error,'artifacts-unavailable','creation identity changed');
    fs.writeFileSync(events,original);
    // The fixture taxonomy is the same canonical source used by Projects.
    const taxonomy=path.join(f.tracker,'taxonomy.yaml');
    assert.ok(fs.existsSync(taxonomy));
    fs.renameSync(taxonomy,taxonomy+'.saved');
    assert.equal(f.invoke(worker,request).error,'artifacts-unavailable');
  }finally{removeScratch(f.root);}
});

test('unknown receipts and foreign machines never confirm an attachment',()=>{
  const f=fixture();try {
    const scope=f.context();
    const request={op:'work-tools',action:'read',context:scope,session:null,revision:null,request_id:null};
    const initial=f.invoke(worker,request);
    assert.equal(f.invoke(worker,{...request,action:'status',request_id:'never-delivered'}).status,'unknown');
    assert.equal(f.invoke(worker,{...request,action:'attach',session,revision:initial.revision,request_id:'foreign'}).error,'artifacts-unavailable');
    assert.deepEqual(f.invoke(worker,request).sessions,[]);
    assert.equal(f.invoke(worker,request).revision,0);
  }finally{removeScratch(f.root);}
});

test('canonical worker transport uses an operation-specific environment',()=>{
  const f=fixture();try {
    const result=spawnSync(process.env.MESH_PYTHON || path.join(REPO,'.venv/bin/python'),['-c',`
import asyncio, json, os
import server
os.environ.update(MESH_ARTIFACTS_CMD="/synthetic/helper", MESH_SESSION_TOKEN="synthetic-session",
                  MESH_NOTES_TOKEN_FILE="/synthetic/notes", CANONICAL_QA_SENTINEL="not-in-worker")
seen = []
class Proc:
    returncode = 0
    async def communicate(self, data):
        return b'{}', b''
async def spawn(*args, **kwargs):
    seen.append(kwargs["env"])
    return Proc()
server.asyncio.create_subprocess_exec = spawn
asyncio.run(server.artifact_command({"op":"work-tools"}))
assert set(seen[0]) == {"HOME","WL_HOME","PATH","MESH_CONF_DIR","MESH_WORK_INSTANCE_REGISTRATION"}, seen[0].keys()
assert seen[0]["MESH_WORK_INSTANCE_REGISTRATION"] == os.environ["MESH_WORK_INSTANCE_REGISTRATION"]
asyncio.run(server.artifact_command({"op":"list"}))
assert seen[1]["CANONICAL_QA_SENTINEL"] == "not-in-worker"
assert "MESH_SESSION_TOKEN" not in seen[1]
print("operation-specific canonical allowlist; existing noncanonical transport unchanged")
`],{cwd:REPO,env:f.env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
  }finally{removeScratch(f.root);}
});

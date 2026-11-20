// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The real one-shot native helper, with disposable metadata only. No native agent,
// provider, credential or running Mesh is used. A registry never enables live switching.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const repo=path.resolve(import.meta.dirname,'..');
const candidate=path.join(repo,'ocaml/_build/default/bin/mesh_profile_main.exe');
const binary=process.env.MESH_PROFILE_CMD || (fs.existsSync(candidate)?candidate:path.join(repo,'_opam/bin/mesh-profile'));
type Reply={version:number;ok:boolean;data?:any;code?:string};
function fixture(){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mesh-profiles-'));
  fs.chmodSync(root,0o700);const conf=path.join(root,'conf');fs.mkdirSync(conf,{mode:0o700});
  const profiles:any[]=[];
  function add(id:string,backend='pi',enabled=true){
    const keys=backend==='codex'?['config','state']:backend==='opencode-v2'?['config','data','state','cache']:['config','history'];
    const roots=Object.fromEntries(keys.map(key=>{const dir=path.join(root,'accounts',id,key);fs.mkdirSync(dir,{recursive:true,mode:0o700});return [key,dir];}));
    const profile={id,label:id,backend,enabled,roots};profiles.push(profile);return profile;
  }
  const file=path.join(conf,'backend-profiles.json'),db=path.join(conf,'backend-accounts.sqlite');
  function save(){fs.writeFileSync(file,JSON.stringify({version:1,profiles}),{mode:0o600});}
  function request(op:string,extra:object={},args:string[]=[]){
    const result=spawnSync(binary,args,{encoding:'utf8',input:JSON.stringify({version:1,op,...extra}),timeout:5000,
      env:{HOME:root,MESH_CONF_DIR:conf,PATH:'/usr/bin:/bin'}});
    if(result.error)throw result.error;
    const reply=JSON.parse(result.stdout) as Reply;
    assert.equal(reply.version,1);assert.equal(result.status,reply.ok?0:1,result.stderr);
    return reply;
  }
  function http(op:string,raw:string){
    const result=spawnSync(binary,['--http',op],{encoding:'utf8',input:raw,timeout:5000,env:{HOME:root,MESH_CONF_DIR:conf,PATH:'/usr/bin:/bin'}});
    if(result.error)throw result.error;return {status:result.status,reply:JSON.parse(result.stdout)};
  }
  return {root,conf,file,db,profiles,add,save,request,http,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function use(fn:(f:ReturnType<typeof fixture>)=>void){const f=fixture();try{fn(f);}finally{f.close();}}

test('unconfigured registry is explicit and does not create account state',()=>use(f=>{
  const reply=f.request('profiles.list');assert.equal(reply.ok,true);assert.deepEqual(reply.data.profiles,[]);
  assert.equal(reply.data.configured,false);assert.equal(fs.existsSync(f.db),false);
}));
test('four backend projections contain no paths and cannot qualify a switch',()=>use(f=>{
  for(const backend of ['claude','codex','opencode-v2','pi'])f.add(backend,backend);f.save();
  const reply=f.request('profiles.list');assert.equal(reply.ok,true);assert.equal(reply.data.profiles.length,4);
  assert.equal(JSON.stringify(reply).includes(f.root),false);
  for(const profile of reply.data.profiles){assert.equal(profile.switch_qualified,false);assert.equal('roots' in profile,false);assert.match(profile.context_revision,/^[a-f0-9]{64}$/);}
}));
test('host-side resolution binds exact ID/backend/context and checks current roots',()=>use(f=>{
  f.add('work');f.add('off','pi',false);f.save();const profile=f.request('profiles.list').data.profiles[0];
  const good=f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:profile.context_revision});assert.equal(good.ok,true);assert.equal(good.data.roots.config,f.profiles[0].roots.config);
  for(const extra of [{id:'missing',backend:'pi',expected_context:null},{id:'off',backend:'pi',expected_context:null},{id:'work',backend:'codex',expected_context:null},{id:'work',backend:'pi',expected_context:'0'.repeat(64)}])assert.equal(f.request('profiles.resolve',extra).ok,false);
  fs.chmodSync(f.profiles[0].roots.config,0o777);assert.equal(f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:null}).ok,false);
}));
test('unknown fields and unsupported native actions refuse before persistent state',()=>use(f=>{
  for(const [op,extra]of [['consent.reset',{expected_revision:0,roots:{config:'/unsafe'}}],['consent.set_global',{expected_revision:0.5,confirmation:'skip'}],['switch.start',{}]] as const){
    assert.equal(f.request(op,extra).ok,false);assert.equal(fs.existsSync(f.db),false);
  }
  assert.equal(f.request('profiles.list',{},['--root','/arbitrary']).code,'unsupported-arguments');
}));
test('global preference persists across helper processes and rejects stale writes',()=>use(f=>{
  assert.equal(f.request('consent.get').data.revision,0);
  assert.equal(f.request('consent.set_global',{expected_revision:0,confirmation:'skip'}).data.revision,1);
  assert.equal(f.request('consent.get').data.global,'skip');
  assert.equal(f.request('consent.reset',{expected_revision:0}).code,'consent-revision-conflict');
  assert.equal(f.request('consent.get').data.global,'skip');
}));
test('pair Ask exceptions use native context and current registry revision',()=>use(f=>{
  f.add('work');f.add('personal');f.save();const registry=f.request('profiles.list').data.registry_revision;
  const pair={expected_revision:0,source_id:'work',target_id:'personal',registry_revision:registry,confirmation:'ask'};
  assert.equal(f.request('consent.set_pair',pair).ok,true);
  const policy=f.request('consent.get').data;assert.equal(policy.pairs.length,1);assert.equal(policy.pairs[0].confirmation,'ask');
  f.profiles[0].label='Renamed';f.save();
  assert.equal(f.request('consent.set_pair',{...pair,expected_revision:1}).code,'profile-registry-changed');
  assert.equal(f.request('consent.get').data.revision,1);
}));
test('retired pair removal and reset remain explicit revisioned management actions',()=>use(f=>{
  f.add('work');f.add('personal');f.save();const registry=f.request('profiles.list').data.registry_revision;
  assert.equal(f.request('consent.set_pair',{expected_revision:0,source_id:'work',target_id:'personal',registry_revision:registry,confirmation:'skip'}).ok,true);
  f.profiles.pop();f.save();
  assert.equal(f.request('consent.remove_pair',{expected_revision:1,source_id:'personal',target_id:'work'}).data.revision,2);
  assert.equal(f.request('consent.reset',{expected_revision:2}).data.revision,3);
  const state=f.request('consent.get').data;assert.equal(state.global,'ask');assert.deepEqual(state.pairs,[]);
}));
test('unsafe registry custody fails without echoing private paths or payload',()=>use(f=>{
  f.add('work');f.save();fs.chmodSync(f.file,0o644);
  const result=f.request('profiles.list');assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(f.root),false);
  assert.equal(fs.existsSync(f.db),false);
}));

test('same-account pair changes are invalid before a state store is created',()=>use(f=>{
  f.add('work');f.save();const registry=f.request('profiles.list').data.registry_revision;
  assert.equal(f.request('consent.set_pair',{expected_revision:0,source_id:'work',target_id:'work',registry_revision:registry,confirmation:'skip'}).code,'invalid-account-pair');
  assert.equal(f.request('consent.remove_pair',{expected_revision:0,source_id:'work',target_id:'work'}).code,'invalid-account-pair');
  assert.equal(fs.existsSync(f.db),false);
}));

test('physical aliases cannot register two credential contexts with different path spellings',()=>use(f=>{
  const a=f.add('work'),b=f.add('personal');
  fs.rmdirSync(b.roots.config);fs.symlinkSync(a.roots.config,b.roots.config);f.save();
  assert.equal(f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:null}).code,'unsafe-profile-roots');
  assert.equal(fs.existsSync(f.db),false);
}));

test('HTTP mode exposes only public operations and retains duplicate-field rejection',()=>use(f=>{
  assert.equal(f.http('profiles.list','{}').reply.http_status,200);
  for(const raw of ['{"op":"profiles.resolve"}','{"version":1}','{"expected_revision":0,"expected_revision":0}',
    '{"expected_revision":0,"roots":{"config":"/arbitrary"}}']){
    const result=f.http('consent.reset',raw);assert.equal(result.status,1);assert.equal(result.reply.http_status,400);
    assert.equal(fs.existsSync(f.db),false);
  }
  assert.equal(f.http('profiles.resolve','{}').reply.code,'unsupported-arguments');
  assert.equal(f.http('switch.start','{}').reply.code,'unsupported-arguments');
  assert.equal(fs.existsSync(f.db),false);
}));

test('native HTTP status projection distinguishes a stale policy from a successful edit',()=>use(f=>{
  assert.equal(f.http('consent.set_global','{"expected_revision":0,"confirmation":"skip"}').reply.http_status,200);
  const stale=f.http('consent.reset','{"expected_revision":0}');assert.equal(stale.status,1);assert.equal(stale.reply.http_status,409);
  assert.equal(stale.reply.code,'consent-revision-conflict');assert.equal(f.http('consent.get','{}').reply.data.global,'skip');
}));

test('concurrent native helpers cannot both commit the same policy revision',async()=>{
  const f=fixture();
  try{
    assert.equal(f.request('consent.get').ok,true);
    const write=(op:string,extra:object)=>new Promise<Reply>((resolve,reject)=>{
      const child=spawn(binary,[],{env:{HOME:f.root,MESH_CONF_DIR:f.conf,PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
      let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
      child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.resume();
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(out));}catch(error){reject(error);}});
      child.stdin.end(JSON.stringify({version:1,op,expected_revision:0,...extra}));
    });
    const replies=await Promise.all([write('consent.set_global',{confirmation:'skip'}),write('consent.reset',{})]);
    assert.equal(replies.filter(reply=>reply.ok).length,1,'exactly one writer owns revision zero');
    const current=f.request('consent.get');assert.equal(current.data.revision,1);
    assert.equal(current.data.global,replies[0].ok?'skip':'ask');
  }finally{f.close();}
});

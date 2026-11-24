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
const platform=path.join(repo,'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
// Without mesh-profile the file is skipped, with the reason, unless MESH_REQUIRE_MESH_PROFILE is set (CI):
// then a missing program fails every test. ocaml/test covers the modules themselves.
const skip=fs.existsSync(binary)||process.env.MESH_REQUIRE_MESH_PROFILE?false
  :`mesh-profile not built: dune build ./bin/mesh_profile_main.exe, or set MESH_PROFILE_CMD (${binary})`;
type Reply={version:number;ok:boolean;data?:any;code?:string};
function fixture(){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mesh-profiles-'));
  fs.chmodSync(root,0o700);const conf=path.join(root,'conf');fs.mkdirSync(conf,{mode:0o700});
  const profiles:any[]=[];
  function add(id:string,backend='pi',enabled=true){
    const keys=backend==='codex'?['config','state']:backend==='opencode-v2'?['config','data','state','cache']:['config','history'];
    const roots=Object.fromEntries(keys.map(key=>{const dir=path.join(root,'accounts',backend,id,key);fs.mkdirSync(dir,{recursive:true,mode:0o700});return [key,dir];}));
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

test('unconfigured registry is explicit and does not create account state',{skip},()=>use(f=>{
  const reply=f.request('profiles.list');assert.equal(reply.ok,true);assert.deepEqual(reply.data.profiles,[]);
  assert.equal(reply.data.configured,false);assert.equal(fs.existsSync(f.db),false);
}));
test('create accepts first and appended aliases in every backend without exposing roots',{skip},()=>use(f=>{
  let expected:string|null=null;
  for(const backend of ['claude','codex','opencode-v2','pi']){
    const profile=f.add(backend,backend);
    f.profiles.pop();
    const created=f.request('profiles.create',{registry_revision:expected,profile:{backend,id:profile.id,label:profile.label,roots:profile.roots}});
    assert.equal(created.ok,true,JSON.stringify(created));
    assert.equal(created.data.profile.backend,backend);
    assert.equal(created.data.profile.enabled,true);
    assert.equal(JSON.stringify(created).includes(f.root),false);
    expected=created.data.registry_revision;
    if(backend==='claude'){
      assert.equal(fs.existsSync(path.join(f.conf,'.backend-profiles.create-intent')),false);
      assert.equal(fs.statSync(f.file).nlink,1);
    }
    assert.equal(f.request('profiles.list').data.registry_revision,expected);
    const resolved=f.request('profiles.resolve',{backend,id:profile.id,expected_context:created.data.profile.context_revision});
    assert.equal(resolved.ok,true,JSON.stringify(resolved));
    assert.deepEqual(resolved.data.roots,profile.roots);
  }
  assert.equal(f.request('profiles.list').data.profiles.length,4);
  assert.equal(fs.existsSync(f.db),false,'creation cannot mutate consent');
}));
test('created aliases enter the native list and backend-qualified launch selectors',{skip:skip||(!fs.existsSync(platform)&&'mesh-platform not built')},()=>use(f=>{
  let revision:string|null=null;
  const select:{[key:string]:string}={claude:'CLAUDE_CONFIG_DIR',codex:'CODEX_HOME',
    'opencode-v2':'XDG_CONFIG_HOME',pi:'PI_CODING_AGENT_DIR'};
  for(const backend of ['claude','codex','opencode-v2','pi']){
    const fprofile=f.add(`new-${backend}`,backend);f.profiles.pop();
    const {enabled,...profile}=fprofile;
    const created=f.request('profiles.create',{registry_revision:revision,profile});
    assert.equal(created.ok,true,JSON.stringify(created));
    revision=created.data.registry_revision;
    const run=(args:string[])=>spawnSync(platform,['accounts',...args],{encoding:'utf8',timeout:5000,
      env:{HOME:f.root,MESH_CONF_DIR:f.conf,PATH:'/usr/bin:/bin'}});
    const file=path.join(f.conf,'accounts.json');
    const listed=run(['list',file]);assert.equal(listed.status,0,listed.stdout);
    assert.ok(JSON.parse(listed.stdout).launch_profiles.some((p:any)=>p.backend===backend&&p.id===profile.id));
    const launch=run(['launch-context',file,backend,profile.id,created.data.profile.context_revision]);
    assert.equal(launch.status,0,launch.stdout);
    const ctx=JSON.parse(launch.stdout).context;
    assert.equal(ctx.env[select[backend]!],profile.roots.config);
    assert.equal(ctx.registry_revision,revision);
    assert.equal(ctx.context_revision,created.data.profile.context_revision);
  }
}));
test('create refuses stale, duplicate, malformed and unsafe roots without altering registry bytes',{skip},()=>use(f=>{
  const one=f.add('one','claude');f.profiles.pop();
  const request=(profile:any,registry_revision:string|null)=>{
    const {enabled,...input}=profile;
    return f.request('profiles.create',{registry_revision,profile:input});
  };
  const first=request(one,null);assert.equal(first.ok,true,JSON.stringify(first));
  const bytes=fs.readFileSync(f.file);
  const two=f.add('two','codex');f.profiles.pop();
  assert.equal(request(two,null).code,'profile-registry-changed');
  assert.equal(request(one,first.data.registry_revision).code,'profile-already-exists');
  assert.equal(request({...two,roots:{config:two.roots.config}},first.data.registry_revision).ok,false);
  assert.equal(request({...two,roots:{...two.roots,state:'/not/a/real/directory'}},first.data.registry_revision).ok,false);
  const linked=path.join(f.root,'linked-config');
  fs.symlinkSync(two.roots.config,linked);
  assert.equal(request({...two,roots:{...two.roots,config:linked}},first.data.registry_revision).code,'unsafe-profile-roots');
  assert.equal(f.request('profiles.create',{registry_revision:first.data.registry_revision,profile:two}).code,'invalid-request');
  assert.deepEqual(fs.readFileSync(f.file),bytes);
  const stale=first.data.registry_revision;
  assert.equal(request(two,stale).ok,true);
  assert.equal(request({...one,id:'three'},stale).code,'profile-registry-changed');
}));
test('create requires explicit legacy migration and never replaces missing migrated or invalid registry',{skip},()=>use(f=>{
  const profile=f.add('new','pi');f.profiles.pop();
  const add=()=>f.request('profiles.create',{registry_revision:null,profile});
  const legacy=path.join(f.conf,'accounts.json');
  const original=JSON.stringify({v:1,accounts:[{id:'old',label:'Old',claude_config_dir:profile.roots.config}]});
  fs.writeFileSync(legacy,original,{mode:0o600});
  assert.equal(add().code,'profile-migration-required');
  assert.equal(fs.readFileSync(legacy,'utf8'),original);
  assert.equal(fs.existsSync(f.file),false);
  fs.unlinkSync(legacy);
  fs.writeFileSync(path.join(f.conf,'backend-profiles.migrated'),'marker',{mode:0o600});
  assert.equal(add().code,'profile-registry-changed');
  assert.equal(fs.existsSync(f.file),false);
  fs.unlinkSync(path.join(f.conf,'backend-profiles.migrated'));
  fs.writeFileSync(f.file,'{broken',{mode:0o600});
  const before=fs.readFileSync(f.file);
  assert.equal(add().ok,false);
  assert.deepEqual(fs.readFileSync(f.file),before);
}));
test('create appends after explicit host migration without changing legacy or retirement bytes',{skip},()=>use(f=>{
  const old=f.add('old','claude');f.profiles.pop();
  const next=f.add('next','codex');f.profiles.pop();
  const legacy=path.join(f.conf,'accounts.json'), marker=path.join(f.conf,'backend-profiles.migrated');
  fs.writeFileSync(legacy,JSON.stringify({v:1,accounts:[{id:'old',label:'Old',claude_config_dir:old.roots.config}]}),{mode:0o600});
  const migration=spawnSync(binary,['migrate'],{encoding:'utf8',env:{HOME:f.root,MESH_CONF_DIR:f.conf,PATH:'/usr/bin:/bin'}});
  assert.equal(migration.status,0,migration.stdout);
  const beforeLegacy=fs.readFileSync(legacy),beforeMarker=fs.readFileSync(marker);
  const revision=f.request('profiles.list').data.registry_revision;
  const {enabled,...profile}=next;
  const created=f.request('profiles.create',{registry_revision:revision,profile});
  assert.equal(created.ok,true,JSON.stringify(created));
  assert.deepEqual(fs.readFileSync(legacy),beforeLegacy);
  assert.deepEqual(fs.readFileSync(marker),beforeMarker);
  assert.deepEqual(f.request('profiles.list').data.profiles.map((p:any)=>p.id),['old','next']);
}));
test('two first creates using the same expected revision cannot both publish',{skip},async()=>{
  const f=fixture();
  try{
    const one=f.add('one','claude'),two=f.add('two','codex');f.profiles.length=0;
    const send=(candidate:any)=>new Promise<Reply>((resolve,reject)=>{
      const {enabled,...profile}=candidate;
      const child=spawn(binary,[],{env:{HOME:f.root,MESH_CONF_DIR:f.conf,PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});
      child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
      child.once('error',reject);
      child.once('close',code=>{
        try{const reply=JSON.parse(stdout) as Reply;assert.equal(code,reply.ok?0:1,stderr);resolve(reply);}catch(error){reject(error);}
      });
      child.stdin.end(JSON.stringify({version:1,op:'profiles.create',registry_revision:null,profile}));
    });
    const results=await Promise.all([send(one),send(two)]);
    assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));
    assert.ok(['profile-registry-changed','migration-busy'].includes(results.find(r=>!r.ok)?.code ?? ''));
    assert.equal(f.request('profiles.list').data.profiles.length,1);
  }finally{f.close();}
});
test('four backend projections contain no paths and cannot qualify a switch',{skip},()=>use(f=>{
  for(const backend of ['claude','codex','opencode-v2','pi'])f.add(backend,backend);f.save();
  const reply=f.request('profiles.list');assert.equal(reply.ok,true);assert.equal(reply.data.profiles.length,4);
  assert.equal(JSON.stringify(reply).includes(f.root),false);
  for(const profile of reply.data.profiles){assert.equal(profile.switch_qualified,false);assert.equal('roots' in profile,false);assert.match(profile.context_revision,/^[a-f0-9]{64}$/);}
}));
test('one alias ID resolves independently in each backend without changing legacy IDs',{skip},()=>use(f=>{
  for(const backend of ['claude','codex','opencode-v2','pi'])f.add('work',backend);f.save();
  const list=f.request('profiles.list');assert.equal(list.ok,true);assert.equal(list.data.profiles.length,4);
  for(const backend of ['claude','codex','opencode-v2','pi']){
    const resolved=f.request('profiles.resolve',{id:'work',backend,expected_context:null});
    assert.equal(resolved.ok,true);assert.equal(resolved.data.profile.backend,backend);
    assert.equal(resolved.data.roots.config,f.profiles.find(p=>p.backend===backend).roots.config);
  }
}));
test('profile IDs reuse the alias grammar and labels are unambiguous within a backend',{skip},()=>{
  for(const id of ['default','Work','work_id','a'.repeat(33)])use(f=>{
    const p=f.add('work');p.id=id;f.save();assert.equal(f.request('profiles.list').code,'invalid-profile-config');
  });
  use(f=>{const a=f.add('work'),b=f.add('personal');a.label='Work';b.label='wOrK';f.save();
    assert.equal(f.request('profiles.list').code,'invalid-profile-config');});
});
test('pair references require a backend and cannot remove another backend rule',{skip},()=>use(f=>{
  for(const backend of ['claude','codex']){f.add('work',backend);f.add('personal',backend);}f.save();
  const listed=f.request('profiles.list');assert.equal(listed.ok,true);
  const pair={expected_revision:0,source_id:'work',target_id:'personal',registry_revision:listed.data.registry_revision,confirmation:'skip'};
  assert.equal(f.request('consent.set_pair',pair).code,'invalid-request');assert.equal(fs.existsSync(f.db),false);
  assert.equal(f.request('consent.set_pair',{...pair,backend:'claude'}).ok,true);
  assert.equal(f.request('consent.set_pair',{...pair,backend:'codex',confirmation:'ask',expected_revision:1}).ok,true);
  const both=f.request('consent.get').data.pairs;assert.equal(both.length,2);
  for(const backend of ['claude','codex']){
    const rule=both.find((r:any)=>r.a.backend===backend);assert(rule);
    assert.equal(rule.b.backend,backend);assert.equal(rule.confirmation,backend==='claude'?'skip':'ask');
    for(const ref of [rule.a,rule.b]){
      const own=listed.data.profiles.find((p:any)=>p.backend===backend&&p.id===ref.id);assert(own);
      assert.equal(ref.context_revision,own.context_revision,'lookup must use the selected backend, not the first ID match');
    }
  }
  assert.equal(f.request('consent.remove_pair',{expected_revision:2,backend:'claude',source_id:'personal',target_id:'work'}).ok,true);
  const state=f.request('consent.get').data;assert.equal(state.pairs.length,1);assert.equal(state.pairs[0].a.backend,'codex');
  assert.equal(state.pairs[0].b.backend,'codex');
}));
test('labels follow the alias character limit and normalized display names are unique',{skip},()=>{
  for(const label of ['x'.repeat(25),'work\u200b'])use(f=>{
    const p=f.add('work');p.label=label;f.save();assert.equal(f.request('profiles.list').code,'invalid-profile-config');
  });
  use(f=>{const p=f.add('work');p.label='é'.repeat(24);f.save();assert.equal(f.request('profiles.list').ok,true);});
  use(f=>{const p=f.add('work');p.label=' Work ';f.save();assert.equal(f.request('profiles.list').data.profiles[0].label,'Work');});
  use(f=>{const a=f.add('work'),b=f.add('personal');a.label='Work';b.label=' Work ';f.save();
    assert.equal(f.request('profiles.list').code,'invalid-profile-config');});
});
test('host-side resolution binds exact ID/backend/context and checks current roots',{skip},()=>use(f=>{
  f.add('work');f.add('off','pi',false);f.save();const profile=f.request('profiles.list').data.profiles[0];
  const good=f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:profile.context_revision});assert.equal(good.ok,true);assert.equal(good.data.roots.config,f.profiles[0].roots.config);
  for(const extra of [{id:'missing',backend:'pi',expected_context:null},{id:'off',backend:'pi',expected_context:null},{id:'work',backend:'codex',expected_context:null},{id:'work',backend:'pi',expected_context:'0'.repeat(64)}])assert.equal(f.request('profiles.resolve',extra).ok,false);
  fs.chmodSync(f.profiles[0].roots.config,0o777);assert.equal(f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:null}).ok,false);
}));
test('unknown fields and unsupported native actions refuse before persistent state',{skip},()=>use(f=>{
  for(const [op,extra]of [['consent.reset',{expected_revision:0,roots:{config:'/unsafe'}}],['consent.set_global',{expected_revision:0.5,confirmation:'skip'}],['switch.start',{}]] as const){
    assert.equal(f.request(op,extra).ok,false);assert.equal(fs.existsSync(f.db),false);
  }
  assert.equal(f.request('profiles.list',{},['--root','/arbitrary']).code,'unsupported-arguments');
}));
test('global preference persists across helper processes and rejects stale writes',{skip},()=>use(f=>{
  assert.equal(f.request('consent.get').data.revision,0);
  assert.equal(f.request('consent.set_global',{expected_revision:0,confirmation:'skip'}).data.revision,1);
  assert.equal(f.request('consent.get').data.global,'skip');
  assert.equal(f.request('consent.reset',{expected_revision:0}).code,'consent-revision-conflict');
  assert.equal(f.request('consent.get').data.global,'skip');
}));
test('pair Ask exceptions use native context and current registry revision',{skip},()=>use(f=>{
  f.add('work');f.add('personal');f.save();const registry=f.request('profiles.list').data.registry_revision;
  const pair={backend:'pi',expected_revision:0,source_id:'work',target_id:'personal',registry_revision:registry,confirmation:'ask'};
  assert.equal(f.request('consent.set_pair',pair).ok,true);
  const policy=f.request('consent.get').data;assert.equal(policy.pairs.length,1);assert.equal(policy.pairs[0].confirmation,'ask');
  f.profiles[0].label='Renamed';f.save();
  assert.equal(f.request('consent.set_pair',{...pair,expected_revision:1}).code,'profile-registry-changed');
  assert.equal(f.request('consent.get').data.revision,1);
}));
test('retired pair removal and reset remain explicit revisioned management actions',{skip},()=>use(f=>{
  f.add('work');f.add('personal');f.save();const registry=f.request('profiles.list').data.registry_revision;
  assert.equal(f.request('consent.set_pair',{backend:'pi',expected_revision:0,source_id:'work',target_id:'personal',registry_revision:registry,confirmation:'skip'}).ok,true);
  f.profiles.pop();f.save();
  assert.equal(f.request('consent.remove_pair',{backend:'pi',expected_revision:1,source_id:'personal',target_id:'work'}).data.revision,2);
  assert.equal(f.request('consent.reset',{expected_revision:2}).data.revision,3);
  const state=f.request('consent.get').data;assert.equal(state.global,'ask');assert.deepEqual(state.pairs,[]);
}));
test('unsafe registry custody fails without echoing private paths or payload',{skip},()=>use(f=>{
  f.add('work');f.save();fs.chmodSync(f.file,0o644);
  const result=f.request('profiles.list');assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(f.root),false);
  assert.equal(fs.existsSync(f.db),false);
}));

test('same-account pair changes are invalid before a state store is created',{skip},()=>use(f=>{
  f.add('work');f.save();const registry=f.request('profiles.list').data.registry_revision;
  assert.equal(f.request('consent.set_pair',{backend:'pi',expected_revision:0,source_id:'work',target_id:'work',registry_revision:registry,confirmation:'skip'}).code,'invalid-account-pair');
  assert.equal(f.request('consent.remove_pair',{backend:'pi',expected_revision:0,source_id:'work',target_id:'work'}).code,'invalid-account-pair');
  assert.equal(fs.existsSync(f.db),false);
}));

test('physical aliases cannot register two credential contexts with different path spellings',{skip},()=>use(f=>{
  const a=f.add('work'),b=f.add('personal');
  fs.rmdirSync(b.roots.config);fs.symlinkSync(a.roots.config,b.roots.config);f.save();
  assert.equal(f.request('profiles.resolve',{id:'work',backend:'pi',expected_context:null}).code,'unsafe-profile-roots');
  assert.equal(fs.existsSync(f.db),false);
}));
test('the same alias ID in two backends does not bypass physical peer custody',{skip},()=>use(f=>{
  const a=f.add('work','claude'),b=f.add('work','codex');
  fs.rmdirSync(b.roots.config);fs.symlinkSync(a.roots.config,b.roots.config);f.save();
  assert.equal(f.request('profiles.resolve',{id:'work',backend:'claude',expected_context:null}).code,'unsafe-profile-roots');
  assert.equal(fs.existsSync(f.db),false);
}));
test('native profile paths retain the shell-safe alias grammar',{skip},()=>use(f=>{
  const p=f.add('work');p.roots.config+=" 'quoted'";f.save();
  assert.equal(f.request('profiles.list').code,'invalid-profile-config');
  assert.equal(fs.existsSync(f.db),false);
}));

test('HTTP mode exposes only public operations and retains duplicate-field rejection',{skip},()=>use(f=>{
  assert.equal(f.http('profiles.list','{}').reply.http_status,200);
  for(const raw of ['{"op":"profiles.resolve"}','{"version":1}','{"expected_revision":0,"expected_revision":0}',
    '{"expected_revision":0,"roots":{"config":"/arbitrary"}}']){
    const result=f.http('consent.reset',raw);assert.equal(result.status,1);assert.equal(result.reply.http_status,400);
    assert.equal(fs.existsSync(f.db),false);
  }
  assert.equal(f.http('profiles.resolve','{}').reply.code,'unsupported-arguments');
  assert.equal(f.http('recover-create','{}').reply.code,'unsupported-arguments');
  assert.equal(f.http('switch.start','{}').reply.code,'unsupported-arguments');
  assert.equal(fs.existsSync(f.db),false);
}));

test('native HTTP status projection distinguishes a stale policy from a successful edit',{skip},()=>use(f=>{
  assert.equal(f.http('consent.set_global','{"expected_revision":0,"confirmation":"skip"}').reply.http_status,200);
  const stale=f.http('consent.reset','{"expected_revision":0}');assert.equal(stale.status,1);assert.equal(stale.reply.http_status,409);
  assert.equal(stale.reply.code,'consent-revision-conflict');assert.equal(f.http('consent.get','{}').reply.data.global,'skip');
}));

test('concurrent native helpers cannot both commit the same policy revision',{skip},async()=>{
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
    assert.equal(replies.find(reply=>!reply.ok)?.code,'consent-revision-conflict','the loser observes the committed revision, not a transient storage failure');
    const current=f.request('consent.get');assert.equal(current.data.revision,1);
    assert.equal(current.data.global,replies[0].ok?'skip':'ask');
  }finally{f.close();}
});

// About one round in a hundred lost the WAL switch race before the retry; 100 rounds (about 1 s) caught
// it in most runs. ocaml/test/backend_store_test.ml reproduces it on every run.
test('concurrent first-use readers all reuse one initialized private store',{skip},async()=>{
  for(let attempt=0;attempt<100;attempt++){
    const f=fixture();
    try{
      const get=()=>new Promise<Reply>((resolve,reject)=>{
        const child=spawn(binary,[],{env:{HOME:f.root,MESH_CONF_DIR:f.conf,PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
        let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
        child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.resume();
        child.on('error',error=>{clearTimeout(timer);reject(error);});
        child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(out));}catch(error){reject(error);}});
        child.stdin.end('{"version":1,"op":"consent.get"}');
      });
      const replies=await Promise.all(Array.from({length:8},get));
      assert(replies.every(reply=>reply.ok),JSON.stringify(replies.map(reply=>reply.code??'ok')));
      assert(replies.every(reply=>reply.data.revision===0));
      assert.equal(f.request('consent.get').data.revision,0);
    }finally{f.close();}
  }
});

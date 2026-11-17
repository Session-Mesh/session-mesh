// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Internal rich-catalog validator CLI; real subprocess and exact input bytes. */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, stat, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
let root: string, entry: string, provider: string, marker: string;
before(async () => {
  // Resolved: project file paths refuse symlinks, and the macOS temporary directory is under /var, a symlink.
  root = await mkdtemp(join(await realpath(tmpdir()), "mi1-validate-")); entry = join(root,"project-observation.mjs");
  marker = join(root,"provider-ran"); provider=join(root,"provider.mjs");
  await writeFile(provider,`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)},"called");`,{mode:0o700});
  await build({entryPoints:[new URL("../tools/project-observation.ts",import.meta.url).pathname],outfile:entry,bundle:true,platform:"node",format:"esm",target:"es2022"});
});
after(async()=>{await rm(root,{recursive:true,force:true});});
const scope={machine_id:"host",project_id:"one",captured_revision:"cfg1_"+"c".repeat(64)};
const catalog=()=>({kind:"mesh-project-catalog",schema_version:2,features:["project-metadata/1","roster-followup/1"],machine_id:"host",revision:"d".repeat(64),generated_at:"2026-11-15T00:00:00Z",projects:[{id:"one",title:"One",sources:[],sessions:[]}]});
const header=(bytes:Buffer)=>({kind:"mesh-project-catalog-validation-input",version:1,observation_id:"a".repeat(64),boot:"b".repeat(64),scope,sha256:createHash("sha256").update(bytes).digest("hex")});
function invoke(bytes:Buffer, metadata=header(bytes), args=["--validate-catalog"]) {
  return spawnSync(process.execPath,[entry,...args],{input:Buffer.concat([Buffer.from(JSON.stringify(metadata)+"\n"),bytes]),encoding:"utf8",maxBuffer:8192,env:{...process.env,MESH_PROJECT_ROSTER_CLI:provider,MESH_PROJECT_ROSTER_PIPELINE_CLI:provider}});
}
test("internal validator acknowledges exact noncanonical JSON bytes without provider execution",async()=>{
  const bytes=Buffer.from(JSON.stringify(catalog(),null,2)+" \n"),meta=header(bytes),result=invoke(bytes,meta);
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,"");
  assert.deepEqual(JSON.parse(result.stdout),{kind:"mesh-project-catalog-validation-reply",version:1,observation_id:meta.observation_id,boot:meta.boot,scope,sha256:meta.sha256,valid:true,settlement:{providers_closed:true,provider_pipes_closed:true}});
  assert.ok(Buffer.byteLength(result.stdout)<=8192);await assert.rejects(stat(marker),{code:"ENOENT"});
});
test("internal validator rejects full rich-schema corruptions with settled validfalse replies",()=>{
  for(const mutate of [v=>{v.projects[0].title=17;},v=>{v.projects[0].sources=[{id:"x",kind:"roster",label:"X",status:"available",observed_at:v.generated_at,summary:{provider_schema:"roster-roadmap-view",provider_version:1,counts:{},items:[],truncated:false,more:0,followup:{schema_version:1,metadata:{availability:"valid",value:{}},task_details:{items:[],total:0,truncated:false},truncated:false}}}];},v=>{v.features.pop();},v=>{v.projects[0].id="other";},v=>{v.machine_id="other";},v=>{v.projects.push(v.projects[0]);},v=>{v.extra=true;}]){
    const value=catalog();mutate(value);const result=invoke(Buffer.from(JSON.stringify(value)));assert.equal(result.status,0,result.stderr);const ack=JSON.parse(result.stdout);assert.equal(ack.valid,false);assert.deepEqual(ack.settlement,{providers_closed:true,provider_pipes_closed:true});
  }
});
test("internal validator binds raw digest and rejects duplicate malformed and invalid UTF8 catalogs",()=>{
  const normal=Buffer.from(JSON.stringify(catalog()));const wrongDigest={...header(normal),sha256:"f".repeat(64)};
  for(const [bytes,meta]of [[normal,wrongDigest],[Buffer.from(JSON.stringify(catalog()).replace(`"schema_version":2`,`"schema_version":2,"schema_version":2`)),undefined],[Buffer.from([0xff]),undefined],[Buffer.from("{} {}"),undefined]]){
    const result=invoke(bytes,meta);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).valid,false);
  }
});
test("internal validator malformed identity header emits no witness and unsupported argv stays refused",()=>{
  const bytes=Buffer.from(JSON.stringify(catalog()));for(const mutate of [v=>{v.kind="other";},v=>{v.extra=true;},v=>{v.scope={...scope,extra:true};},v=>{v.sha256="bad";},v=>{v.boot="bad";}]){
    const meta=header(bytes);mutate(meta);const result=invoke(bytes,meta);assert.equal(result.status,1);assert.equal(result.stdout,"");assert.match(result.stderr,/refused/);
  }
  const duplicate=JSON.stringify(header(bytes)).replace(`"version":1`,`"version":1,"version":1`);
  const result=spawnSync(process.execPath,[entry,"--validate-catalog"],{input:Buffer.concat([Buffer.from(duplicate+"\n"),bytes]),encoding:"utf8",maxBuffer:8192});assert.equal(result.status,1);assert.equal(result.stdout,"");
  assert.equal(invoke(bytes,header(bytes),["--validate-catalog","--extra"]).status,1);
});

test("internal pure validator finishes witnessed reply after owned SIGTERM during input",async()=>{
  const bytes=Buffer.from(JSON.stringify(catalog())),meta=header(bytes);
  const child=spawn(process.execPath,[entry,"--validate-catalog"],{stdio:["pipe","pipe","pipe"],env:{...process.env,MESH_PROJECT_VALIDATOR_READY_MARKER:"1"}});
  const readyLine="project-observation: validator-ready\n";
  let stdout="",stderr="",exited=false,wake=()=>{};
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",s=>{stdout+=s;});child.stderr.on("data",s=>{stderr+=s;wake();});
  const closed=new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",(code,signal)=>{exited=true;wake();resolve({code,signal});});});
  child.stdin.write(JSON.stringify(meta)+"\n");
  // The validator writes this marker right after installing its JS SIGTERM handler; signalling
  // earlier would test Node's start-up, not the validator. Bounded wait; fails if it never comes.
  const deadline=Date.now()+10000;
  while(!exited&&!stderr.includes(readyLine)&&Date.now()<deadline)await new Promise(resolve=>{wake=()=>resolve(undefined);setTimeout(resolve,50);});
  assert.equal(exited,false);assert.ok(stderr.includes(readyLine),"validator never reported its SIGTERM handler as installed");
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(exited,false);
  assert.equal(child.kill("SIGTERM"),true);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(exited,false);assert.equal(stdout,"");
  child.stdin.end(bytes);assert.deepEqual(await closed,{code:0,signal:null});assert.equal(stderr,readyLine);const ack=JSON.parse(stdout);assert.equal(ack.valid,true);assert.deepEqual(ack.settlement,{providers_closed:true,provider_pipes_closed:true});
});

test("internal validator and browser decoder accept only operator text up to 2000 units", async()=>{
  const {parseProjectCatalog}=await import('../static/project-catalog.ts');
  for(const length of [501,2000,2001]) {
    const value=catalog(),title='é'.repeat(length);
    value.projects[0].sources.push({id:'r3',kind:'roster',label:'R3',status:'available',observed_at:value.generated_at,
      summary:{provider_schema:'roster-roadmap-view',provider_version:1,counts:{},items:[],truncated:false,more:0,
        operator_status:'valid',operator_requests:[{id:'ask',title,state:'answered'}]}});
    const bytes=Buffer.from(JSON.stringify(value)),result=invoke(bytes);
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).valid,length<=2000);
    const parsed=parseProjectCatalog(bytes.toString('utf8'));
    if(length<=2000) {assert.ok(parsed);assert.equal(parsed.projects[0].sources[0].summary.operator_requests[0].title,title);}
    else assert.equal(parsed,null);
    value.projects[0].title='x'.repeat(241);
    assert.equal(parseProjectCatalog(value),null,'project titles keep their separate 240-unit bound');
  }
});

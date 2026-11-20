// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import {test} from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
const run=promisify(execFile), root=path.resolve(import.meta.dirname,"..");
const helper=path.join(root,"ocaml/_build/default/bin/mesh_artifacts_main.exe");
const options={skip:!existsSync(helper)&&!process.env.MESH_REQUIRE_ARTIFACTS ? "built mesh-artifacts required" : false};
let observations:Promise<Record<string,Record<string,unknown>>>|undefined;
function exercise() {return observations??=(async()=>{
  const home=await mkdtemp(path.join(tmpdir(),"mesh-transfer-proof-"));
  const env={...process.env};
  for(const k of Object.keys(env)) if(k.startsWith("MESH_")||k.startsWith("OPENCODE_")||["WL_HOME","XDG_DATA_HOME","CLAUDE_CONFIG_DIR","CODEX_HOME","COPILOT_HOME","VIBE_HOME","GEMINI_CLI_HOME","PI_CODING_AGENT_DIR"].includes(k))delete env[k];
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),XDG_CACHE_HOME:path.join(home,"cache"),MESH_CONF_DIR:path.join(home,"config","mesh"),MESH_ARTIFACTS_CMD:helper});
  try {
    const {stdout}=await run(process.env.MESH_PYTHON||path.join(root,".venv/bin/python"),["-c",String.raw`
import asyncio,json,os,sys
from pathlib import Path
from aiohttp import web
import server,respawn,sessiontoken
sys.path.insert(0,"tests")
from respawn_helpers import mesh_item
async def main():
    out={}; actual=server.artifact_lifecycle; command=server.artifact_command; drop=respawn.drop_lost
    knowledge={}
    for label,value in [
        ("absent",{"catalogue_present":False,"source_present":False,"references":[]}),
        ("legacy-empty",{"references":[]}),
        ("empty-existing-without-source",{"catalogue_present":True,"source_present":False,"references":[]}),
        ("explicit-zero",{"catalogue_present":True,"source_present":True,"references":[]}),
        ("nonempty",{"catalogue_present":True,"source_present":True,"references":[{}]}),
        ("malformed",{"catalogue_present":True,"source_present":True,"references":None}),
        ("wrong-proof-type",{"catalogue_present":1,"source_present":True,"references":[]}),
        ("unavailable",None)]:
        async def probe(*args,**kwargs):
            if value is None:raise web.HTTPServiceUnavailable()
            return value
        server.artifact_lifecycle=probe
        knowledge[label]=await server.artifact_transfer_required("fixture",1)
    out["knowledge"]=knowledge;server.artifact_lifecycle=actual
    helper=os.environ["MESH_ARTIFACTS_CMD"]; store=server.CONF_DIR/"session-artifacts.json"
    cases=[(mode,f) for mode in ("ordinary","exact") for f in ("pre-probe-disappear","disappear","native-disappear","unknown-disappear","replacement-empty","unproven-false","unproven-true","receipt-lost","fresh-empty","absent-source","empty-existing","nonempty-existing","corrupt-existing","unreadable-existing","unavailable-helper","never-enabled","confirmed-empty","unknown-probe-recovers")]+[("exact","legacy-marker"),("exact","legacy-false")]
    for index,(mode,fault) in enumerate(cases):
        key=mode+"-"+fault; old="offer"+str(index); created=index+1; born=2000+index
        backup=server.CONF_DIR/(key+"-backup.json")
        respawn.FILE=server.CONF_DIR/(key+"-snapshot.json")
        respawn.update([mesh_item(old,Path(os.environ["HOME"]),created,None)],listed=True);respawn.update([],listed=True)
        ref={"connector":"notes","id":key,"kind":"note","title":"fixture","url":"https://example.invalid/s/fixture","availability":"observed-present","created_at":1,"updated_at":1}
        has_refs=fault not in ("fresh-empty","absent-source","empty-existing","never-enabled","confirmed-empty","legacy-marker")
        state={"version":1,"sessions":[{"session":{"name":old,"created":created},"references":[ref]}] if has_refs else []}
        if fault in ("fresh-empty","empty-existing","confirmed-empty"):state["sessions"].append({"session":{"name":old,"created":created},"references":[]})
        store.write_text(json.dumps(state));store.chmod(0o600)
        if fault=="pre-probe-disappear":store.rename(backup)
        if fault=="corrupt-existing":backup.write_bytes(store.read_bytes());backup.chmod(0o600);store.write_text("corrupt catalogue")
        if fault=="unreadable-existing":store.chmod(0o000 if os.geteuid() else 0o644)
        os.environ["MESH_ARTIFACTS_CMD"]=helper
        if fault=="never-enabled":store.unlink()
        if fault in ("unavailable-helper","never-enabled"):os.environ["MESH_ARTIFACTS_CMD"]=str(Path(os.environ["HOME"])/"missing-helper")
        live=[]; launches=[]; transfers=[]; once=[True]; drop_once=[True]
        if fault in ("legacy-marker","legacy-false"):
            store.rename(backup);nonce=sessiontoken.new_nonce()
            respawn.begin_restoring(old,created,nonce,**({"artifacts_required":False} if fault=="legacy-false" else {}))
            live.append({"name":old,"created":born,"meta":{"nonce":nonce}})
        async def host(q):assert q=={"op":"list"};return list(live)
        async def create(name,*args,**kwargs):
            target=name if kwargs.get("exact") else "restored"+str(index);launches.append(target)
            live.append({"name":target,"created":born,"meta":{"nonce":kwargs.get("nonce") or sessiontoken.new_nonce()}})
            if fault=="confirmed-empty":os.environ["MESH_ARTIFACTS_CMD"]=str(Path(os.environ["HOME"])/"missing-helper")
            return target
        async def nothing(*args,**kwargs):return None
        async def sessions(**kwargs):return {"mesh":list(live),"external":[]}
        async def identity(e,expected):return e,None
        async def lifecycle(op,*args,**kwargs):
            if op=="list" and fault in ("unknown-disappear","fresh-empty","unknown-probe-recovers"):raise web.HTTPServiceUnavailable()
            if op=="transfer":
                transfers.append(True)
                if once[0] and fault in ("disappear","unknown-disappear","replacement-empty"):
                    once[0]=False;store.rename(backup)
                    if fault=="replacement-empty":await command({"op":"begin"})  # a legitimate writer initializes a different empty store
                if once[0] and fault.startswith("unproven-"):
                    once[0]=False;return {"transferred":fault=="unproven-true"}
            result=await actual(op,*args,**kwargs)
            if op=="transfer" and fault=="receipt-lost" and once[0]:once[0]=False;raise web.HTTPServiceUnavailable()
            return result
        async def artifact_command(body):
            if body["op"]=="transfer" and fault=="native-disappear" and once[0]:
                once[0]=False;store.rename(backup)  # after Python presence check, before native open
            return await command(body)
        def drop_lost(*args,**kwargs):
            if fault=="confirmed-empty" and drop_once[0]:drop_once[0]=False;raise OSError("fixture completion write failure")
            return drop(*args,**kwargs)
        server.host=host;server.new_session=create;server.sessions=sessions
        server._restore_identity=lambda e:(e,None);server._exact_identity=identity
        server.board.transfer=lambda *args:False;server.restore_organisation=nothing;server._transfer_restored_mail=nothing
        server.artifact_lifecycle=lifecycle;server.artifact_command=artifact_command;respawn.drop_lost=drop_lost;server.HELD_OFFERS.clear()
        app={"organisation_lock":asyncio.Lock(),"restore_lock":asyncio.Lock(),"recent_conversations":{}}
        expected={"name":old,"created":created,"agent_kind":respawn.SHELL_KIND,"resume_id":None,"cwd":str(Path(os.environ["HOME"]))}
        async def restore():
            return await server.restore_one(old,set(),app["organisation_lock"]) if mode=="ordinary" else await server.restore_exact(app,expected)
        try:first=await restore()
        except OSError as exc:first={"exception":type(exc).__name__}
        saved=respawn.lost_entry(old);target=live[0]["name"]
        if fault in ("corrupt-existing","unreadable-existing","unavailable-helper","confirmed-empty"):
            dest={"references":None}  # storage is deliberately not readable at this point
        else:dest=await actual("list",target,born)
        row={"first_ok":first.get("ok") is True,"first_pending":bool(saved and saved.get("restoring")),"warning":any(str(w).startswith("Artifact") for w in first.get("warnings",[])) or first.get("code")=="completion-failed" or first.get("exception")=="OSError","first_target_has_data":dest.get("references")==([ref] if has_refs else []),"known_empty_flag":bool(saved and saved.get("restoring",{}).get("artifacts_empty_confirmed") is True),"transfers":len(transfers)}
        if backup.exists():backup.rename(store)
        if fault=="unreadable-existing":store.chmod(0o600)
        if fault in ("legacy-marker","never-enabled","absent-source"):store.write_text(json.dumps({"version":1,"sessions":[{"session":{"name":old,"created":created},"references":[]}]}));store.chmod(0o600)
        if fault!="confirmed-empty":os.environ["MESH_ARTIFACTS_CMD"]=helper
        server.artifact_lifecycle=actual;server.artifact_command=command;respawn.drop_lost=drop;server.HELD_OFFERS.clear()
        second=await restore()
        os.environ["MESH_ARTIFACTS_CMD"]=helper
        dest=await actual("list",target,born)
        row.update({"second_ok":second.get("ok") is True,"launches":len(launches),"offer_finished":respawn.lost_entry(old) is None,"data_preserved":dest.get("references")==([ref] if has_refs else [])})
        out[key]=row
    print(json.dumps(out))
asyncio.run(main())
`],{cwd:root,env,timeout:30000,maxBuffer:1024*1024});
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  }finally{await rm(home,{recursive:true,force:true});}
})();}

for(const mode of ["ordinary","exact"]) for(const fault of ["pre-probe-disappear","disappear","native-disappear","unknown-disappear","replacement-empty","unproven-false","unproven-true","receipt-lost","fresh-empty","absent-source","empty-existing","nonempty-existing","corrupt-existing","unreadable-existing","unavailable-helper","never-enabled","confirmed-empty","unknown-probe-recovers"]){
  test(`${mode} transfer ${fault}: preserve proof and completion-only retry`,options,async()=>{
    const r=(await exercise())[`${mode}-${fault}`]!;
    if(["fresh-empty","empty-existing","nonempty-existing","unknown-probe-recovers"].includes(fault))assert.equal(r.first_ok,true);
    else {assert.equal(r.first_pending,true,JSON.stringify(r));assert.equal(r.warning,true,JSON.stringify(r));assert.equal(r.second_ok,true,JSON.stringify(r));}
    if(fault==="receipt-lost")assert.equal(r.first_target_has_data,true,"first move really committed");
    if(fault==="confirmed-empty"){assert.equal(r.known_empty_flag,true);assert.equal(r.transfers,0);}
    assert.equal(r.launches,1);assert.equal(r.offer_finished,true);assert.equal(r.data_preserved,true);
  });
}
test("legacy exact marker is unknown until a fresh existing-store empty proof",options,async()=>{
  const r=(await exercise())["exact-legacy-marker"]!;
  assert.equal(r.first_pending,true);assert.equal(r.warning,true);
  assert.equal(r.second_ok,true);assert.equal(r.launches,0);assert.equal(r.offer_finished,true);
});
test("legacy required=false is not affirmative empty evidence",options,async()=>{
  const r=(await exercise())["exact-legacy-false"]!;
  assert.equal(r.first_pending,true);assert.equal(r.warning,true);assert.equal(r.known_empty_flag,false);
  assert.equal(r.second_ok,true);assert.equal(r.launches,0);assert.equal(r.offer_finished,true);assert.equal(r.data_preserved,true);
});
test("knowledge predicate accepts only positive durable source-zero evidence",options,async()=>{
  assert.deepEqual((await exercise()).knowledge,{absent:true,"legacy-empty":true,"empty-existing-without-source":true,"explicit-zero":false,nonempty:true,malformed:true,"wrong-proof-type":true,unavailable:true});
});

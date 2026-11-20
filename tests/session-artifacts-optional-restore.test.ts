// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root,"ocaml/_build/default/bin/mesh_artifacts_main.exe");
const options = {skip: !existsSync(helper) && !process.env.MESH_REQUIRE_ARTIFACTS
  ? "built mesh-artifacts required; MESH_REQUIRE_ARTIFACTS=1 makes absence fail" : false};
let results: Promise<Record<string, Record<string, unknown>>> | undefined;
function exercise() {
  return results ??= (async () => {
    const home = await mkdtemp(path.join(tmpdir(),"mesh-optional-restore-"));
    const env = {...process.env};
    for (const k of Object.keys(env)) if (k.startsWith("MESH_") || k.startsWith("OPENCODE_") || ["WL_HOME","XDG_DATA_HOME","CLAUDE_CONFIG_DIR","CODEX_HOME","COPILOT_HOME","VIBE_HOME","GEMINI_CLI_HOME","PI_CODING_AGENT_DIR"].includes(k)) delete env[k];
    Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),XDG_CACHE_HOME:path.join(home,"cache"),MESH_CONF_DIR:path.join(home,"config","mesh"),MESH_ARTIFACTS_CMD:helper});
    try {
      const {stdout} = await run(process.env.MESH_PYTHON || path.join(root,".venv/bin/python"),["-c",String.raw`
import asyncio, json, os, sys
from pathlib import Path
import server, respawn, sessiontoken
sys.path.insert(0,"tests")
from respawn_helpers import mesh_item

async def main():
    out = {}; actual = server.artifact_lifecycle; original_begin = respawn.begin_restoring
    executable = os.environ["MESH_ARTIFACTS_CMD"]
    missing = str(Path(os.environ["HOME"])/"missing-artifacts-helper")
    store = server.CONF_DIR/"session-artifacts.json"
    for index,(fault,has_refs) in enumerate([(f,r) for f in ("corrupt","unreadable","helper") for r in (False,True)]+[("helper-after-empty",False),("absent-helper",False),("intent-write",False)]):
        key = fault + ("-refs" if has_refs else "-empty")
        respawn.FILE = server.CONF_DIR/(key+"-snapshot.json")
        old = "old"+str(index); created = index+1
        respawn.update([mesh_item(old,Path(os.environ["HOME"]),created,None)],listed=True); respawn.update([],listed=True)
        reference = {"connector":"notes","id":key,"kind":"note","title":"fixture","url":"https://example.invalid/s/fixture","availability":"observed-present","created_at":1,"updated_at":1}
        other = {"session":{"name":"unrelated","created":9999},"references":[{**reference,"id":"other-"+key}]}
        good = json.dumps({"version":1,"sessions":[other]+([{"session":{"name":old,"created":created},"references":[reference] if has_refs else []}] if has_refs or fault=="helper-after-empty" else [])}).encode()
        data = b"corrupt-prefix\n"+good if fault in ("corrupt","intent-write") else good
        store.write_bytes(data); store.chmod(0o600)
        os.environ["MESH_ARTIFACTS_CMD"] = executable
        if fault == "unreadable":
            # Root bypasses mode 000; unsafe public permissions exercise the same
            # real helper refusal there without pretending to test OS denial.
            store.chmod(0o000 if os.geteuid() else 0o644)
        if fault in ("helper","absent-helper"): os.environ["MESH_ARTIFACTS_CMD"] = missing
        if fault == "absent-helper": store.unlink()
        live = []; launches = []; transfers = []; intent_attempts = []
        async def host(q): assert q == {"op":"list"}; return list(live)
        async def create(name,*args,**kwargs):
            target = "restored"+str(index); launches.append(target)
            live.append({"name":target,"created":1000+index,"meta":{"nonce":kwargs.get("nonce") or sessiontoken.new_nonce()}})
            return target
        async def nothing(*args,**kwargs): return None
        async def lifecycle(op,*args,**kwargs):
            if op == "transfer": transfers.append(op)
            result = await actual(op,*args,**kwargs)
            if op == "list" and fault == "helper-after-empty": os.environ["MESH_ARTIFACTS_CMD"] = missing
            return result
        def unavailable_intent(*args,**kwargs): intent_attempts.append(True); raise OSError("fixture snapshot failure")
        server.host = host; server.new_session = create; server._restore_identity = lambda e:(e,None)
        server.board.transfer = lambda *args:False; server.restore_organisation = nothing; server._transfer_restored_mail = nothing
        server.artifact_lifecycle = lifecycle; server.HELD_OFFERS.clear()
        respawn.begin_restoring = unavailable_intent if fault == "intent-write" else original_begin
        first = {}
        try: first = await server.restore_one(old,set(),asyncio.Lock())
        except Exception as exc: first = {"exception":type(exc).__name__,"http_status":getattr(exc,"status",None)}
        if live:
            respawn.update([mesh_item(s["name"],Path(os.environ["HOME"]),s["created"],None) for s in live],listed=True)
        saved = respawn.lost_entry(old)
        row = {"first_ok":first.get("ok") is True,"warning":any(str(w).startswith("Artifact") for w in first.get("warnings",[])),"initial_launches":len(launches),"marker":bool(saved and saved.get("restoring",{}).get("mode") == "ordinary"),"intent_attempts":len(intent_attempts),"transfers":len(transfers),"offer_retained":saved is not None}
        row["first_exception"] = first.get("exception"); row["first_http_status"] = first.get("http_status")
        # Inspect the faulted bytes before operator-like repair. Never reset the
        # catalogue in product code merely because it was unreadable.
        if store.exists(): store.chmod(0o600); row["bytes_preserved"] = store.read_bytes() == data
        else: row["bytes_preserved"] = fault == "absent-helper"
        os.environ["MESH_ARTIFACTS_CMD"] = executable; respawn.begin_restoring = original_begin
        server.artifact_lifecycle = actual; server.HELD_OFFERS.clear()
        repaired = json.loads(good)
        if not has_refs and fault in ("corrupt","unreadable","helper","intent-write","absent-helper"):
            # Explicit operator confirmation for this unknown source scope;
            # an unrelated or newly initialized sparse store is not zero proof.
            repaired["sessions"].append({"session":{"name":old,"created":created},"references":[]})
        store.write_text(json.dumps(repaired)); store.chmod(0o600)
        second = await server.restore_one(old,set(),asyncio.Lock())
        row["second_ok"] = second.get("ok") is True
        row["launches_after_retry"] = len(launches)
        row["offer_finished"] = respawn.lost_entry(old) is None
        dest = await actual("list","restored"+str(index),1000+index)
        row["references_preserved"] = dest["references"] == ([reference] if has_refs else [])
        unrelated = await actual("list","unrelated",9999)
        row["unrelated_preserved"] = unrelated["references"] == other["references"]
        out[key] = row
    print(json.dumps(out))
asyncio.run(main())
`],{cwd:root,env,timeout:30000,maxBuffer:1024*1024});
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { await rm(home,{recursive:true,force:true}); }
  })();
}

for (const fault of ["corrupt","unreadable","helper"]) for (const refs of [false,true]) {
  test(`optional catalogue ${fault}, ${refs ? "existing references" : "no references"}: creation plus bound recovery`, options, async () => {
    const row = (await exercise())[fault+(refs ? "-refs" : "-empty")]!;
    assert.equal(row.first_ok,true,`optional catalogue must not prevent creation: ${JSON.stringify(row)}`);
    assert.equal(row.warning,true,"partial catalogue completion remains explicit");
    assert.equal(row.initial_launches,1); assert.equal(row.marker,true);
    assert.equal(row.bytes_preserved,true,"faulted data must not be replaced");
    assert.equal(row.second_ok,true); assert.equal(row.launches_after_retry,1,"retry is completion only");
    assert.equal(row.offer_finished,true); assert.equal(row.references_preserved,true);
    assert.equal(row.unrelated_preserved,true);
  });
}
test("known empty probe does not require a transfer if helper disappears", options, async () => {
  const row = (await exercise())["helper-after-empty-empty"]!;
  assert.equal(row.first_ok,true); assert.equal(row.warning,false);
  assert.equal(row.transfers,0); assert.equal(row.offer_retained,false);
  assert.equal(row.launches_after_retry,1);
});
test("no catalogue and no helper is unknown but creation and bound recovery remain available", options, async () => {
  const row = (await exercise())["absent-helper-empty"]!;
  assert.equal(row.first_ok,true); assert.equal(row.warning,true); assert.equal(row.marker,true);
  assert.equal(row.offer_retained,true); assert.equal(row.second_ok,true); assert.equal(row.offer_finished,true);
  assert.equal(row.launches_after_retry,1);
});
test("unknown catalogue does not create when the durable intent itself cannot be written", options, async () => {
  const row = (await exercise())["intent-write-empty"]!;
  assert.equal(row.first_ok,false); assert.equal(row.intent_attempts,1);
  assert.equal(row.initial_launches,0); assert.equal(row.offer_retained,true);
  assert.equal(row.bytes_preserved,true); assert.equal(row.second_ok,true);
  assert.equal(row.launches_after_retry,1);
});

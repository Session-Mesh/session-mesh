// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname,"..");
const nativeOptions = {skip:!existsSync(path.join(root,"ocaml/_build/default/bin/mesh_artifacts_main.exe")) && !process.env.MESH_REQUIRE_ARTIFACTS
  ? "built mesh-artifacts required; MESH_REQUIRE_ARTIFACTS=1 makes absence fail" : false};
let observations: Promise<Record<string,unknown>> | undefined;
async function exercise() {
  if (observations) return observations;
  observations = (async () => {
    const home = await mkdtemp(path.join(tmpdir(),"mesh-artifacts-review-"));
    const env = {...process.env};
    for (const k of Object.keys(env)) if (k.startsWith("MESH_") || k.startsWith("OPENCODE_") || ["WL_HOME","XDG_DATA_HOME","CLAUDE_CONFIG_DIR","CODEX_HOME","COPILOT_HOME","VIBE_HOME","GEMINI_CLI_HOME","PI_CODING_AGENT_DIR"].includes(k)) delete env[k];
    Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),XDG_CACHE_HOME:path.join(home,"cache"),MESH_CONF_DIR:path.join(home,"config","mesh"),MESH_ARTIFACTS_CMD:path.join(root,"ocaml/_build/default/bin/mesh_artifacts_main.exe")});
    try {
      const {stdout} = await run(process.env.MESH_PYTHON || path.join(root,".venv/bin/python"),["-c",String.raw`
import asyncio, json, os, sys, secrets, subprocess
from pathlib import Path
from aiohttp import web, ClientSession
import server, sessiontoken, agentmcp, respawn
sys.path.insert(0,"tests")
from respawn_helpers import mesh_item, claude, SID
async def main():
    out = {}; mutation_paths = []; waiting = asyncio.Event(); release = asyncio.Event()
    secret = secrets.token_hex(24)
    key = Path(os.environ["HOME"])/"notes-token"; key.write_text(secret); key.chmod(0o600)
    os.environ["MESH_NOTES_TOKEN_FILE"] = str(key)
    async def notes(request):
        assert request.headers.get("Authorization") == "Bearer "+secret
        q = await request.json(); method = q["method"]
        if method == "notifications/initialized": return web.Response(status=202)
        if method == "initialize": result = {"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}
        else:
            tool = q["params"]["name"]; args = q["params"]["arguments"]; p = args.get("path","")
            mutation_paths.append(p)
            if p == "delayed.md": waiting.set(); await release.wait()
            if tool == "mint_share":
                ident = "race" if p in ("race.md","delayed.md") else "shared"
                payload = {"id":ident,"token":secret,"share_url":str(request.url.origin())+"/s/"+secret,"scope_path":p.replace("/./","/"),"scope_kind":"note","target_present":True}
            elif tool == "revoke_share": payload = {"revoked":args.get("id") != "unconfirmed-revoke"}
            elif p.startswith("error-"): payload = {"status":"error","reason":p[6:].replace("-text","").replace(".md",""),"message":"fixture domain error"}
            elif p == "unknown.md": payload = {"status":"unexpected"}
            elif p == "malformed.md": payload = {"status":"error"}
            else: payload = {"status":"ok"}
            if p == "malformed-share.md": payload["share_url"] = "javascript:alert(1)"
            result = {"isError":False,"content":[{"type":"text","text":json.dumps(payload)}]}
            if not p.endswith("-text.md"): result["structuredContent"] = payload
            if p == "tool-error.md": result = {"isError":True,"content":[{"type":"text","text":"fixture"}]}
        return web.json_response({"jsonrpc":"2.0","id":q["id"],"result":result})
    nr = web.AppRunner(web.Application(),access_log=None); nr.app.router.add_post("/mcp",notes); await nr.setup()
    ns = web.TCPSite(nr,"127.0.0.1",0); await ns.start()
    os.environ["MESH_NOTES_MCP_URL"] = "http://127.0.0.1:"+str(ns._server.sockets[0].getsockname()[1])+"/mcp"
    nonces = {n:sessiontoken.new_nonce() for n in ("a","b")}
    live = [{"name":n,"created":i+1,"meta":{"nonce":nonces[n]}} for i,n in enumerate(nonces)]
    async def host(q): assert q == {"op":"list"}; return list(live)
    server.host = host
    app = web.Application(middlewares=[server.auth_mw]); app.router.add_post("/api/session-artifacts/@self/notes",server.api_session_notes); app.router.add_get("/api/session-artifacts/{name}",server.api_session_artifacts)
    mr = web.AppRunner(app,access_log=None); await mr.setup(); ms = web.TCPSite(mr,"127.0.0.1",0); await ms.start()
    base = "http://127.0.0.1:"+str(ms._server.sockets[0].getsockname()[1])
    async with ClientSession() as client:
        async def operation(n,tool,args):
            async with client.post(base+"/api/session-artifacts/@self/notes",headers={"Authorization":"MeshSession "+sessiontoken.issue(n,nonces[n])},json={"tool":tool,"arguments":args}) as r:
                return r.status, await r.json() if r.content_type == "application/json" else {}
        async def refs(n="a",created=1):
            async with client.get(base+"/api/session-artifacts/"+n+"?created="+str(created),headers={"Authorization":"Bearer "+server.TOKEN}) as r: return (await r.json())["references"]
        before = len(mutation_paths)
        denied,_ = await operation("a","create_note",{"path":"a.md","content":"x"})
        out["denied"] = denied == 403 and len(mutation_paths) == before
        grants = {"version":1,"sessions":[{**s,"tools":["create_note","replace_note","mint_share","revoke_share"]} for s in [{"name":n,"created":i+1,"nonce":nonces[n]} for i,n in enumerate(nonces)]]}
        grant_path = server.CONF_DIR/"notes-grants.json"; grant_path.write_text(json.dumps(grants)); grant_path.chmod(0o600)
        denied_cases = []
        for mutation in ("operation","nonce","created","permissions"):
            altered = json.loads(json.dumps(grants))
            if mutation == "operation": altered["sessions"][0]["tools"] = ["replace_note"]
            if mutation == "nonce": altered["sessions"][0]["nonce"] = sessiontoken.new_nonce()
            if mutation == "created": altered["sessions"][0]["created"] = 999
            grant_path.write_text(json.dumps(altered)); grant_path.chmod(0o644 if mutation == "permissions" else 0o600)
            before = len(mutation_paths)
            status,_ = await operation("a","create_note",{"path":"a.md","content":"x"})
            denied_cases.append(status == 403 and len(mutation_paths) == before)
        grant_path.write_text(json.dumps(grants)); grant_path.chmod(0o600)
        out["grant_scope"] = all(denied_cases)
        agentmcp.work_available = lambda:False
        os.environ.pop("MESH_NOTES_ADAPTER",None)
        default = agentmcp.mesh_servers("opencode",bridge=sys.executable)
        os.environ["MESH_NOTES_ADAPTER"] = "1"
        enabled = agentmcp.mesh_servers("opencode",bridge=sys.executable)
        mcp_input = '\n'.join(json.dumps(q) for q in [{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"tools/list"}])+"\n"
        exe = "ocaml/_build/default/bin/mesh_board_mcp_main.exe"
        def tool_names(args):
            p = subprocess.run([exe,*args],input=mcp_input,text=True,capture_output=True,env={**os.environ,"MESH_SESSION_TOKEN":"fixture"},timeout=5)
            replies = [json.loads(x) for x in p.stdout.splitlines()]
            return [t["name"] for r in replies if r.get("id") == 2 for t in r.get("result",{}).get("tools",[])]
        import fnmatch
        board_names = tool_names([]); notes_names = tool_names(["--notes"])
        old_policy = {"mesh-board_*":"allow"}
        out["namespace"] = (all(s.name != "mesh-notes" for s in default) and any(s.name == "mesh-notes" and s.args == ["--notes"] for s in enabled) and not any(n.startswith("notes_") for n in board_names) and len(notes_names) == 4 and all(n.startswith("notes_") for n in notes_names) and not any(fnmatch.fnmatch("mesh-notes_"+n,pattern) for n in notes_names for pattern in old_policy))
        statuses = []
        for tool,p in [("create_note","error-already_exists.md"),("replace_note","error-missing_target.md"),("create_note","ok.md"),("replace_note","ok-text.md"),("create_note","unknown.md"),("replace_note","malformed.md"),("replace_note","error-missing_target-text.md"),("create_note","tool-error.md")]:
            _,r = await operation("a",tool,{"path":p,"content":"x"}); statuses.append(r.get("status"))
        _,r = await operation("a","revoke_share",{"id":"unconfirmed-revoke"}); statuses.append(r.get("status"))
        _,r = await operation("a","mint_share",{"path":"malformed-share.md","label":"invalid result"}); statuses.append(r.get("status"))
        out["outcomes"] = statuses
        before = len(mutation_paths)
        _,r = await operation("a","mint_share",{"path":"a/./b.md","label":"normalized"})
        out["canonical"] = r.get("status") == "invalid" and len(mutation_paths) == before
        await operation("a","mint_share",{"path":"a.md","label":"A"})
        await operation("b","revoke_share",{"id":"shared"})
        a = [r for r in await refs() if r["id"] == "shared"]
        out["cross_session_revoke"] = len(a) == 1 and a[0]["availability"] == "revoked" and a[0]["url"] is None
        await operation("a","mint_share",{"path":"a.md","label":"fresh confirmation"})
        out["fresh_id_reuse"] = next(r for r in await refs() if r["id"] == "shared")["availability"] == "observed-present"
        await operation("a","mint_share",{"path":"race.md","label":"race"})
        pending = asyncio.create_task(operation("a","mint_share",{"path":"delayed.md","label":"late"}))
        await asyncio.wait_for(waiting.wait(),5)
        await operation("a","revoke_share",{"id":"race"}); release.set(); await pending
        race = [r for r in await refs() if r["id"] == "race"]
        out["ordered"] = len(race) == 1 and race[0]["availability"] == "revoked" and race[0]["url"] is None
    await mr.cleanup(); await nr.cleanup()
    # Actual snapshot, ordinary restore orchestration and native catalogue; only PTY creation,
    # unrelated mail/organisation effects and one transfer failure are fixture ports.
    respawn.FILE = server.CONF_DIR/"review-snapshot.json"
    respawn.update([mesh_item("old",Path(os.environ["HOME"]),10,None)],listed=True); respawn.update([],listed=True)
    existing = json.loads((server.CONF_DIR/"session-artifacts.json").read_text())
    old_ref = {"connector":"notes","id":"restore-ref","kind":"note","title":"old","url":"https://example.invalid/s/fixture","availability":"observed-present","created_at":1,"updated_at":1}
    existing["sessions"].append({"session":{"name":"old","created":10},"references":[old_ref]})
    (server.CONF_DIR/"session-artifacts.json").write_text(json.dumps(existing))
    live[:] = []; spawned = []
    async def create(name,*args,**kwargs):
        target = "restored"+str(len(spawned)); spawned.append(target)
        live.append({"name":target,"created":100+len(spawned),"meta":{"nonce":kwargs.get("nonce") or sessiontoken.new_nonce()}})
        return target
    async def nothing(*args,**kwargs): return None
    server.new_session = create; server._restore_identity = lambda e:(e,None)
    server.board.transfer = lambda *args:False; server.restore_organisation = nothing
    actual = server.artifact_lifecycle; failures = [True]
    async def flaky(op,*args,**kwargs):
        if op == "restore-transfer" and failures[0]: failures[0] = False; raise web.HTTPServiceUnavailable()
        return await actual(op,*args,**kwargs)
    server.artifact_lifecycle = flaky
    first = await server.restore_one("old",set(),asyncio.Lock())
    saved = respawn.lost_entry("old")
    server.HELD_OFFERS.clear()  # a process restart cannot rely on an in-memory hold
    second = await server.restore_one("old",set(),asyncio.Lock())
    target = spawned[0]
    moved = await actual("list",target,101)
    out["restore"] = (bool(saved and saved.get("restoring")) and first.get("ok") is True and second.get("ok") is True and len(spawned) == 1 and respawn.lost_entry("old") is None and any(r["id"] == "restore-ref" for r in moved["references"]))
    async def seed_offer(name,created,agent=None):
        live[:] = []
        respawn.update([mesh_item(name,Path(os.environ["HOME"]),created,agent)],listed=True); respawn.update([],listed=True)
        state = json.loads((server.CONF_DIR/"session-artifacts.json").read_text())
        state["sessions"].append({"session":{"name":name,"created":created},"references":[{**old_ref,"id":name+"-ref"}]})
        (server.CONF_DIR/"session-artifacts.json").write_text(json.dumps(state))
    await seed_offer("bindfail",11)
    bind = respawn.bind_restoring; fail_bind = [True]
    def bind_once(*args,**kwargs):
        if fail_bind[0]: fail_bind[0] = False; raise OSError("fixture bind failure")
        return bind(*args,**kwargs)
    respawn.bind_restoring = bind_once; count = len(spawned)
    try: await server.restore_one("bindfail",set(),asyncio.Lock())
    except OSError: pass
    marker = respawn.lost_entry("bindfail")["restoring"]
    server.HELD_OFFERS.clear()
    recovered = await server.restore_one("bindfail",set(),asyncio.Lock())
    out["bind_recovery"] = marker.get("mode") == "ordinary" and recovered.get("ok") is True and len(spawned) == count+1
    respawn.bind_restoring = bind
    await seed_offer("replaced",12); failures[0] = True; count = len(spawned)
    await server.restore_one("replaced",set(),asyncio.Lock())
    live[0]["meta"]["nonce"] = sessiontoken.new_nonce()
    refused = await server.restore_one("replaced",set(),asyncio.Lock())
    out["replaced_restore"] = refused.get("ok") is False and len(spawned) == count+1 and respawn.lost_entry("replaced") is not None
    await seed_offer("resumable",13,claude()); failures[0] = True; count = len(spawned)
    server._resume_argv = lambda agent:["synthetic-agent"]
    server._transfer_restored_mail = nothing
    running = set()
    first = await server.restore_one("resumable",running,asyncio.Lock())
    assert SID in running
    second = await server.restore_one("resumable",running,asyncio.Lock())
    out["resumable_recovery"] = first.get("ok") is True and second.get("ok") is True and second.get("resumed") is True and len(spawned) == count+1
    print(json.dumps(out))
asyncio.run(main())
`],{cwd:root,env,timeout:30000,maxBuffer:1024*1024});
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally { await rm(home,{recursive:true,force:true}); }
  })();
  return observations;
}
test("HIGH1: credentials and board wildcards do not authorize Notes", nativeOptions, async () => { const r=await exercise(); assert.equal(r.denied,true); assert.equal(r.namespace,true); assert.equal(r.grant_scope,true); });
test("HIGH2: structured/text domain outcomes are not MCP success flags", nativeOptions, async () => { const r=await exercise(); assert.deepEqual(r.outcomes,["upstream-error","upstream-error","success","success","uncertain","uncertain","upstream-error","upstream-error","uncertain","uncertain"]); });
test("HIGH3: ordinary restore retries completion without another shell", nativeOptions, async () => {const r=await exercise(); assert.equal(r.restore,true); assert.equal(r.bind_recovery,true); assert.equal(r.replaced_restore,true); assert.equal(r.resumable_recovery,true);});
test("HIGH4: confirmed revoke clears capability in another session", nativeOptions, async () => assert.equal((await exercise()).cross_session_revoke,true));
test("MED5: noncanonical paths are refused before mutation", nativeOptions, async () => assert.equal((await exercise()).canonical,true));
test("MED6: delayed observation cannot revive a confirmed revocation", nativeOptions, async () => {const r=await exercise(); assert.equal(r.ordered,true); assert.equal(r.fresh_id_reuse,true);});

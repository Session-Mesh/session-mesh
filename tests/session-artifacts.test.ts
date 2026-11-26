// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { parseSessionReferences } from "../static/session-artifacts.ts";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const reference = { connector:"notes", id:"fixture", kind:"note", title:"<img src=x>", url:"https://example.invalid/s/fixture", availability:"pending-target" };
test("reference schema rejects active schemes, credentials, duplicates and revoked links", () => {
  assert.equal(parseSessionReferences({references:[reference]})[0]!.title,"<img src=x>");
  for (const url of ["javascript:alert(1)","https://user:secret@example.invalid/","//example.invalid/","http://example.invalid/","https://example.invalid/\\evil"]) {
    assert.throws(() => parseSessionReferences({references:[{...reference,url}]}));
  }
  assert.throws(() => parseSessionReferences({references:[reference,reference]}));
  assert.throws(() => parseSessionReferences({references:[{...reference,availability:"revoked"}]}));
  assert.equal(parseSessionReferences({references:[{...reference,availability:"revoked",url:null}]}).length,1);
});

const helper = path.join(root,"ocaml/_build/default/bin/mesh_artifacts_main.exe");
for (const transport of ["application/json", "text/event-stream"]) test(`actual Mesh auth, native connector and durable catalogue via ${transport}`, {
  timeout:30000, skip:!existsSync(helper) && !process.env.MESH_REQUIRE_ARTIFACTS ? "built mesh-artifacts required; MESH_REQUIRE_ARTIFACTS=1 makes absence fail" : false,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(),"mesh-artifacts-test-"));
  const secret = randomBytes(24).toString("hex"), tokenFile = path.join(home,"upstream-token");
  await writeFile(tokenFile,secret,{mode:0o600});
  let calls = 0;
  const upstream = http.createServer(async (req,res) => {
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    assert.deepEqual(req.headers.accept?.split(",").map(value => value.trim()), ["application/json", "text/event-stream"]);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "notifications/initialized") {res.writeHead(202).end(); return;}
    let result: unknown = {protocolVersion:"2025-11-25",capabilities:{},serverInfo:{name:"fixture",version:"1"}};
    if (rpc.method === "tools/call") {
      calls++;
      const {name,arguments:args} = rpc.params;
      if (args.path === "diskfail.md") await chmod(path.join(home,"config","mesh","session-artifacts.json"),0o644);
      if (args.path === "churn.md") await new Promise(resolve => setTimeout(resolve,150));
      const share = {id:"fixture-share",token:secret,share_url:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/s/${secret}#${secret}`,scope_path:args.path,scope_kind:"note",target_present:false};
      result = {isError:false,structuredContent:name === "mint_share" ? share : name === "revoke_share" ? {revoked:true} : {status:"ok"},content:[]};
    }
    res.writeHead(200,{"content-type":`${transport}; charset=utf-8`});
    if (transport === "application/json") {
      res.end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
    } else {
      res.write("\uFEFF: opening\r\ndata:\r\n\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\ndata: {\r");
      await new Promise(resolve => setTimeout(resolve, 5));
      // Leave the stream open. The connector must return as soon as its response arrives.
      res.write(`\ndata: "jsonrpc":"2.0","id":${rpc.id},"result":${JSON.stringify(result)}\r\ndata: }\r\n\r\n`);
    }
  });
  await new Promise<void>(resolve => upstream.listen(0,"127.0.0.1",resolve));
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith("MESH_") || key.startsWith("OPENCODE_") || key === "WL_HOME") delete env[key];
  for (const key of ["XDG_DATA_HOME","COPILOT_HOME","VIBE_HOME","GEMINI_CLI_HOME","PI_CODING_AGENT_DIR","CLAUDE_CONFIG_DIR","CODEX_HOME"]) delete env[key];
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,"config"),XDG_CACHE_HOME:path.join(home,"cache"),
    MESH_CONF_DIR:path.join(home,"config","mesh"),MESH_NOTES_TOKEN_FILE:tokenFile,
    MESH_NOTES_MCP_URL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/mcp`,
    MESH_ARTIFACTS_CMD:helper});
  try {
    const {stdout} = await run(process.env.MESH_PYTHON || "python3",["-c", String.raw`
import asyncio, json, os
from aiohttp import web, ClientSession
import server, sessiontoken
async def main():
    nonce = sessiontoken.new_nonce()
    live = [{"name":"fixture","created":1,"meta":{"nonce":nonce}}]
    async def host(body):
        assert body == {"op":"list"}
        return list(live)
    server.host = host
    app = web.Application(middlewares=[server.auth_mw])
    app.router.add_post("/api/session-artifacts/@self/notes", server.api_session_notes)
    app.router.add_get("/api/session-artifacts/{name}", server.api_session_artifacts)
    runner = web.AppRunner(app, access_log=None); await runner.setup()
    site = web.TCPSite(runner,"127.0.0.1",0); await site.start()
    base = "http://127.0.0.1:" + str(site._server.sockets[0].getsockname()[1])
    headers = {"Authorization":"MeshSession " + sessiontoken.issue("fixture",nonce)}
    owner = {"Authorization":"Bearer " + server.TOKEN}
    grant_path = server.CONF_DIR / "notes-grants.json"
    grant_path.write_text(json.dumps({"version":1,"sessions":[{"name":"fixture","created":1,"nonce":nonce,"tools":["create_note","replace_note","mint_share","revoke_share"]}]}))
    grant_path.chmod(0o600)
    async with ClientSession() as client:
        async def operation(tool,args,extra=None,auth=None):
            async with client.post(base+"/api/session-artifacts/@self/notes",headers=auth or headers,json={"tool":tool,"arguments":args,**(extra or {})}) as r:
                return r.status, await r.json() if r.content_type == "application/json" else {}
        async def catalogue(created=1,auth=None):
            async with client.get(base+"/api/session-artifacts/fixture?created="+str(created),headers=auth or owner) as r:
                return r.status, await r.json() if r.content_type == "application/json" else {}
        assert (await operation("mint_share",{"path":"a.md","label":"A"},auth=owner))[0] == 401
        assert (await operation("mint_share",{"path":"a.md","label":"A"},extra={"session_id":"other"}))[0] == 400
        status,result = await operation("create_note",{"path":"a.md","content":"example"})
        assert status == 200 and result["status"] == "success" and result["catalogue"] == "not-applicable", result
        assert (await catalogue())[1]["references"] == []
        for _ in range(2):
            status,result = await operation("mint_share",{"path":"a.md","label":"A"})
            assert status == 200 and result["catalogue"] == "recorded", result
        status,result = await catalogue()
        assert status == 200 and len(result["references"]) == 1 and result["references"][0]["availability"] == "pending-target"
        assert (await catalogue(auth=headers))[0] == 401
        status,result = await operation("revoke_share",{"id":"fixture-share"})
        assert result["catalogue"] == "recorded", result
        assert (await catalogue())[1]["references"][0]["url"] is None
        status,result = await operation("mint_share",{"path":"diskfail.md","label":"A"})
        assert status == 200 and result["status"] == "success" and result["catalogue"] == "not-recorded", result
        os.chmod(server.CONF_DIR/"session-artifacts.json",0o600)
        pending = asyncio.create_task(operation("mint_share",{"path":"churn.md","label":"late"}))
        await asyncio.sleep(0.06)
        live[:] = [{"name":"fixture","created":2,"meta":{"nonce":sessiontoken.new_nonce()}}]
        status,result = await pending
        assert status == 200 and result["catalogue"] == "not-recorded", result
        assert (await catalogue(2))[1]["references"] == []
        assert (await operation("mint_share",{"path":"a.md","label":"A"}))[0] == 401
    await runner.cleanup()
    print("auth/dedup/create/revoke/partial/churn/isolation: PASS")
asyncio.run(main())
`],{cwd:root,env,timeout:25000});
    assert.match(stdout,/isolation: PASS/);
    assert.equal(calls,6,"exactly explicit operations; no publication on create, no mutation replay");
  } finally {
    await new Promise<void>(resolve => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
    await rm(home,{recursive:true,force:true});
  }
});

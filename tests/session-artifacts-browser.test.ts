// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Generated-asset component test, not full application acceptance.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright-core";
import { chromiumLaunchOptions } from "./helpers/browser-launch.ts";

test("Artifacts dialog: keyboard, narrow viewport, untrusted text, external link and stale response", {
  timeout:20000, skip:!process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? "MESH_CHROMIUM required" : false,
}, async () => {
  const js = await readFile(new URL("../static/pane-actions.js",import.meta.url),"utf8");
  const en = JSON.parse(await readFile(new URL("../static/i18n/en.json",import.meta.url),"utf8"));
  const fr = JSON.parse(await readFile(new URL("../static/i18n/fr.json",import.meta.url),"utf8"));
  for (const key of Object.keys(en).filter(k => k.startsWith("artifacts."))) assert.equal(typeof fr[key],"string");
  let delay = false;
  const server = http.createServer(async (req,res) => {
    if (req.url?.startsWith("/api/session-artifacts/")) {
      if (delay) await new Promise(resolve => setTimeout(resolve,150));
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({references:[{
        connector:"notes",id:"fixture",kind:"note",title:"<img src=x onerror=alert(1)>",
        availability:"pending-target",url:"https://example.invalid/s/fixture#capability",
      }]}));
    } else if (req.url === "/pane-actions.js") res.writeHead(200,{"content-type":"text/javascript"}).end(js);
    else res.writeHead(200,{"content-type":"text/html"}).end('<button id="info">Info</button><script src="/pane-actions.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM || "", ["--no-sandbox"]));
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    await page.evaluate((catalogue) => {
      const w = window as unknown as {MeshPaneActions:{openSessionArtifacts:(ports:unknown)=>void};current:boolean};
      w.current = true;
      document.querySelector<HTMLButtonElement>("#info")!.onclick = () => w.MeshPaneActions.openSessionArtifacts({
        document,name:"fixture",created:1,current:() => w.current,translate:(key:string) => catalogue[key] ?? key,
      });
    },en);
    await page.getByRole("button",{name:"Info",exact:true}).click();
    await page.getByRole("link",{name:"Open externally"}).waitFor();
    assert.equal(await page.locator("dialog img").count(),0);
    assert.match(await page.locator("dialog").innerText(),/<img src=x/);
    const link = page.getByRole("link");
    assert.equal(await link.getAttribute("rel"),"noopener noreferrer");
    assert.equal(await link.getAttribute("referrerpolicy"),"no-referrer");
    assert.ok((await page.locator("dialog").boundingBox())!.width <= 390);
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({state:"detached",timeout:1000});
    assert.equal(await page.locator("dialog").count(),0);
    assert.equal(await page.evaluate(() => document.activeElement?.id),"info");
    delay = true;
    await page.getByRole("button",{name:"Info",exact:true}).click();
    await page.evaluate(() => { (window as unknown as {current:boolean}).current = false; });
    await page.getByText("This session was replaced or closed.",{exact:false}).waitFor();
    assert.equal(await page.locator("dialog a").count(),0);
    await page.keyboard.press("Escape");
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

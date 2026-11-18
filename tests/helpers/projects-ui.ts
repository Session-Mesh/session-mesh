// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import {chromiumLaunchOptions} from './browser-launch.ts';

export class ProjectsUiFixture {
  private browser!: Browser;
  private server!: http.Server;
  private origin = '';
  private root: string;
  constructor(root: string) { this.root = root; }
  async start() {
    this.server = http.createServer((request,response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/sessions') {
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({mesh:[{id:'session-one',name:'session-one',kind:'mesh',created:1234,
          cwd:'/tmp/project',pid:123,label:'Session one'}],external:[],home:'/tmp',now:Date.now()/1000,management:{state:'observed',sessions:[]}})); return;
      }
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify(url.pathname==='/api/history'?{sessions:[],full:true,gen:'test'}:{available:false})); return;
      }
      const file = path.resolve(this.root, url.pathname==='/' ? 'static/index.html' : '.'+url.pathname);
      if (!file.startsWith(this.root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {response.writeHead(404).end();return;}
      const ext=path.extname(file);
      response.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css'} as Record<string,string>)[ext] ?? 'application/octet-stream');
      const body = fs.readFileSync(file);
      response.end(body);
    });
    await new Promise<void>(resolve=>this.server.listen(0,'127.0.0.1',resolve));
    this.origin=`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.browser=await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM ?? '', ['--no-sandbox','--mute-audio']));
  }
  async stop() { await this.browser?.close(); this.server?.close(); }
  async mountFollowup(page: Page, catalog: unknown, followupContext?: unknown) {
    const translations = JSON.parse(fs.readFileSync(path.join(this.root, 'static/i18n/en.json'), 'utf8'));
    await page.evaluate(async ({ catalog, followupContext, translations }) => {
      const module = await import('/static/projects.js');
      const previous = (window as unknown as { standalone?: { destroy: () => void } }).standalone; previous?.destroy();
      document.querySelector('#standalone-followup')?.remove();
      const root = document.createElement('section'); root.id = 'standalone-followup'; document.querySelector('#projects')!.append(root);
      const translate = (key: string, params: Record<string, string | number> = {}) => String(translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
      const value = catalog as { machine_id: string; projects: { id: string; sources: { id: string; summary: unknown }[] }[] };
      const project = value.projects[0]!, source = project.sources[0]!;
      (window as unknown as { standalone: unknown }).standalone = module.mountProjectFollowup({ root, summary: source.summary, project, source: source.id,
        machine: value.machine_id, translate, followupContext });
    }, { catalog, followupContext, translations });
  }

  async sessionPage(mobile=false,catalogOverride?:Record<string,string>,twoSessions=false,locale='en-US') {
    const page=await this.browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900},locale,hasTouch:mobile});
    let sockets=0; const input:(string|Buffer)[]=[]; let inventories=0;const projectRequests:string[]=[];
    let output = (_value:string) => { throw new Error('socket not ready'); };
    page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(pathname==='/api/sessions') inventories++;if(pathname==='/static/projects.js'||pathname==='/api/view')projectRequests.push(pathname);});
    await page.routeWebSocket('**/ws/**',socket=>{
      sockets++; socket.onMessage(message=>input.push(message));
      output = value => socket.send(Buffer.from(value));
      socket.send(Buffer.from('Ready\r\n'+Array.from({length:80},(_,i)=>`line ${i}\r\n`).join('')));
    });
    if(catalogOverride) await page.route('**/static/i18n/en.json*',route=>route.fulfill({json:catalogOverride}));
    if(twoSessions) await page.route('**/api/sessions',route=>route.fulfill({json:{mesh:[
      {id:'session-one',name:'session-one',kind:'mesh',created:1234,cwd:'/tmp/project',pid:123,label:'Session one'},
      {id:'session-two',name:'session-two',kind:'mesh',created:5678,cwd:'/tmp/second',pid:124,label:'Session two'},
    ],external:[],home:'/tmp',now:Date.now()/1000,management:{state:'observed',sessions:[]}}}));
    await page.goto(this.origin);
    await page.waitForFunction(expected=>typeof meshContext !== 'undefined' && panes.length > 0 && data.mesh.length===expected,twoSessions?2:1);
    await page.evaluate('openSession("session-one")');
    await page.waitForFunction('active?.conn?.terminal?.isOpen() && active.term.buffer.active.length > 80');
    await page.evaluate(`(() => {
      window.sessionEvidence={pane:active,term:active.term,conn:active.conn,terminal:active.conn.terminal};
      observePaneActions(active);
      window.sessionEvidence.target=paneTargets.capture(active,true);
      window.sessionEvidence.id=active.id;
      window.sessionEvidence.created=data.mesh.find(row=>row.id===active.id||row.name===active.id).created;
      document.querySelector('#line-text').value='pending draft';
      document.querySelector('#line-text').dispatchEvent(new Event('input',{bubbles:true}));
      active.noteUserScroll(false);
      active.term.scrollToLine(20);
      window.sessionViewport=active.term.buffer.active.viewportY;
    })()`);
    assert.ok(await page.evaluate('window.sessionViewport') > 0, 'nontrivial terminal viewport captured');
    assert.equal(await page.evaluate('!!sessionEvidence.target && paneTargets.valid(sessionEvidence.target)'),true,'exact action target captured from observed fixture inventory');
    assert.deepEqual(projectRequests,[], 'Sessions boot does not load Projects module or artifact');
    return {page,input,sockets:()=>sockets,inventories:()=>inventories,output:(value:string)=>output(value)};
  }
  async enter(page:Page,mobile=false) {
    if(mobile){await page.locator('#btn-mobile-actions').click();await page.locator('[data-mobile-action="btn-projects"]').click();}
    else await page.locator('#btn-projects').click();
    await page.locator('#projects').waitFor({state:'visible'});
  }
  async readableText(page:Page, selector:string) {
    const geometries=await page.locator(selector).evaluateAll(elements=>elements.map(element=>{
      const range=document.createRange();range.selectNodeContents(element);
      const box=element.getBoundingClientRect();
      return {text:element.textContent,client:element.clientWidth,scroll:element.scrollWidth,
        left:box.left,right:box.right,viewport:innerWidth,
        fragments:[...range.getClientRects()].map(rect=>({left:rect.left,right:rect.right}))};
    }));
    assert.ok(geometries.length>0, `expected visible text at ${selector}`);
    for(const geometry of geometries){
      assert.ok(geometry.scroll<=geometry.client+1, `${selector} scroll ${geometry.scroll} exceeds client ${geometry.client}`);
      assert.ok(geometry.left>=-1 && geometry.right<=geometry.viewport+1, `${selector} element outside viewport`);
      for(const fragment of geometry.fragments)
        assert.ok(fragment.left>=geometry.left-1 && fragment.right<=geometry.right+1, `${selector} text outside its element`);
    }
  }
  async continuity(page:Page, sockets:()=>number,input:(string|Buffer)[],sameViewport=true) {
    assert.equal(await page.evaluate(`active===window.sessionEvidence.pane && active.term===window.sessionEvidence.term
      && active.conn===window.sessionEvidence.conn && active.conn.terminal===window.sessionEvidence.terminal
      && active.conn.terminal.isOpen()`),true);
    assert.equal(await page.locator('#line-text').inputValue(),'pending draft');
    if(sameViewport) assert.equal(await page.evaluate('active.term.buffer.active.viewportY === window.sessionViewport'),true);
    assert.equal(await page.evaluate('paneTargets.valid(sessionEvidence.target) && active.id===sessionEvidence.id && data.mesh.find(row=>row.id===active.id||row.name===active.id).created===sessionEvidence.created'),true);
    assert.equal(sockets(),1);
    await page.evaluate('active.conn.terminal.queueInput(new TextEncoder().encode("continuity"))');
    await page.waitForTimeout(30);
    assert.ok(input.some(value=>Buffer.isBuffer(value)&&value.toString()==='continuity'));
  }
}

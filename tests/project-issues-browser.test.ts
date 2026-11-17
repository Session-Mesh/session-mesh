// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {ProjectsUiFixture} from './helpers/projects-ui.ts';
import {followupCatalog} from './helpers/project-followup-fixtures.ts';
import {parseProjectCatalog} from '../static/project-catalog.ts';

const root=path.resolve(import.meta.dirname,'..');
// Catalog/client/view integration with authored HTTP replies. Native workspace
// authentication and actual provider CLI/network access are qualified elsewhere.
test('Chrome issue reader: explicit source reads, labels, safe bodies, paging, source lifetime and Sessions',
  {timeout:60000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
    assert.ok(process.env.MESH_CHROMIUM);
    const result=await build({stdin:{contents:"export {ProjectCatalogView,ProjectDom} from './static/project-catalog-view.ts';export {issueReader} from './static/project-issue-client.ts';",resolveDir:root},bundle:true,platform:'browser',format:'esm',write:false});
    const fixture=new ProjectsUiFixture(root);
    try{
      await fixture.start();
      for(const width of [1560,390]){
        const {page,sockets,input}=await fixture.sessionPage(width===390);
        const requests:Record<string,unknown>[]=[];let staleReply=false;
        try{
          await page.setViewportSize({width,height:1000});await page.waitForTimeout(100);await page.evaluate('window.sessionViewport=active.term.buffer.active.viewportY');
          await fixture.enter(page,width===390);
          for(const file of ['marked.min.js','purify.min.js'])await page.route(`**/viewlib/${file}`,route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'static/vendor',file))}));
          await page.route('**/__issues-test.js',route=>route.fulfill({contentType:'text/javascript',body:result.outputFiles[0]!.text}));
          await page.route('**/api/projects/issues/v1',async route=>{
            const body=route.request().postDataJSON();requests.push(body);
            assert.equal(route.request().method(),'POST');assert.deepEqual(Object.keys(body).sort(),['boot','machine_id','page','project_id','revision','source_id']);
            assert.deepEqual([body.boot,body.machine_id,body.project_id,body.revision],['boot','host','one','configuration']);
            assert.ok(['github-ref','gitlab-ref'].includes(body.source_id));
            const provider=body.source_id==='github-ref'?'github':'gitlab';
            const row=(id:string,state:string,column:string,labels:string[])=>({id,native_identity:{host:provider+'.com',issue_id:String(9000+Number(id)),node_id:provider==='github'?'I_'+id:null,project_id:provider==='gitlab'?'123':null},title:'Same issue title <img src=x onerror=alert(1)>',state,column,
              labels:labels.map(name=>({name,color:'#c0ffee'})),assignees:['worker'],priority:'high',updated_at:'2026-11-17T00:00:00Z',
              description:'# Issue body\n\nSafe body marker\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1))',description_truncated:false});
            await route.fulfill({json:{kind:'mesh-project-issues-reply',version:1,...body,...(staleReply?{revision:'obsolete-revision'}:{}),status:'ok',issues:{provider,repository:'example/project',page:body.page,has_more:body.page===1,partial:false,observed_at:'2026-11-17T00:00:00Z',
              items:body.page===1?[row('7','source-open','todo',['bug','needs review']),row('8','source-blocked','blocked',['blocked']),row('9','source-closed','done',['bug'])]:[row('10','second-page-state','doing',['page two'])]}}});
          });
          const catalog=followupCatalog();
          catalog.projects[0]!.sources=[
            {id:'github-ref',kind:'github',label:'GitHub tasks',url:'https://github.com/example/project',status:'unconfigured',observed_at:'2026-11-17T00:00:00Z'},
            {id:'gitlab-ref',kind:'gitlab',label:'GitLab tasks',url:'https://gitlab.com/example/project',status:'unconfigured',observed_at:'2026-11-17T00:00:00Z'},
            {id:'linear-ref',kind:'linear',label:'Linear reference',url:'https://linear.app/example/team/EX',status:'unconfigured',observed_at:'2026-11-17T00:00:00Z'},
          ];assert.ok(parseProjectCatalog(catalog));
          const translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
          await page.evaluate(async({catalog,translations})=>{
            const {ProjectCatalogView,ProjectDom,issueReader}=await import('/__issues-test.js');
            const t=(key:string,values:Record<string,string|number>={})=>String(translations[key]??key).replace(/\{(\w+)\}/g,(_:string,k:string)=>String(values[k]??''));
            const host=document.createElement('section');host.id='issues-test';
            const status=document.createElement('p'),list=document.createElement('nav'),detail=document.createElement('section');host.append(status,list,detail);document.querySelector('#projects')!.append(host);
            const state={aborted:[] as string[],hold:false,release:null as null|(()=>void),view:null as unknown};(window as any).issuesTest=state;
            const factory=(source_id:string)=>{
              const reader=issueReader((url:string,options:RequestInit)=>fetch(url,options),{boot:'boot',machine_id:'host',project_id:'one',revision:'configuration',source_id});
              return {...reader,read:async(page:number,signal:AbortSignal)=>{
                signal.addEventListener('abort',()=>state.aborted.push(source_id),{once:true});const value=await reader.read(page,signal);(state as any).lastIdentity=value.items[0]?.nativeIdentity;
                if(state.hold&&source_id==='github-ref')return new Promise(resolve=>{state.release=()=>resolve(value);});return value;
              }};
            };
            const view=new ProjectCatalogView(new ProjectDom(document,t),status,list,detail,undefined,true,factory);state.view=view;view.render(catalog);
          },{catalog,translations});
          const host=page.locator('#issues-test'),source=host.getByLabel(translations['projects.followup.source'],{exact:true});
          assert.deepEqual(await source.locator('option').allTextContents(),['GitHub tasks','GitLab tasks']);
          assert.equal(requests.length,0,'mount does not fetch external issues');
          await host.getByRole('button',{name:'Read issues',exact:true}).click();await host.locator('.project-work-card').first().waitFor();
          assert.equal(requests.length,1);assert.equal(await host.locator('.project-work-card').count(),3);
          assert.deepEqual(await page.evaluate('(window.issuesTest).lastIdentity'),{host:'github.com',issueId:'9007',nodeId:'I_7',projectId:null});
          assert.match(await host.locator('.project-work-card').first().textContent()??'',/source-open/);assert.match(await host.textContent()??'',/needs review/);
          assert.equal(await host.locator('img,script,iframe').count(),0);const githubKey=await host.locator('.project-work-card').first().getAttribute('data-work-key');
          await host.getByLabel('Labels',{exact:true}).selectOption('bug');assert.equal(await host.locator('.project-work-card').count(),2);
          assert.equal(requests.length,1,'label filter is local to the observed page');
          await host.locator('.project-work-card').first().focus();await page.keyboard.press('Enter');await host.locator('.project-issue-detail .project-artifact-markdown[data-markdown-state="rendered"]').waitFor();
          assert.match(await host.locator('.project-issue-detail').textContent()??'',/Safe body marker/);
          assert.equal(await host.locator('.project-issue-detail script,.project-issue-detail img,.project-issue-detail iframe,.project-issue-detail a[href^="javascript:"]').count(),0);
          assert.equal(await host.getByRole('link',{name:'Open original issue ↗'}).getAttribute('href'),'https://github.com/example/project/issues/7');
          if(process.env.MESH_PROJECT_EVIDENCE){fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await host.locator('.project-issue-detail').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,`issues-body-${width}.png`)});}
          await host.locator('[data-followup-key="issues-next"]').click();await host.locator('.project-work-card').filter({hasText:'github · 10'}).waitFor();
          assert.equal(requests.at(-1)!.page,2);assert.equal(await host.locator('[data-followup-key="issues-next"]').isDisabled(),true);
          await host.getByRole('button',{name:'Refresh issues',exact:true}).click();await host.locator('.project-work-card').filter({hasText:'github · 10'}).waitFor();assert.equal(requests.at(-1)!.page,2,'refresh keeps the current observed page');
          await host.locator('[data-followup-key="issues-previous"]').click();await host.locator('.project-work-card').filter({hasText:'github · 7'}).waitFor();
          await page.evaluate('window.issuesTest.hold=true');await host.getByRole('button',{name:'Refresh issues',exact:true}).click();await page.waitForFunction('!!window.issuesTest.release');
          const beforeSwitch=requests.length;await source.selectOption('gitlab-ref');assert.equal(requests.length,beforeSwitch,'source switch waits for explicit Read issues');
          assert.equal(await page.evaluate('window.issuesTest.aborted.includes("github-ref")'),true);
          await host.getByRole('button',{name:'Read issues',exact:true}).click();await host.locator('.project-work-card').filter({hasText:'gitlab · 7'}).waitFor();
          await page.evaluate('window.issuesTest.release()');await page.waitForTimeout(50);
          assert.deepEqual(await page.evaluate('(window.issuesTest).lastIdentity'),{host:'gitlab.com',issueId:'9007',nodeId:null,projectId:'123'});
          assert.equal(await host.locator('.project-work-card').filter({hasText:'github ·'}).count(),0,'late old-source reply cannot publish');
          assert.notEqual(await host.locator('.project-work-card').first().getAttribute('data-work-key'),githubKey,'equal issue ID/title never conflates sources');
          const board=host.locator('.project-kanban');await board.scrollIntoViewIfNeeded();
          if(width===390){
            const lanes=board.locator('.project-kanban-lane');
            const boxes=await lanes.evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height};}));
            assert.ok(boxes.every((box,index)=>Math.abs(box.x-boxes[0]!.x)<1&&Math.abs(box.width-boxes[0]!.width)<1&&(!index||box.y>=boxes[index-1]!.y+boxes[index-1]!.height)),'phone issue statuses are full-width vertical sections');
            assert.equal(await board.evaluate(element=>getComputedStyle(element).maxHeight),'none','phone issue board uses page flow');
            assert.ok(await board.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'no internal horizontal issue travel');
            assert.equal(await host.locator('.project-work-inspector').count(),0);
            const first=lanes.first();await first.scrollIntoViewIfNeeded();const before=(await first.boundingBox())!;
            const x=before.x+before.width/2,y=Math.max(120,Math.min(800,before.y+80));
            const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
            for(const distance of [30,70,110])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-distance}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
            await page.waitForFunction(previous=>document.querySelector('#issues-test .project-kanban-lane')!.getBoundingClientRect().y<previous-20,before.y);
            assert.equal(await board.evaluate(element=>element.scrollLeft),0,'phone vertical scroll needs no horizontal board travel');
            assert.equal(await host.locator('.project-work-inspector').count(),0,'vertical touch does not select an issue');
          }else{
            await board.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(150);
            const overflow=await board.evaluate(element=>element.scrollWidth>element.clientWidth);if(overflow)assert.ok(await board.evaluate(element=>element.scrollLeft)>0,'desktop keyboard moves local lanes');
          }
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
          await board.evaluate(element=>element.scrollLeft=0);
          if(process.env.MESH_PROJECT_EVIDENCE){fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,`issues-${width}.png`)});}
          staleReply=true;await host.locator('[data-followup-key="issues-next"]').click();
          await host.getByText(translations['projects.issues.failed'],{exact:true}).waitFor();assert.equal(await host.locator('.project-work-card').count(),0,'obsolete scope cannot publish or retain an issue page');
          staleReply=false;await host.getByRole('button',{name:'Read issues',exact:true}).click();await host.locator('.project-work-card').filter({hasText:'gitlab · 7'}).waitFor();
          await page.evaluate('(window.issuesTest.view).suspend()');await host.evaluate(element=>element.remove());await page.locator('#projects-return').click();await fixture.continuity(page,sockets,input);
        }finally{await page.close();}
      }
    }finally{await fixture.stop();}
  });

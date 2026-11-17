// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import type {Locator,Page} from 'playwright-core';
import {ProjectsUiFixture} from './helpers/projects-ui.ts';
import {followupCatalog,roadmapObservation,roadmapTask,attemptObservation} from './helpers/project-followup-fixtures.ts';

const root=path.resolve(import.meta.dirname,'..');
async function geometry(page:Page,host:Locator,width:number){
  const chart=await host.locator('.project-kanban').boundingBox(),inspector=await host.locator('.project-work-inspector').boundingBox();
  assert.ok(chart&&inspector);
  if(width===1560)assert.ok(inspector.x>=chart.x+chart.width+10,'wide inspector sits beside the chart');
  else assert.ok(inspector.y>=chart.y+chart.height+10,'phone inspector sits below the chart');
  assert.ok(chart.height<=page.viewportSize()!.height*0.7+1,'Kanban is bounded to70vh');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
}
async function screenshot(page:Page,name:string){
  if(!process.env.MESH_PROJECT_EVIDENCE)return;
  fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,name)});
}
test('Chrome work inspectors: responsive Roster provenance, issue pan/focus, close return and Sessions',
  {timeout:60000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
    assert.ok(process.env.MESH_CHROMIUM);
    const module=await build({stdin:{contents:"export {ProjectDom} from './static/project-catalog-view.ts';export {ProjectIssueView} from './static/project-issue-view.ts';export {readIssue} from './static/project-issue-client.ts';",resolveDir:root},bundle:true,platform:'browser',format:'esm',write:false});
    const fixture=new ProjectsUiFixture(root);
    try{await fixture.start();for(const width of [1560,390]){
      const {page,sockets,input}=await fixture.sessionPage(width===390);
      try{
        await page.setViewportSize({width,height:width===1560?600:1000});await page.waitForTimeout(100);await page.evaluate('window.sessionViewport=active.term.buffer.active.viewportY');await fixture.enter(page,width===390);
        const tasks=Array.from({length:18},(_,i)=>roadmapTask({id:'queued-'+i,objective:'Queued task '+i}));
        tasks.push(roadmapTask({id:'working',objective:'Selected progress fixture',state:'active',attempts:1,
          assignment:{id:'attempt-1',assignee:'worker',runtime:'runtime',role:'implementer',route:null,model:null},timeline:[attemptObservation(1,{outcome:'active',ended_at:null})],
          progress:{status:'reported',source:'worker-reported',sequence:1,recorded_at:'2026-11-17T00:00:00Z',message:'Worker progress marker',current_step:'Checking inspector progress marker',reason:null}}));
        tasks.push(roadmapTask({id:'blocked',objective:'Selected blocker fixture',state:'blocked',attempts:60,
          timeline:Array.from({length:60},(_,i)=>attemptObservation(i+1)),blocker:'Visible blocker marker '+'long blocker text '.repeat(100)}));
        await fixture.mountFollowup(page,followupCatalog(roadmapObservation(tasks)));
        const roster=page.locator('#standalone-followup');await roster.locator('[data-followup-key="view-mode"]').selectOption('kanban');
        const blocked=roster.locator('[data-followup-key="row-blocked"]');await blocked.focus();await page.keyboard.press('Enter');
        assert.equal(await blocked.getAttribute('aria-pressed'),'true');
        const inspector=roster.getByRole('complementary',{name:'Work details',exact:true});await inspector.waitFor();await geometry(page,roster,width);
        if(width===390){const top=await inspector.evaluate(element=>element.getBoundingClientRect().top);assert.ok(top>=40&&top<850,'phone selection brings the inspector heading into view');}
        const validation=inspector.locator('details[data-followup-key="validation-blocked"]');assert.equal(await validation.evaluate((el:HTMLDetailsElement)=>el.open),false);
        assert.equal(await inspector.locator('.project-selected-blocker').isVisible(),true);assert.match(await inspector.locator('.project-selected-blocker').textContent()??'',/Visible blocker marker/);
        await validation.locator(':scope > summary').focus();await page.keyboard.press('Enter');assert.equal(await validation.evaluate((el:HTMLDetailsElement)=>el.open),true);
        assert.match(await validation.textContent()??'',/Source lineage/);const diagnostics=validation.locator('details');await diagnostics.locator('summary').click();assert.match(await diagnostics.textContent()??'',/blocker · valid/);
        await inspector.locator('details[data-followup-key="attempts-blocked"] > summary').click();
        const nextClaims=inspector.getByRole('button',{name:'Next claims',exact:true});await nextClaims.focus();await page.keyboard.press('Enter');
        if(width===1560){const target=await nextClaims.boundingBox(),bounds=await inspector.boundingBox();assert.ok(target&&bounds&&target.y>=bounds.y&&target.y+target.height<=bounds.y+bounds.height,'focused claim pager remains visible after repaint');}
        await inspector.locator('[data-followup-key="close-detail"]').click();assert.equal(await inspector.count(),0);
        assert.equal(await blocked.evaluate(el=>document.activeElement===el),true);assert.equal(await blocked.getAttribute('aria-pressed'),'false');
        const working=roster.locator('[data-followup-key="row-working"]');assert.equal(await working.locator('.project-work-status').textContent(),'Open assignment');assert.match(await working.getAttribute('title')??'',/work activity unknown/);
        await working.focus();await page.keyboard.press('Space');await geometry(page,roster,width);
        assert.equal(await inspector.locator('.project-selected-progress').isVisible(),true);assert.match(await inspector.locator('.project-selected-progress').textContent()??'',/Checking inspector progress marker/);
        await roster.locator('[data-followup-key="view-mode"]').focus();await page.keyboard.press('Escape');assert.equal(await inspector.count(),1,'Escape in a native select keeps the inspector');
        await inspector.scrollIntoViewIfNeeded();await screenshot(page,`roster-inspector-${width}.png`);
        await inspector.locator('[data-followup-key="close-detail"]').focus();await page.keyboard.press('Escape');assert.equal(await inspector.count(),0);
        assert.equal(await working.evaluate(el=>document.activeElement===el),true);assert.equal(await page.locator('#projects').isVisible(),true,'Escape closes only the work inspector');
        await roster.locator('[data-followup-key="view-mode"]').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#projects').isVisible(),false,'without inspector native select Escape reaches the Projects shortcut');await fixture.enter(page,width===390);
        await page.evaluate('window.standalone.destroy()');await roster.evaluate(el=>el.remove());
        // Existing component with authored IssueReader records, not live provider access.
        for(const file of ['marked.min.js','purify.min.js'])await page.route(`**/viewlib/${file}`,route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'static/vendor',file))}));
        await page.route('**/__work-inspector-test.js',route=>route.fulfill({contentType:'text/javascript',body:module.outputFiles[0]!.text}));
        const translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
        await page.evaluate(async translations=>{
          const {ProjectDom,ProjectIssueView,readIssue}=await import('/__work-inspector-test.js');
          const t=(k:string,p:Record<string,string|number>={})=>String(translations[k]??k).replace(/\{(\w+)\}/g,(_:string,n:string)=>String(p[n]??''));
          const columns=['todo','doing','blocked','done'];const items=Array.from({length:24},(_,i)=>readIssue({id:String(i+1),title:i===0?'Long issue title '.repeat(15).slice(0,240):'Issue inspector fixture '+i,state:'source-state-'+i,column:columns[i%4],
            labels:[{name:i===0?'other':'keep',color:'#c0ffee'}],assignees:[],priority:null,description:'# Inspector issue body\n\nVisible issue detail marker\n\n'+'Long issue detail paragraph.\n\n'.repeat(180),updated_at:'2026-11-17T00:00:00Z'},'scope','github','example/project'));
          const view=new ProjectIssueView(new ProjectDom(document,t),{scopeKey:'scope',read:async()=>{if((window as any).refreshHold)await new Promise(resolve=>(window as any).refreshRelease=resolve);return {items,page:1,hasMore:false,partial:false,observed:'2026-11-17T00:00:00Z'};}});
          view.root.id='inspector-issues-test';document.querySelector('#projects')!.append(view.root);(window as any).inspectorIssue=view;
        },translations);
        const issues=page.locator('#inspector-issues-test');await issues.getByRole('button',{name:'Read issues',exact:true}).click();
        const first=issues.locator('.project-work-card').first();await first.focus();await page.keyboard.press('Enter');await geometry(page,issues,width);
        const issueInspector=issues.getByRole('complementary',{name:'Work details',exact:true});await issueInspector.locator('.project-artifact-markdown[data-markdown-state="rendered"]').waitFor();assert.match(await issueInspector.textContent()??'',/Visible issue detail marker/);
        if(width===1560){
          await issueInspector.evaluate(element=>{element.scrollTop=400;(window as any).sameIssueInspector=element;});
          await first.evaluate(element=>element.focus({preventScroll:true}));await page.keyboard.press('Enter');
          assert.equal(await issueInspector.evaluate(element=>element===(window as any).sameIssueInspector),true,'same issue retains its rendered document DOM');
          assert.equal(await issueInspector.evaluate(element=>element.scrollTop),400,'same issue retains the long document position');
        }
        // Refresh must retain the same selected issue and restore after async Markdown.
        await issueInspector.evaluate((element,top)=>element.scrollTop=top,width===1560?400:0);
        await issues.getByRole('button',{name:'Refresh issues',exact:true}).click();
        await issues.locator('.project-work-card').first().waitFor();assert.equal(await issueInspector.count(),1,'refresh retains the selected issue');
        await issueInspector.locator('.project-artifact-markdown[data-markdown-state="rendered"]').waitFor();
        assert.match(await issueInspector.textContent()??'',/Visible issue detail marker/);
        if(width===1560)assert.equal(await issueInspector.evaluate(element=>element.scrollTop),400,'refresh restores the inspector position after Markdown rendering');
        if(width===1560){
          await issues.evaluate(root=>{
            const observer=new MutationObserver(()=>{
              const body=root.querySelector<HTMLElement>('.project-artifact-markdown[data-markdown-state="rendered"]');
              if(body){body.closest<HTMLElement>('.project-work-inspector')!.scrollTop=120;(window as any).readingPositionChanged=true;observer.disconnect();}
            });
            observer.observe(root,{subtree:true,attributes:true,attributeFilter:['data-markdown-state']});
          });
          await issues.getByRole('button',{name:'Refresh issues',exact:true}).click();await page.waitForFunction('!!window.readingPositionChanged');
          assert.equal(await issueInspector.evaluate(element=>element.scrollTop),120,'async restoration keeps a reading position changed before render completion');
        }
        await page.evaluate(()=>{(window as any).refreshHold=true;const button=document.createElement('button');button.id='refresh-outside';button.textContent='Other workspace control';document.body.append(button);});
        await issues.getByRole('button',{name:'Refresh issues',exact:true}).click();await page.waitForFunction('!!window.refreshRelease');await page.locator('#refresh-outside').focus();
        await page.evaluate(()=>{(window as any).refreshHold=false;(window as any).refreshRelease();});await issues.locator('.project-work-card').first().waitFor();
        assert.equal(await page.locator('#refresh-outside').evaluate(element=>document.activeElement===element),true,'late refresh does not steal another control focus');
        await page.locator('#refresh-outside').evaluate(element=>element.remove());
        const board=issues.locator('.project-kanban'),second=issues.locator('.project-work-card').nth(1);
        await board.evaluate(el=>{el.scrollLeft=120;el.scrollTop=80;});const pan=await board.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop}));
        await second.evaluate(el=>el.focus({preventScroll:true}));await page.keyboard.press('Enter');
        assert.deepEqual(await board.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop})),pan,'issue selection keeps local horizontal and vertical pan');
        assert.equal(await second.evaluate(el=>document.activeElement===el),true,'selection restores exact card focus');assert.equal(await second.getAttribute('aria-pressed'),'true');
        await issueInspector.scrollIntoViewIfNeeded();await screenshot(page,`issue-inspector-${width}.png`);
        await issueInspector.locator('[data-followup-key="close-detail"]').focus();await page.keyboard.press('Escape');assert.equal(await issueInspector.count(),0);assert.equal(await second.evaluate(el=>document.activeElement===el),true);assert.equal(await second.getAttribute('aria-pressed'),'false');
        await issues.getByLabel('Labels',{exact:true}).focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#projects').isVisible(),false,'without issue inspector native select Escape reaches Projects shortcut');await fixture.enter(page,width===390);
        await second.evaluate(el=>el.focus({preventScroll:true}));await page.keyboard.press('Enter');await board.evaluate(el=>{el.scrollLeft=100;el.scrollTop=60;});
        const beforeFilter=await board.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop}));const filter=issues.getByLabel('Labels',{exact:true});await filter.focus();await filter.selectOption('keep');
        assert.equal(await issueInspector.count(),0);assert.equal(await filter.evaluate(el=>document.activeElement===el),true,'filter focus survives repaint');
        const afterFilter=await board.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop,maxLeft:el.scrollWidth-el.clientWidth,maxTop:el.scrollHeight-el.clientHeight}));
        assert.equal(afterFilter.left,Math.min(beforeFilter.left,afterFilter.maxLeft));assert.equal(afterFilter.top,Math.min(beforeFilter.top,afterFilter.maxTop));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.evaluate('window.inspectorIssue.destroy()');await issues.evaluate(el=>el.remove());await page.locator('#projects-return').click();await fixture.continuity(page,sockets,input);
      }finally{await page.close();}
    }}finally{await fixture.stop();}
  });

test('Chrome Escape leaves Projects when a selected Roster task disappears',
  {timeout:30000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
    const code=await build({stdin:{contents:"export {mountProjectFollowup} from './static/project-followup-controller.ts';export {FollowupPreferenceStore} from './static/project-followup-preferences.ts';",resolveDir:root},bundle:true,platform:'browser',format:'esm',write:false});
    const fixture=new ProjectsUiFixture(root);
    try{await fixture.start();for(const mobile of [false,true]){
      const {page}=await fixture.sessionPage(mobile);
      try{
        await fixture.enter(page,mobile);await page.route('**/__missing-selection.js',route=>route.fulfill({contentType:'text/javascript',body:code.outputFiles[0]!.text}));
        const first=followupCatalog(roadmapObservation([roadmapTask({id:'removed'}),roadmapTask({id:'retained'})]));
        const next=followupCatalog(roadmapObservation([roadmapTask({id:'retained'})]));
        const translations=JSON.parse(fs.readFileSync(path.join(root,'static/i18n/en.json'),'utf8'));
        await page.evaluate(async({first,next,translations})=>{
          const {mountProjectFollowup,FollowupPreferenceStore}=await import('/__missing-selection.js');
          const host=document.createElement('section');host.id='missing-selection';document.querySelector('#projects')!.append(host);
          const preferences=new FollowupPreferenceStore('missing-selection');
          const translate=(key:string,values:Record<string,string|number>={})=>String(translations[key]??key).replace(/\{(\w+)\}/g,(_:string,name:string)=>String(values[name]??''));
          const mount=(catalog:typeof first)=>{const project=catalog.projects[0]!,source=project.sources[0]!;return mountProjectFollowup({root:host,summary:source.summary,project,source:source.id,machine:catalog.machine_id,translate,preferences});};
          let controller=mount(first);(window as any).missingSelection={remount:()=>{controller.destroy();controller=mount(next);},destroy:()=>controller.destroy()};
        },{first,next,translations});
        const host=page.locator('#missing-selection');await host.locator('[data-followup-key="view-mode"]').selectOption('kanban');
        await host.locator('[data-followup-key="row-removed"]').click();assert.equal(await host.locator('.project-work-inspector').count(),1);
        await page.evaluate('window.missingSelection.remount()');assert.equal(await host.locator('.project-work-inspector').count(),0);assert.match(await host.textContent()??'',/Selected entity no longer appears/);
        await host.locator('[data-followup-key="view-mode"]').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#projects').isVisible(),false);
        await page.evaluate('window.missingSelection.destroy()');
      }finally{await page.close();}
    }}finally{await fixture.stop();}
  });

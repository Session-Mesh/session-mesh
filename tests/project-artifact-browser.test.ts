// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {REPO,scratchHome,runServer,stopServer} from './mesh-server-lib.ts';
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const done=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await done;clearTimeout(timer);}
async function ready(file:string){for(let i=0;i<200;i++){const ok=await new Promise<boolean>(resolve=>{const socket=net.connect(file,()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));});if(ok)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('private native socket not ready');}
test('complete public Roster artifact through native scope, owner HTTP and Chrome desktop/phone', {timeout:90000,skip:!process.env.MESH_REQUIRE_PROJECT_ARTIFACTS&&(!process.env.MESH_NATIVE_PTYHOST||!process.env.MESH_CHROMIUM||!process.env.MESH_PROJECT_ROSTER_PIPELINE_CLI)?'optional public Roster reader runtime not configured':false},async()=>{
  const native=process.env.MESH_NATIVE_PTYHOST,cli=process.env.MESH_PROJECT_ROSTER_PIPELINE_CLI;
  assert.ok(native&&cli&&process.env.MESH_PYTHON&&process.env.MESH_CHROMIUM,'explicit private native/Python/Chrome/public CLI required');
  const where=await scratchHome('artifact-reader.');const fixtureMachine=crypto.randomUUID();
  assert.equal(where.env.MESH_CONF_DIR,where.confDir);fs.mkdirSync(where.confDir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(where.confDir,'projects.json'),JSON.stringify({kind:'mesh-project-config',schema_version:1,machine_id:fixtureMachine,projects:[]}),{mode:0o600,flag:'wx'});
  const root=path.join(where.home,'source');fs.mkdirSync(path.join(root,'briefs'),{recursive:true});
  const text='---\nmode: full\nstatus: NO-GO\nauthority: denied\n---\n# Complete project brief\n\n'+('é😀'.repeat(30000))+'\n\nEND COMPLETE ARTIFACT\n';
  fs.writeFileSync(path.join(root,'briefs','reader-intake.md'),text);fs.writeFileSync(path.join(root,'briefs','reader-state.json'),JSON.stringify({task:'reader',mode:'fast',current_phase:'implement',events:[{phase:'implement',outcome:'COMPLETED'}]}));
  Object.assign(where.env,{MESH_PROJECT_ROSTER_PIPELINE_CLI:cli,MESH_PROJECT_ROSTER_CLI:process.env.MESH_PROJECT_ROSTER_CLI});
  const host=spawn(native,[],{cwd:REPO,env:{...where.env,MESH_PROJECT_OBSERVATION_RUNTIME:process.execPath,MESH_PROJECT_OBSERVATION_ENTRY:path.join(REPO,'tools/project-observation.mjs')},stdio:'ignore'});
  let server:ChildProcess|undefined;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await ready(path.join(where.home,'run','session-mesh','ptyhost.sock'));const launched=await runServer(where);server=launched.child;assert.ok(launched.result.listened,launched.result.output);
    const origin=`http://127.0.0.1:${where.port}`,token=fs.readFileSync(path.join(where.confDir,'token'),'utf8').trim();
    const call=async(body:Record<string,unknown>)=>{const response=await fetch(origin+'/api/projects/v1',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({version:1,...body})});assert.equal(response.status,200);return response.json();};
    const caps=await call({op:'project_capabilities'}),list=await call({op:'project_list'}),id=crypto.randomUUID();
    assert.equal(list.status,'ok');assert.equal(list.machine_id,fixtureMachine);assert.equal(list.total,0);assert.equal(list.complete,true);assert.deepEqual(list.projects,[]);
    const created=await call({op:'project_create',boot:caps.boot,expected_revision:list.revision,request_id:id,project:{title:'Complete reader project'}});assert.equal(created.status,'ok');
    const configured=await call({op:'project_settings',boot:caps.boot,expected_revision:created.revision,request_id:crypto.randomUUID(),project_id:id,patch:{source_changes:[{type:'put',id:'reader-source',kind:'roster',label:'Project evidence',selector:{kind:'pipeline',root,task:'reader'}}],observation:{repository:false,source_ids:['reader-source']}}});assert.equal(configured.status,'ok',JSON.stringify(configured));
    browser=await chromium.launch({executablePath:process.env.MESH_CHROMIUM,args:['--no-sandbox','--mute-audio']});
    for(const width of [1560,390]){
      const context=await browser.newContext({viewport:{width,height:1000},locale:'en-US',hasTouch:width===390});assert.ok((await context.request.post(origin+'/login',{form:{token}})).ok());const page=await context.newPage();const reads:string[]=[];
      page.on('request',request=>{if(request.url().endsWith('/api/projects/artifacts/v1'))reads.push(request.postDataJSON().kind);});
      try{
        await page.goto(origin);if(width===390){await page.locator('#btn-mobile-actions').click();await page.locator('[data-mobile-action="btn-projects"]').click();}else await page.locator('#btn-projects').click();
        await page.locator('.cockpit-tabs').waitFor();await page.locator('[data-cockpit-tab="roster"]').click();
        const intake=page.locator('.project-artifact-item[data-artifact-kind="intake"]');await intake.waitFor({timeout:35000});await intake.click();
        await page.waitForFunction(()=>document.querySelector('.project-artifact-status')?.textContent?.includes('integrity verified'),{},{timeout:35000});
        assert.match(await page.locator('.project-artifact-content details pre').textContent()||'',/authority: denied/);
        assert.match(await page.locator('.project-artifact-content').innerText(),/END COMPLETE ARTIFACT/);assert.ok((await page.locator('.project-artifact-content').innerText()).length>90000);
        await page.getByRole('button',{name:'Complete source',exact:true}).click();
        assert.ok((await page.locator('.project-artifact-source').textContent())?.startsWith('---\nmode: full'));
        await page.locator('.project-artifact-pages').last().locator('button').last().click();
        assert.match(await page.locator('.project-artifact-source').textContent()||'',/END COMPLETE ARTIFACT/);
        await page.getByRole('button',{name:'Document',exact:true}).click();
        assert.ok(reads.filter(kind=>kind==='artifact-read').length>=2,'full body crossed actual public pages');assert.equal(await page.locator('.project-artifact-content script,.project-artifact-content img,.project-artifact-content iframe').count(),0);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        const documentBox=await page.locator('.project-artifact-document').boundingBox(),listBox=await page.locator('.project-artifact-list').boundingBox();
        assert.ok(documentBox&&documentBox.width>=250,'document has a usable reading width');
        if(width===390)assert.ok(documentBox!.y>=listBox!.y+listBox!.height,'phone document sits below the artifact list');
        if(process.env.MESH_PROJECT_EVIDENCE){fs.mkdirSync(process.env.MESH_PROJECT_EVIDENCE,{recursive:true});await page.locator('.project-artifact-browser').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.MESH_PROJECT_EVIDENCE,`artifact-native-${width}.png`)});}
        await page.locator('#projects-return').click();assert.equal(await page.locator('#projects').isVisible(),false);assert.ok((await context.request.get(origin+'/api/sessions')).ok());
      }finally{await context.close();}
    }
  }finally{await browser?.close();if(server)await stopServer(server);await stop(host);fs.rmSync(where.home,{recursive:true,force:true});}
});

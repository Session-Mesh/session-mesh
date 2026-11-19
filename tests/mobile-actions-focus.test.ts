// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import type {Page} from 'playwright-core';
import {ProjectsUiFixture} from './helpers/projects-ui.ts';

const root=path.resolve(import.meta.dirname,'..');
const focusedId=(page:Page)=>page.evaluate(()=>document.activeElement?.id??'');
const dialogClosed=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>{
  const sheet=document.querySelector<HTMLDialogElement>('#mobile-actions-sheet')!;
  if(!sheet.open){setTimeout(resolve,0);return;}
  sheet.addEventListener('close',()=>setTimeout(resolve,0),{once:true});
}));

test('mobile actions sheet: an action keeps the focus it moved, dismissal returns it to the button',
  {timeout:60000,skip:!process.env.MESH_CHROMIUM&&!process.env.MESH_REQUIRE_BROWSER?'MESH_CHROMIUM not configured':false},async()=>{
    assert.ok(process.env.MESH_CHROMIUM);
    const fixture=new ProjectsUiFixture(root);
    try{
      await fixture.start();
      const {page}=await fixture.sessionPage(true);
      await fixture.optIntoLegacy(page);
      try{
        assert.equal(page.viewportSize()!.width,390);
        await page.locator('#btn-mobile-actions').click();
        const closed=page.evaluate(()=>new Promise<void>(resolve=>{
          document.querySelector('#mobile-actions-sheet')!.addEventListener('close',()=>setTimeout(resolve,0),{once:true});
        }));
        await page.locator('[data-mobile-action="btn-projects"]').click();
        await closed;
        await page.locator('#projects-return').waitFor({state:'visible'});
        assert.equal(await focusedId(page),'projects-return','focus stays on the control the action moved it to');
        await page.locator('#projects-return').click();

        for(const dismissal of ['Escape','Cancel']){
          await page.locator('#btn-mobile-actions').click();
          await page.locator('#mobile-actions-sheet').waitFor({state:'visible'});
          if(dismissal==='Escape')await page.keyboard.press('Escape');
          else await page.locator('#mobile-actions-sheet [value=cancel]').click();
          await dialogClosed(page);
          assert.equal(await focusedId(page),'btn-mobile-actions',dismissal+' returns focus to the actions button');
        }
      }finally{await page.close();}
    }finally{await fixture.stop();}
  });

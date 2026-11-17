// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ProjectSource,ProviderSummary} from '../static/project-catalog.ts';
import {roadmapLifecycle} from '../static/project-roadmap-lifecycle.ts';
function source(patch:Partial<ProviderSummary>={}):ProjectSource{return {id:'roadmap',kind:'roster',label:'Roadmap',status:'available',observed_at:'2026-11-17T00:00:00Z',summary:{provider_schema:'roster-roadmap-view',provider_version:1,counts:{tasks_total:3,tasks_done:3},items:[],truncated:false,more:null,...patch}};}
test('all tasks reported done still waits for the actual global gate',()=>assert.equal(roadmapLifecycle(source({phase:'global-verification-needed',global_accepted:false})),'global-verification-needed'));
test('availability and absence of global receipt do not invent an active lifecycle',()=>{assert.equal(roadmapLifecycle(source({global_accepted:false})),'unknown');assert.equal(roadmapLifecycle(source({phase:'ready',global_accepted:false})),'ready');});
test('completion needs both the published completion phase and global acceptance',()=>{assert.equal(roadmapLifecycle(source({phase:'complete',global_accepted:true})),'complete');assert.equal(roadmapLifecycle(source({phase:'complete',global_accepted:false})),'inconsistent');assert.equal(roadmapLifecycle(source({phase:'complete'})),'unknown');assert.equal(roadmapLifecycle(source({phase:'active',global_accepted:true})),'inconsistent');});
test('withdrawn tasks never become a canceled roadmap',()=>assert.equal(roadmapLifecycle(source({phase:'canceled',counts:{withdrawn:3},global_accepted:false})),'unknown'));
test('an unavailable source does not keep an old completion badge',()=>assert.equal(roadmapLifecycle({...source({phase:'complete',global_accepted:true}),status:'unavailable'}),'unavailable'));

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {ProviderSummary} from './project-catalog.ts';
import {roadmapRows} from './project-followup-model.ts';

/** Recorded states only: an assignment is not proof of a live worker. */
export function workPreview(summary:ProviderSummary) {
  const rank=(state:string)=>state==='active'?0:state==='blocked'?1:state==='queued'?3:2;
  return roadmapRows(summary).filter(row=>row.state!=='done'&&row.state!=='accepted')
    .sort((a,b)=>rank(a.state)-rank(b.state)).slice(0,2);
}

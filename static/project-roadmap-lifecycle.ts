// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {ProjectSource} from './project-catalog.ts';
import {validValue} from './project-followup-model.ts';
export type RoadmapLifecycle='draft'|'ready'|'active'|'blocked'|'global-verification-needed'|'complete'|'unknown'|'inconsistent'|'unavailable';
/** Availability and task counts never establish a roadmap's lifecycle. */
export function roadmapLifecycle(source:ProjectSource):RoadmapLifecycle {
  if(source.status!=='available')return 'unavailable';
  const summary=source.summary;if(summary?.provider_schema!=='roster-roadmap-view')return 'unknown';
  const phase=summary.phase,accepted=validValue(summary.followup?.metadata)?.contract_accepted;
  const known=['draft','ready','active','blocked','global-verification-needed','complete'];
  if(!phase||!known.includes(phase))return 'unknown';
  if(accepted===false&&phase!=='draft'||accepted===true&&phase==='draft')return 'inconsistent';
  if(phase==='complete')return summary.global_accepted===true?'complete':summary.global_accepted===false?'inconsistent':'unknown';
  if(summary.global_accepted===true)return 'inconsistent';
  return phase as RoadmapLifecycle;
}

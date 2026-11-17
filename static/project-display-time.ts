// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {recordedInstant} from './project-followup-time.ts';
/** Local display only; the source timestamp remains unchanged in the observation. */
export function displayProjectTime(value:string|null|undefined,doc:Document,unknown:string):string {
  const instant=recordedInstant(value);if(instant===null)return unknown;
  return new Intl.DateTimeFormat(doc.documentElement.lang||'en',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(instant);
}

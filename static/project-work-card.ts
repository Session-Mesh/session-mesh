// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { FollowupRow } from './project-followup-model.ts';
import { validValue } from './project-followup-model.ts';

export type WorkProvider = 'roster' | 'github' | 'gitlab' | 'linear';
export type WorkColumn = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled' | 'unknown';
/** The source identity survives grouping; equal titles never establish a link. */
export interface WorkCard {
  key: string; selection: string; provider: WorkProvider; source: string; id: string;
  title: string; state: string; column: WorkColumn; meaning: string;
  labels: { name: string; color?: string }[]; assignees: string[]; priority: string | null;
  prerequisites: string[]; progress: string | null;
}
export function rosterWorkCard(row: FollowupRow, source: string): WorkCard {
  const assignment = row.detail ? validValue(row.detail.assignment) : null;
  const states: Record<string, WorkColumn> = { queued: 'todo', active: 'doing', blocked: 'blocked', done: 'done', cancelled: 'cancelled', canceled: 'cancelled' };
  return { key: JSON.stringify(['roster', source, row.id]), selection: row.key, provider: 'roster', source,
    id: row.id, title: row.title, state: row.state, column: states[row.state] ?? 'unknown', meaning: row.meaning,
    labels: [], assignees: assignment?.assignee ? [assignment.assignee] : [], priority: null,
    prerequisites: row.dependsOn, progress: row.worker };
}

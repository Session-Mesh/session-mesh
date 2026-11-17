// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectMembership } from './project-host.ts';

type Translate = (key: string) => string;
/** Validated owner metadata, never a session action or a liveness assertion. */
export function projectMembership(document: Document, membership: ProjectMembership, t: Translate): HTMLElement {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  const label = (key: string) => t('projectMembership.' + key);
  const root = el('section'); root.className = 'project-membership';
  root.append(el('h3', label('title')), el('p', label('scope')));
  if (!membership.complete) { const note = el('p', label('partial')); note.className = 'project-membership-warning'; root.append(note); }
  const section = (key: 'participations' | 'sessions', count: number | undefined) => {
    const group = el('section'); group.className = 'project-membership-group';
    group.append(el('h4', label(key) + (count === undefined ? '' : ' · ' + count)));
    if (count === undefined) group.append(el('p', label('omitted')));
    else if (!count) group.append(el('p', label('empty')));
    const list = el('div'); list.className = 'project-membership-list'; group.append(list); root.append(group); return list;
  };
  const identity = (parent: HTMLElement, name: string, created: number, machine?: string) => {
    parent.append(el('p', label('name') + ': ' + name), el('p', label('created') + ': ' + String(created)),
      el('p', label('machine') + ': ' + (machine ?? label('unknown'))));
  };
  const relationLabels = new Map([['active', t('projectMembership.active')], ['saved', t('projectMembership.saved')], ['historical', t('projectMembership.historical')]]);
  const participants = section('participations', membership.participations?.length);
  for (const person of membership.participations ?? []) {
    const row = el('details'); row.className = 'project-membership-row'; row.dataset.membershipKey = JSON.stringify(['participation', person.id, person.target]);
    const heading = el('summary'); heading.append(el('strong', person.label ?? person.id), el('span', relationLabels.get(person.recorded_relation)));
    row.append(heading, el('p', label('id') + ': ' + person.id));
    if (person.role_label !== undefined) row.append(el('p', label('role') + ': ' + person.role_label));
    if (person.target.kind === 'mesh') identity(row, person.target.name, person.target.created, person.target.machine_id);
    else row.append(el('p', label('agent') + ': ' + person.target.agent), el('p', label('conversation') + ': ' + person.target.conversation_id));
    if (person.work_refs?.length) {
      row.append(el('h5', label('references')));
      for (const ref of person.work_refs) row.append(el('p', [ref.source_id, ref.kind, ref.native_id, ref.instance_id].filter(value => value !== undefined).join(' · ')));
    }
    participants.append(row);
  }
  const sessions = section('sessions', membership.sessions?.length);
  for (const session of membership.sessions ?? []) {
    const row = el('details'); row.className = 'project-membership-row'; row.dataset.membershipKey = JSON.stringify(['session', session]);
    row.append(el('summary', session.name)); identity(row, session.name, session.created, session.machine_id); sessions.append(row);
  }
  return root;
}

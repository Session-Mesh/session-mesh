// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import type {ProjectDetail, ProjectHTTP} from './project-host.ts';
import {openSessionProjectAttachment} from './session-project-tools.ts';
import type {SessionToolReference, SessionToolReceipt} from './session-project-tools.ts';

export function projectSessionTools(ports: {
  document: Document; project: ProjectDetail; machine: string; request: ProjectHTTP;
  translate: (key: string) => string; current: () => boolean;
  live?: (reference: SessionToolReference) => boolean;
  open?: (reference: SessionToolReference, current: () => boolean) => void;
  confirmed?: (receipt: SessionToolReceipt) => void;
}): HTMLElement {
  const doc = ports.document, t = ports.translate;
  const root = doc.createElement('section'); root.className = 'project-session-tools';
  const title = doc.createElement('h3'); title.textContent = t('artifacts.projectTools');
  const hint = doc.createElement('p'); hint.textContent = t('artifacts.projectScope'); root.append(title, hint);
  if (!ports.project.sessions || ports.project.sessions.length !== ports.project.sessions_total) {
    const status = doc.createElement('p'); status.textContent = t('artifacts.projectUnavailable'); root.append(status); return root;
  }
  for (const row of ports.project.sessions) {
    const menu = doc.createElement('details'), heading = doc.createElement('summary');
    heading.textContent = `${row.name} · ${row.created} · ${t('artifacts.tools')}`; menu.append(heading);
    const identity = doc.createElement('p'); identity.textContent = row.machine_id ?? t('artifacts.projectUnavailable'); menu.append(identity);
    const reference = row.machine_id ? {name: row.name, created: row.created, machine_id: row.machine_id} : null;
    const artifacts = doc.createElement('button'); artifacts.type = 'button'; artifacts.dataset.tool = 'artifacts'; artifacts.textContent = t('artifacts.title');
    artifacts.disabled = !reference || reference.machine_id !== ports.machine || !ports.open;
    artifacts.onclick = () => {if (reference && reference.machine_id === ports.machine && ports.current()) ports.open?.(reference, ports.current);};
    const manage = doc.createElement('button'); manage.type = 'button'; manage.textContent = t('artifacts.projectTitle'); manage.disabled = !reference;
    manage.onclick = () => {
      if (!reference || !ports.current()) return;
      openSessionProjectAttachment({document: doc, request: ports.request, ...reference, project: ports.project.id,
        translate: t, scopeCurrent: ports.current, current: () => ports.current() && (ports.live?.(reference) ?? false),
        ...(ports.confirmed ? {confirmed: ports.confirmed} : {})});
    };
    menu.append(artifacts, manage); root.append(menu);
  }
  if (!ports.project.sessions.length) {const empty = doc.createElement('p'); empty.textContent = t('artifacts.projectEmpty'); root.append(empty);}
  return root;
}

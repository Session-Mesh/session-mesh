// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import type {ProjectHTTP, ProjectRequest, HostReply} from './project-host.ts';

export interface SessionToolReference {name: string; created: number; machine_id: string}
export interface SessionToolReceipt {project_id: string; machine_id: string; boot: string; revision: string; request_id: string}
export function sameSessionTool(a: SessionToolReference, b: SessionToolReference): boolean {
  return a.name === b.name && a.created === b.created && a.machine_id === b.machine_id;
}

/** Owner-authored metadata only: this never grants Notes access or resolves a session by name. */
export function openSessionProjectAttachment(ports: {
  document: Document; request: ProjectHTTP; name: string; created: number; machine_id?: string;
  translate: (key: string) => string; current: () => boolean;
  scopeCurrent?: () => boolean; project?: string;
  confirmed?: (receipt: SessionToolReceipt) => void;
}): void {
  let transport: typeof import('./project-host.ts') | null = null;
  const loading = import('./project-host.ts').then(value => {transport = value; return value;});
  const doc = ports.document, t = ports.translate, focus = doc.activeElement as HTMLElement | null;
  const dialog = doc.createElement('dialog'); dialog.className = 'session-project-tools';
  const heading = doc.createElement('h2'); heading.textContent = `${t('artifacts.projectTitle')} — ${ports.name} · ${ports.created}`;
  const hint = doc.createElement('p'); hint.textContent = t('artifacts.projectScope');
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const select = doc.createElement('select'); select.setAttribute('aria-label', t('artifacts.projectChoose'));
  const button = (key: string) => {const b = doc.createElement('button'); b.type = 'button'; b.textContent = t(key); return b;};
  const attach = button('artifacts.projectAttach'), detach = button('artifacts.projectDetach');
  const check = button('artifacts.projectCheck'), close = button('common.close');
  dialog.setAttribute('aria-label', t('artifacts.projectTitle'));
  dialog.append(heading, hint, select, attach, detach, check, status, close); doc.body.append(dialog);
  const abort = new AbortController(); let sequence = 0, busy = false;
  let boot = '', machine = '', selected: {id: string; revision: string; reference: SessionToolReference; attached: boolean} | null = null;
  let pending: ProjectRequest | null = null;
  const valid = () => dialog.open && !abort.signal.aborted && (ports.scopeCurrent?.() ?? true);
  const controls = () => {
    select.disabled = !valid() || busy || !!pending;
    attach.disabled = busy || !!pending || !selected || selected.attached || selected.reference.machine_id !== machine || !ports.current() || !valid();
    detach.disabled = busy || !!pending || !selected?.attached || !valid();
    check.disabled = busy || !pending || !valid();
  };
  const call = async (value: ProjectRequest) => (await loading).requestProject(ports.request, value, AbortSignal.any([abort.signal, AbortSignal.timeout(6500)]));
  const bound = (reply: HostReply) => reply.status === 'ok' && reply.boot === boot && reply.machine_id === machine;
  const notify = (reply: HostReply, value: ProjectRequest) => {
    if (!bound(reply) || reply.project_id !== value.project_id || reply.request_id !== value.request_id || !reply.project_id || !reply.request_id || !reply.revision || !reply.machine_id) return;
    ports.confirmed?.({project_id: reply.project_id, request_id: reply.request_id, revision: reply.revision, machine_id: reply.machine_id, boot: reply.boot});
  };
  const read = async () => {
    if (!valid()) return;
    const issue = ++sequence, id = select.value; selected = null; controls();
    try {
      const reply = await call({op: 'project_read', version: 1, project_id: id});
      if (!valid() || issue !== sequence || id !== select.value) return;
      if (!bound(reply) || reply.project?.id !== id || !reply.revision || !reply.project.sessions || reply.omitted_fields?.includes('sessions') || reply.project.sessions.length !== reply.project.sessions_total) throw Error('incomplete');
      const reference = {name: ports.name, created: ports.created, machine_id: ports.machine_id ?? machine};
      selected = {id, revision: reply.revision, reference, attached: reply.project.sessions.some(row => row.machine_id !== undefined && sameSessionTool(row as SessionToolReference, reference))};
      status.textContent = t(selected.attached ? 'artifacts.projectAttached' : 'artifacts.projectNotAttached');
    } catch {if (valid() && issue === sequence) status.textContent = t('artifacts.projectUnavailable');}
    controls();
  };
  const save = async (type: 'attach' | 'detach') => {
    const scope = selected;
    if (!valid()) {status.textContent = t('artifacts.projectChanged'); controls(); return;}
    if (busy || pending || !scope) return;
    if (type === 'attach' && (!ports.current() || scope.reference.machine_id !== machine)) {
      status.textContent = t('artifacts.stale'); controls(); return;
    }
    busy = true; controls();
    let value: ProjectRequest | null = null;
    try {
      value = {op: 'project_settings', version: 1, boot, expected_revision: scope.revision, project_id: scope.id,
        request_id: crypto.randomUUID(), patch: {session_changes: [{type, session: scope.reference}]}};
      const reply = await call(value);
      if (!valid() || selected !== scope || select.value !== scope.id) {notify(reply, value); return;}
      if (!bound(reply)) {status.textContent = t('artifacts.projectUnavailable'); selected = null; return;}
      status.textContent = t('artifacts.projectSaved'); notify(reply, value);
      if (valid()) await read();
    } catch (error) {
      if (!valid() || selected !== scope) return;
      if (value && transport && error instanceof transport.ProjectTransportError && error.reason === 'uncertain') {pending = value; status.textContent = t('artifacts.projectUncertain');}
      else {selected = null; status.textContent = t('artifacts.projectUnavailable');}
    } finally {busy = false; controls();}
  };
  attach.onclick = () => {void save('attach');}; detach.onclick = () => {void save('detach');};
  check.onclick = async () => {
    const value = pending; if (!value || busy || !valid()) return;
    busy = true; controls();
    try {
      const reply = await call({op: 'project_status', version: 1, project_id: value.project_id, request_id: value.request_id});
      if (pending !== value) return;
      if (bound(reply) && reply.intent_state === 'confirmed' && reply.intent_kind === 'settings') {
        pending = null; status.textContent = t('artifacts.projectSaved'); notify(reply, value);
        if (valid()) await read();
      }
      else if (valid()) status.textContent = t('artifacts.projectUncertain');
    } catch {if (valid()) status.textContent = t('artifacts.projectUncertain');}
    finally {busy = false; controls();}
  };
  select.onchange = () => {void read();};
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {abort.abort(); ++sequence; dialog.remove(); if (focus?.isConnected) focus.focus();}, {once: true});
  dialog.showModal(); controls(); status.textContent = t('artifacts.loading');
  void (async () => {
    try {
      const capability = await call({op: 'project_capabilities', version: 1});
      if (!valid()) return;
      if (capability.status !== 'ok' || !capability.features?.includes(transport!.PROJECT_SESSION_TOOLS_FEATURE)) throw Error('unsupported');
      boot = capability.boot;
      const list = await call({op: 'project_list', version: 1});
      if (!valid()) return;
      if (list.status !== 'ok' || list.boot !== boot || !list.machine_id || !list.projects?.length) throw Error('projects');
      machine = list.machine_id;
      for (const project of list.projects) {const option = doc.createElement('option'); option.value = project.id; option.textContent = project.title; select.append(option);}
      if (ports.project && list.projects.some(row => row.id === ports.project)) select.value = ports.project;
      await read();
    } catch {if (valid()) {status.textContent = t('artifacts.projectUnavailable'); controls();}}
  })();
}

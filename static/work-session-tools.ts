// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {openSessionArtifacts} from './session-artifacts.ts';

type Context = {instance_id: string; project_id: string; product_id: string; project_created: string};
type Session = {machine_id: string; name: string; created: number};
type Head = {id: string; product: string};
type Ports = {document: Document; project: Head; translate: (key: string) => string; current: () => boolean; fetch?: typeof fetch;
  fixedSession?: {name:string;created:number}};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => {
  if (record(a) && record(b)) {
    const keys=Object.keys(a).sort();
    return same(keys,Object.keys(b).sort()) && keys.every(key=>same(a[key],b[key]));
  }
  if(Array.isArray(a) && Array.isArray(b))return a.length===b.length && a.every((v,i)=>same(v,b[i]));
  return a===b;
};
// Both generated entry points share the document, not their module instances.
// No identity or authority is carried by this hint: every recipient re-resolves.
const changedEvent='mesh:work-session-tools-invalidated';
export function invalidateWorkSessionTools(doc:Document):void {
  const EventClass=doc.defaultView?.Event;
  if(EventClass)doc.dispatchEvent(new EventClass(changedEvent));
}

/** Canonical Work Projects only. The old local registry is deliberately not consulted. */
export function workSessionTools(ports: Ports): HTMLElement {
  const doc = ports.document, t = ports.translate, fetcher = ports.fetch ?? fetch;
  const root = doc.createElement('section'); root.className = 'work-session-tools';
  const title = doc.createElement('h3'); title.textContent = t('artifacts.projectTools');
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const identity = doc.createElement('p'); identity.textContent = `${ports.project.product} / ${ports.project.id}`;
  const scopeHint=doc.createElement('p');scopeHint.textContent=t('artifacts.workScope');
  const list = doc.createElement('div'), select = doc.createElement('select');
  select.setAttribute('aria-label', t('artifacts.workSession'));
  const button = (key: string) => {const b = doc.createElement('button'); b.type='button'; b.textContent=t(key); return b;};
  const refresh = button('projectWorkspace.refresh'), attach = button('artifacts.projectAttach'), check = button('artifacts.projectCheck');
  root.append(title, identity, scopeHint, status, list, select, attach, check, refresh);
  let context: Context | null = null, revision: number | null = null, machine = '', live: Session[] = [];
  let busy = false, epoch = 0, pending: Record<string, unknown> | null = null, invalidated=false;
  let inventoryLoaded = false;
  const valid = () => root.isConnected && ports.current();
  const drain = () => {
    if(!valid() || busy || pending || !invalidated)return;
    invalidated=false;void read();
  };
  const controls = () => {
    attach.disabled = busy || !!pending || !context || revision === null || !select.value || !valid();
    check.disabled = busy || !pending || !valid(); refresh.disabled = busy || !!pending;
    select.disabled = busy || !!pending;
  };
  const post = async (url: string, body: unknown) => {
    const response = await fetcher(url, {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('unavailable');
    return await response.json() as unknown;
  };
  const request = (action: string, session: Session | null = null, requestId: string | null = null) => ({
    op:'work-tools',action,context,session,request_id:requestId,revision,
  });
  const readContext = async (): Promise<Context> => {
    const wire = await post('/api/work/v1', {op:'attachment-context',
      args:{project:ports.project.id, product:ports.project.product}});
    if (!record(wire) || wire.command !== 'attachment-context' || wire.truncated !== false ||
        wire.project_id !== ports.project.id || wire.product_id !== ports.project.product ||
        typeof wire.instance_id !== 'string' || !/^[a-f0-9]{64}$/.test(wire.instance_id) ||
        typeof wire.project_created !== 'string') throw Error('context');
    return {instance_id:wire.instance_id,project_id:wire.project_id as string,
      product_id:wire.product_id as string,project_created:wire.project_created};
  };
  const render = (wire: unknown) => {
    if (!record(wire) || wire.status !== 'confirmed' || !same(wire.context,context) ||
        !Number.isSafeInteger(wire.revision) || !Array.isArray(wire.sessions)) throw Error('shape');
    revision=wire.revision as number; list.replaceChildren();
    for (const raw of wire.sessions) {
      if (!record(raw) || typeof raw.name !== 'string' || typeof raw.machine_id !== 'string' ||
          typeof raw.created !== 'number' || !Number.isFinite(raw.created)) throw Error('session');
      const session = raw as Session, row=doc.createElement('div');
      const label=doc.createElement('span'); label.textContent=`${session.name} · ${session.created}`;
      const open=button('artifacts.title'), detach=button('artifacts.projectDetach');
      open.disabled=session.machine_id!==machine || !live.some(s=>same(s,session));
      open.onclick=()=>{if(valid() && !open.disabled) openSessionArtifacts({document:doc,...session,translate:t,current:valid,fetch:fetcher});};
      detach.onclick=()=>{void mutate('detach',session);};
      row.append(label,open,detach);list.append(row);
    }
    status.textContent=t('artifacts.projectSaved');
  };
  const read = async () => {
    if (!valid() || busy || pending) return;
    const issue=++epoch; busy=true; context=null;revision=null;controls();
    try {
      const next=await readContext();
      context=next;
      const wire=await post('/api/projects/v1',request('read'));
      const signal = AbortSignal.timeout(10000);
      let inventory: unknown;
      // The server can answer while the first post-restart inventory is still being assembled.
      for (let attempt = 0; attempt < 5 && valid(); attempt++) {
        const response = await fetcher('/api/sessions', {credentials:'same-origin', signal});
        if (!response.ok) throw Error('inventory');
        inventory = await response.json() as unknown;
        if (!record(inventory) || inventory.complete !== false) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!record(wire) || typeof wire.machine_id!=='string' || !record(inventory) || inventory.complete!==true || !Array.isArray(inventory.mesh)) throw Error('inventory');
      if (!valid() || epoch!==issue) return;
      const previous = select.value === '' ? undefined : live[Number(select.value)];
      machine=wire.machine_id;live=[];select.replaceChildren();
      for(const raw of inventory.mesh) if(record(raw) && typeof raw.name==='string' && typeof raw.created==='number' && Number.isFinite(raw.created)) {
        if(ports.fixedSession && (raw.name!==ports.fixedSession.name || raw.created!==ports.fixedSession.created))continue;
        const session={name:raw.name,created:raw.created,machine_id:machine}; live.push(session);
        const option=doc.createElement('option');option.value=String(live.length-1);option.textContent=`${session.name} · ${session.created}`;select.append(option);
      }
      if (inventoryLoaded) select.selectedIndex = previous ? live.findIndex(session => same(session, previous)) : -1;
      inventoryLoaded = true;
      if(valid() && epoch===issue) render(wire);
    } catch {if(valid() && epoch===issue) {context=null;revision=null;list.replaceChildren();status.textContent=t('artifacts.projectUnavailable');}}
    finally {if(epoch===issue){busy=false;controls();drain();}}
  };
  const mutate = async (action: 'attach'|'detach', session: Session) => {
    if (!valid() || busy || pending || !context || revision===null) return;
    const scope=context;busy=true;controls();
    try {
      if(!same(await readContext(),scope) || !valid()) throw Error('stale');
      const value=request(action,session,crypto.randomUUID());
      pending=value; // Keep the exact intent if delivery or confirmation is uncertain.
      const wire=await post('/api/projects/v1',value);
      if(record(wire) && wire.status==='confirmed' && wire.request_id===value.request_id &&
          same(wire.context,scope))invalidateWorkSessionTools(doc);
      if(!valid() || context!==scope) return;
      if(!record(wire) || wire.request_id!==value.request_id) throw Error('receipt');
      render(wire);pending=null;
    } catch {if(valid())status.textContent=t(pending?'artifacts.projectUncertain':'artifacts.projectChanged');}
    finally {busy=false;controls();drain();}
  };
  select.onchange = controls;
  attach.onclick=()=>{const session=live[select.selectedIndex];if(session)void mutate('attach',session);};
  refresh.onclick=()=>{void read();};
  check.onclick=async()=>{
    if(!valid() || busy || !pending)return;
    const intent=pending;busy=true;controls();
    try {
      const wire=await post('/api/projects/v1',{...intent,action:'status'});
      if(!record(wire) || wire.status!=='confirmed' || wire.request_id!==intent.request_id)throw Error('unknown');
      if(!same(wire.context,intent.context) || !record(wire.receipt) ||
          wire.receipt.action!==intent.action || !same(wire.receipt.session,intent.session))throw Error('foreign receipt');
      invalidateWorkSessionTools(doc);
      if(!valid() || pending!==intent)return;
      render(wire);pending=null;
    } catch {if(valid())status.textContent=t('artifacts.projectUncertain');}
    finally {busy=false;controls();drain();}
  };
  // One subscription per mounted control, removed on detach or stale selection.
  // A single bit coalesces hints while a read/save/uncertain intent is active.
  const observer=new MutationObserver(()=>{if(!valid())dispose();});
  const dispose=()=>{doc.removeEventListener(changedEvent,invalidate);observer.disconnect();};
  const invalidate=()=>{if(!valid()){dispose();return;}invalidated=true;drain();};
  controls();queueMicrotask(()=>{
    if(!valid())return;
    doc.addEventListener(changedEvent,invalidate);
    observer.observe(doc.documentElement,{childList:true,subtree:true});
    void read();
  });return root;
}

/** Session Tools entry point into the same canonical project/product list as Projects. */
export function openWorkProjectAttachment(ports: {
  document: Document; name: string; created: number; translate:(key:string)=>string; current:()=>boolean;
  openLegacy?: ()=>void;
}): void {
  const doc=ports.document,t=ports.translate,dialog=doc.createElement('dialog');
  dialog.className='session-project-tools';dialog.setAttribute('aria-label',t('artifacts.projectTitle'));
  const heading=doc.createElement('h2');heading.textContent=t('artifacts.projectTitle');
  const choose=doc.createElement('select');choose.setAttribute('aria-label',t('artifacts.workProjectChoose'));
  const status=doc.createElement('p');status.setAttribute('role','status');
  const slot=doc.createElement('div'),close=doc.createElement('button');close.type='button';close.textContent=t('common.close');
  dialog.append(heading,choose,status,slot,close);doc.body.append(dialog);
  if(ports.openLegacy) {
    const legacy=doc.createElement('button');legacy.type='button';legacy.textContent=t('artifacts.legacyProjects');
    legacy.onclick=()=>{dialog.close();dialog.remove();ports.openLegacy?.();};dialog.append(legacy);
  }
  const focus=doc.activeElement as HTMLElement|null;let sequence=0;
  close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{sequence++;dialog.remove();if(focus?.isConnected)focus.focus();},{once:true});
  dialog.showModal();choose.disabled=true;status.textContent=t('artifacts.loading');
  void (async()=>{
    try {
      const response=await fetch('/api/work/v1',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'projects',args:{all:true}}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('unavailable');const wire:unknown=await response.json();
      if(!record(wire) || wire.command!=='projects' || wire.truncated!==false || !Array.isArray(wire.projects))throw Error('incomplete');
      if(!dialog.open)return;
      const projects:Head[]=[];
      for(const value of wire.projects) {
        if(!record(value)||typeof value.id!=='string'||typeof value.product!=='string'||typeof value.title!=='string')throw Error('shape');
        projects.push({id:value.id,product:value.product});
        const option=doc.createElement('option');option.value=String(projects.length-1);
        option.textContent=`${value.product} / ${value.id} — ${value.title}`;choose.append(option);
      }
      const select=()=>{
        const project=projects[Number(choose.value)];const issue=++sequence;slot.replaceChildren();
        if(!project)return;
        slot.append(workSessionTools({document:doc,project,translate:t,fixedSession:ports,
          current:()=>dialog.open&&issue===sequence&&ports.current()}));
      };
      choose.onchange=select;choose.disabled=false;status.textContent='';select();
    } catch {if(dialog.open)status.textContent=t('artifacts.projectUnavailable');}
  })();
}

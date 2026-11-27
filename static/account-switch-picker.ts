// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

type Agent = {type?: unknown; status?: unknown; session_id?: unknown; foreground?: unknown;
  pid?: unknown; started?: unknown};
type Session = {kind?: unknown; id?: unknown; created?: unknown; account?: unknown;
  account_context_revision?: unknown; default_context_revision?: unknown; switch_qualified?: unknown;
  agent?: Agent | null};
type SwitchBackend = 'claude' | 'codex' | 'pi';
export type SwitchSource = {id: string; created: number; agent: SwitchBackend; account: string;
  context_revision: string; conversation: string; agent_pid: number; agent_started: number};
export type SwitchTarget = {id: string; label: string; context_revision: string | null};
export type SwitchReceipt = {id: string; state: string; result?: {error?: string} | null};
type Remembered = {source: SwitchSource; id: string | null; state: string; error?: string};
type Profile = {backend?: unknown; id?: unknown; label?: unknown; context_revision?: unknown;
  enabled?: unknown; switch_qualified?: unknown; managed?: unknown};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const accountId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value);
const switchBackend = (value: unknown): value is SwitchBackend =>
  value === 'claude' || value === 'codex' || value === 'pi';

/** This is a presentation gate, not authority: the server checks the native host again. */
export function switchSource(session: Session | null | undefined, authoritative: boolean): SwitchSource | null {
  if (!authoritative || session?.kind !== 'mesh' || session.switch_qualified !== true
    || typeof session.id !== 'string'
    || !/^[A-Za-z0-9_-]{1,48}$/.test(session.id)
    || typeof session.created !== 'number' || !Number.isFinite(session.created) || session.created <= 0
    || !switchBackend(session.agent?.type)
    || session.agent.status !== 'idle' || session.agent.foreground !== true
    || typeof session.agent.pid !== 'number' || !Number.isSafeInteger(session.agent.pid) || session.agent.pid <= 0
    || typeof session.agent.started !== 'number' || !Number.isFinite(session.agent.started) || session.agent.started <= 0
    || typeof session.agent.session_id !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/.test(session.agent.session_id)) return null;
  const account = session.account == null || session.account === '' ? 'default' : session.account;
  const revision = account === 'default' ? session.default_context_revision : session.account_context_revision;
  if (!accountId(account) || !digest(revision) || (session.agent.type === 'pi' && account === 'default')) return null;
  return {id: session.id, created: session.created, agent: session.agent.type, account,
    context_revision: revision, conversation: session.agent.session_id,
    agent_pid: session.agent.pid, agent_started: session.agent.started};
}

export function sameSwitchSource(snapshot: SwitchSource, current: Session | null | undefined,
  authoritative = true): boolean {
  const latest = switchSource(current, authoritative);
  return latest !== null && Object.keys(snapshot).every(key =>
    latest[key as keyof SwitchSource] === snapshot[key as keyof SwitchSource]);
}

export function switchTargets(source: SwitchSource, profiles: readonly Profile[]): SwitchTarget[] {
  return profiles.filter(p => p.backend === source.agent && p.enabled === true && p.switch_qualified === true
    && p.managed !== true && accountId(p.id) && p.id !== 'default' && p.id !== source.account
    && !profiles.some(other => other.backend === source.agent && other.id !== p.id
      && typeof other.label === 'string' && other.label.toLowerCase() === p.id)
    && digest(p.context_revision) && typeof p.label === 'string' && p.label.length > 0)
    .map(p => ({id: p.id as string, label: p.label as string, context_revision: p.context_revision as string}));
}

export function createAccountSwitchPicker(dialog: HTMLDialogElement, ports: {
  source(): {session: Session; authoritative: boolean} | null;
  profiles(): Promise<readonly Profile[]>;
  submit(source: SwitchSource, target: SwitchTarget): Promise<SwitchReceipt>;
  status(id: string): Promise<SwitchReceipt>;
  label(session: Session): string;
  t(key: string, params?: Record<string, string>): string;
  notice(message: string): void;
}) {
  const doc = dialog.ownerDocument;
  const from = dialog.querySelector<HTMLElement>('[data-switch-from]')!;
  const to = dialog.querySelector<HTMLSelectElement>('[data-switch-to]')!;
  const warning = dialog.querySelector<HTMLElement>('[data-switch-warning]')!;
  const status = dialog.querySelector<HTMLElement>('[data-switch-status]')!;
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-switch-confirm]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[data-switch-cancel]')!;
  let selected: SwitchSource | null = null, targets: SwitchTarget[] = [], busy = false, sequence = 0;
  let trigger: HTMLElement | null = null;
  let displayedReceipt: Remembered | null = null, receiptGeneration = 0;
  const storageKey = 'mesh.accountSwitchReceipts.v1';
  const receipts = new Map<string, Remembered>();
  const keyOf = (session: Session) => `${session.id}:${session.created}:${session.agent?.type}`;
  try {
    const raw = doc.defaultView?.sessionStorage.getItem(storageKey);
    if (raw && raw.length <= 8192) {
      for (const item of JSON.parse(raw) as Remembered[]) {
        if (item?.source && typeof item.source.id === 'string' && typeof item.source.created === 'number'
          && switchBackend(item.source.agent)
          && (item.id === null || typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id)))
          receipts.set(keyOf({id: item.source.id, created: item.source.created,
            agent: {type: item.source.agent}}), item);
      }
    }
  } catch { /* storage is optional; the in-memory receipt still prevents replay on reopen */ }
  const remember = (receipt: Remembered) => {
    receipts.set(keyOf({id: receipt.source.id, created: receipt.source.created,
      agent: {type: receipt.source.agent}}), receipt);
    try { doc.defaultView?.sessionStorage.setItem(storageKey, JSON.stringify([...receipts.values()].slice(-20))); }
    catch { /* private storage can be unavailable */ }
  };
  const receiptFor = (session: Session | null | undefined) => session && receipts.get(keyOf(session));
  const showReceipt = (receipt: Remembered) => {
    to.parentElement!.hidden = true;
    to.disabled = true;
    confirm.disabled = true;
    cancel.textContent = ports.t('common.close');
    warning.textContent = '';
    const key = receipt.state === 'completed' ? 'completed'
      : receipt.state === 'failed' ? 'failed'
        : receipt.state === 'unknown' || receipt.state === 'execution_unknown' ? 'unknown' : 'admitted';
    status.textContent = ports.t(`accountSwitch.${key}`)
      + (key === 'failed' && receipt.error ? ` ${receipt.error}` : '');
  };
  const refreshReceipt = async (receipt: Remembered, generation: number) => {
    const displayed = () => dialog.open && receiptGeneration === generation && displayedReceipt === receipt;
    if (!receipt.id || !displayed()) return;
    try {
      const observed = await ports.status(receipt.id);
      if (!displayed()) return;
      if (observed.id !== receipt.id || !['approved', 'executing', 'completed', 'failed', 'execution_unknown'].includes(observed.state))
        throw new Error();
      receipt.state = observed.state;
      if (typeof observed.result?.error === 'string') receipt.error = observed.result.error;
      else delete receipt.error;
    } catch {
      if (!displayed()) return;
      receipt.state = 'unknown'; // A failed status read cannot establish a successful result.
    }
    remember(receipt);
    showReceipt(receipt);
    if (!['completed', 'failed', 'unknown', 'execution_unknown'].includes(receipt.state))
      doc.defaultView?.setTimeout(() => { void refreshReceipt(receipt, generation); }, 800);
  };
  const displayReceipt = (receipt: Remembered) => {
    displayedReceipt = receipt;
    showReceipt(receipt);
    void refreshReceipt(receipt, ++receiptGeneration);
  };
  const current = () => {
    const now = ports.source();
    return selected !== null && now && sameSwitchSource(selected, now.session, now.authoritative);
  };
  const revalidate = () => {
    if (!dialog.open || busy || !selected) return; // an admitted receipt remains visible during inventory changes
    if (!current()) {
      dialog.close();
      ports.notice(ports.t('accountSwitch.stale'));
    }
  };
  dialog.addEventListener('close', () => {
    selected = null;
    displayedReceipt = null;
    if (trigger?.isConnected && doc.activeElement === doc.body) trigger.focus();
    trigger = null;
  });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  to.addEventListener('change', () => {
    const target = targets.find(p => p.id === to.value);
    warning.textContent = target ? ports.t('accountSwitch.warning', {to: target.label}) : '';
  });
  confirm.addEventListener('click', () => {
    if (busy || !selected || !current()) {
      revalidate();
      return;
    }
    const target = targets.find(p => p.id === to.value);
    if (!target) return;
    busy = true; confirm.disabled = true; cancel.disabled = true; to.disabled = true;
    const source = selected;
    status.textContent = ports.t('accountSwitch.submitting');
    // No retry: an interrupted reply may still have scheduled the durable operation.
    void ports.submit(source, target).then(received => {
      if (!received || typeof received.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(received.id)
        || received.state !== 'approved') throw new Error();
      const receipt: Remembered = {source, id: received.id, state: received.state};
      selected = null;
      remember(receipt); displayReceipt(receipt);
    }).catch(() => {
      const receipt: Remembered = {source, id: null, state: 'unknown'};
      selected = null;
      remember(receipt); displayReceipt(receipt);
    }).finally(() => {
      busy = false; cancel.disabled = false;
      // Only an observed new session incarnation permits another submission.
    });
  });
  return {
    revalidate,
    hasReceipt: (session: Session | null | undefined) => !!receiptFor(session),
    async open(element: HTMLElement) {
      if (busy || dialog.open || doc.querySelector('dialog:modal')) return;
      const snapshot = ports.source();
      if (snapshot?.authoritative) {
        const previous = receiptFor(snapshot.session);
        if (previous) {
          selected = null; trigger = element;
          from.textContent = ports.t('accountSwitch.previous');
          dialog.showModal();
          displayReceipt(previous);
          cancel.focus();
          return;
        }
      }
      const source = snapshot && switchSource(snapshot.session, snapshot.authoritative);
      if (!source) return;
      const attempt = ++sequence;
      let profiles: readonly Profile[];
      try { profiles = await ports.profiles(); }
      catch { ports.notice(ports.t('accountSwitch.unavailable')); return; }
      const fresh = ports.source();
      if (attempt !== sequence || !fresh || !sameSwitchSource(source, fresh.session, fresh.authoritative)) {
        ports.notice(ports.t('accountSwitch.stale')); return;
      }
      targets = switchTargets(source, profiles);
      if (!targets.length) { ports.notice(ports.t('accountSwitch.noTargets')); return; }
      selected = source; trigger = element;
      to.parentElement!.hidden = false; to.disabled = false;
      cancel.textContent = ports.t('common.cancel');
      from.textContent = ports.t('accountSwitch.from', {session: ports.label(fresh.session),
        account: fresh.session.account === source.account && typeof fresh.session.account === 'string'
          ? String((fresh.session as Session & {account_label?: unknown}).account_label || source.account)
          : ports.t('list.accountDefault')});
      to.replaceChildren(...targets.map(target => {
        const option = doc.createElement('option'); option.value = target.id; option.textContent = target.label; return option;
      }));
      warning.textContent = ports.t('accountSwitch.warning', {to: targets[0]!.label});
      status.textContent = ''; confirm.disabled = false;
      dialog.showModal(); to.focus();
    },
  };
}

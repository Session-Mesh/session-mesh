// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// UI-04 only. These ports carry native public replies, not URLs or execution authority.
export const BACKENDS = ['claude', 'codex', 'opencode-v2', 'pi'] as const;
export type Backend = typeof BACKENDS[number];
export type Confirmation = 'ask' | 'skip';
export type AccountRef = Readonly<{backend: Backend; id: string; context_revision: string}>;
export type Profile = AccountRef & Readonly<{label: string; enabled: boolean; switch_qualified: boolean; managed?: true}>;
export type PairRule = Readonly<{a: AccountRef; b: AccountRef; confirmation: Confirmation}>;
export type Policy = Readonly<{version: 1; revision: number; global: Confirmation; pairs: readonly PairRule[]}>;
export type Registry = Readonly<{configured: boolean; registry_revision: string | null; profiles: readonly Profile[]}>;
export type Snapshot = Readonly<{registry: Registry; policy: Policy}>;
export type ProfileInput = Readonly<{backend: Backend; id: string; label: string; roots: Readonly<Record<string, string>>}>;
export type ProfileMutation = Readonly<{version: 1; op: 'profiles.create'; registry_revision: string | null; profile: ProfileInput}>;
export type ProvisionBackend = Exclude<Backend, 'pi'>;
export type ProvisionInput = Readonly<{backend: ProvisionBackend; label: string}>;
export type ProvisionMutation = Readonly<{version: 1; op: 'profiles.provision'; registry_revision: string | null; profile: ProvisionInput; operation_id?: string}>;
type BaseMutation = Readonly<{version: 1; expected_revision: number}>;
export type ConsentMutation = BaseMutation & (
  | Readonly<{op: 'consent.set_global'; confirmation: Confirmation}>
  | Readonly<{op: 'consent.reset'}>
  | Readonly<{op: 'consent.set_pair'; backend: Backend; source_id: string; target_id: string; registry_revision: string; confirmation: Confirmation}>
  | Readonly<{op: 'consent.remove_pair'; backend: Backend; source_id: string; target_id: string}>
);
export type BackendAccountPorts = Readonly<{
  /** Both values are complete mesh-profile public reply envelopes. No private resolve response. */
  load: (signal: AbortSignal) => Promise<{profiles: unknown; policy: unknown}>;
  /** Adapter authenticates the human request and maps the native request to its agreed transport. */
  mutate: (request: ConsentMutation, signal: AbortSignal) => Promise<unknown>;
  create?: (request: ProfileMutation, signal: AbortSignal) => Promise<unknown>;
  /** Read-only registry inspection is independent of the native write capability. */
  inspect?: (signal: AbortSignal) => Promise<unknown>;
  inspectProvision?: (signal: AbortSignal) => Promise<unknown>;
  acknowledgeProvision?: (proof: string, signal: AbortSignal) => Promise<unknown>;
  listProvisionReceipts?: (signal: AbortSignal) => Promise<unknown>;
  forgetProvisionReceipt?: (proof: string, signal: AbortSignal) => Promise<unknown>;
  provision?: Readonly<{backends: readonly ProvisionBackend[];
    managed?: true;
    write: (request: ProvisionMutation, signal: AbortSignal) => Promise<unknown>}> | undefined;
  timeoutMs?: number;
}>;
export type AccountState = Readonly<{
  phase: 'closed' | 'loading' | 'ready' | 'saving' | 'saved' | 'conflict' | 'refused' | 'error' | 'verification';
  snapshot: Snapshot | null;
  inspected?: Registry;
  refusal?: string;
  provisionPending?: 'provisionUncertain' | 'provisionVerification';
}>;

const invalid = (): never => { throw new Error('invalid-response'); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) return invalid();
  return row;
}
const backend = (value: unknown): Backend => BACKENDS.includes(value as Backend) ? value as Backend : invalid();
const id = (value: unknown): string => typeof value === 'string' && value.length >= 1 && value.length <= 32
  && !/[^a-z0-9-]/.test(value) && value !== 'default' ? value : invalid();
const digest = (value: unknown): string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
const confirmation = (value: unknown): Confirmation => value === 'ask' || value === 'skip' ? value : invalid();
const flag = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 48 || [...value].length > 24
    || !/\P{White_Space}/u.test(value) || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
    || value.replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, '') !== value) return invalid();
  return value;
}
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, c => c.toLowerCase());
const CONFLICTS = new Set(['consent-revision-conflict', 'profile-registry-changed', 'profile-context-changed',
  'profile-already-exists', 'profile-migration-required', 'profile-provision-unavailable',
  'consent-rule-capacity', 'consent-revision-exhausted']);
// Native precommit errors and the HTTP route's pre-helper queue refusal. Publication
// uncertainty is recognized below but is never a definite refusal.
const REFUSALS = new Map<string, number>([
  ...[...CONFLICTS].map(code => [code, 409] as const),
  ...['unknown-profile', 'profiles-unconfigured'].map(code => [code, 404] as const),
  ['request-too-large', 413],
  ['unsupported-media-type', 415],
  ['busy', 503],
  ...['invalid-request', 'unsupported-request-version', 'invalid-account-pair', 'invalid-account-reference',
    'profile-backend-mismatch', 'unsupported-operation'].map(code => [code, 400] as const),
  ...['disabled-profile', 'invalid-consent-policy', 'invalid-profile-config', 'unsafe-profile-roots',
    'migration-busy',
    'unsafe-configuration-root', 'unsafe-backend-store', 'invalid-backend-state', 'unsupported-backend-store-version',
    'backend-transaction-aborted', 'backend-store-busy', 'backend-journal-capacity'].map(code => [code, 503] as const),
  ['profile-publication-uncertain', 503],
]);
class ReplyFailure extends Error {
  readonly conflict: boolean;
  readonly code: string;
  constructor(code: string) { super('request-refused'); this.code = code; this.conflict = CONFLICTS.has(code); }
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const hasStatus = Object.hasOwn(value, 'http_status');
  const ok = (value as Record<string, unknown>).ok;
  const row = exact(value, ['version', 'ok', ok === true ? 'data' : 'code', ...(hasStatus ? ['http_status'] : [])]);
  if (row.version !== 1 || typeof ok !== 'boolean') return invalid();
  if (hasStatus && (ok ? row.http_status !== 200 : ![400, 404, 409, 413, 415, 503].includes(row.http_status as number))) return invalid();
  if (!ok) {
    if (typeof row.code !== 'string' || !REFUSALS.has(row.code)
      || (hasStatus && row.http_status !== REFUSALS.get(row.code))) return invalid();
    if (row.code === 'profile-publication-uncertain') throw new Error('publication-uncertain');
    throw new ReplyFailure(row.code);
  }
  return row.data;
}
function ref(value: unknown): AccountRef {
  const row = exact(value, ['backend', 'id', 'context_revision']);
  return {backend: backend(row.backend), id: id(row.id), context_revision: digest(row.context_revision)};
}
export function pairKey(a: AccountRef, b: AccountRef): string {
  if (backend(a.backend) !== backend(b.backend) || id(a.id) === id(b.id)) return invalid();
  digest(a.context_revision); digest(b.context_revision);
  return `${a.backend}:${[a.id, b.id].sort().join(':')}`;
}
export function parseProfilesReply(value: unknown): Registry {
  const row = exact(data(value), ['configured', 'registry_revision', 'profiles']);
  const configured = flag(row.configured);
  const registry_revision = configured ? digest(row.registry_revision) : row.registry_revision === null ? null : invalid();
  if (!Array.isArray(row.profiles) || row.profiles.length > 128 || (!configured && row.profiles.length !== 0)) return invalid();
  const profiles: Profile[] = [];
  for (const raw of row.profiles) {
    const managed = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'managed');
    const p = exact(raw, ['backend', 'id', 'context_revision', 'label', 'enabled', 'switch_qualified',
      ...(managed ? ['managed'] : [])]);
    if (managed && p.managed !== true) return invalid();
    const item: Profile = {backend: backend(p.backend), id: id(p.id), context_revision: digest(p.context_revision),
      label: label(p.label), enabled: flag(p.enabled), switch_qualified: flag(p.switch_qualified),
      ...(managed ? {managed: true} : {})};
    if (profiles.some(other => other.backend === item.backend && (other.id === item.id || asciiLower(other.label) === asciiLower(item.label)))) return invalid();
    profiles.push(item);
  }
  return {configured, registry_revision, profiles};
}
export function parsePolicyReply(value: unknown): Policy {
  const row = exact(data(value), ['version', 'revision', 'global', 'pairs']);
  if (row.version !== 1 || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || !Array.isArray(row.pairs) || row.pairs.length > 1024) return invalid();
  const keys = new Set<string>();
  const pairs = row.pairs.map(raw => {
    const r = exact(raw, ['a', 'b', 'confirmation']);
    let a = ref(r.a), b = ref(r.b);
    const key = pairKey(a, b);
    if (keys.has(key)) return invalid();
    keys.add(key);
    if (a.id > b.id) [a, b] = [b, a];
    return {a, b, confirmation: confirmation(r.confirmation)};
  });
  return {version: 1, revision: row.revision as number, global: confirmation(row.global), pairs};
}
/** Display-only precedence, never switch authority. Unknown/disabled/stale input references refuse. */
export function effectiveConfirmation(policy: Policy, registry: Registry, a: AccountRef, b: AccountRef): Confirmation {
  const key = pairKey(a, b);
  if (![a, b].every(ref => registry.profiles.some(p => p.backend === ref.backend && p.id === ref.id
    && p.context_revision === ref.context_revision && p.enabled))) return invalid();
  const rule = policy.pairs.find(rule => pairKey(rule.a, rule.b) === key);
  if (rule?.confirmation === 'ask') return 'ask';
  if (rule) {
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    if (rule.a.context_revision === first.context_revision && rule.b.context_revision === second.context_revision) return 'skip';
  }
  return policy.global;
}
export function ruleStatus(registry: Registry, rule: PairRule): 'current' | 'stale' | 'retired' | 'disabled' {
  const profiles = [rule.a, rule.b].map(ref => registry.profiles.find(p => p.backend === ref.backend && p.id === ref.id));
  if (profiles.some(p => !p)) return 'retired';
  if (profiles.some(p => !p!.enabled)) return 'disabled';
  return profiles.some((p, i) => p!.context_revision !== [rule.a, rule.b][i]!.context_revision) ? 'stale' : 'current';
}
const account = (p: AccountRef): AccountRef => ({backend: p.backend, id: p.id, context_revision: p.context_revision});
export const PROFILE_ROLES: Readonly<Record<Backend, readonly string[]>> = {
  claude: ['config', 'history'], codex: ['config', 'state'],
  'opencode-v2': ['config', 'data', 'state', 'cache'], pi: ['config', 'history'],
};
export function validProfileInput(input: ProfileInput): boolean {
  try {
    backend(input.backend); id(input.id); label(input.label);
    const roles = PROFILE_ROLES[input.backend];
    return !!input.roots && typeof input.roots === 'object' && !Array.isArray(input.roots)
      && Object.keys(input.roots).length === roles.length
      && roles.every(role => typeof input.roots[role] === 'string'
        && input.roots[role]!.length <= 1024
        && /^\/[A-Za-z0-9._+@/-]+$/.test(input.roots[role]!)
        && !input.roots[role]!.endsWith('/')
        && input.roots[role]!.split('/').slice(1).every(part => part && part !== '.' && part !== '..'));
  } catch { return false; }
}
export function validProvisionInput(input: ProvisionInput): boolean {
  try {
    const fields = exact(input, ['backend', 'label']);
    return backend(fields.backend) !== 'pi' && label(fields.label).length > 0;
  } catch { return false; }
}
function samePolicy(a: Policy, b: Policy): boolean {
  const normalized = (p: Policy) => JSON.stringify({...p, pairs: [...p.pairs].sort((a, b) => pairKey(a.a, a.b).localeCompare(pairKey(b.a, b.b)))});
  return normalized(a) === normalized(b);
}

import type {ProvisionJournal} from './backend-account-provision-journal.ts';

export function createBackendAccountController(ports: BackendAccountPorts, provisionJournal?: ProvisionJournal) {
  let state: AccountState = {phase: 'closed', snapshot: null};
  let generation = 0;
  let active: AbortController | null = null;
  type Receipt = {revision: string; profile: Profile};
  type PendingProvision = {snapshot: Snapshot | null; id?: string; receipt?: Receipt; owned?: boolean};
  let pending: PendingProvision | undefined;
  async function restoreProvision(snapshot: Snapshot | null): Promise<PendingProvision | undefined> {
    if (!provisionJournal) return;
    try {
      const saved = await provisionJournal.load();
      if (saved === null) return;
      return saved.value === 'uncertain' ? {snapshot, id: saved.id}
        : {snapshot, id: saved.id, receipt: profileReceipt(JSON.parse(saved.value))};
    } catch { return {snapshot}; }
  }
  async function remember(receipt?: Receipt) {
    if (!pending?.id) return;
    await provisionJournal?.save(pending.id, receipt ? JSON.stringify({version: 1, ok: true, data: {
      registry_revision: receipt.revision, profile: receipt.profile,
    }}) : 'uncertain');
  }
  async function clearPending() {
    if (pending?.id) await provisionJournal?.save(pending.id, null);
    pending = await restoreProvision(pending?.snapshot ?? null);
  }
  const listeners = new Set<(state: AccountState) => void>();
  const publish = (next: AccountState) => {
    if (pending && next.snapshot) pending.snapshot = next.snapshot;
    state = pending && next.phase !== 'closed' ? {...next,
      provisionPending: pending.receipt ? 'provisionVerification' : 'provisionUncertain'} : next;
    for (const listener of listeners) listener(state);
  };
  const writable = () => (state.phase === 'ready' || state.phase === 'saved') && !!state.snapshot;
  const currentRegistry = () => state.snapshot?.registry ?? state.inspected;
  const canAssociate = () => !pending && (state.phase === 'ready' || state.phase === 'saved') && !!currentRegistry();
  async function inspect(signal: AbortSignal): Promise<Registry> {
    if (!ports.inspect) throw new Error('registry-inspection-unavailable');
    return parseProfilesReply(await ports.inspect(signal));
  }
  const timeoutMs = Math.max(1, Math.min(60_000, ports.timeoutMs ?? 15_000));
  async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, abort: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('request-unconfirmed'));
      abort.signal.addEventListener('abort', onAbort, {once: true});
      timer = setTimeout(() => abort.abort(), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error('request-unconfirmed');
      return run(abort.signal);
    }), cancelled]); }
    finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); }
  }
  async function refresh(): Promise<void> {
    if (state.phase === 'closed' || state.phase === 'saving' || state.phase === 'loading') return;
    const request = ++generation, abort = new AbortController(); active = abort;
    publish({phase: 'loading', snapshot: null});
    try {
      if (pending?.owned && pending.id && !pending.receipt && provisionJournal
          && ports.listProvisionReceipts && ports.acknowledgeProvision) {
        const owned = pending, entry = await provisionJournal.load();
        if (request !== generation) return;
        if (!entry || entry.id !== owned.id) {
          const result = exact(data(await bounded(signal => ports.listProvisionReceipts!(signal), abort)), ['receipts']);
          if (!Array.isArray(result.receipts) || result.receipts.length > 256) return invalid();
          const matches = result.receipts.map(item => exact(item, ['proof', 'operation', 'outcome']))
            .filter(item => item.operation === owned.id);
          if (matches.length === 1) {
            const match = matches[0]!;
            if (typeof match.proof !== 'string' || !/^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[a-f0-9]{64}$/.test(match.proof)
                || (match.outcome !== 'published' && match.outcome !== 'unpublished')) return invalid();
            const confirmed = exact(data(await bounded(signal => ports.acknowledgeProvision!(match.proof as string, signal), abort)), ['outcome']);
            if (confirmed.outcome !== match.outcome) return invalid();
            if (request !== generation) return;
            if (pending === owned) pending = undefined;
          }
        }
      }
      if ((!pending || !pending.owned) && provisionJournal) {
        const restored = await restoreProvision(pending?.snapshot ?? null);
        if (request !== generation) return;
        pending = restored;
      }
      if (request !== generation) return;
      if (pending) {
        const operation = pending;
        const raw = operation.snapshot ? await bounded(ports.load, abort) : null;
        const registry = raw ? parseProfilesReply(raw.profiles) : await bounded(inspect, abort);
        if (request !== generation) return;
        const snapshot = raw ? {registry, policy: parsePolicyReply(raw.policy)} : null;
        const receipt = operation.receipt;
        if (receipt && verifies(registry, receipt)) {
          await clearPending();
          if (request !== generation) return;
          publish({phase: 'saved', snapshot, ...(!snapshot ? {inspected: registry} : {})});
        } else {
          // An unchanged registry, or a plausible matching row without a
          // validated receipt, cannot identify this particular write.
          publish({phase: 'ready', snapshot, ...(!snapshot ? {inspected: registry} : {})});
        }
        return;
      }
      const raw = await bounded(ports.load, abort);
      const snapshot = {registry: parseProfilesReply(raw.profiles), policy: parsePolicyReply(raw.policy)};
      if (request === generation) publish({phase: 'ready', snapshot});
    } catch { if (request === generation) publish({phase: 'error', snapshot: pending?.snapshot ?? null}); }
    finally { if (active === abort) active = null; }
  }
  async function write(request: ConsentMutation, expected: Policy): Promise<boolean> {
    if (!writable()) return false;
    const snapshot = state.snapshot!, token = ++generation, abort = new AbortController(); active = abort;
    publish({phase: 'saving', snapshot});
    try {
      const next = parsePolicyReply(await bounded(signal => ports.mutate(request, signal), abort));
      if (!samePolicy(next, expected)) return invalid();
      if (token !== generation) return false;
      publish({phase: 'saved', snapshot: {...snapshot, policy: next}}); return true;
    } catch (error) {
      if (token === generation) publish({phase: error instanceof ReplyFailure ? error.conflict ? 'conflict' : 'refused' : 'error',
        snapshot, ...(error instanceof ReplyFailure ? {refusal: error.code} : {})});
      return false;
    } finally { if (active === abort) active = null; }
  }
  const base = (): BaseMutation => ({version: 1, expected_revision: state.snapshot!.policy.revision});
  const next = (): Policy => ({...state.snapshot!.policy, revision: state.snapshot!.policy.revision + 1});
  function profileReceipt(value: unknown): Receipt {
    const created = exact(data(value), ['registry_revision', 'profile']);
    const revision = digest(created.registry_revision);
    const parsed = parseProfilesReply({version: 1, ok: true,
      data: {configured: true, registry_revision: revision, profiles: [created.profile]}});
    return {revision, profile: parsed.profiles[0]!};
  }
  function verifies(registry: Registry, receipt: Receipt): boolean {
    return registry.registry_revision === receipt.revision
      && registry.profiles.some(p => JSON.stringify(p) === JSON.stringify(receipt.profile));
  }
  async function saveProfile(profile: ProfileInput): Promise<boolean> {
      const snapshot = state.snapshot, registry = currentRegistry()!, token = ++generation;
      const abort = new AbortController(); active = abort;
      const current = {snapshot, ...(!snapshot ? {inspected: registry} : {})};
      publish({phase: 'saving', ...current});
      let receiptValidated = false;
      try {
        const receipt = profileReceipt(await bounded(signal => ports.create!({version: 1, op: 'profiles.create',
          registry_revision: registry.registry_revision, profile}, signal), abort));
        const answer = receipt.profile;
        if (answer.backend !== profile.backend || answer.label !== profile.label
          || !answer.enabled || answer.switch_qualified || answer.id !== profile.id) return invalid();
        receiptValidated = true;
        if (pending) {
          // Association is a distinct write; its receipt must never settle a creation journal.
          const registry = await bounded(inspect, abort);
          if (!verifies(registry, receipt) || token !== generation) return invalid();
          publish({phase: 'saved', snapshot: snapshot ? {...snapshot, registry} : null,
            ...(!snapshot ? {inspected: registry} : {})});
          return true;
        }
        const raw = await bounded(ports.load, abort);
        const refreshed = {registry: parseProfilesReply(raw.profiles), policy: parsePolicyReply(raw.policy)};
        if (!verifies(refreshed.registry, receipt)) return invalid();
        if (token !== generation) return false;
        publish({phase: 'saved', snapshot: refreshed}); return true;
      } catch (error) {
        if (token === generation) publish({
          phase: receiptValidated ? 'verification' : error instanceof ReplyFailure ? error.conflict ? 'conflict' : 'refused' : 'error',
          ...current, ...(!receiptValidated && error instanceof ReplyFailure ? {refusal: error.code} : {}),
        });
        return false;
      } finally { if (active === abort) active = null; }
  }
  return {
    async acknowledgePending(operation: string): Promise<boolean> {
      const result = await provisionJournal?.clearUncertain?.(operation);
      const settled = result === 'cleared' || result === 'missing';
      if (settled && pending?.id === operation && !pending.receipt) pending = undefined;
      return settled;
    },
    get state() { return state; },
    subscribe(listener: (state: AccountState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async open() { if (state.phase !== 'closed') return; publish({phase: 'error', snapshot: null}); await refresh(); },
    refresh,
    close() { ++generation; active?.abort(); active = null; publish({phase: 'closed', snapshot: null}); },
    async createProfile(profile: ProfileInput): Promise<boolean> {
      if (!canAssociate() || !ports.create || !validProfileInput(profile)) return false;
      return saveProfile(profile);
    },
    async provisionProfile(profile: ProvisionInput): Promise<boolean> {
      const provision = ports.provision;
      if (!writable() || pending || !ports.inspect || !provision || !validProvisionInput(profile) || !provision.backends.includes(profile.backend)) return false;
      const snapshot = state.snapshot!;
      const token = ++generation, abort = new AbortController(); active = abort;
      publish({phase: 'saving', snapshot});
      let id: string | undefined;
      try {
        const saved = await restoreProvision(snapshot);
        if (token !== generation) return false;
        if (saved) { pending = saved; publish({phase: 'ready', snapshot}); return false; }
        if (provisionJournal) {
          const result = await provisionJournal.acquire();
          id = result.entry.id;
          if (!result.acquired) {
            const next = await restoreProvision(snapshot);
            if (token === generation) { pending = next; publish({phase: 'ready', snapshot}); }
            return false;
          }
          if (token !== generation) {
            await provisionJournal.save(id, null); // No network write was attempted.
            return false;
          }
        }
      } catch { if (token === generation) publish({phase: 'error', snapshot}); return false; }
      const operation: PendingProvision = {snapshot, owned: true, ...(id ? {id} : {})};
      pending = operation; // Closing while the request is in flight does not cancel publication.
      publish({phase: 'saving', snapshot});
      try {
        // acquire() durably stores intent before dispatch. Without a journal,
        // retain the existing in-memory behavior.
        const receipt = profileReceipt(await bounded(signal => provision.write({version: 1, op: 'profiles.provision',
          registry_revision: snapshot.registry.registry_revision, profile,
          ...(id && /^[a-f0-9]{32}$/.test(id) ? {operation_id: id} : {})}, signal), abort));
        const answer = receipt.profile;
        if (answer.backend !== profile.backend || answer.label !== profile.label
          || answer.enabled !== !!provision.managed || answer.managed !== provision.managed
          || answer.switch_qualified || !/^p-[a-f0-9]{16}$/.test(answer.id)
          || receipt.revision === snapshot.registry.registry_revision) return invalid();
        if (token !== generation) return false;
        operation.receipt = receipt;
        await remember(receipt);
        if (token !== generation) return false;
        const registry = await bounded(inspect, abort);
        if (!verifies(registry, receipt)) return invalid();
        if (token !== generation) return false;
        await clearPending();
        if (token !== generation) return false;
        publish({phase: 'saved', snapshot: {...snapshot, registry}});
        return true;
      } catch (error) {
        if (token === generation) {
          if (!operation.receipt && error instanceof ReplyFailure) {
            try { await clearPending(); }
            catch { if (token === generation) publish({phase: 'error', snapshot}); return false; }
            if (token !== generation) return false;
            publish({phase: error.conflict ? 'conflict' : 'refused', snapshot, refusal: error.code});
          } else publish({phase: 'error', snapshot});
        }
        return false;
      } finally { if (active === abort) active = null; }
    },
    async saveGlobal(value: Confirmation): Promise<boolean> {
      if (!writable() || !['ask', 'skip'].includes(value)) return false;
      return write({...base(), op: 'consent.set_global', confirmation: value}, {...next(), global: value});
    },
    async savePair(source: AccountRef, target: AccountRef, value: Confirmation): Promise<boolean> {
      if (!writable() || !['ask', 'skip'].includes(value)) return false;
      try {
        const registry = state.snapshot!.registry, key = pairKey(source, target);
        const selected = [source, target].map(ref => registry.profiles.find(p => p.backend === ref.backend && p.id === ref.id
          && p.context_revision === ref.context_revision && p.enabled));
        if (!registry.registry_revision || selected.some(p => !p)) return false;
        const [a, b] = source.id < target.id ? [account(source), account(target)] : [account(target), account(source)];
        return write({...base(), op: 'consent.set_pair', backend: a.backend, source_id: a.id, target_id: b.id,
          registry_revision: registry.registry_revision, confirmation: value},
        {...next(), pairs: [...next().pairs.filter(r => pairKey(r.a, r.b) !== key), {a, b, confirmation: value}]});
      } catch { return false; }
    },
    async removePair(rule: PairRule): Promise<boolean> {
      if (!writable()) return false;
      try {
        const key = pairKey(rule.a, rule.b);
        if (!state.snapshot!.policy.pairs.some(r => pairKey(r.a, r.b) === key)) return false;
        const [a, b] = rule.a.id < rule.b.id ? [rule.a, rule.b] : [rule.b, rule.a];
        return write({...base(), op: 'consent.remove_pair', backend: a.backend, source_id: a.id, target_id: b.id},
          {...next(), pairs: next().pairs.filter(r => pairKey(r.a, r.b) !== key)});
      } catch { return false; }
    },
    async reset(): Promise<boolean> {
      if (!writable()) return false;
      return write({...base(), op: 'consent.reset'}, {version: 1, revision: next().revision, global: 'ask', pairs: []});
    },
  };
}
export type BackendAccountController = ReturnType<typeof createBackendAccountController>;

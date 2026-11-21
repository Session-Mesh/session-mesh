// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// UI-04 only. These ports carry native public replies, not URLs or execution authority.
export const BACKENDS = ['claude', 'codex', 'opencode-v2', 'pi'] as const;
export type Backend = typeof BACKENDS[number];
export type Confirmation = 'ask' | 'skip';
export type AccountRef = Readonly<{backend: Backend; id: string; context_revision: string}>;
export type Profile = AccountRef & Readonly<{label: string; enabled: boolean; switch_qualified: boolean}>;
export type PairRule = Readonly<{a: AccountRef; b: AccountRef; confirmation: Confirmation}>;
export type Policy = Readonly<{version: 1; revision: number; global: Confirmation; pairs: readonly PairRule[]}>;
export type Registry = Readonly<{configured: boolean; registry_revision: string | null; profiles: readonly Profile[]}>;
export type Snapshot = Readonly<{registry: Registry; policy: Policy}>;
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
  timeoutMs?: number;
}>;
export type AccountState = Readonly<{
  phase: 'closed' | 'loading' | 'ready' | 'saving' | 'saved' | 'conflict' | 'refused' | 'error';
  snapshot: Snapshot | null;
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
  'consent-rule-capacity', 'consent-revision-exhausted']);
// mesh_profile_main.http_status and its precommit error paths. Generic helper failure
// (including the HTTP adapter losing an ACK) and store/commit failure are NOT refusals.
const REFUSALS = new Map<string, number>([
  ...[...CONFLICTS].map(code => [code, 409] as const),
  ...['unknown-profile', 'profiles-unconfigured'].map(code => [code, 404] as const),
  ['request-too-large', 413],
  ['unsupported-media-type', 415],
  ...['invalid-request', 'unsupported-request-version', 'invalid-account-pair', 'invalid-account-reference',
    'profile-backend-mismatch', 'unsupported-operation'].map(code => [code, 400] as const),
  ...['disabled-profile', 'invalid-consent-policy', 'invalid-profile-config', 'unsafe-profile-roots',
    'unsafe-configuration-root', 'unsafe-backend-store', 'invalid-backend-state', 'unsupported-backend-store-version',
    'backend-transaction-aborted', 'backend-store-busy', 'backend-journal-capacity'].map(code => [code, 503] as const),
]);
class ReplyFailure extends Error {
  readonly conflict: boolean;
  constructor(code: string) { super('request-refused'); this.conflict = CONFLICTS.has(code); }
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
    const p = exact(raw, ['backend', 'id', 'context_revision', 'label', 'enabled', 'switch_qualified']);
    const item: Profile = {backend: backend(p.backend), id: id(p.id), context_revision: digest(p.context_revision),
      label: label(p.label), enabled: flag(p.enabled), switch_qualified: flag(p.switch_qualified)};
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
function samePolicy(a: Policy, b: Policy): boolean {
  const normalized = (p: Policy) => JSON.stringify({...p, pairs: [...p.pairs].sort((a, b) => pairKey(a.a, a.b).localeCompare(pairKey(b.a, b.b)))});
  return normalized(a) === normalized(b);
}

export function createBackendAccountController(ports: BackendAccountPorts) {
  let state: AccountState = {phase: 'closed', snapshot: null};
  let generation = 0;
  let active: AbortController | null = null;
  const listeners = new Set<(state: AccountState) => void>();
  const publish = (next: AccountState) => { state = next; for (const listener of listeners) listener(state); };
  const writable = () => (state.phase === 'ready' || state.phase === 'saved') && !!state.snapshot;
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
      const raw = await bounded(ports.load, abort);
      const snapshot = {registry: parseProfilesReply(raw.profiles), policy: parsePolicyReply(raw.policy)};
      if (request === generation) publish({phase: 'ready', snapshot});
    } catch { if (request === generation) publish({phase: 'error', snapshot: null}); }
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
      if (token === generation) publish({phase: error instanceof ReplyFailure ? error.conflict ? 'conflict' : 'refused' : 'error', snapshot});
      return false;
    } finally { if (active === abort) active = null; }
  }
  const base = (): BaseMutation => ({version: 1, expected_revision: state.snapshot!.policy.revision});
  const next = (): Policy => ({...state.snapshot!.policy, revision: state.snapshot!.policy.revision + 1});
  return {
    get state() { return state; },
    subscribe(listener: (state: AccountState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async open() { if (state.phase !== 'closed') return; publish({phase: 'error', snapshot: null}); await refresh(); },
    refresh,
    close() { ++generation; active?.abort(); active = null; publish({phase: 'closed', snapshot: null}); },
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

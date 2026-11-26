// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {validProvisionInput, type BackendAccountPorts, type ConsentMutation, type ProvisionBackend} from './backend-account-model.ts';

type AccountFetch = (input: string, init: RequestInit) => Promise<Response>;
const routes: Readonly<Record<ConsentMutation['op'], string>> = {
  'consent.set_global': '/api/accounts/consent/set-global',
  'consent.set_pair': '/api/accounts/consent/set-pair',
  'consent.remove_pair': '/api/accounts/consent/remove-pair',
  'consent.reset': '/api/accounts/consent/reset',
};

/** Fixed same-origin transport. The controller bounds the whole headers/body operation;
 * native public decoders remain responsible for the reply shape and policy semantics. */
export function createBackendAccountApi(request: AccountFetch, nativeProvision?: unknown): BackendAccountPorts & {
  setProvisionCapability(value: unknown): void;
} {
  async function read(url: string, signal: AbortSignal, body?: string): Promise<unknown> {
    if (signal.aborted) throw new Error('account-request-aborted');
    const response = await request(url, {
      method: body === undefined ? 'GET' : 'POST', signal, credentials: 'same-origin',
      mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: body === undefined ? {Accept: 'application/json'} : {Accept: 'application/json', 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body}),
    });
    if (![200, 400, 404, 409, 413, 415, 503].includes(response.status)
      || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') {
      throw new Error('account-response-unavailable');
    }
    const reply: unknown = await response.json();
    if (signal.aborted) throw new Error('account-request-aborted');
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)
      || (reply as Record<string, unknown>).http_status !== response.status) {
      throw new Error('account-response-unavailable');
    }
    return reply;
  }
  const known = (value: unknown): value is ProvisionBackend =>
    value === 'claude' || value === 'codex' || value === 'opencode-v2';
  const backends = (value: unknown): ProvisionBackend[] => Array.isArray(value) && value.length <= 3
    && value.every(known) && new Set(value).size === value.length ? [...value] : [];
  let provision = backends(nativeProvision);
  return {
    setProvisionCapability(value) { provision = backends(value); },
    inspect: signal => read('/api/accounts/profiles', signal),
    inspectProvision: signal => read('/api/accounts/profiles/provision-inspect', signal),
    listProvisionReceipts: signal => read('/api/accounts/profiles/provision-receipts', signal),
    forgetProvisionReceipt: (proof, signal) => {
      if (!/^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[a-f0-9]{64}$/.test(proof)) return Promise.reject(new Error('invalid-account-operation'));
      return read('/api/accounts/profiles/provision-forget-receipt', signal, JSON.stringify({proof}));
    },
    acknowledgeProvision: (proof, signal) => {
      if (!/^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[a-f0-9]{64}$/.test(proof)) return Promise.reject(new Error('invalid-account-operation'));
      return read('/api/accounts/profiles/provision-acknowledge', signal, JSON.stringify({proof}));
    },
    async load(signal) {
      // Sequential reads avoid an orphan second request if the first one refuses.
      const profiles = await read('/api/accounts/profiles', signal);
      if ((profiles as Record<string, unknown>).ok !== true) throw new Error('account-profiles-unavailable');
      const policy = await read('/api/accounts/consent', signal);
      return {profiles, policy};
    },
    mutate(mutation, signal) {
      const {version, op, ...body} = mutation;
      if (version !== 1 || !Object.hasOwn(routes, op)) return Promise.reject(new Error('invalid-account-operation'));
      return read(routes[op], signal, JSON.stringify(body));
    },
    create(mutation, signal) {
      const {version, op, ...body} = mutation;
      if (version !== 1 || op !== 'profiles.create') return Promise.reject(new Error('invalid-account-operation'));
      return read('/api/accounts/profiles/create', signal, JSON.stringify(body));
    },
    get provision(): BackendAccountPorts['provision'] { return provision.length ? {
      backends: provision,
      managed: true as const,
      write(mutation, signal) {
        const {version, op, registry_revision, profile, operation_id} = mutation;
        if (version !== 1 || op !== 'profiles.provision' || !validProvisionInput(profile)
          || !provision.includes(profile.backend) || (operation_id !== undefined && !/^[a-f0-9]{32}$/.test(operation_id))) return Promise.reject(new Error('invalid-account-operation'));
        return read('/api/accounts/profiles/provision', signal, JSON.stringify({registry_revision, profile, ...(operation_id ? {operation_id} : {})}));
      },
    } : undefined; },
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {BACKENDS, PROFILE_ROLES, createBackendAccountController, effectiveConfirmation, pairKey, ruleStatus, validProfileInput,
  type AccountState, type Backend, type BackendAccountPorts, type Confirmation, type PairRule, type Profile,
  type ProfileInput, type Snapshot} from './backend-account-model.ts';

export type AccountTranslate = (key: string, params?: Record<string, string | number>) => string;
export type BackendAccountPanelPorts = BackendAccountPorts & Readonly<{t: AccountTranslate}>;
let serial = 0;

/** Standalone UI-04 foundation. The caller supplies a host, catalogs, transport and the CSS asset.
 * No app globals, credential editor, network fallback, provider access or switch operation. */
export function createBackendAccountPanel(host: HTMLElement, ports: BackendAccountPanelPorts) {
  const doc = host.ownerDocument, prefix = `backend-accounts-${++serial}`;
  const controller = createBackendAccountController(ports);
  const t = ports.t;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const dialog = node('dialog'); dialog.className = 'backend-account-panel';
  const title = node('h2', t('backendAccounts.title')); title.id = `${prefix}-title`; dialog.setAttribute('aria-labelledby', title.id);
  const description = node('p', t('backendAccounts.description')); description.id = `${prefix}-description`;
  dialog.setAttribute('aria-describedby', description.id);
  const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const content = node('div'); const footer = node('div'); footer.className = 'backend-account-actions';
  const button = (key: string, focus: string, action: () => void): HTMLButtonElement => {
    const b = node('button', t(`backendAccounts.${key}`)); b.type = 'button'; b.dataset.focus = focus; b.addEventListener('click', action); return b;
  };
  const refresh = button('refresh', 'refresh', () => { clearDraft(); void controller.refresh(); });
  const closeButton = button('close', 'close', () => close());
  footer.append(refresh, closeButton); dialog.append(title, description, status, content, footer); host.append(dialog);
  let opener: HTMLElement | null = null, disposed = false, shown: Snapshot | null = null, generation = 0;
  let editHost: HTMLElement | null = null, createHost: HTMLElement | null = null;
  let creation: {backend: Backend; id: string; label: string; roots: Record<string, string>} | null = null;
  const trimLabel = (value: string) => value.replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, '');
  let draft: {backend: Backend; a: string; b: string; confirmation: Confirmation} | null = null;
  let restoreFocus: string | null = null;
  const writable = () => controller.state.phase === 'ready' || controller.state.phase === 'saved';
  const context = (profile: Profile): string => t('backendAccounts.context', {label: profile.label, backend: t(`backendAccounts.backend.${profile.backend}`), id: profile.id});
  const profilesFor = (backend: Backend) => controller.state.snapshot?.registry.profiles.filter(p => p.backend === backend && p.enabled) ?? [];
  const selected = () => {
    if (!draft) return null;
    const profiles = profilesFor(draft.backend), a = profiles.find(p => p.id === draft!.a), b = profiles.find(p => p.id === draft!.b);
    return a && b && a.id !== b.id ? {a, b} : null;
  };
  function clearDraft() { draft = null; editHost?.replaceChildren(); }
  function close() {
    ++generation;
    controller.close(); clearDraft(); creation = null; shown = null;
    if (dialog.open) dialog.close();
    if (opener?.isConnected) opener.focus(); opener = null;
  }
  // A delayed native close event from an earlier open must not close the new generation.
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('submit', event => event.preventDefault());
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, select, input, [tabindex="0"]'))
      .filter(el => !el.matches(':disabled') && el.getClientRects().length > 0);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  function labelledSelect(key: string, focus: string): {label: HTMLLabelElement; select: HTMLSelectElement} {
    const label = node('label', t(`backendAccounts.${key}`)), select = node('select');
    select.id = `${prefix}-${focus}`; select.dataset.focus = focus; label.htmlFor = select.id;
    return {label, select};
  }
  function startCreate() {
    if (!writable() || !ports.create) return;
    creation = {backend: 'claude', id: '', label: '', roots: {}};
    renderCreate(); createHost?.querySelector<HTMLElement>('[data-focus="create-backend"]')?.focus();
  }
  function renderCreate() {
    if (!creation || !createHost) return;
    createHost.replaceChildren();
    const fields = node('fieldset'); fields.dataset.controls = '';
    fields.append(node('legend', t('backendAccounts.createTitle')),
      node('p', t('backendAccounts.createHelp')));
    const backend = labelledSelect('backendLabel', 'create-backend');
    for (const tag of BACKENDS) {
      const option = node('option', t(`backendAccounts.backend.${tag}`)); option.value = tag; backend.select.append(option);
    }
    backend.select.value = creation.backend;
    backend.select.addEventListener('change', () => {
      if (!creation || !writable()) return;
      creation.backend = backend.select.value as Backend; creation.roots = {};
      renderCreate(); createHost?.querySelector<HTMLElement>('[data-focus="create-backend"]')?.focus();
    });
    fields.append(backend.label, backend.select);
    const save = button('saveAccount', 'save-account', () => {
      if (!creation || !writable()) return;
      const input: ProfileInput = {backend: creation.backend, id: creation.id,
        label: trimLabel(creation.label), roots: {...creation.roots}};
      if (!validProfileInput(input)) return;
      const request = generation;
      void controller.createProfile(input).then(saved => {
        if (saved && request === generation && dialog.open) {
          creation = null; createHost?.replaceChildren();
          content.querySelector<HTMLElement>('[data-focus="add-account"]')?.focus();
        }
      });
    });
    const input = (key: string, focus: string, value: string, update: (value: string) => void) => {
      const label = node('label', t(`backendAccounts.${key}`)), control = node('input');
      control.type = 'text'; control.value = value; control.id = `${prefix}-${focus}`;
      control.dataset.focus = focus; control.autocomplete = 'off'; label.htmlFor = control.id;
      control.addEventListener('input', () => { update(control.value); save.disabled = !valid(); });
      fields.append(label, control);
    };
    const valid = () => !!creation && validProfileInput({...creation, label: trimLabel(creation.label)});
    input('createId', 'create-id', creation.id, value => { if (creation) creation.id = value; });
    input('createLabel', 'create-label', creation.label, value => { if (creation) creation.label = value; });
    for (const role of PROFILE_ROLES[creation.backend]) {
      input(`root.${role}`, `create-${role}`, creation.roots[role] ?? '',
        value => { if (creation) creation.roots[role] = value; });
    }
    const actions = node('div'); actions.className = 'backend-account-actions';
    actions.append(button('cancelEdit', 'cancel-create', () => {
      creation = null; createHost?.replaceChildren();
      content.querySelector<HTMLElement>('[data-focus="add-account"]')?.focus();
    }), save);
    fields.append(actions); createHost.append(fields); save.disabled = !valid();
  }
  function radios(key: string, group: string, value: Confirmation, change: (value: Confirmation) => void): HTMLFieldSetElement {
    const fieldset = node('fieldset'); fieldset.append(node('legend', t(`backendAccounts.${key}`)));
    for (const choice of ['ask', 'skip'] as const) {
      const label = node('label'), input = node('input'); input.type = 'radio'; input.name = `${prefix}-${group}`;
      input.value = choice; input.checked = value === choice; input.dataset.focus = `${group}-${choice}`;
      input.addEventListener('change', () => { if (input.checked && writable()) change(choice); });
      label.append(input, doc.createTextNode(t(`backendAccounts.${choice}`))); fieldset.append(label);
    }
    return fieldset;
  }
  function startEdit(rule?: PairRule) {
    if (!writable()) return;
    draft = {backend: rule?.a.backend ?? 'claude', a: rule?.a.id ?? '', b: rule?.b.id ?? '', confirmation: rule?.confirmation ?? 'ask'};
    renderEditor(); editHost?.querySelector<HTMLElement>('select')?.focus();
  }
  function renderEditor() {
    if (!editHost || !draft || !controller.state.snapshot) return;
    editHost.replaceChildren();
    const fields = node('fieldset'); fields.dataset.controls = ''; fields.append(node('legend', t('backendAccounts.pairEditor')));
    const backend = labelledSelect('backendLabel', 'pair-backend');
    for (const tag of BACKENDS) { const option = node('option', t(`backendAccounts.backend.${tag}`)); option.value = tag; backend.select.append(option); }
    backend.select.value = draft.backend;
    backend.select.addEventListener('change', () => {
      if (!writable() || !draft) return;
      draft = {backend: backend.select.value as Backend, a: '', b: '', confirmation: 'ask'}; renderEditor();
      editHost?.querySelector<HTMLElement>('[data-focus="pair-backend"]')?.focus();
    });
    fields.append(backend.label, backend.select);
    const summary = node('p'); summary.dataset.selected = '';
    const preview = node('p'); preview.dataset.preview = ''; preview.setAttribute('aria-live', 'polite');
    const ruleRadios = radios('pairRule', 'pair-rule', draft.confirmation, value => { if (draft) draft.confirmation = value; updatePreview(); });
    const save = button('savePair', 'save-pair', () => {
      const pair = selected(); if (!writable() || !pair || !draft) return;
      const request = generation;
      void controller.savePair(pair.a, pair.b, draft.confirmation).then(saved => {
        if (saved && request === generation && dialog.open) {
          const active = doc.activeElement;
          const restore = !active || active === doc.body || active === dialog || !!editHost?.contains(active);
          clearDraft();
          if (restore) content.querySelector<HTMLElement>('[data-focus="add-pair"]')?.focus();
        }
      });
    });
    const updatePreview = () => {
      const pair = selected(); save.disabled = !writable() || !pair;
      if (!pair || !draft) { summary.textContent = t('backendAccounts.choosePair'); preview.textContent = ''; return; }
      summary.textContent = t('backendAccounts.pairNames', {a: context(pair.a), b: context(pair.b)});
      preview.textContent = t(draft.confirmation === 'ask' && controller.state.snapshot!.policy.global === 'skip' ? 'backendAccounts.previewOverride' : 'backendAccounts.preview',
        {confirmation: t(`backendAccounts.${draft.confirmation}`)});
    };
    for (const side of ['a', 'b'] as const) {
      const account = labelledSelect(side === 'a' ? 'accountA' : 'accountB', `pair-${side}`);
      const empty = node('option', t('backendAccounts.chooseAccount')); empty.value = ''; account.select.append(empty);
      for (const profile of profilesFor(draft.backend)) {
        const option = node('option', context(profile)); option.value = profile.id; account.select.append(option);
      }
      account.select.value = draft[side];
      account.select.addEventListener('change', () => {
        if (!writable() || !draft) return;
        const previous = selected();
        draft[side] = account.select.value;
        const pair = selected();
        const existing = pair && controller.state.snapshot!.policy.pairs.find(r => pairKey(r.a, r.b) === pairKey(pair.a, pair.b));
        if (existing) draft.confirmation = existing.confirmation;
        else if (!pair || !previous || pairKey(previous.a, previous.b) !== pairKey(pair.a, pair.b)) draft.confirmation = 'ask';
        ruleRadios.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = input.value === draft!.confirmation; });
        updatePreview();
      });
      fields.append(account.label, account.select);
    }
    const actions = node('div'); actions.className = 'backend-account-actions';
    actions.append(button('cancelEdit', 'cancel-edit', () => { clearDraft(); content.querySelector<HTMLElement>('[data-focus="add-pair"]')?.focus(); }), save);
    fields.append(summary, ruleRadios, preview, actions); editHost.append(fields); updatePreview();
  }
  function renderContent(snapshot: Snapshot) {
    content.replaceChildren();
    const profileSection = node('section'); profileSection.append(node('h3', t('backendAccounts.profiles')));
    const profiles = node('ul');
    for (const profile of snapshot.registry.profiles) {
      const row = node('li', context(profile));
      row.append(node('p', t(profile.enabled ? 'backendAccounts.profileEnabled' : 'backendAccounts.profileDisabled')));
      row.append(node('p', t(profile.switch_qualified ? 'backendAccounts.qualificationNotAuthority' : 'backendAccounts.notQualified'))); profiles.append(row);
    }
    profileSection.append(profiles); if (!snapshot.registry.profiles.length) profileSection.append(node('p', t('backendAccounts.noProfiles')));
    if (ports.create) {
      profileSection.append(button('addAccount', 'add-account', startCreate));
      createHost = node('div'); profileSection.append(createHost);
      if (creation) renderCreate();
    }
    content.append(profileSection);
    const controls = node('fieldset'); controls.dataset.controls = '';
    controls.append(node('legend', t('backendAccounts.confirmations')));
    let globalDraft = snapshot.policy.global;
    const global = radios('global', 'global', globalDraft, value => { globalDraft = value; });
    const warning = node('p', t('backendAccounts.globalWarning')); warning.id = `${prefix}-global-warning`; global.setAttribute('aria-describedby', warning.id);
    const saveGlobal = button('saveGlobal', 'save-global', () => { if (writable()) void controller.saveGlobal(globalDraft); });
    controls.append(global, warning, saveGlobal, node('h3', t('backendAccounts.pairRules')), node('p', t('backendAccounts.pairScope')));
    if (!snapshot.policy.pairs.length) controls.append(node('p', t('backendAccounts.noRules')));
    for (const rule of snapshot.policy.pairs) {
      const key = pairKey(rule.a, rule.b), row = node('section'); row.dataset.rule = key;
      const find = (ref: PairRule['a']) => snapshot.registry.profiles.find(p => p.backend === ref.backend && p.id === ref.id);
      const a = find(rule.a), b = find(rule.b);
      const names = t('backendAccounts.pairNames', {a: a ? context(a) : t('backendAccounts.retiredName', {backend: t(`backendAccounts.backend.${rule.a.backend}`), id: rule.a.id}),
        b: b ? context(b) : t('backendAccounts.retiredName', {backend: t(`backendAccounts.backend.${rule.b.backend}`), id: rule.b.id})});
      row.append(node('h4', names), node('p', t('backendAccounts.savedRule', {confirmation: t(`backendAccounts.${rule.confirmation}`)})), node('p', t(`backendAccounts.ruleStatus.${ruleStatus(snapshot.registry, rule)}`)));
      row.append(node('p', a?.enabled && b?.enabled ? t('backendAccounts.effective', {confirmation: t(`backendAccounts.${effectiveConfirmation(snapshot.policy, snapshot.registry, a, b)}`)}) : t('backendAccounts.notApplicable')));
      row.append(node('p', t('backendAccounts.removeFallback', {confirmation: t(`backendAccounts.${snapshot.policy.global}`)})));
      const actions = node('div'); actions.className = 'backend-account-actions';
      if (a?.enabled && b?.enabled) {
        const edit = button('edit', `edit-${key}`, () => startEdit(rule)); edit.setAttribute('aria-label', t('backendAccounts.editNamed', {pair: names})); actions.append(edit);
      }
      const remove = button('remove', `remove-${key}`, () => { if (writable()) void controller.removePair(rule); });
      remove.setAttribute('aria-label', t('backendAccounts.removeNamed', {pair: names})); actions.append(remove); row.append(actions); controls.append(row);
    }
    controls.append(button('addPair', 'add-pair', () => startEdit()));
    editHost = node('div'); controls.append(editHost);
    controls.append(node('p', t('backendAccounts.resetHelp')), button('reset', 'reset', () => { if (writable()) void controller.reset(); }));
    content.append(controls); if (draft) renderEditor();
  }
  function render(state: AccountState) {
    if (disposed || state.phase === 'closed') return;
    const focused = doc.activeElement instanceof HTMLElement ? doc.activeElement.dataset.focus : undefined;
    if (state.phase === 'saving') restoreFocus = focused ?? null;
    const statusKey = state.phase === 'error' && state.snapshot === null ? 'loadError' : state.phase;
    const fieldErrors = ['invalid-request', 'invalid-profile-config', 'unsafe-profile-roots',
      'profile-registry-changed', 'profile-already-exists', 'profile-migration-required'];
    status.textContent = t(`backendAccounts.status.${statusKey}`)
      + (state.refusal && creation && fieldErrors.includes(state.refusal)
        ? ` ${t(`backendAccounts.refusal.${state.refusal}`)}` : '');
    dialog.setAttribute('aria-busy', String(state.phase === 'loading' || state.phase === 'saving'));
    refresh.disabled = state.phase === 'saving' || state.phase === 'loading';
    if (state.snapshot !== shown) {
      shown = state.snapshot;
      if (shown) { clearDraft(); renderContent(shown); } else { clearDraft(); content.replaceChildren(); }
    }
    content.querySelectorAll<HTMLFieldSetElement>('fieldset[data-controls]').forEach(fields => { fields.disabled = !writable(); });
    if (writable() && restoreFocus) {
      if (!focused || focused === restoreFocus) {
        const previous = Array.from(content.querySelectorAll<HTMLElement>('[data-focus]')).find(el => el.dataset.focus === restoreFocus);
        (previous ?? content.querySelector<HTMLElement>('[data-focus="add-pair"]'))?.focus();
      }
      restoreFocus = null;
    }
  }
  const unsubscribe = controller.subscribe(render);
  return {
    dialog,
    async open(trigger?: HTMLElement) {
      if (disposed || dialog.open) return;
      ++generation;
      opener = trigger ?? (doc.activeElement instanceof HTMLElement ? doc.activeElement : null);
      dialog.showModal(); closeButton.focus(); await controller.open();
    },
    close,
    dispose() { if (disposed) return; close(); disposed = true; unsubscribe(); dialog.remove(); },
  };
}

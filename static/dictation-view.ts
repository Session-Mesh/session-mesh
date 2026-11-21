// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type {DictationController, DictationSession, DictationState} from './dictation.ts';
import type {Translator} from './pane-actions.ts';

let translate: Translator = key => key;
export function setDictationTranslator(fn: Translator): void {translate = fn;}
export function dictationLabel(state: DictationState): string {
  return state === 'idle' ? '' : translate(`dictation.state.${state}`);
}
// Only code-owned codes select catalog keys; untrusted server prose is never UI.
const messages = new Set(['storageWrite', 'storageRead', 'unavailable', 'unsupported', 'nonempty', 'outstanding',
  'microphoneBusy', 'ineligible', 'originalUnavailable', 'permissionTimeout', 'permissionDenied', 'audioLimit',
  'recordingError', 'microphoneInterrupted', 'durationLimit', 'invalidAudio', 'contextChanged', 'channelExpired',
  'resultExpired', 'admissionRejected', 'admissionUnconfirmed', 'draftChanged', 'statusUnavailable', 'jobMissing',
  'discardPending', 'channelUnavailable', 'resultUnconfirmed', 'settlementPending', 'deliveryUncertain']);
function message(code: string): string {
  return code ? translate(`dictation.message.${messages.has(code) ? code : 'serviceError'}`) : '';
}
interface ViewPorts {
  controller(): DictationController | null;
  session(): DictationSession | null;
  text: HTMLTextAreaElement; microphone: HTMLButtonElement; status: HTMLElement;
  discard?: HTMLButtonElement | null;
  send: HTMLButtonElement; insert: HTMLButtonElement; global: HTMLElement;
  sync(): void;
  autoSend?: HTMLInputElement; preferenceStatus?: HTMLElement;
}
function statusRow(s: DictationSession, controller: DictationController) {
  const row = document.createElement('section'); row.className = 'dictation-row';
  const label = document.createElement('span'); label.className = 'dictation-label';
  row.append(label);
  const originalTitle = document.createElement('strong'), original = document.createElement('pre');
  const feedback = document.createElement('span'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  let copying = 0;
  const copy = async (text: string): Promise<void> => {
    const operation = ++copying;
    try {
      await navigator.clipboard.writeText(text);
      if (operation === copying) {feedback.textContent = ''; feedback.hidden = true;}
    } catch {
      if (operation === copying) {feedback.textContent = translate('compose.copyFailed'); feedback.hidden = false;}
    }
  };
  const copyOriginal = document.createElement('button'); copyOriginal.type = 'button';
  copyOriginal.onclick = () => copy(s.transcript);
  const draftTitle = document.createElement('strong'), draft = document.createElement('pre');
  const copyDraft = document.createElement('button'); copyDraft.type = 'button';
  copyDraft.onclick = () => copy(s.text);
  const clear = document.createElement('button'); clear.type = 'button'; clear.onclick = () => s.edit('');
  const discard = document.createElement('button'); discard.type = 'button';
  discard.onclick = () => controller.discard(s);
  row.append(originalTitle, original, copyOriginal, draftTitle, draft, copyDraft, clear, discard, feedback);
  return {row, update(): void {
    label.dataset.state = s.state;
    label.textContent = translate('dictation.sessionStatus', {session: s.name,
      status: [dictationLabel(s.state) || translate('dictation.draftRetained'), message(s.message)]
        .filter(Boolean).join(' · ')});
    originalTitle.textContent = translate('dictation.original'); original.textContent = s.transcript;
    copyOriginal.textContent = translate('dictation.copyOriginal');
    for (const node of [originalTitle, original, copyOriginal]) node.hidden = !s.transcript;
    draftTitle.textContent = translate('dictation.currentDraft'); draft.textContent = s.text;
    copyDraft.textContent = translate('dictation.copyDraft'); clear.textContent = translate('dictation.clearDraft');
    for (const node of [draftTitle, draft, copyDraft, clear]) node.hidden = !s.text;
    discard.textContent = translate('dictation.discard'); discard.hidden = !s.outstanding;
  }};
}
type BeginHold = () => object | null;
type EndHold = (token?: object) => void;
function keyboardHold(button: HTMLButtonElement, press: BeginHold, release: EndHold, cancel: EndHold): void {
  let key: string | null = null;
  let token: object | null = null;
  let cancelled = false;
  const blocked = new Set<string>();
  // Keep the release latch after blur so Space-up cannot activate a new button.
  const abandon = (): void => {if (key === null) return; cancelled = true; if (token) cancel(token);};
  button.addEventListener('keydown', e => {
    if (e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); abandon(); cancel(); return;}
    if (![' ', 'Enter'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat || key !== null) {if (e.key !== key) blocked.add(e.key); return;}
    const candidate = press();
    if (candidate) {key = e.key; cancelled = false; token = candidate; blocked.delete(e.key);}
    else blocked.add(e.key);
  });
  document.addEventListener('keyup', e => {
    if (blocked.delete(e.key)) {e.preventDefault(); e.stopPropagation(); return;}
    if (e.key !== key) return;
    e.preventDefault(); e.stopPropagation(); key = null;
    if (token) {if (!cancelled && document.activeElement === button) release(token); else cancel(token);}
    token = null;
  }, true);
  button.addEventListener('blur', abandon);
  window.addEventListener('blur', abandon);
}
function pointerHold(button: HTMLButtonElement, press: BeginHold, release: EndHold, cancel: EndHold): void {
  let pointer: {id: number; token: object; started: number} | null = null;
  button.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); const token = press();
    if (token) {pointer = {id: e.pointerId, token, started: e.timeStamp}; button.setPointerCapture(e.pointerId);}
  });
  button.addEventListener('pointerup', e => {
    if (!pointer || pointer.id !== e.pointerId || e.timeStamp < pointer.started) return;
    e.preventDefault(); const token = pointer.token; pointer = null; release(token);
  });
  const abandon = (e: PointerEvent): void => {
    if (!pointer || pointer.id !== e.pointerId || e.timeStamp < pointer.started) return;
    if (e.type === 'lostpointercapture' && button.hasPointerCapture(e.pointerId)) return;
    const token = pointer.token; pointer = null; cancel(token);
  };
  button.addEventListener('pointercancel', abandon); button.addEventListener('lostpointercapture', abandon);
}
export function createDictationView(p: ViewPorts) {
  let held: {session: DictationSession; token: object} | null = null;
  const background = new Map<DictationSession, ReturnType<typeof statusRow>>();
  const press = (): object | null => {
    const s = p.session(), c = p.controller();
    p.sync();
    if (!s || !c || c.reason(s)) return null;
    const token = {}; held = {session: s, token}; void c.press(s); return token;
  };
  const release: EndHold = token => {
    if (held && token === held.token) {p.controller()?.release(held.session); held = null;}
  };
  const cancel: EndHold = token => {
    if (held && (!token || token === held.token)) {p.controller()?.detach(held.session); held = null;}
  };
  pointerHold(p.microphone, press, release, cancel);
  p.microphone.addEventListener('contextmenu', e => e.preventDefault());
  p.microphone.addEventListener('click', e => e.preventDefault());
  keyboardHold(p.microphone, press, release, cancel);
  p.discard?.addEventListener('click', () => {
    p.sync();
    const s = p.session();
    if (s?.outstanding) p.controller()?.discard(s);
  });
  document.addEventListener('visibilitychange', () => {if (document.hidden) {cancel(); p.controller()?.hidden();}});
  p.autoSend?.addEventListener('change', () => p.controller()?.setAutoSend(p.autoSend!.checked));
  return {cancel, render(): void {
    renderView(p);
    const c = p.controller(), sessions = new Set(c?.holds() || []);
    for (const [s, item] of background) if (!sessions.has(s)) {item.row.remove(); background.delete(s);}
    for (const s of sessions) {
      let item = background.get(s);
      if (!item) {item = statusRow(s, c!); background.set(s, item); p.global.append(item.row);}
      item.update();
    }
    p.global.hidden = !background.size;
  }};
}
function renderView(p: ViewPorts): void {
  const c = p.controller(), s = p.session();
  const reason = s && c ? message(c.reason(s)) : translate('dictation.localSession');
  renderPreference(p, c);
  const capturing = s?.state === 'requesting' || s?.state === 'recording';
  // aria-disabled preserves pointer capture during hold.
  p.microphone.setAttribute('aria-disabled', String(!!reason && !capturing));
  p.microphone.setAttribute('aria-pressed', String(s?.state === 'recording'));
  p.microphone.title = reason || translate('dictation.holdHint');
  p.status.textContent = s?.state === 'ready' && !s.text ? translate('dictation.emptyDraft')
    : (s ? [dictationLabel(s.state), message(s.message)].filter(Boolean).join(' · ') : '') || reason;
  p.status.dataset.state = s?.state || 'idle';
  if (p.discard) p.discard.disabled = !s?.outstanding || s.discard || !!s.outcome;
  if (s && p.text.value !== s.text) p.text.value = s.text;
  if (s?.outstanding) {
    p.insert.disabled = true; p.insert.title = translate('dictation.noInsert');
    p.send.disabled = p.send.disabled || s.state !== 'ready' || !s.text || s.busy;
  } else p.insert.title = '';
}
function renderPreference(p: ViewPorts, c: DictationController | null): void {
  if (p.autoSend) {p.autoSend.checked = c?.autoSend ?? false; p.autoSend.disabled = !c?.preferenceAvailable;}
  if (p.preferenceStatus) p.preferenceStatus.textContent = message(c?.preferenceMessage || '') || translate(c?.autoSend
    ? 'dictation.autoEnabled' : 'dictation.autoDisabled');
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pinned CoreService fires onUserInput synchronously immediately before the
// corresponding onData. Unknown shapes remain conservative human input.
type Admission = (owner: unknown) => boolean;
interface Binding {connection: unknown; terminal: unknown; view: unknown}
function sameBinding(a: unknown, b: unknown): boolean {
  const first = a as Binding, second = b as Binding;
  return first.connection === second.connection && first.terminal === second.terminal && first.view === second.view;
}
// Pinned InputHandler keeps decoder and async pause state outside public reset().
// EscapeSequenceParser.reset marks a paused continuation cancelled; empty parse
// drains that cancellation without consuming any bytes from the next binding.
function resetInputState(source: unknown): boolean {
  const handler = source as {_parser?: {reset(): void; parse(data: Uint32Array, length: number): unknown};
    _utf8Decoder?: {clear(): void}; _stringDecoder?: {clear(): void}; _parseStack?: {paused: boolean}};
  try {
    if (![handler?._parser?.reset, handler?._parser?.parse, handler?._utf8Decoder?.clear, handler?._stringDecoder?.clear]
      .every(method => typeof method === 'function') || typeof handler?._parseStack?.paused !== 'boolean') return false;
    handler._parser!.reset();
    if (handler._parser!.parse(new Uint32Array(0), 0) !== undefined) return false;
    handler._utf8Decoder!.clear(); handler._stringDecoder!.clear(); handler._parseStack!.paused = false;
    return true;
  } catch {return false;}
}
function protocolParser(source: unknown, admit: Admission) {
  const parser = source as {parse?: (...args: unknown[]) => unknown};
  const owners = new WeakMap<object, unknown>();
  let original: ((...args: unknown[]) => unknown) | undefined;
  let owner: unknown = null;
  let parsing = false;
  let last: unknown = null, clean = true;
  const reset = (): boolean => {last = null; clean = resetInputState(source); return clean;};
  const wrapped = (...args: unknown[]): unknown => {
    const tagged = args[0] && typeof args[0] === 'object' && owners.has(args[0]);
    const next = tagged ? owners.get(args[0] as object) : null;
    if (tagged) {
      if (!admit(next) || !clean) return;
      if (last && !sameBinding(last, next) && !reset()) return;
      last = next;
    }
    const previous = owner, previousParsing = parsing; parsing = true;
    owner = next;
    try {return original!.apply(parser, args);} finally {owner = previous; parsing = previousParsing;}
  };
  let supported = false;
  try {original = parser?.parse; if (typeof original === 'function') {parser.parse = wrapped; supported = parser.parse === wrapped;}} catch { /* Unknown provenance stays human. */ }
  return {get supported() {return supported && clean;}, reset, active: () => parsing, target: () => owner,
    tag(data: unknown, target: unknown): void {if (data && typeof data === 'object') owners.set(data, target);},
    dispose(): void {try {if (supported && typeof original === 'function' && parser.parse === wrapped) parser.parse = original;} catch { /* Already retired. */ } owner = last = null; clean = false;}};
}
export function createTerminalInputOrigin(source: unknown, parserSource?: unknown, admit: Admission = () => true) {
  const core = source as {onUserInput?: (callback: () => void) => {dispose(): void}};
  let human = false;
  let subscription: {dispose(): void} | null = null;
  const parser = protocolParser(parserSource, admit);
  let focusOwner: unknown = null;
  try {
    if (typeof core?.onUserInput === 'function') {
      const signal = core.onUserInput(() => {human = true;});
      if (typeof signal?.dispose === 'function') subscription = signal;
    }
  } catch { /* Fail conservative. */ }
  return {consume(): boolean {
    if (!subscription || !parser.supported) return true;
    const result = human; human = false; return result;
  }, get supported() {return parser.supported;}, reset: parser.reset, tag: parser.tag, target: () => parser.active() ? parser.target() : focusOwner,
    focus(target: unknown): void {focusOwner = target; setTimeout(() => {if (focusOwner === target) focusOwner = null;}, 0);},
    clearFocus(): void {focusOwner = null;},
    dispose(): void {subscription?.dispose(); subscription = null; human = false; focusOwner = null; parser.dispose();}};
}

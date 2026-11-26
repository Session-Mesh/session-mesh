// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Reuse the shipped xterm state table, numeric Params and streaming UTF-8
// decoder, without InputHandler, payload handlers, a renderer or output history.
interface Params {length: number; params: Int32Array}
interface Parser {
  registerCsiHandler(id: object, handler: (params: Params) => boolean): unknown;
  registerEscHandler(id: object, handler: () => boolean): unknown;
  parse(data: Uint32Array, length: number): unknown;
  reset(): void; dispose(): void;
}
interface Decoder {decode(data: Uint8Array, output: Uint32Array): number; clear(): void}
interface Machinery {Parser: new () => Parser; Decoder: new () => Decoder; columnsReset: boolean}
export interface DictationMode {readonly value: boolean; readonly valid: boolean; bytes(data: Uint8Array): void; dispose(): void}
let pinned: Machinery | null = null;
function machinery(source: unknown): Machinery | null {
  const term = source as {_core?: {_inputHandler?: {_parser?: Parser; _utf8Decoder?: Decoder}; optionsService?: {rawOptions?: {windowOptions?: {setWinLines?: boolean}}}}};
  const handler = term?._core?._inputHandler;
  if (source !== undefined && (!handler || typeof handler._parser?.parse !== 'function'
    || typeof handler._utf8Decoder?.decode !== 'function')) return null;
  if (handler) pinned = {Parser: handler._parser!.constructor as Machinery['Parser'],
    Decoder: handler._utf8Decoder!.constructor as Machinery['Decoder'],
    columnsReset: term._core?.optionsService?.rawOptions?.windowOptions?.setWinLines === true};
  return pinned;
}
class PinnedMode implements DictationMode {
  private readonly parser: Parser; private readonly decoder: Decoder;
  value: boolean; valid = true;
  private readonly buffer = new Uint32Array(4096);
  constructor(parser: Parser, decoder: Decoder, initial: boolean, columnsReset: boolean) {
    this.parser = parser; this.decoder = decoder;
    this.value = initial;
    const change = (params: Params, enabled: boolean): boolean => {
      for (let i = 0; i < params.length; i++) {
        if (params.params[i] === 3 && columnsReset) this.value = false;
        if (params.params[i] === 2004) this.value = enabled;
      }
      return true;
    };
    parser.registerCsiHandler({prefix: '?', final: 'h'}, p => change(p, true));
    parser.registerCsiHandler({prefix: '?', final: 'l'}, p => change(p, false));
    parser.registerCsiHandler({intermediates: '!', final: 'p'}, () => {this.value = false; return true;});
    parser.registerEscHandler({final: 'c'}, () => {this.value = false; parser.reset(); return true;});
  }
  bytes(data: Uint8Array): void {
    if (!this.valid) return;
    try {
      for (let offset = 0; offset < data.length; offset += 4092) {
        const n = this.decoder.decode(data.subarray(offset, offset + 4092), this.buffer);
        if (this.parser.parse(this.buffer, n) !== undefined) throw Error('unsupported async parser');
      }
    } catch {this.dispose();}
  }
  dispose(): void {
    if (!this.valid) return; this.valid = false;
    try {this.parser.dispose();} catch { /* Unsupported parser is already disabled. */ }
    try {this.decoder.clear();} catch { /* No further bytes will be decoded. */ }
  }
}
export function createDictationModeObserver(initial: boolean, source?: unknown): DictationMode {
  try {
    const constructors = machinery(source);
    if (!constructors) throw Error('unsupported pinned xterm');
    const parser = new constructors.Parser(), decoder = new constructors.Decoder();
    if (![parser.parse, parser.registerCsiHandler, parser.registerEscHandler, parser.reset, parser.dispose, decoder.decode, decoder.clear]
      .every(method => typeof method === 'function')) throw Error('unsupported pinned xterm');
    return new PinnedMode(parser, decoder, initial, constructors.columnsReset);
  } catch {return {value: initial, valid: false, bytes() {}, dispose() {}};}
}

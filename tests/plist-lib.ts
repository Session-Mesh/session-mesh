// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A strict reader for the XML property lists the macOS installer writes: the subset it uses
// (dict, key, string, array, integer, true, false), with XML's five predefined entities and
// numeric character references. Anything else, including a raw `<` or `&` in text, an unknown
// element or an unbalanced tag, throws: a plist the installer escaped wrongly fails here.
export type PlistValue = string | number | boolean | PlistValue[] | {[key: string]: PlistValue};

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decodeText(raw: string): string {
  if (raw.includes('<')) throw new Error(`raw < in text: ${raw}`);
  return raw.replace(/&([^;]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new Error(`unterminated entity in: ${raw}`);
    if (name in ENTITIES) return ENTITIES[name];
    const numeric = /^#(x[0-9a-fA-F]+|[0-9]+)$/.exec(name);
    if (!numeric) throw new Error(`unknown entity &${name};`);
    const code = numeric[1].startsWith('x') ? parseInt(numeric[1].slice(1), 16) : parseInt(numeric[1], 10);
    return String.fromCodePoint(code);
  });
}

class Reader {
  position = 0;
  readonly text: string;
  constructor(text: string) { this.text = text; }

  skipSpace(): void { while (/\s/.test(this.text[this.position] ?? '')) this.position++; }

  // The next tag: its name, whether it closes (</x>) or is empty (<x/>).
  tag(): {name: string; closing: boolean; empty: boolean} {
    this.skipSpace();
    const match = /^<(\/?)([a-z]+)(\s+version="1\.0")?\s*(\/?)>/.exec(this.text.slice(this.position));
    if (!match) throw new Error(`expected a tag at ${this.position}: ${this.text.slice(this.position, this.position + 40)}`);
    this.position += match[0].length;
    return {name: match[2], closing: match[1] === '/', empty: match[4] === '/'};
  }

  expectClose(name: string): void {
    const tag = this.tag();
    if (!tag.closing || tag.name !== name) throw new Error(`expected </${name}>, got <${tag.closing ? '/' : ''}${tag.name}>`);
  }

  textUntilClose(name: string): string {
    const end = this.text.indexOf(`</${name}>`, this.position);
    if (end < 0) throw new Error(`unclosed <${name}>`);
    const value = decodeText(this.text.slice(this.position, end));
    this.position = end;
    this.expectClose(name);
    return value;
  }

  value(): PlistValue {
    const tag = this.tag();
    if (tag.closing) throw new Error(`unexpected </${tag.name}>`);
    if (tag.empty) {
      if (tag.name === 'true') return true;
      if (tag.name === 'false') return false;
      if (tag.name === 'dict') return {};
      if (tag.name === 'array') return [];
      throw new Error(`unexpected <${tag.name}/>`);
    }
    if (tag.name === 'string') return this.textUntilClose('string');
    if (tag.name === 'integer') {
      const text = this.textUntilClose('integer');
      if (!/^-?[0-9]+$/.test(text)) throw new Error(`bad integer ${text}`);
      return Number(text);
    }
    if (tag.name === 'array') return this.array();
    if (tag.name === 'dict') return this.dict();
    throw new Error(`unsupported element <${tag.name}>`);
  }

  array(): PlistValue[] {
    const items: PlistValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.text.startsWith('</array>', this.position)) { this.expectClose('array'); return items; }
      items.push(this.value());
    }
  }

  dict(): {[key: string]: PlistValue} {
    const entries: {[key: string]: PlistValue} = {};
    for (;;) {
      this.skipSpace();
      if (this.text.startsWith('</dict>', this.position)) { this.expectClose('dict'); return entries; }
      const tag = this.tag();
      if (tag.closing || tag.empty || tag.name !== 'key') throw new Error(`expected <key>, got <${tag.name}>`);
      const key = this.textUntilClose('key');
      if (key in entries) throw new Error(`duplicate key ${key}`);
      entries[key] = this.value();
    }
  }
}

export function parsePlist(text: string): PlistValue {
  const header = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/.exec(text);
  if (!header) throw new Error('missing XML declaration or plist DOCTYPE');
  const reader = new Reader(text);
  reader.position = header[0].length;
  const root = reader.tag();
  if (root.name !== 'plist' || root.closing || root.empty) throw new Error('missing <plist version="1.0">');
  const value = reader.value();
  reader.expectClose('plist');
  reader.skipSpace();
  if (reader.position !== text.length) throw new Error('content after </plist>');
  return value;
}

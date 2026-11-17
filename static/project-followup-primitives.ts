// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Closed selected observations. None of these labels conveys authority. */
export type RecordValue = Record<string, unknown>;
export interface Window<T> { items: T[]; total: number | null; truncated: boolean }
export interface Part<T> { availability: 'valid' | 'not-provided' | 'invalid'; reason: string | null;
  text_truncated: boolean; truncated: boolean; value: T | null }
export function record(value: unknown, fields?: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('record');
  const result = value as RecordValue;
  if (fields && (Object.keys(result).length !== fields.length || fields.some(k => !Object.hasOwn(result, k)))) throw Error('fields');
  return result;
}
export function text(value: unknown, maximum = 240, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw Error('text');
  return value;
}
export function integer(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) throw Error('integer');
  return value as number;
}
export function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw Error('boolean'); return value; }
export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw Error('choice'); return value as T;
}
export function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
export function identity(value: unknown): string {
  const result = text(value, 80); if (!/^[A-Za-z0-9_-]+$/.test(result)) throw Error('identity'); return result;
}
export function digest(value: unknown): string {
  const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) throw Error('digest'); return result;
}
export function window<T>(value: unknown, cap: number, read: (value: unknown) => T): Window<T> {
  const o = record(value, ['items', 'total', 'truncated']);
  if (!Array.isArray(o.items) || o.items.length > cap) throw Error('window');
  const items = o.items.map(read), total = nullable(o.total, integer), truncated = boolean(o.truncated);
  if (total === null ? !truncated : items.length !== Math.min(total, cap) || truncated !== (total > items.length)) throw Error('window coverage');
  return { items, total, truncated };
}
/** Only declared nested truncation flags participate; text is never reinterpreted. */
export function hasTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTruncation);
  if (!value || typeof value !== 'object') return false;
  const o = value as RecordValue;
  return o.truncated === true || Object.values(o).some(hasTruncation);
}
export function part<T>(value: unknown, read: (value: unknown) => T, allowNull = false): Part<T> {
  const o = record(value, ['availability', 'reason', 'text_truncated', 'truncated', 'value']);
  const availability = choice(o.availability, ['valid', 'not-provided', 'invalid']);
  const reason = nullable(o.reason, v => text(v)), text_truncated = boolean(o.text_truncated), truncated = boolean(o.truncated);
  if (availability !== 'valid') {
    if (o.value !== null || truncated || text_truncated || (availability === 'not-provided' ? reason !== 'not-in-source' : !reason)) throw Error('unavailable part');
    return { availability, reason, text_truncated, truncated, value: null };
  }
  const selected = o.value === null && allowNull ? null : read(o.value);
  if (reason !== null || selected === null && (text_truncated || truncated) || truncated !== (text_truncated || hasTruncation(selected))) throw Error('part truncation');
  return { availability, reason, text_truncated, truncated, value: selected };
}
export function unique<T>(values: T[], key: (value: T) => unknown = value => value): T[] {
  if (new Set(values.map(key)).size !== values.length) throw Error('duplicate'); return values;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Comparable recorded instants require an explicit zone and a real calendar date. */
export function recordedInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]! || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)) return null;
  const instant = Date.parse(value); return Number.isFinite(instant) ? instant : null;
}
export function observedInterval(start: string | null, end: string | null, observed: string | null): number | null {
  const first = recordedInstant(start), boundary = recordedInstant(observed), last = recordedInstant(end ?? observed);
  if (first === null || boundary === null || last === null || last < first || first > boundary || last > boundary) return null;
  return (last - first) / 60000;
}
/** A wall-clock rollback cannot make the same observation younger. */
export class ObservationAge {
  private anchor: { observation: string; wall: number; mono: number; age: number } | null = null;
  age(observation: string | null, wall: number, monotonic: number): number | null {
    const source = recordedInstant(observation); if (source === null || !Number.isFinite(wall) || !Number.isFinite(monotonic)) return null;
    const previous = this.anchor;
    if (source > wall) return null;
    const age = Math.max(0, wall - source, previous?.observation === observation ? previous.age + Math.max(0, monotonic - previous.mono) : 0);
    this.anchor = { observation: observation!, wall, mono: monotonic, age }; return age;
  }
}

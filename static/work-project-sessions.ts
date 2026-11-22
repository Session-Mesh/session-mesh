// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Sessions recorded on Work tasks, not an assertion about live Mesh sessions. */
import { el, formatDateTime } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { isObj, text } from './work-parse.ts';

export type RecordedSessions = Readonly<{ sessions: readonly Readonly<{ name: string; agent: string; last: string | null }>[]; total: number; omitted: number; partial: boolean }>;

export function parseRecordedSessions(value: unknown, project: string): RecordedSessions | null {
  if (!isObj(value) || value.schema !== 1 || value.command !== 'sessions-of' || typeof value.truncated !== 'boolean'
      || !isObj(value.scope) || value.scope.kind !== 'project' || value.scope.id !== project
      || !Array.isArray(value.sessions) || value.sessions.length > 100 || !Number.isSafeInteger(value.total) || (value.total as number) < 0) return null;
  const sessions: { name: string; agent: string; last: string | null }[] = [];
  for (const row of value.sessions) {
    if (!isObj(row)) return null;
    const name = text(row.name), agent = text(row.agent);
    if (!name || !agent) return null;
    sessions.push({ name, agent, last: text(row.last_activity) });
  }
  const total = value.total as number;
  if (total < sessions.length) return null;
  const reported = value.sessions_omitted;
  if (reported !== undefined && (!Number.isSafeInteger(reported) || (reported as number) < 0)) return null;
  const warnings = value.data_warnings, warningsOmitted = value.data_warnings_omitted;
  if (warnings !== undefined && (!Array.isArray(warnings) || warnings.length > 10 || warnings.some(warning => typeof warning !== 'string'))) return null;
  if (warningsOmitted !== undefined && (!Number.isSafeInteger(warningsOmitted) || (warningsOmitted as number) < 0)) return null;
  const omitted = Math.max(total - sessions.length, (reported as number | undefined) ?? 0);
  return { sessions, total, omitted, partial: value.truncated || omitted > 0 || (Array.isArray(warnings) && warnings.length > 0) || (warningsOmitted as number | undefined || 0) > 0 };
}

export function projectSessions(ctx: ViewContext, project: string): HTMLElement {
  const details = el('details', 'work-project-sessions');
  const summary = el('summary', '', ctx.t('work.sessions.title'));
  const content = el('div', 'work-project-sessions-content');
  details.append(summary, content);
  let controller: AbortController | null = null, sequence = 0;
  details.addEventListener('toggle', () => {
    controller?.abort(); const current = ++sequence;
    if (!details.open) { content.replaceChildren(); return; }
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ctx.scopeSignal!]);
    content.replaceChildren(el('p', '', ctx.t('work.sessions.loading')));
    void ctx.projectSessions!(project, signal).then(result => {
      if (signal.aborted || current !== sequence || !details.open || !details.isConnected) return;
      if (!result.ok) { content.replaceChildren(el('p', '', ctx.t('work.sessions.unavailable'))); return; }
      const note = el('p', 'work-mute', ctx.t('work.sessions.scope'));
      const list = el('ul', 'work-plain-list');
      for (const session of result.value.sessions) {
        list.append(el('li', 'work-project-session', el('strong', '', session.name), el('span', 'work-mute', session.agent),
          session.last ? el('span', 'work-mute', ctx.t('work.sessions.last', { date: formatDateTime(session.last, ctx.locale) })) : null));
      }
      content.replaceChildren(note, result.value.sessions.length ? list : el('p', '', ctx.t('work.sessions.empty')));
      if (result.value.omitted) content.append(el('p', 'work-mute', ctx.t('work.sessions.omitted', { n: result.value.omitted })));
      if (result.value.partial) content.append(el('p', 'work-mute', ctx.t('work.sessions.partial'))); 
    }, () => { if (!signal.aborted && current === sequence && details.open && details.isConnected)
      content.replaceChildren(el('p', '', ctx.t('work.sessions.unavailable'))); });
  });
  return details;
}

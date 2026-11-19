// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The detail pane of a task (`task` operation): fields, blockers, sessions (plain text), notes, typed events, questions. */

import { answerForm, unavailableNote } from './work-answer-form.ts';
import { el, formatDate, formatDateTime, omittedNote, priorityTag, statusBadge } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { Answer, Blocker, LinkedSession, Question, TargetRef, TaskDetail, TimelineEvent } from './work-types.ts';

const KNOWN_EVENTS: ReadonlySet<string> = new Set(['created', 'set', 'add', 'remove', 'progress', 'note', 'blocker', 'unblocked',
  'session_linked', 'question', 'answer', 'decision', 'learning', 'risk', 'metric', 'mentoring', 'shipped', 'project_created']);

function field(ctx: ViewContext, name: string, value: string | null): HTMLElement[] {
  if (!value) return [];
  return [el('dt', '', ctx.t(`work.field.${name}`)), el('dd', '', value)];
}

function fieldList(ctx: ViewContext, detail: TaskDetail): HTMLElement {
  const { task } = detail;
  const list = el('dl', 'work-fields');
  const rows: [string, string | null][] = [['product', task.product], ['project', detail.projectTitle ?? task.project], ['track', task.track],
    ['owner', task.owner], ['eta', task.eta ? formatDate(task.eta, ctx.locale) : null], ['size', task.size], ['origin', detail.origin],
    ['due', task.due ? formatDate(task.due, ctx.locale) : null], ['created', task.created ? formatDate(task.created, ctx.locale) : null],
    ['category', detail.category], ['tags', detail.tags.join(', ') || null]];
  for (const [name, value] of rows) list.append(...field(ctx, name, value));
  return list;
}

function blockerItem(ctx: ViewContext, blocker: Blocker): HTMLElement {
  const parts = [blocker.kind, blocker.text, blocker.on ? ctx.t('work.blockerWho', { on: blocker.on }) : ''].filter(part => part !== '');
  return el('li', 'work-detail-item', parts.join(' · '), blocker.opened ? el('span', 'work-mute', ` ${formatDate(blocker.opened, ctx.locale)}`) : null);
}

function targetItem(ctx: ViewContext, target: TargetRef): HTMLElement {
  return el('li', `work-detail-item work-dep-target work-dep-${target.state}`, el('span', 'work-dep-id', target.id),
    target.title ? el('span', 'work-dep-title', target.title) : null, el('span', 'work-dep-state', ctx.t(`work.dep.${target.state}`)));
}

function sessionItem(ctx: ViewContext, session: LinkedSession): HTMLElement {
  const parts = [session.name, session.agent, session.branch, session.repo].filter((part): part is string => !!part);
  const item = el('li', 'work-detail-item', parts.join(' · '));
  if (session.lastActivity) item.append(el('span', 'work-mute', ` ${formatDateTime(session.lastActivity, ctx.locale)}`));
  return item;
}

function section(ctx: ViewContext, titleKey: string, items: readonly HTMLElement[], note?: Node): HTMLElement | null {
  if (items.length === 0) return null;
  const root = el('section', 'work-detail-section', el('h4', 'work-detail-title', ctx.t(titleKey)));
  root.append(el('ul', 'work-detail-list', ...items));
  if (note) root.append(note);
  return root;
}

function eventSummary(event: TimelineEvent): string {
  return event.fields.map(([key, value]) => (key === 'text' || key === 'title' || key === 'value' ? value : `${key}: ${value}`)).join(' · ');
}

function eventItem(ctx: ViewContext, event: TimelineEvent): HTMLElement {
  const item = el('li', `work-event${event.prov === 'inferred' ? ' work-event-inferred' : ''}`);
  item.append(el('span', 'work-event-when', formatDateTime(event.at, ctx.locale)),
    el('span', 'work-event-type', KNOWN_EVENTS.has(event.type) ? ctx.t(`work.event.${event.type}`) : event.type),
    el('span', 'work-event-text', eventSummary(event)));
  if (event.prov) item.append(el('span', `work-prov work-prov-${event.prov}`, ctx.t(`work.prov.${event.prov}`)));
  const who = [event.agent, event.session].filter((part): part is string => !!part).join(' · ');
  if (who) item.append(el('span', 'work-mute work-event-who', who));
  return item;
}

/**
 * An answer written through the owner's signed-in browser (work-write) reads as the owner's. Any other answer was
 * relayed by an agent session that writes `by` freely: it reads as a relayed claim, a `by` other than `owner`
 * appears only as the stated answerer, and one that the owner's answer replaces says so.
 */
function provenance(ctx: ViewContext, answer: Answer): string {
  if (answer.ownerVerified) return ctx.t('work.answer.verified');
  const relayed = relayedProvenance(ctx, answer);
  return answer.superseded ? `${relayed} · ${ctx.t('work.answer.superseded')}` : relayed;
}

function relayedProvenance(ctx: ViewContext, answer: Answer): string {
  const session = answer.relayedBy;
  if (answer.by === null || answer.by === 'owner') {
    return session ? ctx.t('work.answer.relayed', { session }) : ctx.t('work.answer.unrelayed');
  }
  return session ? ctx.t('work.answer.relayedOther', { session, by: answer.by }) : ctx.t('work.answer.unrelayedOther', { by: answer.by });
}

function answerItem(ctx: ViewContext, answer: Answer): HTMLElement {
  const meta = [provenance(ctx, answer), answer.at ? formatDateTime(answer.at, ctx.locale) : null].filter((part): part is string => !!part);
  const state = answer.ownerVerified ? ' work-answer-verified' : answer.superseded ? ' work-answer-superseded' : '';
  return el('li', `work-answer${state}`, el('p', 'work-answer-text', answer.text), el('p', 'work-mute work-answer-meta', meta.join(' · ')));
}

/** The hint of a question the owner can still answer: open, or answered only by relayed (unverified) answers. */
function answerHint(ctx: ViewContext, question: Question, form: boolean): string {
  if (!question.open) return ctx.t('work.question.supersedeHint');
  return ctx.t(form ? 'work.question.answerHintForm' : 'work.question.answerHint');
}

/** The reply slot `[data-work-answer-slot]`: the owner's answer form, the note that work-write is missing, or (no
 *  sender) empty and hidden. */
function answerSlot(ctx: ViewContext, question: Question): { slot: HTMLElement; form: boolean } {
  const slot = el('div', 'work-answer-slot');
  slot.dataset.workAnswerSlot = question.id;
  const sender = ctx.answers;
  if (!sender) slot.hidden = true;
  else slot.append(sender.available() ? answerForm(ctx, sender, question.id) : unavailableNote(ctx));
  return { slot, form: !!sender && sender.available() };
}

/**
 * The answer area of a question, kept apart from the question text: the answers given, then, while the owner has
 * not answered it here (open, or answered only by relayed answers), a hint and the reply slot.
 */
function answerArea(ctx: ViewContext, question: Question): HTMLElement {
  const area = el('div', 'work-answer-area');
  area.dataset.workAnswerFor = question.id;
  if (question.answers.length > 0) area.append(el('ul', 'work-answer-list', ...question.answers.map(answer => answerItem(ctx, answer))));
  const verified = question.answers.some(answer => answer.ownerVerified);
  if (question.open || (!verified && ctx.answers)) {
    const { slot, form } = answerSlot(ctx, question);
    area.append(el('p', 'work-answer-hint work-mute', answerHint(ctx, question, form)), slot);
  }
  return area;
}

function questionItem(ctx: ViewContext, question: Question): HTMLElement {
  const state = question.open ? 'open' : 'answered';
  const item = el('li', `work-detail-item work-question-item work-question-${state}`,
    el('p', 'work-question-text', question.text, el('span', 'work-mute', ` ${ctx.t(question.open ? 'work.question.open' : 'work.question.answered')}`)), answerArea(ctx, question));
  item.dataset.questionId = question.id;
  return item;
}

function notesSection(ctx: ViewContext, notes: string): HTMLElement | null {
  if (!notes.trim()) return null;
  return el('section', 'work-detail-section', el('h4', 'work-detail-title', ctx.t('work.detail.notes')), el('pre', 'work-notes', notes));
}

export function renderDetail(ctx: ViewContext, detail: TaskDetail): HTMLElement {
  const { task } = detail;
  const root = el('div', 'work-detail');
  root.append(el('p', 'work-detail-id', task.id), el('h3', 'work-detail-heading', task.title),
    el('p', 'work-detail-status', statusBadge(ctx.t, task.status), priorityTag(task.priority)), fieldList(ctx, detail));
  const blocks = [
    section(ctx, 'work.detail.openBlockers', detail.openBlockers.map(blocker => blockerItem(ctx, blocker)), omittedNote(ctx.t, detail.omitted.open_blockers)),
    section(ctx, 'work.detail.blockedBy', detail.blockedBy.map(target => targetItem(ctx, target)), omittedNote(ctx.t, detail.omitted.blocked_by)),
    section(ctx, 'work.detail.blocking', detail.blocking.map(target => targetItem(ctx, target)), omittedNote(ctx.t, detail.omitted.blocking)),
    section(ctx, 'work.detail.sessions', detail.sessions.map(session => sessionItem(ctx, session)), omittedNote(ctx.t, detail.omitted.sessions)),
    notesSection(ctx, detail.notes),
    section(ctx, 'work.detail.questions', detail.questions.map(question => questionItem(ctx, question)), omittedNote(ctx.t, detail.omitted.questions)),
  ];
  for (const block of blocks) if (block) root.append(block);
  const events = detail.timeline.map(event => eventItem(ctx, event));
  const timeline = section(ctx, 'work.detail.events', events, omittedNote(ctx.t, detail.omitted.timeline));
  if (timeline) {
    timeline.className = 'work-detail-section work-events';
    root.append(timeline, el('p', 'work-legend', ctx.t('work.detail.legend')));
  }
  return root;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The open questions of the entry screen: one folded line above the products ("Pending questions n"), which unfolds
 * into the questions classified by zone, product, project and task (static/work-questions-triage.ts), with the
 * unattached ones grouped by the session that asked them. A row gives the question, its kind, age and asker, where
 * it stands, the options and the assumption (folded), and one way in: the task sheet at that question, the project's
 * Questions tab, or the question's own sheet. No answer form here: the operator answers where the context is.
 * Question text is tracker data written by agents: it only ever becomes text nodes.
 */

import { button, el, notice } from './work-dom.ts';
import type { Child, ViewContext } from './work-dom.ts';
import { errorBlock } from './work-error-view.ts';
import { linkText } from './work-linkify.ts';
import { aboutKind, ageOf, formatAge } from './work-questions.ts';
import { isAttached, isLongText, questionKind, triageQuestions } from './work-questions-triage.ts';
import type { Triage, TriageProduct, TriageProject, TriageTask, TriageZone, ZoneName } from './work-questions-triage.ts';
import type { EntryQuestionsState } from './work-questions-view.ts';
import type { Question } from './work-types.ts';

export type TriageHandlers = Readonly<{
  /** The order and names of the zones (the categories of the products document). */
  zones: readonly ZoneName[];
  /** The title of a project of the entry list, or null when it is not listed there. */
  projectTitle: (id: string) => string | null;
  /** Open the task sheet at the question (`question` is the id to show). */
  openTask: (task: string, question: string) => void;
  openProject: (project: string, question: string) => void;
  /** Open the sheet of a question about no task or project. */
  openQuestion: (question: Question) => void;
  /** Whether the section is unfolded, and the owner unfolding or folding it (the view keeps it with its place,
   *  static/work-view-state.ts). */
  sectionOpen: boolean;
  sectionToggled: (open: boolean) => void;
  /** Read the next page of questions ("Show more"). */
  showMore: () => void;
}>;

function count(n: number): HTMLElement {
  return el('span', 'work-count', String(n));
}

function askedBy(ctx: ViewContext, question: Question): string | null {
  const { askedByAgent: agent, askedBySession: session } = question;
  if (session && agent) return ctx.t('work.questions.askedByBoth', { session, agent });
  const who = session ?? agent;
  return who ? ctx.t('work.questions.askedBy', { who }) : null;
}

function metaLine(ctx: ViewContext, question: Question): HTMLElement {
  const kind = questionKind(question);
  const parts: Child[] = [el('span', `work-qkind work-qkind-${kind}`, ctx.t(`work.triage.kind.${kind}`))];
  const age = ageOf(question.askedAt, ctx.nowMs());
  if (age) {
    const when = el('time', 'work-qcard-age', formatAge(age, ctx.locale));
    when.dateTime = question.askedAt ?? '';
    parts.push(when);
  }
  parts.push(askedBy(ctx, question));
  const line = el('p', 'work-qcard-meta work-mute');
  parts.filter(part => part).forEach((part, index) => { if (index > 0) line.append(' · '); line.append(part!); });
  return line;
}

/** Where the question stands, in words: product, project, task (only the parts known). */
function contextLine(ctx: ViewContext, question: Question): HTMLElement | null {
  const context = question.context;
  const task = aboutKind(question.about) === 'task' ? question.about : null;
  const parts = [
    context?.product ? ctx.t('work.triage.product', { name: context.product }) : null,
    context?.project ? ctx.t('work.triage.project', { title: context.projectTitle ?? context.project }) : null,
    task ? ctx.t('work.triage.task', { id: task, title: context?.taskTitle ?? '' }).trim() : null,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? el('p', 'work-qrow-context work-mute', parts.join(' › ')) : null;
}

function textBlock(ctx: ViewContext, question: Question): HTMLElement[] {
  const text = el('p', 'work-question-text work-qrow-text', linkText(ctx.t, question.text));
  if (!isLongText(question.text)) return [text];
  text.id = `work-qrow-text-${question.id}`;
  text.classList.add('work-qrow-folded');
  const more = button('work-qrow-more', ctx.t('work.triage.more'), () => {
    const folded = text.classList.toggle('work-qrow-folded');
    more.textContent = ctx.t(folded ? 'work.triage.more' : 'work.triage.less');
    more.setAttribute('aria-expanded', String(!folded));
  });
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', text.id);
  return [text, more];
}

function assumptionBlock(ctx: ViewContext, question: Question): HTMLElement | null {
  if (!question.assumption) return null;
  return el('details', 'work-qrow-assumption', el('summary', '', ctx.t('work.triage.assumption')),
    el('p', 'work-qcard-extra', linkText(ctx.t, question.assumption)));
}

function openControl(ctx: ViewContext, handlers: TriageHandlers, question: Question): HTMLElement {
  // A question about a task or project the tracker does not know opens its own sheet, with the answer form.
  const about = isAttached(question) ? question.about : null, kind = aboutKind(about);
  if (about && kind === 'task') {
    const open = button('btn work-qrow-open', ctx.t('work.triage.openInTask', { id: about }), () => handlers.openTask(about, question.id));
    open.dataset.task = about;
    return open;
  }
  if (about && kind === 'project') {
    const title = question.context?.projectTitle ?? handlers.projectTitle(about) ?? about;
    const open = button('btn work-qrow-open', ctx.t('work.questions.openProject', { title }), () => handlers.openProject(about, question.id));
    open.dataset.project = about;
    return open;
  }
  const open = button('btn work-qrow-open', ctx.t('work.triage.openQuestion'), () => handlers.openQuestion(question));
  open.dataset.question = question.id;
  return open;
}

/** One question of the list: no form, one way in. */
function questionRow(ctx: ViewContext, handlers: TriageHandlers, question: Question): HTMLElement {
  const row = el('li', 'work-qcard work-qrow', ...textBlock(ctx, question), metaLine(ctx, question), contextLine(ctx, question));
  if (question.options.length > 0) row.append(el('p', 'work-qcard-extra', ctx.t('work.questions.options', { options: question.options.join(' · ') })));
  row.append(assumptionBlock(ctx, question) ?? '', el('div', 'work-actions work-qrow-actions', openControl(ctx, handlers, question)));
  row.dataset.questionId = question.id;
  return row;
}

function rows(ctx: ViewContext, handlers: TriageHandlers, questions: readonly Question[]): HTMLElement {
  return el('ul', 'work-qcard-list', ...questions.map(question => questionRow(ctx, handlers, question)));
}

function taskBlock(ctx: ViewContext, handlers: TriageHandlers, group: TriageTask): HTMLElement {
  const title = group.task === null ? ctx.t('work.triage.aboutProject')
    : ctx.t('work.triage.task', { id: group.task, title: group.title ?? '' }).trim();
  const block = el('div', 'work-qtask', el('p', 'work-qtask-title', title, count(group.questions.length)), rows(ctx, handlers, group.questions));
  block.dataset.group = group.task ?? 'project';
  return block;
}

function projectBlock(ctx: ViewContext, handlers: TriageHandlers, group: TriageProject): HTMLElement {
  const title = group.project === null ? ctx.t('work.triage.noProject') : group.title ?? group.project;
  const block = el('div', 'work-qproject', el('h5', 'work-qproject-title', title, count(group.count)),
    ...group.tasks.map(task => taskBlock(ctx, handlers, task)));
  block.dataset.group = group.project ?? 'no-project';
  return block;
}

function productBlock(ctx: ViewContext, handlers: TriageHandlers, group: TriageProduct): HTMLElement {
  const block = el('div', 'work-qproduct', el('h4', 'work-qproduct-title', group.product ?? ctx.t('work.triage.productUnknown'), count(group.count)),
    ...group.projects.map(project => projectBlock(ctx, handlers, project)));
  block.dataset.group = group.product ?? 'unknown';
  return block;
}

function zoneBlock(ctx: ViewContext, handlers: TriageHandlers, zone: TriageZone): HTMLElement {
  const block = el('section', 'work-qzone', el('h3', 'work-qzone-title', zone.name ?? ctx.t('work.triage.zoneUnknown'), count(zone.count)),
    ...zone.products.map(product => productBlock(ctx, handlers, product)));
  block.dataset.zone = zone.key ?? 'unknown';
  return block;
}

function unattachedBlock(ctx: ViewContext, handlers: TriageHandlers, triage: Triage): HTMLElement | null {
  if (triage.unattachedCount === 0) return null;
  const block = el('section', 'work-qzone work-qzone-unattached',
    el('h3', 'work-qzone-title', ctx.t('work.triage.unattached'), count(triage.unattachedCount)),
    el('p', 'work-qzone-hint work-mute', ctx.t('work.triage.unattachedHint')));
  for (const group of triage.unattached) {
    const session = el('div', 'work-qproduct', el('h4', 'work-qproduct-title', group.session ?? ctx.t('work.triage.sessionUnknown'),
      count(group.questions.length)), rows(ctx, handlers, group.questions));
    session.dataset.group = group.session ?? 'unknown';
    block.append(session);
  }
  block.dataset.zone = 'unattached';
  return block;
}

/** The newer questions not read yet (the list shows the oldest first, a page at a time): how many, and the way to the
 *  next page. The counts of the groups cover the questions shown. */
function moreBlock(ctx: ViewContext, handlers: TriageHandlers, left: number): HTMLElement {
  return el('div', 'work-qmore', notice('work-omitted', ctx.t('work.questions.more', { n: left })),
    el('div', 'work-actions', button('btn work-qmore-button', ctx.t('work.triage.showMore'), handlers.showMore)));
}

function listBody(ctx: ViewContext, handlers: TriageHandlers, state: EntryQuestionsState): Node[] {
  if (state.kind !== 'ready' && state.kind !== 'stale') return [];
  const { doc } = state;
  const triage = triageQuestions(doc.questions, handlers.zones, handlers.projectTitle);
  const nodes: Node[] = triage.zones.map(zone => zoneBlock(ctx, handlers, zone));
  const unattached = unattachedBlock(ctx, handlers, triage);
  if (unattached) nodes.push(unattached);
  const left = Math.max(doc.omitted, doc.openQuestions - doc.questions.length);
  if (left > 0) nodes.push(moreBlock(ctx, handlers, left));
  return nodes;
}

function heading(ctx: ViewContext, handlers: TriageHandlers, state: EntryQuestionsState, body: HTMLElement): HTMLElement {
  const title = el('h2', 'work-entry-category-name work-qsection-title');
  title.id = 'work-entry-questions-title';
  const shown = state.kind === 'ready' || state.kind === 'stale' ? state.doc.openQuestions : null;
  if (shown === null || shown === 0) {
    title.append(ctx.t('work.triage.title'), shown === null ? '' : count(0));
    return title;
  }
  const open = handlers.sectionOpen;
  const toggle = button('work-qsection-toggle', '', () => {
    const now = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(now));
    body.hidden = !now;
    handlers.sectionToggled(now);
  }, el('span', 'work-chev'), el('span', 'work-qsection-name', ctx.t('work.triage.title')), count(shown));
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-controls', body.id);
  body.hidden = !open;
  title.append(toggle);
  return title;
}

/** The questions section of the entry screen: the folded line, the state of the read, and the classified list. */
export function renderEntryQuestions(ctx: ViewContext, handlers: TriageHandlers, state: EntryQuestionsState): HTMLElement {
  const body = el('div', 'work-qsection-body', ...listBody(ctx, handlers, state));
  body.id = 'work-entry-questions-body';
  const root = el('section', 'work-entry-questions', heading(ctx, handlers, state, body));
  root.setAttribute('aria-labelledby', 'work-entry-questions-title');
  if (state.kind === 'loading') root.append(el('p', 'work-loading work-mute', ctx.t('work.questions.loading')));
  if (state.kind === 'failed' || state.kind === 'stale') root.append(errorBlock(ctx.t, state.error, { retry: state.retry }));
  if ((state.kind === 'ready' || state.kind === 'stale') && state.doc.openQuestions === 0 && state.doc.questions.length === 0) {
    root.append(el('p', 'work-entry-empty work-questions-none', ctx.t('work.questions.none')));
  }
  root.append(body);
  return root;
}

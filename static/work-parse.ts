// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Defensive parsing of the work-read documents. The route is authenticated, but its content comes from
 * user-written tracker data: TypeScript types do not validate runtime values. Unknown fields are ignored,
 * a missing field gets a neutral value, a wrong type is dropped, and strings are kept exactly as received.
 */

import type {
  Answer, Blocker, Category, ColumnKey, Columns, Counts, Dependency, DependencyState, LinkedSession, NoProject, Omitted, OpenQuestionsDoc, Product,
  ProductsDoc, ProjectDoc, ProjectHead, ProjectsDoc, ProjectSummary, Provenance, Question, QuestionContext, Reprise, TargetRef, TaskDetail,
  TaskRow, TimelineEvent,
} from './work-types.ts';

type Obj = Record<string, unknown>;

export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const ratio = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
const flag = (value: unknown): boolean => value === true;
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');
const objects = (value: unknown): Obj[] => list(value).filter(isObj);

export function parseCounts(value: unknown): Counts {
  const source = isObj(value) ? value : {};
  return { open: count(source.open), done: count(source.done), blockedTasks: count(source.blocked_tasks),
    dependencyOpenTasks: count(source.dependency_open_tasks),
    blockers: count(source.blockers), progress: ratio(source.progress) };
}

function collectOmitted(source: Obj, prefix: string, into: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('_omitted') && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      into[prefix + key.slice(0, -'_omitted'.length)] = Math.floor(value);
    }
  }
}

function parseOmitted(source: Obj): Omitted {
  const omitted: Record<string, number> = {};
  collectOmitted(source, '', omitted);
  if (isObj(source.reprise)) collectOmitted(source.reprise, 'reprise.', omitted);
  if (isObj(source.columns_omitted)) {
    for (const [name, value] of Object.entries(source.columns_omitted)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) omitted['columns.' + name] = Math.floor(value);
    }
  }
  return omitted;
}

function parseProduct(source: Obj): Product | null {
  const id = text(source.id);
  if (!id) return null;
  return { id, parent: text(source.parent), own: parseCounts(source), tree: parseCounts(source.tree),
    projects: count(source.projects), noProjectOpen: count(source.no_project_open) };
}

function parseCategory(source: Obj): Category {
  const products = objects(source.products).map(parseProduct).filter((p): p is Product => p !== null);
  return { key: text(source.key) ?? '', name: text(source.name) ?? text(source.key) ?? '', products };
}

export function parseProducts(value: unknown): ProductsDoc | null {
  if (!isObj(value) || !Array.isArray(value.categories)) return null;
  return { categories: objects(value.categories).map(parseCategory), truncated: flag(value.truncated) };
}

function parseProjectSummary(source: Obj): ProjectSummary | null {
  const id = text(source.id);
  if (!id) return null;
  return { id, title: text(source.title) ?? id, product: text(source.product) ?? '', status: text(source.status) ?? '',
    quarter: text(source.quarter), owner: text(source.owner), counts: parseCounts(source),
    lastActivity: text(source.last_activity) };
}

function parseNoProject(source: Obj): NoProject | null {
  const product = text(source.product);
  return product ? { product, counts: parseCounts(source) } : null;
}

export function parseProjects(value: unknown): ProjectsDoc | null {
  if (!isObj(value) || !Array.isArray(value.projects)) return null;
  const projects = objects(value.projects).map(parseProjectSummary).filter((p): p is ProjectSummary => p !== null);
  const noProject = objects(value.no_project).map(parseNoProject).filter((p): p is NoProject => p !== null);
  return { projects, noProject, total: count(value.total) || projects.length, truncated: flag(value.truncated) };
}

function parseBlocker(source: Obj): Blocker {
  return { id: text(source.id) ?? '', kind: text(source.kind) ?? '', text: text(source.text) ?? '',
    on: text(source.on), opened: text(source.opened) };
}

export function parseTaskRow(source: Obj): TaskRow | null {
  const id = text(source.id);
  if (!id) return null;
  return {
    id, title: text(source.title) ?? id, status: text(source.status) ?? '', priority: text(source.priority) ?? '',
    product: text(source.product) ?? '', project: text(source.project), track: text(source.track), due: text(source.due),
    owner: text(source.owner), lastActivity: text(source.last_activity), lastNote: text(source.last_note),
    created: text(source.created), eta: text(source.eta), size: text(source.size), doneAt: text(source.done_at),
    blockers: count(source.blockers), blockedBy: strings(source.blocked_by), dependencyOpen: flag(source.dependency_open),
    sessions: strings(source.sessions),
    daysSinceActivity: typeof source.days_since_activity === 'number' ? count(source.days_since_activity) : null,
    openBlockers: objects(source.open_blockers).map(parseBlocker),
  };
}

const taskRows = (value: unknown): TaskRow[] => objects(value).map(parseTaskRow).filter((row): row is TaskRow => row !== null);

function parseProjectHead(value: unknown): ProjectHead | null {
  if (!isObj(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  return {
    id, title: text(value.title) ?? id, product: text(value.product) ?? '', status: text(value.status) ?? '',
    quarter: text(value.quarter), owner: text(value.owner), milestones: strings(value.milestones), risks: strings(value.risks),
    openTasks: count(value.open_tasks), doneTasks: count(value.done_tasks), progress: ratio(value.progress),
    created: text(value.created), lastActivity: text(value.last_activity), blockedTasks: count(value.blocked_tasks),
    dependencyOpenTasks: count(value.dependency_open_tasks),
    blockers: count(value.blockers),
  };
}

const COLUMN_SOURCE: Readonly<Record<ColumnKey, string>> = { todo: 'todo', inProgress: 'in_progress', blocked: 'blocked', done: 'done', other: 'other' };

function parseColumns(value: unknown): Columns {
  const source = isObj(value) ? value : {};
  const column = (key: ColumnKey) => strings(source[COLUMN_SOURCE[key]]);
  return { todo: column('todo'), inProgress: column('inProgress'), blocked: column('blocked'), done: column('done'), other: column('other') };
}

/** The server caps the dependency list at 300 edges (wr_projects.ml); the parser holds the same bound. */
export const MAX_DEPENDENCIES = 300;
const dependencyState = (value: unknown): DependencyState => (value === 'open' || value === 'finished' ? value : 'unknown');

function parseDependency(source: Obj): Dependency | null {
  const from = text(source.from), to = text(source.to);
  if (!from || !to) return null;
  return { from, to, state: dependencyState(source.state), toTitle: text(source.to_title), toStatus: text(source.to_status),
    toInProject: flag(source.to_in_project) };
}

function parseReprise(value: unknown): Reprise {
  const source = isObj(value) ? value : {};
  return { inProgress: taskRows(source.in_progress), blocked: taskRows(source.blocked), stale: taskRows(source.stale),
    due: taskRows(source.due) };
}

const PROVENANCE: readonly string[] = ['stated', 'inferred', 'confirmed'];
const SCALAR_EVENT_KEYS_SKIPPED: ReadonlySet<string> = new Set(['at', 'task', 'type', 'agent', 'session', 'prov']);

function eventFieldValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return strings(value).join(', ');
  return null;
}

function parseEvent(source: Obj): TimelineEvent | null {
  const type = text(source.type);
  if (!type) return null;
  const fields: [string, string][] = [];
  for (const [key, value] of Object.entries(source)) {
    const shown = SCALAR_EVENT_KEYS_SKIPPED.has(key) ? null : eventFieldValue(value);
    if (shown) fields.push([key, shown]);
  }
  const prov = typeof source.prov === 'string' && PROVENANCE.includes(source.prov) ? (source.prov as Provenance) : null;
  return { at: text(source.at), task: text(source.task) ?? '', type, agent: text(source.agent), session: text(source.session),
    fields, prov };
}

const events = (value: unknown): TimelineEvent[] => objects(value).map(parseEvent).filter((e): e is TimelineEvent => e !== null);

function parseAnswer(source: Obj): Answer | null {
  const body = text(source.text);
  if (body === null) return null;
  return { text: body, by: text(source.by), at: text(source.at), relayedBy: text(source.relayed_by_session),
    ownerVerified: source.owner_verified === true, superseded: source.superseded === true };
}

/** The `context` of a question of `resume`; absent (not an empty object) when it names nothing. */
function contextOf(value: unknown): { context: QuestionContext } | Record<string, never> {
  if (!isObj(value)) return {};
  const context = { taskTitle: text(value.task_title), project: text(value.project), projectTitle: text(value.project_title),
    product: text(value.product), category: text(value.category) };
  return Object.values(context).some(part => part !== null) ? { context } : {};
}

function parseQuestion(source: Obj): Question | null {
  const id = text(source.id), body = text(source.text);
  if (!id || body === null) return null;
  const answers = objects(source.answers).map(parseAnswer).filter((a): a is Answer => a !== null);
  const askedByAgent = text(source.asked_by_agent), askedBySession = text(source.asked_by_session);
  return { id, open: source.state !== 'answered', text: body, options: strings(source.options), assumption: text(source.assumption),
    about: text(source.about), askedBy: askedBySession ?? askedByAgent, askedByAgent, askedBySession, askedAt: text(source.asked_at), answers,
    ownerAnswered: source.owner_answered === true || answers.some(answer => answer.ownerVerified), ...contextOf(source.context) };
}

const questions = (value: unknown): Question[] => objects(value).map(parseQuestion).filter((q): q is Question => q !== null);

/** A page of `open-questions` (or the questions part of an unscoped `resume`): only open questions are kept. */
export function parseOpenQuestions(value: unknown): OpenQuestionsDoc | null {
  if (!isObj(value) || !Array.isArray(value.questions)) return null;
  const open = questions(value.questions).filter(question => question.open);
  return { openQuestions: Math.max(count(value.open_questions), open.length), questions: open,
    omitted: count(value.questions_omitted), truncated: flag(value.truncated) };
}

export function parseProject(value: unknown): ProjectDoc | null {
  if (!isObj(value)) return null;
  const project = parseProjectHead(value.project);
  if (!project) return null;
  return {
    project, tasks: taskRows(value.tasks), columns: parseColumns(value.columns),
    dependencies: objects(value.dependencies).map(parseDependency).filter((d): d is Dependency => d !== null).slice(0, MAX_DEPENDENCIES),
    reprise: parseReprise(value.reprise), openQuestions: count(value.open_questions), questions: questions(value.questions),
    timeline: events(value.timeline), omitted: parseOmitted(value), truncated: flag(value.truncated),
  };
}

function parseTarget(source: Obj): TargetRef | null {
  const id = text(source.id);
  return id ? { id, state: dependencyState(source.state), title: text(source.title), status: text(source.status) } : null;
}

const targets = (value: unknown): TargetRef[] => objects(value).map(parseTarget).filter((t): t is TargetRef => t !== null);

function parseSession(source: Obj): LinkedSession | null {
  const name = text(source.name);
  return name ? { name, agent: text(source.agent), repo: text(source.repo), branch: text(source.branch),
    lastActivity: text(source.last_activity) } : null;
}

export function parseTask(value: unknown): TaskDetail | null {
  if (!isObj(value) || !isObj(value.task)) return null;
  const task = parseTaskRow(value.task);
  if (!task) return null;
  const extra = value.task;
  return {
    task, category: text(extra.category), origin: text(extra.origin), tags: strings(extra.tags), links: strings(extra.links),
    projectTitle: isObj(value.project) ? text(value.project.title) : null, notes: text(value.notes) ?? '',
    resolvedBlockers: count(value.resolved_blockers), openBlockers: objects(value.open_blockers).map(parseBlocker),
    blockedBy: targets(value.blocked_by), blocking: targets(value.blocking),
    sessions: objects(value.sessions).map(parseSession).filter((s): s is LinkedSession => s !== null),
    timeline: events(value.timeline), openQuestions: count(value.open_questions), questions: questions(value.questions),
    omitted: parseOmitted(value), truncated: flag(value.truncated),
  };
}

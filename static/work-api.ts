// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Client of `POST /api/work/v1`: same origin, page credentials, every outcome a value (never a throw). */

import { isObj, parseOpenQuestions, parseProducts, parseProject, parseProjects, parseTask, text } from './work-parse.ts';
import { parseProductDoc } from './work-product-parse.ts';
import { parseRecordedSessions } from './work-project-sessions.ts';
import type { RecordedSessions } from './work-project-sessions.ts';
import type { ProductDoc } from './work-product-parse.ts';
import { parseSessionQuestions } from './work-session-questions.ts';
import type { SessionQuestionsDoc } from './work-session-questions.ts';
import { parseIds } from './work-references-parse.ts';
import type { KnownIds } from './work-references-parse.ts';
import type { OpenQuestionsDoc, ProductsDoc, ProjectDoc, ProjectsDoc, TaskDetail } from './work-types.ts';

export type WorkFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * no-tracker: no single data repository was found, missing or ambiguous (error `repository`); not-available: the
 * program is not installed (503 `not_available`); busy: the server already runs its maximum of programs
 * (503 `busy`); unavailable: any other 503;
 * invalid: the request was refused (400); missing: nothing under that id (404); conflict: the question already has another
 * answer from the owner (409); auth: the server refused the credential or the origin (401, 403); failed: the program failed
 * (502, other statuses); timeout: 504; network: no answer; shape: an answer that is not the expected document; aborted: cancelled.
 */
export type WorkErrorKind = 'no-tracker' | 'not-available' | 'busy' | 'unavailable' | 'invalid' | 'missing' | 'conflict' | 'auth'
  | 'failed' | 'timeout' | 'network' | 'shape' | 'aborted';
export type WorkError = Readonly<{ kind: WorkErrorKind; status: number; code: string | null; retry: boolean }>;
export type WorkResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: WorkError }>;

const fail = (kind: WorkErrorKind, status = 0, code: string | null = null): { ok: false; error: WorkError } =>
  ({ ok: false, error: { kind, status, code, retry: !['invalid', 'missing', 'conflict', 'aborted'].includes(kind) } });

function errorKind(status: number, code: string | null): WorkErrorKind {
  if (code === 'repository') return 'no-tracker';
  if (status === 400) return 'invalid';
  if (status === 404) return 'missing';
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403) return 'auth';
  if (status === 503) return code === 'not_available' ? 'not-available' : code === 'busy' ? 'busy' : 'unavailable';
  if (status === 504) return 'timeout';
  return 'failed';
}

async function readBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function errorCode(body: unknown): string | null {
  return isObj(body) && isObj(body.error) ? text(body.error.code) : null;
}

/** A parser is meant never to throw; if one does, the answer is a shape error, not a rejected promise. */
function parseBody<T>(parse: (body: unknown) => T | null, body: unknown, status: number): WorkResult<T> {
  try {
    const value = parse(body);
    return value === null ? fail('shape', status) : { ok: true, value };
  } catch { return fail('shape', status); }
}

/** The reply of an answer written by work-write: the question id, whether the same answer was already there, and
 *  whether the data repository's git commit was skipped or failed (the answer is recorded all the same). */
export type AnswerReceipt = Readonly<{ id: string; duplicate: boolean; uncommitted: boolean }>;

function parseReceipt(body: unknown): AnswerReceipt | null {
  if (!isObj(body) || body.owner_verified !== true) return null;
  const id = text(body.id);
  return id ? { id, duplicate: body.duplicate === true, uncommitted: body.uncommitted === true } : null;
}

/** Which page of the open questions to read: after the question `after`, at most `limit` of them. */
export type OpenQuestionsPage = Readonly<{ after?: string; limit?: number }>;

export type WorkApi = Readonly<{
  products(signal?: AbortSignal): Promise<WorkResult<ProductsDoc>>;
  projects(signal?: AbortSignal): Promise<WorkResult<ProjectsDoc>>;
  /** Every task of a product and of its child products (`product`), for its Board and Timeline. */
  product(id: string, signal?: AbortSignal): Promise<WorkResult<ProductDoc>>;
  project(id: string, signal?: AbortSignal): Promise<WorkResult<ProjectDoc>>;
  task(id: string, signal?: AbortSignal): Promise<WorkResult<TaskDetail>>;
  projectSessions(id: string, signal?: AbortSignal): Promise<WorkResult<RecordedSessions>>;
  /** A page of the open questions of the tracker, oldest first and in full (`open-questions`): those asked after the
   *  question `after` (the last one of the previous page), at most `limit` (20 by default, at most 100), the total, and
   *  how many come after the page (`omitted`). */
  openQuestions(signal?: AbortSignal, page?: OpenQuestionsPage): Promise<WorkResult<OpenQuestionsDoc>>;
  /** The open questions of each session, by name (`session-questions`), for the session marker. */
  sessionQuestions(signal?: AbortSignal): Promise<WorkResult<SessionQuestionsDoc>>;
  /** Every task, project and question id with its title (`ids`), for the references of the terminal. */
  ids(signal?: AbortSignal): Promise<WorkResult<KnownIds>>;
  /** The owner's answer to an open question (the write op, sent with the page's own cookie only); with `edit`, a
   *  correction of the owner's earlier answer; `choices`: the options picked. */
  answer(question: string, answerText: string, extra?: AnswerExtra): Promise<WorkResult<AnswerReceipt>>;
}>;

/** The optional arguments of the write op: sent only when set, so a plain answer is the request it always was. */
export type AnswerExtra = Readonly<{ edit?: boolean; choices?: readonly string[] }>;

function answerArgs(question: string, answerText: string, extra: AnswerExtra = {}): Record<string, unknown> {
  return { question, text: answerText, ...(extra.edit ? { edit: true } : {}),
    ...(extra.choices && extra.choices.length > 0 ? { choices: [...extra.choices] } : {}) };
}

/**
 * The reads a page may have in flight at once. The relay runs at most four work programs for all its pages together and
 * refuses the next one as `busy`; two per page is what the Projects view needed before it also read the open
 * questions, so two pages opening it together still fit. The session marker (work-session-marker.ts) reads through
 * the same slots.
 */
export type ReadSlots = Readonly<{
  /** Wait for a free slot; false when the signal aborted first (the slot is then not taken). */
  take: (signal?: AbortSignal) => Promise<boolean>;
  give: () => void;
}>;

export function readSlots(limit: number): ReadSlots {
  let used = 0;
  const waiting: (() => void)[] = [];
  const take = (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false);
    if (used < limit) { used++; return Promise.resolve(true); }
    return new Promise(resolve => {
      const granted = (): void => { signal?.removeEventListener('abort', aborted); resolve(true); };
      const aborted = (): void => { waiting.splice(waiting.indexOf(granted), 1); resolve(false); };
      signal?.addEventListener('abort', aborted, { once: true });
      waiting.push(granted);
    });
  };
  const give = (): void => {
    const next = waiting.shift();
    if (next) next(); else used = Math.max(0, used - 1);   // the slot passes straight to the next read
  };
  return { take, give };
}

/** The slots of this page, shared by every client it creates. */
const PAGE_READS = readSlots(2);

/** The pauses before a read refused as `busy` is sent again (a little longer each time, spread so pages do not retry
 *  together); a write is never sent again. */
const BUSY_DELAYS: readonly number[] = [300, 900, 2000];

export type WorkApiOptions = Readonly<{ slots?: ReadSlots; busyDelays?: readonly number[] }>;

/** Wait `ms` (a little more, at random), or less when the signal aborts; false when it aborted. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (): void => { signal?.removeEventListener('abort', stop); resolve(true); };
    const timer = setTimeout(done, ms * (1 + Math.random() / 2));
    const stop = (): void => { clearTimeout(timer); resolve(false); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export function createWorkApi(request: WorkFetch, url = '/api/work/v1', options: WorkApiOptions = {}): WorkApi {
  const slots = options.slots ?? PAGE_READS, delays = options.busyDelays ?? BUSY_DELAYS;

  /** A read: in one of the page's slots, sent again after a pause while the relay answers `busy`. */
  async function read<T>(op: string, args: Record<string, unknown>, parse: (body: unknown) => T | null,
    signal?: AbortSignal): Promise<WorkResult<T>> {
    for (let attempt = 0; ; attempt++) {
      if (!await slots.take(signal)) return fail('aborted');
      let result: WorkResult<T>;
      try { result = await call(op, args, parse, signal); } finally { slots.give(); }
      const delay = delays[attempt];
      if (result.ok || result.error.kind !== 'busy' || delay === undefined) return result;
      if (!await pause(delay, signal)) return fail('aborted');
    }
  }

  async function call<T>(op: string, args: Record<string, unknown>, parse: (body: unknown) => T | null,
    signal?: AbortSignal): Promise<WorkResult<T>> {
    let response: Response;
    try {
      const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ op, args }) };
      if (signal) init.signal = signal;
      response = await request(url, init);
    } catch (error) {
      return signal?.aborted || (error instanceof DOMException && error.name === 'AbortError') ? fail('aborted') : fail('network');
    }
    const body = await readBody(response);
    if (!response.ok) return fail(errorKind(response.status, errorCode(body)), response.status, errorCode(body));
    return parseBody(parse, body, response.status);
  }
  return {
    products: signal => read('products', {}, parseProducts, signal),
    projects: signal => read('projects', {}, parseProjects, signal),
    product: (id, signal) => read('product', { id }, parseProductDoc, signal),
    project: (id, signal) => read('project', { id }, parseProject, signal),
    task: (id, signal) => read('task', { id }, parseTask, signal),
    projectSessions: (id, signal) => read('sessions-of', { project: id }, value => parseRecordedSessions(value, id), signal),
    openQuestions: (signal, page = {}) => read('open-questions', {
      ...(page.after ? { after: page.after } : {}), ...(page.limit ? { limit: page.limit } : {}),
    }, parseOpenQuestions, signal),
    sessionQuestions: signal => read('session-questions', {}, parseSessionQuestions, signal),
    ids: signal => read('ids', {}, parseIds, signal),
    answer: (question, answerText, extra) => call('answer', answerArgs(question, answerText, extra), parseReceipt),
  };
}

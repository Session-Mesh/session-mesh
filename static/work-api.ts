// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Client of `POST /api/work/v1`: same origin, page credentials, every outcome a value (never a throw). */

import { isObj, parseProducts, parseProject, parseProjects, parseTask, text } from './work-parse.ts';
import type { ProductsDoc, ProjectDoc, ProjectsDoc, TaskDetail } from './work-types.ts';

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

export type WorkApi = Readonly<{
  products(signal?: AbortSignal): Promise<WorkResult<ProductsDoc>>;
  projects(signal?: AbortSignal): Promise<WorkResult<ProjectsDoc>>;
  project(id: string, signal?: AbortSignal): Promise<WorkResult<ProjectDoc>>;
  task(id: string, signal?: AbortSignal): Promise<WorkResult<TaskDetail>>;
  /** The owner's answer to an open question (the write op, sent with the page's own cookie only). */
  answer(question: string, answerText: string): Promise<WorkResult<AnswerReceipt>>;
}>;

export function createWorkApi(request: WorkFetch, url = '/api/work/v1'): WorkApi {
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
    products: signal => call('products', {}, parseProducts, signal),
    projects: signal => call('projects', {}, parseProjects, signal),
    project: (id, signal) => call('project', { id }, parseProject, signal),
    task: (id, signal) => call('task', { id }, parseTask, signal),
    answer: (question, answerText) => call('answer', { question, text: answerText }, parseReceipt),
  };
}

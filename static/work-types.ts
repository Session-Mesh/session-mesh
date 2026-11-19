// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Shapes of the documents of `POST /api/work/v1`, after defensive parsing (see work-parse.ts). */

export type Counts = Readonly<{
  open: number; done: number; blockedTasks: number; dependencyOpenTasks: number; blockers: number; progress: number | null;
}>;

export type Product = Readonly<{
  id: string; parent: string | null; own: Counts; tree: Counts; projects: number; noProjectOpen: number;
}>;
export type Category = Readonly<{ key: string; name: string; products: readonly Product[] }>;
export type ProductsDoc = Readonly<{ categories: readonly Category[]; truncated: boolean }>;

export type ProjectSummary = Readonly<{
  id: string; title: string; product: string; status: string; quarter: string | null; owner: string | null;
  counts: Counts; lastActivity: string | null;
}>;
export type NoProject = Readonly<{ product: string; counts: Counts }>;
export type ProjectsDoc = Readonly<{
  projects: readonly ProjectSummary[]; noProject: readonly NoProject[]; total: number; truncated: boolean;
}>;

export type Blocker = Readonly<{ id: string; kind: string; text: string; on: string | null; opened: string | null }>;

export type TaskRow = Readonly<{
  id: string; title: string; status: string; priority: string; product: string; project: string | null;
  track: string | null; due: string | null; owner: string | null; lastActivity: string | null; lastNote: string | null;
  created: string | null; eta: string | null; size: string | null; doneAt: string | null;
  blockers: number; blockedBy: readonly string[]; dependencyOpen: boolean; sessions: readonly string[];
  daysSinceActivity: number | null; openBlockers: readonly Blocker[];
}>;

export type ProjectHead = Readonly<{
  id: string; title: string; product: string; status: string; quarter: string | null; owner: string | null;
  milestones: readonly string[]; risks: readonly string[]; openTasks: number; doneTasks: number;
  progress: number | null; created: string | null; lastActivity: string | null; blockedTasks: number;
  dependencyOpenTasks: number; blockers: number;
}>;

export type ColumnKey = 'todo' | 'inProgress' | 'blocked' | 'done' | 'other';
export type Columns = Readonly<Record<ColumnKey, readonly string[]>>;

export type DependencyState = 'open' | 'finished' | 'unknown';
export type Dependency = Readonly<{
  from: string; to: string; state: DependencyState; toTitle: string | null; toStatus: string | null; toInProject: boolean;
}>;

export type Reprise = Readonly<{
  inProgress: readonly TaskRow[]; blocked: readonly TaskRow[]; stale: readonly TaskRow[]; due: readonly TaskRow[];
}>;

export type Provenance = 'stated' | 'inferred' | 'confirmed';
export type TimelineEvent = Readonly<{
  at: string | null; task: string; type: string; agent: string | null; session: string | null;
  fields: readonly (readonly [string, string])[]; prov: Provenance | null;
}>;

export type Question = Readonly<{
  id: string; open: boolean; text: string; options: readonly string[]; about: string | null;
  askedBy: string | null; askedAt: string | null;
}>;

/** Counts of items a list kept out (`<key>_omitted` of the document). */
export type Omitted = Readonly<Record<string, number>>;

export type ProjectDoc = Readonly<{
  project: ProjectHead; tasks: readonly TaskRow[]; columns: Columns; dependencies: readonly Dependency[];
  reprise: Reprise; openQuestions: number; questions: readonly Question[]; timeline: readonly TimelineEvent[];
  omitted: Omitted; truncated: boolean;
}>;

export type TargetRef = Readonly<{ id: string; state: DependencyState; title: string | null; status: string | null }>;

export type LinkedSession = Readonly<{
  name: string; agent: string | null; repo: string | null; branch: string | null; lastActivity: string | null;
}>;

export type TaskDetail = Readonly<{
  task: TaskRow; category: string | null; origin: string | null; tags: readonly string[]; links: readonly string[];
  projectTitle: string | null; notes: string; resolvedBlockers: number; openBlockers: readonly Blocker[];
  blockedBy: readonly TargetRef[]; blocking: readonly TargetRef[]; sessions: readonly LinkedSession[];
  timeline: readonly TimelineEvent[]; openQuestions: number; questions: readonly Question[];
  omitted: Omitted; truncated: boolean;
}>;

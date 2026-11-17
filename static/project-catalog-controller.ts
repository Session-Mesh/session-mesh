// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectCatalog } from './project-catalog.ts';
import { ProjectCatalogView, ProjectDom } from './project-catalog-view.ts';
import type { Translate } from './project-catalog-view.ts';
export type Request = (input: string, init?: RequestInit) => Promise<Response>;
export interface ProjectOptions { root: HTMLElement; request: Request; translate: Translate;
  readPath: () => string; writePath: (path: string) => void; origin: string }
type ReadCatalog = (path: string, request: Request, signal: AbortSignal, current: () => boolean, origin: string) => Promise<ProjectCatalog>;

export class ProjectCatalogController {
  private generation = 0;
  private pending: AbortController | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private catalog: ProjectCatalog | null = null;
  private visible = false;
  private input: HTMLInputElement;
  private status: HTMLElement;
  private view: ProjectCatalogView;
  private options: ProjectOptions;
  private read: ReadCatalog;
  constructor(options: ProjectOptions, read: ReadCatalog) {
    this.options = options; this.read = read;
    const dom = new ProjectDom(options.root.ownerDocument, options.translate);
    const form = dom.element('form'); form.className = 'projects-load';
    const label = dom.element('label', dom.t('projects.path'));
    this.input = dom.element('input'); this.input.id = 'projects-path'; this.input.type = 'text'; this.input.autocomplete = 'off';
    this.input.value = options.readPath(); this.input.placeholder = dom.t('projects.pathExample'); label.htmlFor = this.input.id;
    const load = dom.element('button', dom.t('projects.load')); load.type = 'submit'; load.className = 'btn'; form.append(label, this.input, load);
    this.status = dom.element('p', dom.t('projects.choose')); this.status.id = 'projects-status'; this.status.setAttribute('role', 'status');
    const content = dom.element('div'); content.className = 'projects-content';
    const list = dom.element('nav'); list.className = 'projects-list'; list.setAttribute('aria-label', dom.t('projects.catalog'));
    const detail = dom.element('article'); detail.className = 'projects-detail'; content.append(list, detail);
    options.root.replaceChildren(form, this.status, content); this.view = new ProjectCatalogView(dom, this.status, list, detail);
    form.addEventListener('submit', event => { event.preventDefault(); if (this.visible) void this.refresh(); });
  }
  private cancel() {
    this.generation++; this.pending?.abort(); this.pending = null;
    if (this.deadline !== null) clearTimeout(this.deadline); this.deadline = null;
  }
  private async refresh() {
    this.cancel(); const issue = this.generation, controller = new AbortController(); this.pending = controller;
    const current = () => this.visible && issue === this.generation, path = this.input.value.trim();
    this.status.textContent = this.options.translate('projects.loading'); this.catalog = null; this.view.clear();
    this.deadline = setTimeout(() => { if (current()) { controller.abort(); this.status.textContent = this.options.translate('projects.unavailable'); } }, 5000);
    try {
      const value = await this.read(path, this.options.request, controller.signal, current, this.options.origin);
      if (!current() || controller.signal.aborted) return;
      this.options.writePath(path); this.catalog = value; this.view.render(value);
    } catch { if (current()) this.status.textContent = this.options.translate('projects.unavailable'); }
    finally { if (current()) { if (this.deadline !== null) clearTimeout(this.deadline); this.deadline = null; this.pending = null; } }
  }
  open() { this.visible = true; if (this.catalog) this.view.render(this.catalog); else this.status.textContent = this.options.translate('projects.choose'); }
  close() { this.visible = false; this.cancel(); this.view.suspend(); }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { requestProject, projectReadRequest, ProjectTransportError } from './project-host.ts';
import type { HostReply, ProjectMembership, ProjectDetail, ProjectHTTP, ProjectRequest, ProjectSummary } from './project-host.ts';
import { safeProjectURL } from './project-catalog.js';
import { ProjectObservationReader } from './project-observation.ts';
import { ProjectCatalogView, ProjectDom } from './project-catalog-view.ts';
import { projectPreferences } from './project-followup-preferences.ts';
import type { ProjectObservationSettings } from './project-host.ts';
import { ProjectEditor } from './project-editor.ts';
import { ProjectCockpitView } from './project-cockpit-view.ts';
import { artifactRequest } from './project-artifact-client.ts';
import { issueReader } from './project-issue-client.ts';
import type { IssueReader } from './project-issue-client.ts';
import type { ProjectIntent } from './project-editor.ts';

type Translate = (key: string, values?: Record<string, string | number>) => string;
interface WorkspaceOptions {
  root: HTMLElement; sidebar: HTMLElement; request: ProjectHTTP; translate: Translate;
  availability: (ready: boolean) => void;
  mountArtifact: (root: HTMLElement) => { open: () => void; close: () => void };
}

class ProjectWorkspace {
  private readonly options: WorkspaceOptions;
  private readonly doc: Document;
  private readonly t: Translate;
  private readonly status: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly content: HTMLElement;
  private readonly legacy: HTMLDetailsElement;
  private readonly artifact: { open: () => void; close: () => void };
  private readonly editor: ProjectEditor;
  private readonly cockpit: ProjectCockpitView;
  private visible = false;
  private ready = false;
  private capability: HostReply | null = null;
  private generation = 0;
  private selectionGeneration = 0;
  private boot = '';
  private machine = '';
  private settings: ProjectObservationSettings | undefined;
  private observation: ProjectObservationReader | null = null;
  private observationGeneration = 0;
  private observedView: ProjectCatalogView | null = null;
  private observationRoot: HTMLElement;
  private contextCards: HTMLElement;
  private observationStatus: HTMLElement;
  private observationTimer: ReturnType<typeof setTimeout> | null = null;
  private contextRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private contextRefreshFailures = 0;
  private capacityRefreshFailures = 0;
  private retryObservation = false;
  private observationUnsupported = false;
  private reloadObservationContext = false;
  private busyObservation: ProjectObservationReader | null = null;
  private revision = 'cfg1_missing';
  private selected: string | null = null;
  private summaries: ProjectSummary[] = [];
  private detail: ProjectDetail | null = null;
  private membership: ProjectMembership | undefined;
  private omissions: string[] = [];
  private writing = false;
  private pending: ProjectIntent | null = null;
  private reconciled = false;
  private readonly readers = new Set<AbortController>();
  private readonly pendingKey = 'mesh.projects.pending.v1';

  constructor(options: WorkspaceOptions) {
    this.options = options;
    this.doc = options.root.ownerDocument; this.t = options.translate;
    this.status = this.el('p'); this.status.id = 'project-workspace-status'; this.status.setAttribute('role', 'status');
    this.notice = this.el('section'); this.notice.className = 'project-save-notice'; this.notice.hidden = true;
    this.content = this.el('section'); this.content.id = 'project-overview';
    this.legacy = this.el('details'); this.legacy.className = 'project-legacy'; this.legacy.open = true;
    this.legacy.append(this.el('summary', this.t('projectWorkspace.snapshot')));
    const legacyRoot = this.el('div'); this.legacy.append(legacyRoot);
    this.contextCards = this.el('section'); this.contextCards.className = 'project-context-settings';
    this.observationRoot = this.el('section'); this.observationRoot.className = 'project-observation';
    this.observationStatus = this.el('p'); this.observationStatus.setAttribute('role', 'status');
    options.root.replaceChildren(this.status, this.notice, this.content, this.observationRoot, this.contextCards, this.legacy);
    this.artifact = options.mountArtifact(legacyRoot);
    this.cockpit = new ProjectCockpitView(options.root, this.observationRoot, this.contextCards, this.legacy, this.t,
      (source, task) => this.observedView?.selectTask(source, task) ?? false, source => {
        if(!this.visible||!this.ready||!this.detail)throw Error('unavailable');
        const scope={boot:this.boot,machine_id:this.machine,revision:this.revision,project_id:this.detail.id,source_id:source};
        const read=artifactRequest(options.request,scope);
        return async(query,signal)=>{
          const value=await read(query,signal);
          if(!this.visible||!this.ready||!this.detail||this.detail.id!==scope.project_id||this.selected!==scope.project_id||this.boot!==scope.boot||this.machine!==scope.machine_id||this.revision!==scope.revision)throw Error('source-changed');
          return value;
        };
      },(source,board)=>this.observedView?.selectSource(source,board)??false);
    this.editor = new ProjectEditor({ doc: this.doc, translate: this.t,
      canEdit: () => this.visible && this.ready && !this.writing && !this.pending,
      visible: () => this.visible, blocked: () => { this.renderNotice(); },
      context: () => ({ boot: this.boot, revision: this.revision, omissions: [...this.omissions], ...(this.settings ? { settings: this.settings } : {}) }),
      readSource: async id => {
        const project = this.selected, issue = this.selectionGeneration;
        const value = await this.call({ op: 'project_read', version: 1, project_id: project, settings: { kind: 'source', source_id: id } });
        if (!this.visible || issue !== this.selectionGeneration || project !== this.selected || value.project?.id !== project || value.status !== 'ok' || value.boot !== this.boot || value.machine_id !== this.machine || value.revision !== this.revision || value.observation_settings?.kind !== 'source' || value.observation_settings.source.id !== id || value.omitted_fields?.includes('observation_settings')) throw Error('settings');
        return value.observation_settings;
      },
      focusReturn: () => { this.content.querySelector<HTMLElement>('h2')?.focus(); },
      save: (value, owner, error) => this.save(value, owner, error) });
    this.restorePending(); this.renderOverview(); this.renderNotice();
    this.doc.addEventListener('visibilitychange', () => {
      this.clearObservationTimers();
      if (this.visible && !this.doc.hidden) void this.refreshObservedContext();
    });
  }
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private button(text: string, action: () => void, primary = false) {
    const node = this.el('button', text); node.type = 'button'; node.className = primary ? 'btn primary' : 'btn';
    node.addEventListener('click', action); return node;
  }
  private restorePending() {
    try {
      const raw = this.doc.defaultView?.sessionStorage.getItem(this.pendingKey);
      if (raw && raw.length < 128 * 1024) {
        const item = JSON.parse(raw) as Partial<ProjectIntent>;
        if ((item.op === 'project_create' || item.op === 'project_settings') && item.version === 1 &&
            typeof item.request_id === 'string') this.pending = item as ProjectIntent;
      }
    } catch { /* Disabled draft storage does not replace the host registry. */ }
  }
  private keepPending(value: ProjectIntent | null) {
    this.pending = value; this.reconciled = false;
    try {
      if (value) this.doc.defaultView?.sessionStorage.setItem(this.pendingKey, JSON.stringify(value));
      else this.doc.defaultView?.sessionStorage.removeItem(this.pendingKey);
    } catch { /* Never substitute browser storage for a confirmed host commit. */ }
    this.renderNotice();
  }
  private availability() { this.options.availability(this.ready && !this.writing && !this.pending); }
  private async call(value: ProjectRequest, readOnly = true): Promise<HostReply> {
    const controller = new AbortController(); if (readOnly) this.readers.add(controller);
    const deadline = setTimeout(() => controller.abort(), 6500);
    try { return await requestProject(this.options.request, value, controller.signal); }
    finally { clearTimeout(deadline); this.readers.delete(controller); }
  }
  private renderNotice() {
    this.notice.replaceChildren(); this.notice.hidden = !this.pending;
    if (!this.pending) { this.availability(); return; }
    this.notice.append(this.el('p', this.t(this.reconciled ? 'projectWorkspace.reviewUncertain' : 'projectWorkspace.uncertain')));
    this.notice.append(this.button(this.t('projectWorkspace.checkSave'), () => { void this.checkPending(); }));
    if (this.reconciled) {
      this.notice.append(this.button(this.t('projectWorkspace.keepSaved'), () => { this.keepPending(null); void this.refresh(); }));
      if (this.pending.op === 'project_create') this.notice.append(this.button(this.t('projectWorkspace.retryCreate'), () => {
        if (this.pending) void this.save({ ...this.pending, boot: this.boot, expected_revision: this.revision }, this.editor.generation);
      }));
      else this.notice.append(this.button(this.t('projectWorkspace.reviewDraft'), () => { void this.reviewPendingSettings(); }));
    }
    this.availability();
  }
  private async checkPending() {
    const intent = this.pending; if (!intent || this.writing) return;
    try {
      const value = await this.call({ op: 'project_status', version: 1,
        project_id: intent.project_id ?? intent.request_id, request_id: intent.request_id });
      if (!this.visible || this.pending?.request_id !== intent.request_id) return;
      if (value.status !== 'ok' || value.intent_state === 'pending' || value.intent_state === 'unknown') {
        this.status.textContent = this.t('projectWorkspace.stillPending'); return;
      }
      // A different (or unrecorded) boot cannot confirm the write: the host restarted, so the owner
      // reviews the outcome (Keep / Retry) instead of staying blocked; nothing is resent automatically.
      const sameBoot = value.boot === intent.boot;
      if (sameBoot && value.intent_state === 'confirmed' && value.intent_kind !== (intent.op === 'project_create' ? 'create' : 'settings')) throw Error('intent-confirmation');
      this.boot = value.boot;
      if (sameBoot && value.intent_state === 'confirmed') {
        if (intent.op === 'project_create') this.selected = intent.request_id;
        this.keepPending(null); this.status.textContent = this.t('projectWorkspace.saved'); await this.refresh();
      } else { await this.refresh(); this.reconciled = true; this.renderNotice(); }
    } catch { if (this.visible) this.status.textContent = this.t('projectWorkspace.unavailable'); }
  }
  private async reviewPendingSettings() {
    const intent = this.pending; if (!intent || intent.op !== 'project_settings' || !intent.project_id) return;
    this.selected = intent.project_id; await this.refresh();
    if (!this.visible || !this.detail || this.detail.id !== intent.project_id) return;
    const patch = intent.patch as Record<string, unknown>;
    if (this.omissions.some(field => field === 'sources' ? patch.source_changes !== undefined : patch[field] !== undefined)) {
      this.status.textContent = this.t('projectWorkspace.partial'); return;
    }
    this.keepPending(null); this.editor.open(this.detail, patch);
  }
  private saveSelection() {
    if (!this.machine) return;
    const key = JSON.stringify(['workspace', this.machine]), owner = projectPreferences(this.doc), choice = owner.read(key);
    choice.selected = this.selected; owner.write(key, choice);
  }
  private abandonObservation(resetBackoff = true) {
    this.observationGeneration++;
    this.clearObservationTimers();
    if (resetBackoff) { this.observationUnsupported = false; this.contextRefreshFailures = 0; this.capacityRefreshFailures = 0; }
    this.retryObservation = false; this.reloadObservationContext = false; this.busyObservation = null;
    this.observation = null;
  }
  private clearObservationTimers() {
    if (this.observationTimer !== null) clearTimeout(this.observationTimer);
    if (this.contextRefreshTimer !== null) clearTimeout(this.contextRefreshTimer);
    this.observationTimer = null; this.contextRefreshTimer = null;
  }
  private scheduleContextRefresh(success: boolean, retrySame = false, capacity = false) {
    if (this.contextRefreshTimer !== null) clearTimeout(this.contextRefreshTimer);
    this.contextRefreshTimer = null;
    this.retryObservation = retrySame;
    if (capacity) this.capacityRefreshFailures = Math.min(6, this.capacityRefreshFailures + 1);
    else { this.capacityRefreshFailures = 0; this.contextRefreshFailures = success ? 0 : Math.min(4, this.contextRefreshFailures + 1); }
    if (!this.visible || this.doc.hidden || this.observationUnsupported) return;
    const issue = this.observationGeneration;
    const delay = capacity ? Math.min(30000, 1000 * 2 ** (this.capacityRefreshFailures - 1)) : Math.min(300000, 30000 * 2 ** this.contextRefreshFailures);
    this.contextRefreshTimer = setTimeout(() => {
      this.contextRefreshTimer = null;
      if (issue === this.observationGeneration) void this.refreshObservedContext();
    }, delay);
  }
  private async refreshObservedContext() {
    if (!this.visible || this.doc.hidden || this.observationUnsupported || this.busyObservation) return;
    if (this.reloadObservationContext) { await this.readSelected(true); return; }
    const reader = this.observation;
    if (reader && (this.retryObservation || !reader.lifetime?.observation_state || ['capturing', 'running', 'cancelling', 'cleanup-pending'].includes(reader.lifetime.observation_state))) {
      const issue = this.observationGeneration;
      await this.pollObservation(reader, () => this.visible && issue === this.observationGeneration && this.observation === reader);
    } else await this.observe();
  }
  private async pollObservation(reader: ProjectObservationReader, current: () => boolean) {
    if (!current() || this.doc.hidden || this.busyObservation) return;
    this.busyObservation = reader;
    try {
      // Lost admission acknowledgements retry the same idempotent request, not a new capture.
      if (reader.lifetime) await reader.status(); else await reader.start();
      await this.readObservation(reader, current);
    } catch (error) {
      if (current()) this.observationFailed(error);
    } finally { if (this.busyObservation === reader) this.busyObservation = null; }
  }
  private async observe() {
    if (!this.visible || this.doc.hidden || this.observationUnsupported || this.busyObservation || !this.detail || !this.machine || !this.settings?.plan) return;
    if (this.reloadObservationContext) { await this.readSelected(true); return; }
    // Selection and manual refresh share one admission while a capture is active.
    if (this.observation && (this.retryObservation || !this.observation.lifetime?.observation_state || ['capturing', 'running', 'cancelling', 'cleanup-pending'].includes(this.observation.lifetime.observation_state))) {
      const reader = this.observation, issue = this.observationGeneration;
      await this.pollObservation(reader, () => this.visible && issue === this.observationGeneration && this.observation === reader); return;
    }
    this.abandonObservation(false); const issue = this.observationGeneration;
    const current = () => this.visible && issue === this.observationGeneration;
    const reader = new ProjectObservationReader(this.options.request, { boot: this.boot, machine_id: this.machine, project_id: this.detail.id, revision: this.revision }, current);
    this.observation = reader;
    this.busyObservation = reader;
    this.observationStatus.textContent = this.t('projectObservation.starting') + (this.observedView ? ' ' + this.t('projectObservation.stale') : '');
    if (!this.observationStatus.isConnected) this.observationRoot.prepend(this.observationStatus);
    try {
      await reader.start();
      if (current()) {
        const cancel = this.button(this.t('projectObservation.cancel'), () => {
          void reader.cancel().then(() => { if (current()) void this.readObservation(reader, current); }).catch(() => { if (current()) this.observationStatus.textContent = this.t('projectObservation.unavailable'); });
        }); this.observationRoot.prepend(cancel);
        await this.readObservation(reader, current);
      }
    } catch (error) { if (current()) this.observationFailed(error); }
    finally { if (this.busyObservation === reader) this.busyObservation = null; }
  }
  private async readObservation(reader: ProjectObservationReader, current: () => boolean) {
    try {
      const lifetime = reader.lifetime;
      if (!current() || this.observation !== reader) return;
      const state = lifetime?.observation_state;
      this.observationStatus.textContent = this.t(`projectObservation.state.${state ?? 'unknown'}`) + (this.observedView ? ' ' + this.t('projectObservation.stale') : '');
      if (state === 'complete') {
        const catalog = await reader.assemble(); if (!current()) return;
        if (this.observedView) {
          this.observedView.clear(true);
          for (const button of this.observationRoot.querySelectorAll(':scope > button')) button.remove();
          this.observedView.render(catalog); this.cockpit.observed(catalog); this.scheduleContextRefresh(true); return;
        }
        const list = this.el('nav'); list.hidden = true;
        const detail = this.el('article'); detail.className = 'projects-detail';
        this.observationRoot.replaceChildren(list, detail);
        this.observedView = new ProjectCatalogView(new ProjectDom(this.doc, this.t), this.observationStatus, list, detail, projectPreferences(this.doc), true,source=>this.readIssues(source));
        this.observedView.render(catalog); this.cockpit.observed(catalog); this.scheduleContextRefresh(true); return;
      }
      if (state && ['capturing', 'running', 'cancelling', 'cleanup-pending'].includes(state)) {
        if (!this.doc.hidden) this.observationTimer = setTimeout(() => { this.observationTimer = null; void this.pollObservation(reader, current); }, 400);
      } else {
        // An acknowledged unknown/evicted record is distinct from a lost transport reply.
        if (!state) this.observation = null;
        this.reloadObservationContext = state === 'stale'; this.scheduleContextRefresh(false);
      }
    } catch (error) { if (current()) this.observationFailed(error); }
  }
  private readIssues(source:string):IssueReader {
    if(!this.visible||!this.ready||!this.detail)throw Error('unavailable');
    const scope={boot:this.boot,machine_id:this.machine,revision:this.revision,project_id:this.detail.id,source_id:source};
    const reader=issueReader(this.options.request,scope);
    return {...reader,read:async(page,signal)=>{
      const value=await reader.read(page,signal);
      if(!this.visible||!this.ready||!this.detail||this.selected!==scope.project_id||this.detail.id!==scope.project_id||this.boot!==scope.boot||this.machine!==scope.machine_id||this.revision!==scope.revision)throw Error('source-changed');
      return value;
    }};
  }
  private observationFailed(error: unknown) {
    if (error instanceof ProjectTransportError && error.reason === 'unsupported' && !this.observation?.lifetime) {
      // This HTTP refusal happened before admission. Keep any displayed snapshot.
      this.clearObservationTimers(); this.observation = null; this.retryObservation = false;
      this.reloadObservationContext = false; this.observationUnsupported = true;
      this.observationStatus.textContent = this.t(this.observedView ? 'projectObservation.unsupportedStale' : 'projectObservation.unsupportedEmpty');
      this.renderOverview(); return;
    }
    this.observationStatus.textContent = this.t('projectObservation.unavailable');
    const code = error instanceof Error ? error.message : '';
    this.reloadObservationContext = ['revision-conflict', 'stale', 'observation-stale', 'unknown-project', 'stale-host', 'identity-mismatch'].includes(code);
    // Worker admission refuses before creating a record. Control refusal only
    // declines that status/page request; retain any already admitted capture.
    const capacity = ['worker-capacity', 'control-capacity', 'record-capacity', 'byte-capacity', 'result-capacity'].includes(code);
    const retainCapacity = code === 'control-capacity' || capacity && !!this.observation?.lifetime;
    const transientCapacity = code === 'control-capacity' || code === 'worker-capacity' && !this.observation?.lifetime;
    const definitive = this.reloadObservationContext || ['runtime-not-configured', 'runtime-unavailable', 'worker-capacity', 'control-capacity', 'record-capacity', 'byte-capacity', 'result-capacity', 'expired', 'evicted', 'cancelled', 'deadline', 'collector-failed', 'stopping', 'unknown-source'].includes(code);
    if (definitive && !this.reloadObservationContext && !retainCapacity) this.observation = null;
    this.scheduleContextRefresh(false, retainCapacity || !definitive, transientCapacity);
  }
  private renderSidebar() {
    const sidebar = this.options.sidebar; sidebar.replaceChildren();
    if (!this.summaries.length) sidebar.append(this.el('p', this.t('projectWorkspace.noProjects')));
    for (const item of this.summaries) {
      const node = this.button(item.title, () => {
        if (!this.visible) return;
        this.abandonObservation(); this.observedView?.suspend(); this.observedView = null; this.cockpit.clearObserved(); this.observationRoot.replaceChildren();
        this.selected = item.id; this.selectionGeneration++; this.renderSidebar(); this.saveSelection(); void this.readSelected();
        this.doc.body.classList.remove('drawer');
      });
      node.className = 'project-nav-item'; node.setAttribute('aria-current', String(item.id === this.selected)); sidebar.append(node);
    }
  }
  private link(parent: HTMLElement, url: string) {
    const safe = safeProjectURL(url); if (!safe) return;
    const node = this.el('a', url); node.href = safe; node.target = '_blank'; node.rel = 'noopener noreferrer'; parent.append(node);
  }
  private renderContext(project: ProjectDetail) {
    const context = this.el('section'); context.className = 'project-context-panel';
    context.append(this.el('h3', this.t('projectWorkspace.localContext')));
    if (project.description) context.append(this.el('p', project.description));
    if (project.repository) this.link(context, project.repository.url);
    if (project.folders?.length) {
      const paths = this.el('details'); paths.append(this.el('summary', this.t('projectWorkspace.folders')));
      const folders = this.el('ul'); for (const folder of project.folders) folders.append(this.el('li', folder)); paths.append(folders); context.append(paths);
    }
    if (!project.repository && !project.folders_total) context.append(this.el('p', this.t('projectWorkspace.noContext')));
    if (this.omissions.length) context.append(this.el('p', this.t('projectWorkspace.partial')));
    context.append(this.button(this.t('projectWorkspace.editContext'), () => { if (this.detail) this.editor.open(this.detail); }));
    return context;
  }
  private renderSources(project: ProjectDetail) {
    const sources = this.el('section'); sources.className = 'project-context-panel'; sources.append(this.el('h3', this.t('projectWorkspace.sources')));
    if (!project.sources_total) sources.append(this.el('p', this.t('projectWorkspace.noSources')));
    for (const source of project.sources ?? []) {
      const row = this.el('div'); row.className = 'project-source-reference';
      row.append(this.el('strong', source.label), this.el('p', this.t('projectWorkspace.referenceOnly')));
      if (source.url) this.link(row, source.url); sources.append(row);
    }
    if (this.omissions.includes('sources')) sources.append(this.el('p', this.t('projectWorkspace.partial')));
    return sources;
  }
  private renderOverview() {
    this.content.replaceChildren(); this.contextCards.replaceChildren(); const project = this.detail;
    if (!project) {
      this.content.append(this.el('h2', this.t('projectWorkspace.home')), this.el('p', this.t('projectWorkspace.intro')));
      if (this.ready && !this.summaries.length) this.content.append(this.button(this.t('projectWorkspace.new'), () => { this.create(); }, true));
      return;
    }
    const header = this.el('header'); header.className = 'project-overview-heading';
    const title = this.el('h2', project.title); title.tabIndex = -1;
    header.append(title, this.button(this.t('projectWorkspace.settings'), () => { if (this.detail) this.editor.open(this.detail); }));
    this.content.append(header);

    const grid = this.el('div'); grid.className = 'project-overview-grid'; grid.append(this.renderContext(project), this.renderSources(project));
    grid.classList.add('project-context-cards');
    const context = this.el('details'); context.className = 'project-context-disclosure';
    context.append(this.el('summary', `${this.t('projectWorkspace.localContext')} · ${this.t('projectWorkspace.sources')}`), grid,
      this.el('p', this.t('projectWorkspace.sessionsIndependent')));
    this.contextCards.append(context);
    const plan = this.settings?.plan;
    if (plan && (plan.repository || plan.source_ids.length)) {
      const refresh = this.button(this.t('projectObservation.refresh'), () => { void this.observe(); }, true);
      refresh.disabled = this.observationUnsupported; this.content.append(refresh);
      if (this.observation?.lifetime?.cancel_token) this.content.append(this.button(this.t('projectObservation.cancel'), () => {
        const reader = this.observation; if (reader) void reader.cancel().catch(() => { this.observationStatus.textContent = this.t('projectObservation.unavailable'); });
      }));
    } else this.content.append(this.el('p', this.t('projectObservation.disabled')));
    this.content.append(this.observationStatus);
    this.cockpit.mount(this.content, project, this.machine, this.revision, this.observationUnsupported,this.boot,this.membership);
  }
  private async readSelected(preserve = false) {
    const id = this.selected, issue = ++this.selectionGeneration, mode = this.generation;
    if (!preserve) { this.detail = null; this.membership = undefined; this.settings = undefined; this.omissions = []; this.renderOverview(); } if (!id) return;
    const readBoot=this.boot,readMachine=this.machine;
    try {
      const value = await this.call(projectReadRequest(id, this.capability, this.boot));
      if (!this.visible || mode !== this.generation || issue !== this.selectionGeneration || id !== this.selected) return;
      if (preserve && value.code === 'unknown-project') { await this.refresh(); return; }
      if (value.status !== 'ok' || !value.project || value.project.id !== id || !value.revision) throw Error('detail');
      if (preserve) {
        this.abandonObservation(); this.observedView?.suspend(); this.observedView = null; this.cockpit.clearObserved(); this.observationRoot.replaceChildren(); this.settings = undefined;
      }
      this.membership=value.boot===readBoot&&value.machine_id===readMachine?value.membership:undefined;
      this.boot = value.boot; this.machine = value.machine_id ?? ''; this.revision = value.revision; this.detail = value.project; this.omissions = value.omitted_fields ?? [];
      try {
        const typed = await this.call({ op: 'project_read', version: 1, project_id: id, settings: { kind: 'project' } });
        if (!this.visible || mode !== this.generation || issue !== this.selectionGeneration || id !== this.selected) return;
        if (typed.project?.id === id && typed.status === 'ok' && typed.boot === this.boot && typed.machine_id === this.machine && typed.revision === this.revision && typed.observation_settings?.kind === 'project' && !typed.omitted_fields?.includes('observation_settings')) this.settings = typed.observation_settings;
      } catch { /* Basic registry reads remain useful on older hosts. Incomplete settings stay uneditable. */ }
      this.renderOverview();
      if (this.settings?.plan && (this.settings.plan.repository || this.settings.plan.source_ids.length)) void this.observe();
    } catch { if (this.visible && mode === this.generation && issue === this.selectionGeneration) {
      this.status.textContent = this.t('projectWorkspace.unavailable');
      if (preserve) { this.reloadObservationContext = true; this.scheduleContextRefresh(false); }
    } }
  }
  private async refresh() {
    this.capability = null;
    this.abandonObservation();
    if (this.observationRoot.childElementCount) this.observationStatus.textContent = this.t('projectObservation.stale');
    const issue = ++this.generation; this.status.textContent = this.t('projectWorkspace.loading');
    try {
      const cap = await this.call({ op: 'project_capabilities', version: 1 });
      if (!this.visible || issue !== this.generation) return;
      if (cap.status !== 'ok') {
        this.ready = false; this.legacy.open = true;
        this.status.textContent = this.t(cap.status === 'unsupported' ? 'projectWorkspace.unsupported' : 'projectWorkspace.unavailable');
        this.availability(); this.renderOverview(); return;
      }
      this.capability = cap;
      const value = await this.call({ op: 'project_list', version: 1 });
      if (!this.visible || issue !== this.generation) return;
      if (!['ok', 'uninitialized'].includes(value.status) || !value.projects || !value.revision) throw Error('list');
      const previousSelection = this.selected;
      this.boot = value.boot; this.revision = value.revision; this.summaries = value.projects; this.ready = true;
      if (value.machine_id !== this.machine) {
        this.machine = value.machine_id ?? ''; this.selected = this.machine ? projectPreferences(this.doc).read(JSON.stringify(['workspace', this.machine])).selected : null;
        this.observedView?.suspend(); this.observedView = null; this.cockpit.clearObserved(); this.observationRoot.replaceChildren();
      }
      if (!this.selected || !this.summaries.some(item => item.id === this.selected)) this.selected = this.summaries[0]?.id ?? null;
      if (this.selected !== previousSelection) {
        this.observedView?.suspend(); this.observedView = null; this.cockpit.clearObserved(); this.observationRoot.replaceChildren();
      }
      this.legacy.open = false; this.status.textContent = this.t('projectWorkspace.savedHere');
      this.renderSidebar(); this.renderNotice(); this.availability(); await this.readSelected();
    } catch {
      if (!this.visible || issue !== this.generation) return;
      this.ready = false; this.detail = null; this.legacy.open = true; this.status.textContent = this.t('projectWorkspace.unavailable');
      this.availability(); this.renderOverview();
    }
  }
  private async save(value: ProjectIntent, owner: number, error?: HTMLElement) {
    if (this.writing) return;
    if (this.visible) this.doc.body.classList.remove('drawer');
    this.writing = true; this.keepPending(value); this.availability();
    try {
      const reply = await this.call(value, false);
      if (this.pending?.request_id !== value.request_id) return;
      if (reply.status === 'ok') {
        this.keepPending(null);
        if (this.visible && owner === this.editor.generation) {
          this.editor.close(); this.doc.body.classList.remove('drawer');
          if (value.op === 'project_create') this.selected = reply.project_id ?? value.request_id;
          await this.refresh(); this.status.textContent = this.t('projectWorkspace.saved');
        }
      } else if (reply.status === 'uncertain') {
        if (this.visible && owner === this.editor.generation) { this.editor.close(); this.renderNotice(); }
      } else {
        this.keepPending(null);
        if (this.visible && owner === this.editor.generation) {
          const message = this.t(reply.status === 'conflict' ? 'projectWorkspace.conflict' : 'projectWorkspace.saveFailed');
          if (error) error.textContent = message; else this.status.textContent = message;
        }
      }
    } catch (failure) {
      if (failure instanceof ProjectTransportError && (failure.reason === 'denied' || failure.reason === 'too-large')) {
        this.keepPending(null); if (error) error.textContent = this.t('projectWorkspace.saveFailed');
      } else if (this.visible && owner === this.editor.generation) { this.editor.close(); this.renderNotice(); }
    } finally { this.writing = false; this.availability(); }
  }
  open() { this.visible = true; this.artifact.open(); void this.refresh(); }
  close() {
    this.visible = false; this.abandonObservation(); this.observedView?.suspend(); this.observedView = null; this.cockpit.clearObserved(); this.observationRoot.replaceChildren(); this.generation++; this.selectionGeneration++; this.editor.close();
    for (const controller of this.readers) controller.abort(); this.readers.clear(); this.artifact.close();
  }
  create() { this.editor.open(null); }
}

export function mountProjectWorkspace(options: WorkspaceOptions) {
  const workspace = new ProjectWorkspace(options);
  return Object.freeze({ open: () => { workspace.open(); }, close: () => { workspace.close(); }, create: () => { workspace.create(); } });
}

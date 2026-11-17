// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {validValue} from './project-followup-model.ts';
import {displayProjectTime} from './project-display-time.ts';
import type { ProjectCatalog, Project, ProjectSource, ProviderSummary } from './project-catalog.ts';
import { ProjectPipelineView } from './project-pipeline-view.ts';
import { ProjectFollowupController } from './project-followup-controller.ts';
import type { FollowupObservationState } from './project-followup-controller.ts';
import { FollowupPreferenceStore, projectPreferences } from './project-followup-preferences.ts';
import { ObservationAge } from './project-followup-time.ts';
import { followupScope, FollowupFreshness } from './project-followup-context.ts';
import { renderProjectMarkdown } from './project-markdown.ts';
import { ProjectIssueView } from './project-issue-view.ts';
import type { IssueReader } from './project-issue-client.ts';
export type Translate = (key: string, params?: Record<string, string | number>) => string;
export class ProjectDom {
  readonly doc: Document;
  readonly t: Translate;
  constructor(doc: Document, translate: Translate) { this.doc = doc; this.t = translate; }
  element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  paragraph(parent: HTMLElement, key: string, value: string | number) { parent.append(this.element('p', this.t(key, { value }))); }
  known(value: string | number | null) { return value ?? this.t('projects.unknown'); }
  disclosure(parent: HTMLElement, title: string, key?: string): HTMLDetailsElement {
    const section = this.element('details'), summary = this.element('summary', title);
    if (key) {
      section.dataset.projectsKey = key;
      summary.dataset.followupKey = JSON.stringify([parent.closest<HTMLElement>('[data-projects-focus-scope]')?.dataset.projectsFocusScope ?? null, key]);
    }
    section.append(summary); parent.append(section); return section;
  }
  link(parent: HTMLElement, label: string, value?: string) {
    if (!value) return;
    try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      const anchor = this.element('a', label); anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor);
    } catch { /* Invalid references have no active link. */ }
  }
}
type ProjectRenderContext = {
  element: <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => HTMLElementTagNameMap[K];
  paragraph: (parent: HTMLElement, key: string, value: string | number) => void;
  link: (parent: HTMLElement, label: string, value?: string) => void;
  disclosure: (parent: HTMLElement, title: string, key?: string) => HTMLDetailsElement;
  t: Translate; machine_id: string; viewKey: (project: string, part: string) => string;
  readingFirst?: boolean;
  viewPreferences: { get: (key: string) => {open?: boolean; scroll?: number} | undefined };
};

function renderRepositoryObservation(parent: HTMLElement, project: Project, context: ProjectRenderContext) {
  const {element, paragraph, disclosure, t, viewKey, viewPreferences} = context;
  const value = project.repository?.observation; if (!value) return;
  const section = element("section"); section.className = "projects-repository-observation";
  if (!context.readingFirst) section.append(element("h3", t("projects.repositoryEvidence.title")));
  const evidence = context.readingFirst ? element("details") : section;
  if (context.readingFirst) evidence.className = 'projects-repository-evidence';
  if (context.readingFirst) evidence.append(element("summary", t("projectObservation.repositoryDetails")));
  paragraph(evidence, "projects.repositoryEvidence.state", t(`projects.repositoryEvidence.status.${value.status}`));
  paragraph(evidence, "projects.repositoryEvidence.assembled", value.assembled_at);
  paragraph(evidence, "projects.repositoryEvidence.method", value.method === null ? t("projects.unknown") : t(`projects.repositoryEvidence.method.${value.method}`));
  if (value.reason) paragraph(evidence, "projects.repositoryEvidence.reason", t(`projects.repositoryEvidence.reason.${value.reason}`));
  if (value.ref) paragraph(evidence, "projects.repositoryEvidence.ref", value.ref);
  if (value.commit) paragraph(evidence, "projects.repositoryEvidence.commit", value.commit);
  const readme = value.readme;
  paragraph(evidence, "projects.repositoryEvidence.readmeState", t(`projects.repositoryEvidence.status.${readme.status}`));
  if (readme.reason) paragraph(evidence, "projects.repositoryEvidence.reason", t(`projects.repositoryEvidence.reason.${readme.reason}`));
  let preview: HTMLElement | null = null;
  let readmeContent: HTMLDetailsElement | null = null;
  const key = viewKey(project.id, "repository-readme"), preferences = viewPreferences.get(key);
  if (readme.status === "valid" && readme.text !== null) {
    const content = disclosure(section, t("projects.repositoryEvidence.preview", { path: readme.path!, bytes: readme.size! }));
    content.setAttribute('aria-label', t('projectObservation.readme'));
    readmeContent = content;
    content.className = "projects-readme-disclosure"; content.dataset.projectsKey = key;
    (content.firstElementChild as HTMLElement).dataset.projectsFocus = key;
    (content.firstElementChild as HTMLElement).dataset.followupKey = key;
    section.dataset.projectsScope = key;
    content.open = preferences?.open ?? false;
    if (readme.truncated) content.append(element("p", t("projects.repositoryEvidence.truncated", { value: readme.size! })));
    preview = element("div", readme.text); preview.className = "projects-readme-preview projects-markdown"; content.append(preview);
    const target = preview;
    const render = () => { if (content.open) void renderProjectMarkdown(target, readme.text!); };
    content.addEventListener('toggle', render); render();
  }
  if (context.readingFirst) (readmeContent ?? section).append(evidence);
  parent.append(section);
  if (preview) preview.scrollTop = preferences?.scroll ?? 0;
}


function renderParticipations(parent: HTMLElement, project: Project, context: ProjectRenderContext) {
  const {element, paragraph, t} = context;
  if (project.participations === undefined) return;
  const section = element("section"); section.className = "projects-participations";
  section.dataset.projectsKey = JSON.stringify([context.machine_id, project.id, "participations"]);
  section.append(element("h3", t("projects.metadata.participations")), element("p", t("projects.metadata.unverified")));
  for (const participation of project.participations) {
    const row = element("section"); row.className = "projects-participation";
    row.append(element("h4", participation.label ?? participation.id));
    paragraph(row, "projects.metadata.recordID", participation.id);
    paragraph(row, "projects.metadata.relation", t(`projects.metadata.relation.${participation.recorded_relation}`));
    if (participation.role_label !== undefined) paragraph(row, "projects.metadata.role", participation.role_label);
    const target = participation.target;
    if (target.kind === "mesh") {
      paragraph(row, "projects.metadata.sessionName", target.name);
      paragraph(row, "projects.metadata.created", target.created);
      paragraph(row, "projects.metadata.machine", target.machine_id ?? t("projects.unknown"));
    } else {
      paragraph(row, "projects.metadata.agent", target.agent);
      paragraph(row, "projects.metadata.conversation", target.conversation_id);
    }
    if (participation.work_refs !== undefined) {
      const references = element("ul");
      for (const reference of participation.work_refs) {
        const binding = project.sources.find(source => source.id === reference.source_id);
        const source = reference.source_id === "mesh" ? t("projects.metadata.meshContext") : binding
          ? `${binding.kind} / ${binding.id} / ${binding.label}` : t("projects.metadata.sourceMissing");
        const item = element("li"); paragraph(item, "projects.metadata.sourceReference", `${reference.source_id} · ${source}`);
        paragraph(item, "projects.metadata.nativeID", `${reference.kind} / ${reference.native_id}`);
        if (reference.instance_id !== undefined) paragraph(item, "projects.metadata.instance", reference.instance_id);
        references.append(item);
      }
      row.append(references);
    }
    section.append(row);
  }
  parent.append(section);
}


function renderChannels(parent: HTMLElement, value: ProjectSource, context: ProjectRenderContext) {
  if (value.channels === undefined) return;
  const {element, paragraph, link, t} = context;
  const channels = element("section"); channels.className = "projects-channels";
  channels.append(element("h4", t("projects.metadata.channels")));
  paragraph(channels, "projects.metadata.sourceIdentity", `${value.kind} / ${value.id}`);
  const rows = element("ul");
  for (const channel of value.channels) {
    const row = element("li"); row.append(element("strong", channel.label));
    paragraph(row, "projects.metadata.recordID", channel.id);
    paragraph(row, "projects.metadata.tenant", channel.tenant_id ?? t("projects.unknown"));
    paragraph(row, "projects.metadata.workspace", channel.workspace_id ?? t("projects.unknown"));
    paragraph(row, "projects.metadata.nativeID", channel.native_id ?? t("projects.unknown"));
    link(row, t("projects.metadata.channelLink"), channel.url); rows.append(row);
  }
  channels.append(rows); parent.append(channels);
}


export class ProjectCatalogView {
  private catalog: ProjectCatalog | null = null;
  private selected: string | null = null;
  private selectionMachine: string | null = null;
  private pipeline: ProjectPipelineView;
  private followup: ProjectFollowupController | null = null;
  private preferences: FollowupPreferenceStore;
  private readingFirst: boolean;
  private issueFactory: ((source:string)=>IssueReader)|undefined;
  private issues:ProjectIssueView|null=null;
  private issueScope='';
  private observations = new Map<string, FollowupObservationState>();
  private restoreKey: string | null = null;
  private restoreScope: string | null = null;
  readonly dom: ProjectDom;
  readonly status: HTMLElement;
  readonly list: HTMLElement;
  readonly detail: HTMLElement;
  constructor(dom: ProjectDom, status: HTMLElement, list: HTMLElement, detail: HTMLElement, preferences?: FollowupPreferenceStore, readingFirst = false, issueFactory?: (source:string)=>IssueReader) {
    this.readingFirst = readingFirst;
    this.issueFactory=issueFactory;
    this.preferences = preferences ?? projectPreferences(dom.doc);
    this.dom = dom; this.status = status; this.list = list; this.detail = detail; this.pipeline = new ProjectPipelineView(dom);
  }
  clear(preserveIssues=false) {
    const active = this.dom.doc.activeElement as HTMLElement | null;
    const ownsFocus = this.dom.doc.hasFocus() && active !== null && this.detail.contains(active);
    this.restoreKey = ownsFocus ? active.dataset.followupKey ?? null : null;
    this.restoreScope = ownsFocus ? this.focusScope(active) : null;
    this.suspend(preserveIssues); this.catalog = null; this.list.replaceChildren(); this.detail.replaceChildren();
    if (ownsFocus) { this.status.tabIndex = -1; this.status.focus({ preventScroll: true }); }
  }
  private focusScope(element: HTMLElement): string | null {
    const scope = element.closest<HTMLElement>('[data-followup-scope], [data-projects-scope]');
    return scope?.dataset.followupScope ?? scope?.dataset.projectsScope ?? null;
  }
  suspend(preserveIssues=false) { this.followup?.destroy(); this.followup = null; this.saveDisclosures();if(!preserveIssues)this.closeIssues(); }
  private closeIssues(){this.issues?.destroy();this.issues=null;this.issueScope='';}
  saveDisclosures() {
    if (this.catalog && this.selected) {
      const key = JSON.stringify([this.catalog.machine_id, this.selected, "repository-readme"]), state = this.preferences.read(key);
      const readme = this.detail.querySelector<HTMLDetailsElement>(".projects-readme-disclosure");
      if (readme) { state.disclosures = readme.open ? [key] : []; state.top = this.detail.querySelector(".projects-readme-preview")?.scrollTop ?? 0; this.preferences.write(key, state); }
    }
    for (const section of this.detail.querySelectorAll<HTMLElement>('[data-projects-scope]')) {
      const scope = section.dataset.projectsScope!, details = Array.from(section.querySelectorAll<HTMLDetailsElement>('details[data-projects-key]'));
      if (!details.length) continue;
      const preference = this.preferences.read(scope), present = new Set(details.map(item => item.dataset.projectsKey!));
      preference.disclosures = [...preference.disclosures.filter(key => !present.has(key)), ...details.filter(item => item.open).map(item => item.dataset.projectsKey!)];
      this.preferences.write(scope, preference);
    }
  }
  restoreDisclosures() {
    for (const section of this.detail.querySelectorAll<HTMLElement>('[data-projects-scope]')) {
      if (!this.preferences.has(section.dataset.projectsScope!)) continue;
      const preference = this.preferences.read(section.dataset.projectsScope!);
      for (const details of section.querySelectorAll<HTMLDetailsElement>('details[data-projects-key]')) details.open = preference.disclosures.includes(details.dataset.projectsKey!);
    }
  }
  summary(parent: HTMLElement, value: ProviderSummary, kind: string) {
    this.dom.paragraph(parent, "projects.provider", `${value.provider_schema} / ${value.provider_version}`);
    if (value.source_generated_at) this.dom.paragraph(parent, "projects.sourceTime", value.source_generated_at);
    if (value.source_revision) this.dom.paragraph(parent, "projects.revision", value.source_revision);
    if (value.pipeline) { this.pipeline.render(parent, value.pipeline, parent.dataset.projectsScope); return; }
    if (value.goal) this.dom.paragraph(parent, "projects.goal", value.goal);
    if (value.phase) this.dom.paragraph(parent, "projects.phase", value.phase);
    if (kind === "roster" && value.global_accepted !== undefined)
      this.dom.paragraph(parent, "projects.acceptance", this.dom.t(value.global_accepted ? "projects.accepted" : "projects.notAccepted"));
    const counts = this.dom.element("dl"); counts.className = "projects-counts";
    for (const [name, count] of Object.entries(value.counts)) {
      counts.append(this.dom.element("dt", this.dom.t(`projects.count.${name}`)), this.dom.element("dd", String(count)));
    }
    parent.append(counts);
    parent.append(this.dom.element("p", this.dom.t("projects.included", { value: value.items.length })));
    if (value.truncated) parent.append(this.dom.element("p", this.dom.t("projects.truncated", { value: value.more ?? this.dom.t("projects.unknown") })));
    const items = this.dom.element("ul");
    for (const item of value.items) {
      const row = this.dom.element("li"); row.append(this.dom.element("strong", item.title));
      this.dom.paragraph(row, "projects.item", `${item.id} · ${item.state}`);
      if (item.depends_on?.length) this.dom.paragraph(row, "projects.dependencies", item.depends_on.join(", "));
      if (item.attempts !== undefined) this.dom.paragraph(row, "projects.attempts", item.attempts);
      for (const check of item.checks ?? []) this.dom.paragraph(row, "projects.check", `${check.id}: ${check.accepted_status} / ${check.reported_status}`);
      items.append(row);
    }
    parent.append(items);
    if (value.operator_status !== undefined)
      this.dom.paragraph(parent, "projects.operatorState", this.dom.t(`projects.operatorStatus.${value.operator_status}`));
    if (value.operator_truncated) parent.append(this.dom.element("p", this.dom.t("projects.operatorPartial")));
    if (value.operator_requests?.length) {
      parent.append(this.dom.element("h4", this.dom.t("projects.operatorRequests")));
      const asks = this.dom.element("ul");
      for (const item of value.operator_requests) asks.append(this.dom.element("li", `${item.title} · ${item.state} (${item.id})`));
      parent.append(asks);
    }
  }
  source(parent: HTMLElement, value: ProjectSource) {
    const section = this.dom.element("section"); section.className = "projects-source";
    const scope = this.catalog && this.selected && value.summary ? followupScope(this.catalog.machine_id, this.selected, value.id, value.summary) : null;
    if (scope) section.dataset.projectsScope = scope;
    section.append(this.dom.element("h3", value.label));
    this.dom.paragraph(section, "projects.sourceStatus", this.dom.t(`projects.status.${value.status}`));
    this.dom.paragraph(section, "projects.observed", value.observed_at);
    if (value.error_code) this.dom.paragraph(section, "projects.sourceError", this.dom.t(`projects.error.${value.error_code}`));
    this.dom.link(section, this.dom.t("projects.sourceLink"), value.url);
    if (value.status === "available" && value.summary) this.summary(section, value.summary, value.kind);
    renderChannels(section, value, this.renderContext());
    parent.append(section);
  }
  private renderContext(): ProjectRenderContext {
    return { element: this.dom.element.bind(this.dom), paragraph: this.dom.paragraph.bind(this.dom), link: this.dom.link.bind(this.dom), disclosure: this.dom.disclosure.bind(this.dom), t: this.dom.t, machine_id: this.catalog!.machine_id,
      readingFirst: this.readingFirst, viewKey: (project, part) => JSON.stringify([this.catalog!.machine_id, project, part]),
      viewPreferences: { get: key => { if (!this.preferences.has(key)) return undefined; const state = this.preferences.read(key); return { open: state.disclosures.includes(key), scroll: state.top }; } } };
  }
  showProject(project: Project) {
    this.suspend(true);
    this.selected = project.id;
    for (const button of this.list.querySelectorAll("button")) button.setAttribute("aria-current", String(button.dataset.projectId === this.selected));
    this.detail.replaceChildren();
    if (!this.readingFirst) {
      this.detail.append(this.dom.element('h2', project.title));
      this.dom.paragraph(this.detail, 'projects.identity', this.catalog!.machine_id + ' / ' + project.id);
      if (project.description) this.detail.append(this.dom.element('p', project.description));
      this.dom.link(this.detail, this.dom.t('projects.repository'), project.repository?.url);
      this.dom.link(this.detail, this.dom.t('projects.readme'), project.repository?.readme_url);
      if (project.repository?.branch) this.dom.paragraph(this.detail, 'projects.branch', project.repository.branch);
    }
    if (this.readingFirst) {
      this.richSource(project);
      for (const child of Array.from(this.detail.children)) (child as HTMLElement).dataset.cockpitSection = 'work';
      const sourceStatus = this.dom.element('section'); sourceStatus.className = 'project-source-observations';
      sourceStatus.dataset.cockpitSection = 'sources';
      for (const value of project.sources) {
        // Declarative references are listed in project context; they are not
        // failed observations competing with the configured work provider.
        if (value.kind !== 'roster' && value.status === 'unconfigured') continue;
        const row = this.dom.element('p', value.label + ' · ' + this.dom.t('projects.status.' + value.status));
        if (value.error_code) row.append(this.dom.element('span', ' · ' + this.dom.t('projects.error.' + value.error_code)));
        sourceStatus.append(row);
      }
      if (sourceStatus.childElementCount) this.detail.append(sourceStatus);
      renderParticipations(this.detail, project, this.renderContext());
      const participations = this.detail.querySelector<HTMLElement>(':scope > .projects-participations');
      if (participations) participations.dataset.cockpitSection = 'sessions';
      renderRepositoryObservation(this.detail, project, this.renderContext());
      const repository = this.detail.querySelector<HTMLElement>(':scope > .projects-repository-observation');
      if (repository) repository.dataset.cockpitSection = 'repository';
      const diagnostics = this.dom.disclosure(this.detail, this.dom.t('projectObservation.sourceDetails'));
      diagnostics.dataset.cockpitSection = 'sources';
      this.dom.paragraph(diagnostics, 'projects.identity', this.catalog!.machine_id + ' / ' + project.id);
      this.dom.paragraph(diagnostics, 'projects.revision', this.catalog!.revision);
      for (const value of project.sources) this.source(diagnostics, value);
    } else {
      renderRepositoryObservation(this.detail, project, this.renderContext());
      for (const value of project.sources) this.source(this.detail, value);
      this.richSource(project);
      renderParticipations(this.detail, project, this.renderContext());
    }
    this.restoreDisclosures();
    if (!project.sources.length) this.detail.append(this.dom.element("p", this.dom.t("projects.noSources")));
    if (project.sessions.length) {
      const heading = this.dom.element('h3', this.dom.t('projects.sessions')), note = this.dom.element('p', this.dom.t('projects.unresolved'));
      if (this.readingFirst) { heading.dataset.cockpitSection = 'sessions'; note.dataset.cockpitSection = 'sessions'; }
      this.detail.append(heading, note);
      const sessions = this.dom.element("ul");
      if (this.readingFirst) sessions.dataset.cockpitSection = 'sessions';
      for (const session of project.sessions) sessions.append(this.dom.element("li", `${session.name} · ${session.created}`));
      this.detail.append(sessions);
    }
  }
  selectSource(source:string,expectedBoard?:string|null):boolean {
    const project=this.catalog?.projects.find(project=>project.id===this.selected);
    const provider=project?.sources.find(item=>item.id===source);
    if(!project||!this.catalog||!provider||!(provider.summary?.followup||provider.summary?.pipeline||this.issueFactory&&['github','gitlab'].includes(provider.kind)&&provider.url))return false;
    if(expectedBoard!==undefined&&provider.status!=='available')return false;
    const actual=validValue(provider.summary?.followup?.metadata)?.board_id??null;
    if(expectedBoard!==undefined&&expectedBoard!==actual)return false;
    const key=JSON.stringify(['project',this.catalog.machine_id,project.id]);
    const preference=this.preferences.read(key);preference.selected=source;this.preferences.write(key,preference);this.showProject(project);return true;
  }
  selectTask(source: string, task: string): boolean {
    const project = this.catalog?.projects.find(project => project.id === this.selected);
    const provider = project?.sources.find(item => item.id === source);
    if (!project || !provider?.summary?.items.some(item => item.id === task) || !this.catalog) return false;
    const key = JSON.stringify(['project', this.catalog.machine_id, project.id]);
    const preference = this.preferences.read(key); preference.selected = source; this.preferences.write(key, preference);
    this.showProject(project); return this.followup?.selectTask(task) ?? false;
  }
  richSource(project: Project) {
    const sources = project.sources.filter(source => source.summary?.followup || source.summary?.pipeline ||
      this.issueFactory&&['github','gitlab'].includes(source.kind)&&source.url);
    if (!sources.length || !this.catalog) {this.closeIssues();return;}
    const key = JSON.stringify(['project', this.catalog.machine_id, project.id]);
    const selected = sources.find(source => source.id === this.preferences.read(key).selected) ?? sources[0]!;
    if (sources.length > 1) {
      const label = this.dom.element('label', this.dom.t('projects.followup.source'));
      const select = this.dom.element('select'); select.setAttribute('aria-label', this.dom.t('projects.followup.source'));
      for (const source of sources) { const option = this.dom.element('option', source.label); option.value = source.id; select.append(option); }
      select.value = selected.id; select.addEventListener('change', () => {
        const ownsFocus = this.dom.doc.hasFocus() && this.dom.doc.activeElement === select;
        const preference = this.preferences.read(key); preference.selected = select.value; this.preferences.write(key, preference); this.showProject(project);
        if (ownsFocus) this.detail.querySelector('select')?.focus({ preventScroll: true });
      });
      label.append(select); this.detail.append(label);
    }
    if(!selected.summary){
      try{
        const reader=this.issueFactory!(selected.id);
        if(this.issueScope!==reader.scopeKey){this.closeIssues();this.issues=new ProjectIssueView(this.dom,reader);this.issueScope=reader.scopeKey;}
        this.detail.append(this.dom.element('h3',`${selected.label} · ${selected.kind}`),this.issues!.root);
      }catch{this.closeIssues();this.detail.append(this.dom.element('p',this.dom.t('projects.issues.failed')));}
      return;
    }
    this.closeIssues();
    if (this.readingFirst) {
      const heading = this.dom.element('header'); heading.className = 'project-work-heading';
      heading.append(this.dom.element('h3', selected.kind === 'roster' && !selected.label.toLowerCase().includes('roster') ? `${selected.label} · Roster` : selected.label));
      const counts = selected.summary!.counts;
      const keys = [counts.tasks_total !== undefined ? 'tasks_total' : 'total', counts.tasks_done !== undefined ? 'tasks_done' : 'done', 'active', 'blocked', 'queued'];
      const metrics = this.dom.element('dl'); metrics.className = 'project-work-metrics';
      for (const key of keys) {
        const count = counts[key]; if (count === undefined) continue;
        const item = this.dom.element('div');
        item.append(this.dom.element('dt', this.dom.t(`projects.count.${key}`)), this.dom.element('dd', String(count))); metrics.append(item);
      }
      if (metrics.childElementCount) heading.append(metrics);
      this.detail.append(heading);
    }
    const root = this.dom.element('section'); this.detail.append(root);
    const scope = followupScope(this.catalog.machine_id, project.id, selected.id, selected.summary!) ??
      JSON.stringify(['unavailable-observation', this.catalog.machine_id, project.id, selected.id, selected.summary!.source_revision ?? null, selected.summary!.source_generated_at ?? null]);
    const observationState = (followupScope(this.catalog.machine_id, project.id, selected.id, selected.summary!) ? this.observations.get(scope) : undefined) ?? { age: new ObservationAge(), links: new FollowupFreshness(), sourceRevision: null, estimateRevision: null, inconsistent: false };
    this.observations.delete(scope); this.observations.set(scope, observationState);
    while (this.observations.size > 200) this.observations.delete(this.observations.keys().next().value!);
    this.followup = new ProjectFollowupController({ root, machine: this.catalog.machine_id, project, source: selected.id,
      summary: selected.summary!, translate: this.dom.t, preferences: this.preferences, observationState });
  }
  render(value: ProjectCatalog) {
    if (this.selectionMachine !== value.machine_id) { this.suspend(); this.selected = null; this.restoreKey = null; this.restoreScope = null; }
    this.selectionMachine = value.machine_id; this.catalog = value;
    this.status.textContent = this.dom.t(this.readingFirst ? "projectObservation.observed" : "projects.loaded", { value: displayProjectTime(value.generated_at,this.dom.doc,this.dom.t("projects.unknown")), revision: value.revision });
    this.list.replaceChildren(); this.detail.replaceChildren();
    for (const project of value.projects) {
      const button = this.dom.element("button", project.title); button.type = "button"; button.className = "btn";
      button.dataset.projectId = project.id; button.addEventListener("click", () => this.showProject(project)); this.list.append(button);
    }
    const project = value.projects.find(item => item.id === this.selected) ?? value.projects[0];
    if (project) this.showProject(project);
    else this.status.textContent = this.dom.t("projects.empty");
    if (this.restoreKey && this.dom.doc.hasFocus() && this.dom.doc.activeElement === this.status) {
      const elements = Array.from(this.detail.querySelectorAll<HTMLElement>('[data-followup-key]'))
        .filter(element => this.restoreScope !== null && this.focusScope(element) === this.restoreScope);
      (elements.find(element => element.dataset.followupKey === this.restoreKey) ?? elements.find(element => element.dataset.followupKey?.startsWith('row-')) ?? elements[0])?.focus({ preventScroll: true });
    }
    this.restoreKey = null; this.restoreScope = null;
  }

}

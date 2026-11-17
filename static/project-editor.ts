// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProjectDetail, ProjectRequest, SourceReference, ProjectObservationSettings, SourceSelector, SourceObservationSettings } from './project-host.ts';
import { safeProjectURL, SOURCE_KINDS } from './project-catalog.js';

export type ProjectIntent = ProjectRequest & { request_id: string; project_id?: string };
type Translate = (key: string, values?: Record<string, string | number>) => string;
type Patch = Record<string, unknown>;
type TextField = HTMLInputElement | HTMLTextAreaElement;
type Context = { boot: string; revision: string; omissions: string[]; settings?: ProjectObservationSettings };
type SourceRow = { id: string; root: HTMLElement; kind: HTMLSelectElement;
  label: HTMLInputElement | HTMLTextAreaElement; url: HTMLInputElement | HTMLTextAreaElement };
interface EditorOptions {
  doc: Document; translate: Translate; canEdit: () => boolean; visible: () => boolean;
  blocked: () => void; context: () => Context; focusReturn: () => void;
  readSource: (id: string) => Promise<SourceObservationSettings>;
  save: (value: ProjectIntent, owner: number, error: HTMLElement) => Promise<void>;
}

function draftSources(original: SourceReference[], defaultLabel: string, patch?: Patch): SourceReference[] {
  const result = new Map(original.map(source => [source.id, { ...source }]));
  if (Array.isArray(patch?.source_changes)) for (const value of patch.source_changes) {
    if (!value || typeof value !== 'object') continue;
    const change = value as Patch;
    if (typeof change.id !== 'string') continue;
    if (change.type === 'remove') result.delete(change.id);
    else if (change.type === 'put') {
      const previous = result.get(change.id);
      const next = { id: change.id, kind: typeof change.kind === 'string' ? change.kind : previous?.kind ?? 'roster',
        label: typeof change.label === 'string' ? change.label : previous?.label ?? defaultLabel,
        ...(previous?.url ? { url: previous.url } : {}) };
      if (change.url === null) delete next.url;
      else if (typeof change.url === 'string') next.url = change.url;
      result.set(change.id, next);
    }
  }
  return [...result.values()];
}

function sourceChanges(original: SourceReference[], sources: SourceReference[]): Patch[] {
  const changes: Patch[] = sources.filter(source => {
    const previous = original.find(old => old.id === source.id);
    return !previous || previous.kind !== source.kind || previous.label !== source.label || previous.url !== source.url;
  }).map(source => ({ type: 'put', ...source,
    ...(!source.url && original.some(old => old.id === source.id && old.url) ? { url: null } : {}) }));
  for (const old of original) if (!sources.some(source => source.id === old.id)) changes.push({ type: 'remove', id: old.id });
  return changes;
}

/** One dialog lifetime; old save acknowledgements cannot own a newer editor. */
export class ProjectEditor {
  readonly options: EditorOptions;
  readonly dialog: HTMLDialogElement;
  generation = 0;
  constructor(options: EditorOptions) {
    this.options = options;
    this.dialog = options.doc.createElement('dialog');
    this.dialog.className = 'project-settings-dialog'; options.doc.body.append(this.dialog);
    this.dialog.addEventListener('cancel', () => { this.generation++; });
  }
  close() { this.generation++; if (this.dialog.open) this.dialog.close(); }
  open(project: ProjectDetail | null, patch?: Patch) {
    if (!this.options.canEdit()) { this.options.blocked(); return; }
    const owner = ++this.generation, focus = this.options.doc.activeElement;
    const form = new ProjectForm(this, owner, project, this.options.context(), patch);
    this.dialog.replaceChildren(form.form);
    this.dialog.onclose = () => {
      if (!this.options.visible()) return;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
      else this.options.focusReturn();
    };
    this.dialog.showModal(); form.name.focus();
  }
}

/** Field construction and typed settings serialization for one immutable revision. */
class ProjectForm {
  private readonly snapshots = new WeakMap<TextField, { raw: string; displayed: string }>();
  private localPath: TextField | null = null;
  private primaryRef: TextField | null = null;
  private inspectRepository: HTMLInputElement | null = null;
  private inspectSources = new Map<string, HTMLInputElement>();
  private selectors = new Map<string, { original: SourceSelector; kind: HTMLSelectElement; path: TextField; task: TextField }>();
  private readonly initialFolders: string[];
  private readonly editor: ProjectEditor;
  private readonly owner: number;
  private readonly project: ProjectDetail | null;
  private readonly context: Context;
  readonly form: HTMLFormElement;
  readonly name: HTMLInputElement | HTMLTextAreaElement;
  readonly description: HTMLInputElement | HTMLTextAreaElement;
  readonly folders: HTMLInputElement | HTMLTextAreaElement;
  readonly repository: HTMLInputElement | HTMLTextAreaElement;
  readonly rows: SourceRow[] = [];
  readonly error: HTMLElement;
  readonly submitButton: HTMLButtonElement;
  readonly originalSources: SourceReference[];
  private readonly doc: Document;
  private readonly t: Translate;
  constructor(editor: ProjectEditor, owner: number, project: ProjectDetail | null, context: Context, patch?: Patch) {
    this.editor = editor; this.owner = owner; this.project = project; this.context = context;
    this.doc = editor.options.doc; this.t = editor.options.translate;
    this.form = this.el('form'); this.form.append(this.el('h2', this.t(project ? 'projectWorkspace.settings' : 'projectWorkspace.new')));
    this.name = this.field(this.form, 'projectWorkspace.name', typeof patch?.title === 'string' ? patch.title : project?.title ?? '');
    this.name.required = !project || this.name.value !== ''; this.name.maxLength = 240;
    this.description = this.field(this.form, 'projectWorkspace.description', patch?.description === null ? '' :
      typeof patch?.description === 'string' ? patch.description : project?.description ?? '', true);
    this.description.maxLength = 4000; this.description.disabled = !!project && context.omissions.includes('description');
    const optional = this.optionalFields(patch);
    this.folders = optional.folders; this.repository = optional.repository; this.initialFolders = optional.paths;
    this.originalSources = project?.sources ?? []; this.sources(optional.root, patch);
    this.observationFields(optional.root, patch);
    if (project && context.omissions.length) this.form.append(this.el('p', this.t('projectWorkspace.partial')));
    this.error = this.el('p'); this.error.setAttribute('role', 'status'); this.form.append(this.error);
    this.submitButton = this.actions(); this.form.addEventListener('submit', event => { void this.submit(event); });
  }
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private button(text: string, action: () => void) {
    const node = this.el('button', text); node.type = 'button'; node.className = 'btn';
    node.addEventListener('click', action); return node;
  }
  private field(parent: HTMLElement, key: string, value = '', multiline = false) {
    const wrapper = this.el('label', this.t(key)), input = multiline ? this.el('textarea') : this.el('input');
    input.value = value; if (input instanceof HTMLInputElement) input.autocomplete = 'off';
    this.snapshots.set(input, { raw: value, displayed: input.value });
    wrapper.append(input); parent.append(wrapper); return input;
  }
  private value(input: TextField, trim = false) {
    const initial = this.snapshots.get(input);
    if (initial && input.value === initial.displayed) return initial.raw;
    return trim ? input.value.trim() : input.value;
  }
  private optionalFields(patch?: Patch) {
    const root = this.el('details'); root.open = !!this.project;
    root.append(this.el('summary', this.t('projectWorkspace.optional'))); this.form.append(root);
    const paths = Array.isArray(patch?.folders) ? [...patch.folders as string[]] : [...this.project?.folders ?? []];
    const folders = this.field(root, 'projectWorkspace.folders', paths.join('\n'), true);
    const unrepresentable = paths.some(value => /[\r\n]/u.test(value));
    folders.disabled = unrepresentable || !!this.project && this.context.omissions.includes('folders');
    if (unrepresentable) root.append(this.el('p', this.t('projectWorkspace.foldersReadOnly')));
    const draft = patch?.repository as { url?: string } | null | undefined;
    const repository = this.field(root, 'projectWorkspace.repository', draft === null ? '' : draft?.url ?? this.project?.repository?.url ?? '');
    repository.disabled = !!this.project && this.context.omissions.includes('repository');
    return { root, folders, repository, paths };
  }
  private observationFields(parent: HTMLElement, patch?: Patch) {
    const settings = this.context.settings;
    if (this.project && !settings) return;
    const repository = patch?.repository as Record<string, unknown> | null | undefined;
    const draft = (key: 'local_path' | 'primary_ref') => repository === null || repository?.[key] === null ? '' :
      typeof repository?.[key] === 'string' ? repository[key] as string : settings?.repository?.[key] ?? '';
    this.localPath = this.field(parent, 'projectObservation.localPath', draft('local_path'));
    this.primaryRef = this.field(parent, 'projectObservation.primaryRef', draft('primary_ref'));
    const plan = patch?.observation === null ? null : patch?.observation as { repository: boolean; source_ids: string[] } | undefined ?? settings?.plan;
    const checkbox = (label: string, checked: boolean) => {
      const wrapper = this.el('label', label), input = this.el('input'); input.type = 'checkbox'; input.checked = checked;
      wrapper.append(input); parent.append(wrapper); return input;
    };
    this.inspectRepository = checkbox(this.t('projectObservation.enableRepository'), plan?.repository ?? false);
    for (const source of settings?.source_summaries ?? []) {
      if (source.kind !== 'roster') continue;
      this.inspectSources.set(source.id, checkbox(this.t('projectObservation.enableSource', { value: source.label }), plan?.source_ids.includes(source.id) ?? false));
      const button = this.button(this.t('projectObservation.configureSource', { value: source.label }), () => {
        button.disabled = true;
        void this.editor.options.readSource(source.id).then(value => {
          if (this.owner !== this.editor.generation || !this.form.isConnected) return;
          const original = value.source.selector;
          const change = Array.isArray(patch?.source_changes) ? (patch.source_changes as Patch[]).find(change => change.id === source.id) : undefined;
          const selector = change && 'selector' in change ? change.selector as SourceSelector : original;
          const kind = this.el('select'); kind.setAttribute('aria-label', this.t('projectObservation.selectorKind'));
          for (const name of ['none', 'board', 'pipeline']) { const option = this.el('option', this.t('projectObservation.' + name)); option.value = name; kind.append(option); }
          kind.value = selector?.kind ?? 'none'; parent.append(kind);
          const path = this.field(parent, 'projectObservation.sourcePath', selector?.kind === 'board' ? selector.path : selector?.root ?? '');
          const task = this.field(parent, 'projectObservation.pipelineTask', selector?.kind === 'pipeline' ? selector.task : '');
          this.selectors.set(source.id, { original, kind, path, task });
          button.remove();
        }).catch(() => { if (this.owner === this.editor.generation) { this.error.textContent = this.t('projectWorkspace.conflict'); button.disabled = false; } });
      }); parent.append(button);
    }
  }
  private observationPatch(patch: Patch) {
    if (!this.localPath || !this.primaryRef || !this.inspectRepository) return;
    const settings = this.context.settings, repository: Patch = {};
    for (const [key, field] of [['local_path', this.localPath], ['primary_ref', this.primaryRef]] as const) {
      const value = this.value(field), old = settings?.repository?.[key] ?? '';
      if (value !== old) repository[key] = value || null;
    }
    if (Object.keys(repository).length && patch.repository !== null) patch.repository = { ...(patch.repository as Patch ?? {}), ...repository };
    const plan = { repository: this.inspectRepository.checked, source_ids: [...this.inspectSources].filter(([, field]) => field.checked).map(([id]) => id) };
    if (JSON.stringify(plan) !== JSON.stringify(settings?.plan ?? { repository: false, source_ids: [] })) patch.observation = plan;
    const changes = (patch.source_changes ?? []) as Patch[];
    for (const [id, value] of this.selectors) {
      const selector: SourceSelector = value.kind.value === 'none' ? null : value.kind.value === 'board' ?
        { kind: 'board', path: this.value(value.path) } : { kind: 'pipeline', root: this.value(value.path), task: this.value(value.task) };
      if (JSON.stringify(selector) === JSON.stringify(value.original)) continue;
      const change = changes.find(change => change.id === id);
      if (change?.type === 'put') change.selector = selector;
      else if (!change) changes.push({ type: 'selector', id, selector });
    }
    if (changes.length) patch.source_changes = changes;
  }
  private sourceRow(parent: HTMLElement, source?: SourceReference) {
    const root = this.el('div'); root.className = 'project-source-fields';
    const kind = this.el('select'); kind.setAttribute('aria-label', this.t('projectWorkspace.sourceKind'));
    for (const value of SOURCE_KINDS) {
      const option = this.el('option', value === 'roster' ? this.t('projectWorkspace.roster') : value); option.value = value; kind.append(option);
    }
    kind.value = source?.kind ?? 'roster'; kind.disabled = !!source; root.append(kind);
    const label = this.field(root, 'projectWorkspace.sourceLabel', source?.label ?? this.t('projectWorkspace.roster'));
    const url = this.field(root, 'projectWorkspace.sourceURL', source?.url ?? '');
    this.rows.push({ id: source?.id ?? crypto.randomUUID(), root, kind, label, url });
    root.append(this.button(this.t('projectWorkspace.remove'), () => { root.remove(); })); parent.append(root);
  }
  private sources(parent: HTMLElement, patch?: Patch) {
    const box = this.el('section'); box.className = 'project-source-editor'; parent.append(box);
    box.append(this.el('h3', this.t('projectWorkspace.sources')));
    if (this.project && this.context.omissions.includes('sources')) {
      box.append(this.el('p', this.t('projectWorkspace.partial'))); return;
    }
    for (const source of draftSources(this.originalSources, this.t('projectWorkspace.roster'), patch)) this.sourceRow(box, source);
    box.append(this.button(this.t('projectWorkspace.addSource'), () => {
      if (this.rows.filter(row => row.root.isConnected).length < 20) this.sourceRow(box);
    }));
  }
  private actions() {
    const actions = this.el('div'); actions.className = 'project-dialog-actions';
    actions.append(this.button(this.t('common.cancel'), () => { this.editor.close(); }));
    const submit = this.el('button', this.t(this.project ? 'projectWorkspace.save' : 'projectWorkspace.create'));
    submit.type = 'submit'; submit.className = 'btn primary'; actions.append(submit); this.form.append(actions); return submit;
  }
  private values() {
    const title = this.value(this.name, true), initialFolders = this.snapshots.get(this.folders);
    const folders = this.folders.value === initialFolders?.displayed ? [...this.initialFolders] : this.folders.value.split('\n').filter(value => value !== '');
    if (!title || !this.folders.disabled && (folders.length > 100 || folders.some(value => !value.startsWith('/') || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)))) throw Error('folders');
    const repository = this.value(this.repository, true); if (repository && !safeProjectURL(repository)) throw Error('url');
    const sources = this.rows.filter(row => row.root.isConnected).map(row => {
      const label = this.value(row.label, true), url = this.value(row.url, true);
      if (!label || label.length > 240 || url && !safeProjectURL(url)) throw Error('source');
      return { id: row.id, kind: row.kind.value, label, ...(url ? { url } : {}) };
    });
    return { title, folders, repository, sources };
  }
  private request(): ProjectIntent {
    const value = this.values(), project = this.project, description = this.value(this.description);
    const common = { version: 1 as const, boot: this.context.boot, expected_revision: this.context.revision, request_id: crypto.randomUUID() };
    if (!project) {
      const authored: Patch = { title: value.title,
      ...(description ? { description } : {}), folders: value.folders,
      ...(value.repository ? { repository: { url: value.repository } } : {}), sources: value.sources };
      this.observationPatch(authored);
      return { ...common, op: 'project_create', project: authored };
    }
    const patch: Patch = {};
    if (value.title !== project.title) patch.title = value.title;
    if (!this.description.disabled && description !== (project.description ?? '')) patch.description = description || null;
    if (!this.folders.disabled && JSON.stringify(value.folders) !== JSON.stringify(project.folders ?? [])) patch.folders = value.folders;
    if (!this.repository.disabled && value.repository !== (project.repository?.url ?? '')) patch.repository = value.repository ? { url: value.repository } : null;
    if (!this.context.omissions.includes('sources') && JSON.stringify(value.sources) !== JSON.stringify(this.originalSources))
      patch.source_changes = sourceChanges(this.originalSources, value.sources);
    this.observationPatch(patch);
    return { ...common, op: 'project_settings', project_id: project.id, patch };
  }
  private async submit(event: SubmitEvent) {
    event.preventDefault();
    if (!this.editor.options.canEdit() || this.owner !== this.editor.generation) return;
    try {
      const request = this.request(); this.submitButton.disabled = true;
      await this.editor.options.save(request, this.owner, this.error);
    } catch { this.error.textContent = this.t('projectWorkspace.invalid'); }
    finally { this.submitButton.disabled = false; }
  }
}

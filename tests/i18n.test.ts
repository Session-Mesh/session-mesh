// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The interface's language runtime (static/i18n.js): choice of language,
// English fallback, the forced language setting, interpolation and plurals,
// server messages. The real catalogs are served by a fake fetch.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const I18N = path.join(ROOT, 'static', 'i18n');

type Translate = (key: string, params?: Record<string, unknown>) => string;
type Runtime = {
  ready: Promise<string>; lang: string; languages: Record<string, string>; loaded: boolean;
  t: Translate; locale(): string; serverMessage(text: string): string; preference(): string | null;
  use(code: string | null): Promise<string>;
};
type Core = {
  resolveLanguage(preference: string | null, browser: string[], available: Record<string, string>): string;
  createTranslator(options: {lang: string; catalog: object; fallback: object; onMissing?: (key: string) => void}): Translate;
  createRuntime(env: object): Runtime;
};

const sandbox: {MeshI18n?: {core: Core}} = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'static', 'i18n.js'), 'utf8'), sandbox);
const core = sandbox.MeshI18n!.core;

// A served static/i18n directory, optionally with extra or missing files.
function servedFetch(overrides: Record<string, unknown> = {}) {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const name = url.replace(/^\/static\/i18n\//, '').replace(/\?.*$/, '');
    if (name in overrides) {
      const body = overrides[name];
      return body === undefined ? {ok: false, json: async () => null} : {ok: true, json: async () => body};
    }
    const file = path.join(I18N, name);
    if (!fs.existsSync(file)) return {ok: false, json: async () => null};
    return {ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8'))};
  };
  return {fetch, requested};
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
}

// Just enough DOM for applyDom: elements carrying data-i18n keys.
class FakeElement {
  textContent: string;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  constructor(text: string, attributes: Record<string, string>) {
    this.textContent = text;
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === 'data-i18n') this.dataset.i18n = value;
  }
}
function fakeDocument() {
  const button = new FakeElement('New session', {'data-i18n': 'side.new', title: 'Open a new session', 'data-i18n-title': 'side.newTitle'});
  const select = new FakeElement('', {'aria-label': 'Interface language', 'data-i18n-aria-label': 'foot.language.absent'});
  const document = {
    documentElement: {lang: 'en'},
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === 'template' ? [] : [button, select]),
  };
  return {document, button, select};
}

const quiet = {warn: () => {}};
async function runtime(languages: string[], storage = memoryStorage(), overrides: Record<string, unknown> = {}) {
  const {fetch, requested} = servedFetch(overrides);
  const rt = core.createRuntime({navigator: {languages}, fetch, storage, console: quiet});
  await rt.ready;
  return {rt, requested, storage};
}

const en = JSON.parse(fs.readFileSync(path.join(I18N, 'en.json'), 'utf8')) as Record<string, string>;
const fr = JSON.parse(fs.readFileSync(path.join(I18N, 'fr.json'), 'utf8')) as Record<string, string>;
const SAMPLE = 'common.cancel';

describe('choice of language', () => {
  test('the first browser language with a catalog wins, region tags included', async () => {
    assert.equal(core.resolveLanguage(null, ['de-DE', 'fr-CA', 'en'], {en: 'English', fr: 'Français'}), 'fr');
    assert.equal(core.resolveLanguage(null, ['FR'], {en: 'English', fr: 'Français'}), 'fr');
    assert.equal(core.resolveLanguage(null, ['en-GB', 'fr'], {en: 'English', fr: 'Français'}), 'en');
  });

  test('without a matching catalog the interface is English', async () => {
    assert.equal(core.resolveLanguage(null, ['de', 'ja'], {en: 'English', fr: 'Français'}), 'en');
    assert.equal(core.resolveLanguage(null, [], {en: 'English', fr: 'Français'}), 'en');
    const {rt} = await runtime(['de-DE']);
    assert.equal(rt.lang, 'en');
    assert.equal(rt.t(SAMPLE), en[SAMPLE]);
  });

  test('a French browser gets the French catalog from the server files', async () => {
    const {rt, requested} = await runtime(['fr-FR', 'en']);
    assert.equal(rt.lang, 'fr');
    assert.equal(rt.locale(), 'fr');
    assert.equal(rt.t(SAMPLE), fr[SAMPLE]);
    assert.ok(requested.some(url => url.startsWith('/static/i18n/fr.json')));
  });

  test('a language offered by languages.json is picked up without code change', async () => {
    const {rt} = await runtime(['xx'], memoryStorage(), {
      'languages.json': {en: 'English', fr: 'Français', xx: 'Test'},
      'xx.json': {[SAMPLE]: 'XX-cancel'},
    });
    assert.equal(rt.lang, 'xx');
    assert.equal(rt.t(SAMPLE), 'XX-cancel');
  });
});

describe('the language setting', () => {
  test('a forced language beats the browser and is kept in this browser', async () => {
    const storage = memoryStorage({'mesh.lang': JSON.stringify('fr')});
    const {rt} = await runtime(['en-US'], storage);
    assert.equal(rt.lang, 'fr');
    assert.equal(rt.preference(), 'fr');
  });

  test('use() switches language at once, without a server round other than the catalogs', async () => {
    const {rt, storage} = await runtime(['en-US']);
    assert.equal(rt.t(SAMPLE), en[SAMPLE]);
    assert.equal(await rt.use('fr'), 'fr');
    assert.equal(rt.t(SAMPLE), fr[SAMPLE]);
    assert.equal(storage.data.get('mesh.lang'), JSON.stringify('fr'));
    assert.equal(await rt.use(null), 'en');   // back to the browser's language
    assert.equal(storage.data.has('mesh.lang'), false);
    assert.equal(await rt.use('zz'), 'en');   // an unknown language is not stored
    assert.equal(storage.data.has('mesh.lang'), false);
  });

  test('a stored language that no longer has a catalog falls back to the browser', async () => {
    const {rt} = await runtime(['fr'], memoryStorage({'mesh.lang': JSON.stringify('zz')}));
    assert.equal(rt.lang, 'fr');
  });
});

describe('fallback', () => {
  test('a key missing from the catalog falls back to English, never to the key', async () => {
    const partial = {...fr};
    delete partial[SAMPLE];
    const {rt} = await runtime(['fr'], memoryStorage(), {'fr.json': partial});
    assert.equal(rt.t(SAMPLE), en[SAMPLE]);
  });

  test('an unreachable catalog falls back to English', async () => {
    const {rt} = await runtime(['fr'], memoryStorage(), {'fr.json': undefined});
    assert.equal(rt.lang, 'fr');
    assert.equal(rt.t(SAMPLE), en[SAMPLE]);
  });

  test('an unreachable English catalog never replaces the markup text by keys', async () => {
    const {document, button, select} = fakeDocument();
    const {fetch, requested} = servedFetch({'en.json': undefined});
    const rt = core.createRuntime({document, navigator: {languages: ['en']}, fetch, storage: memoryStorage(), console: quiet});
    await rt.ready;
    assert.equal(button.textContent, 'New session');
    assert.equal(button.getAttribute('title'), 'Open a new session');
    assert.equal(select.getAttribute('aria-label'), 'Interface language');
    assert.equal(requested.filter(url => url.startsWith('/static/i18n/en.json')).length, 2, 'one retry of the English catalog');
  });

  test('a French catalog still applies when English is unreachable, an unknown key keeps its markup', async () => {
    const {document, button, select} = fakeDocument();
    const {fetch} = servedFetch({'en.json': undefined, 'fr.json': {'side.new': 'Nouvelle session'}});
    const rt = core.createRuntime({document, navigator: {languages: ['fr']}, fetch, storage: memoryStorage(), console: quiet});
    await rt.ready;
    assert.equal(button.textContent, 'Nouvelle session');
    assert.equal(button.getAttribute('title'), 'Open a new session');
    assert.equal(select.getAttribute('aria-label'), 'Interface language');
  });

  test('the English catalog is fetched again once after a failure', async () => {
    let failures = 1;
    const {fetch: served} = servedFetch();
    const fetch = async (url: string) => (url.startsWith('/static/i18n/en.json') && failures-- > 0 ? {ok: false, json: async () => null} : served(url));
    const rt = core.createRuntime({navigator: {languages: ['en']}, fetch, storage: memoryStorage(), console: quiet});
    await rt.ready;
    assert.equal(rt.t(SAMPLE), en[SAMPLE]);
  });

  test('a key absent everywhere is reported', () => {
    const missing: string[] = [];
    const t = core.createTranslator({lang: 'fr', catalog: {}, fallback: {}, onMissing: key => missing.push(key)});
    t('nowhere.key');
    assert.deepEqual(missing, ['nowhere.key']);
  });
});

describe('interpolation and plurals', () => {
  const t = core.createTranslator({
    lang: 'fr',
    catalog: {greet: 'Bonjour {name}, {name} !', files: {one: '{n} fichier', other: '{n} fichiers'}},
    fallback: {greet: 'Hello {name}', files: {one: '{n} file', other: '{n} files'}, only: 'Only {x}'},
  });

  test('placeholders are replaced, an unknown one stays visible', () => {
    assert.equal(t('greet', {name: 'Ada'}), 'Bonjour Ada, Ada !');
    assert.equal(t('only', {}), 'Only {x}');
    assert.equal(t('only', {x: 0}), 'Only 0');
  });

  test('plurals follow the language rules', () => {
    assert.equal(t('files', {n: 0}), '0 fichier');   // French: 0 is singular
    assert.equal(t('files', {n: 1}), '1 fichier');
    assert.equal(t('files', {n: 3}), '3 fichiers');
    const english = core.createTranslator({lang: 'en', catalog: {files: {one: '{n} file', other: '{n} files'}}, fallback: {}});
    assert.equal(english('files', {n: 0}), '0 files');
    assert.equal(english('files', {n: 1}), '1 file');
  });
});

// AGPL-3.0-or-later section 13: the interface offers its source. The URL is
// written once, in the link's href, for a redistributor to change.
describe('source code link', () => {
  const SOURCE_URL = 'https://github.com/Session-Mesh/session-mesh';
  const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
  const footer = html.match(/<footer class="side-foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
  const link = footer.match(/<a\b[^>]*\bid="source-link"[^>]*>([^<]*)<\/a>/);

  test('the sidebar footer links to the source, beside the language setting, in a new tab', () => {
    assert.ok(link, 'an <a id="source-link"> in the sidebar footer');
    const tag = link[0];
    assert.match(tag, new RegExp(`\\bhref="${SOURCE_URL}"`));
    assert.match(tag, /\btarget="_blank"/);
    assert.match(tag, /\brel="noopener noreferrer"/);
    assert.ok(footer.indexOf('id="lang-select"') < footer.indexOf('id="source-link"'), 'after the language setting');
  });

  test('its text comes from both catalogs', () => {
    const key = link![0].match(/\bdata-i18n="([^"]+)"/)?.[1];
    assert.ok(key, 'the link names its key');
    assert.equal(en[key], 'Source code');
    assert.equal(link![1].trim(), 'Source code');
    assert.equal(fr[key], 'Code source');
  });

  test('the URL is defined in one place only', () => {
    const files = (fs.readdirSync(path.join(ROOT, 'static'), {recursive: true}) as string[])
      .filter(name => !name.startsWith('vendor') && /\.(js|mjs|ts|html|json)$/.test(name)).map(name => path.join(ROOT, 'static', name));
    const count = files.reduce((total, file) => total + fs.readFileSync(file, 'utf8').split(SOURCE_URL).length - 1, 0);
    assert.equal(count, 1);
  });
});

describe('server messages', () => {
  test('a known server message is translated, an unknown one is shown as it came', async () => {
    const rows = JSON.parse(fs.readFileSync(path.join(I18N, 'server-messages.json'), 'utf8')) as Array<{key: string}>;
    assert.ok(rows.length > 0, 'the table maps at least one server message');
    const {rt} = await runtime(['en'], memoryStorage(), {
      'server-messages.json': [{pattern: '^Folder not found: (?<path>.+)$', key: 'test.notFound'}],
      'en.json': {...en, 'test.notFound': 'folder not found: {path}'},
    });
    assert.equal(rt.serverMessage('Folder not found: /tmp/x\n'), 'folder not found: /tmp/x');
    assert.equal(rt.serverMessage('something else'), 'something else');
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The interface's displayed text lives in the catalogs (static/i18n/), never in
// the code: every catalog has the same keys, every key the code names exists,
// and no displayed literal is left in the interface files.
//
// I18N_SCAN=a.js,b.js limits the literal scan to those files (a work aid);
// I18N_EN=path names the English catalog used to check the keys they name.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATIC = path.join(ROOT, 'static');
const I18N = path.join(STATIC, 'i18n');

type Catalog = Record<string, string | Record<string, string>>;
type Finding = {file: string; line: number; text: string; rule: string};

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const catalogFiles = () => fs.readdirSync(I18N).filter(name => /^[a-z]{2,3}(-[a-z0-9]+)?\.json$/.test(name));
const loadCatalog = (code: string) => readJson(path.join(I18N, `${code}.json`)) as Catalog;

// Files the scan does not apply to, with the reason.
const GENERATED = new Set(['pane-actions.js', 'folder-state.js', 'history-state.js', 'session-activity.js',
  'demo-catalog.js', 'demo-view.js', 'diff-view.js', 'workspace-spec.js', 'shortcuts.js', 'terminal-links.js', 'projects.js', 'work-view.js', 'themes.js', 'update-notice.js', 'sessions-progress.js', 'flow-view.js']);   // built from the .ts next to them
// Sandboxed documents rendered by the server (/view, demo scenes): no network
// (connect-src 'none'), no storage, so no catalog can reach them until the
// server injects the language. Their text is English; the French check applies.
const SERVER_RENDERED = new Set(['code.html', 'markdown.html', 'diff.html', 'diff-view.ts', 'demo-view.ts', 'board.html']);

// Words and names that are the same in every language: product, agent and key names.
const INVARIANT = new Set([
  'Session Mesh', 'session mesh', 'Mesh', 'Claude', 'claude', 'Codex', 'codex', 'Pi', 'pi', 'OpenCode', 'Antigravity', 'Copilot CLI', 'Mistral Vibe',
  'Gemini CLI', 'shell', 'Esc', 'Tab', 'Ctrl', 'Ctrl+C', 'MCP', 'URL', 'HTML', 'PID', 'pid', 'CPU', 'RAM', 'JSON',
]);

const FRENCH_LETTERS = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ«»’]/u;
const FRENCH_WORDS = /(^|[\s(«"'])(le|la|les|de|des|un|une|du|au|aux|ce|cet|que|qui|quoi|en|est|sont|pas|pour|dans|avec|sans|sur|par|cette|ces|aucun|aucune|ou|et|ne|il|elle|ils|elles|nous|vous|mais|donc|lui|se|sa|ses|son|mon|ma|mes|nos|vos|tout|toute|tous|rien|peut|non|oui|ici|déjà|encore|puis|vers|chez|leur|leurs|votre|tu|te|ton|ta|tes)(?=[\s,.;:!?)»"']|$)/iu;
const FRENCH_ELISION = /(^|[\s(«"])[dlnsjmtc]['’][a-zà-ÿ]/iu;
// Common interface words without accents, and French typography (a space
// before : ; ! ?). Checked against the English catalog: no match there.
const FRENCH_VOCABULARY = /(^|[^\p{L}])(fichiers?|dossiers?|introuvables?|indisponibles?|invalides?|attendue?s?|requise?s?|nouveau|nouvelle|nouveaux|ancien|ancienne|anciens|enregistrer|enregistrement|envoyer|envoi|joindre|relancer|recharger|restaurer|maintenant|inconnue?s?|trop|fermer|ouvrir|supprimer|annuler|erreur|partiel|incertain|lecture|seule|taille|tri|police|colonne|galerie|appareil|dernier|derniers|lancer|chargement|aucune?|renommer|copier|coller|afficher|masquer|choisir|attente|jours|heures|retour|tableau|autres|touches|ligne|historique|corrompue?s?|sauvegarde|chemin|cible|vide|corps|objet)(?=[^\p{L}]|$)/iu;
const FRENCH_SPACED_PUNCTUATION = /\S\s[:;!?](\s|$)/u;

export function looksFrench(text: string): boolean {
  if (FRENCH_LETTERS.test(text)) return true;
  if (!/\s/.test(text.trim())) return false;   // a single token is code, not prose
  return FRENCH_WORDS.test(text) || FRENCH_ELISION.test(text) || FRENCH_VOCABULARY.test(text) || FRENCH_SPACED_PUNCTUATION.test(text);
}

const words = (text: string) => text.replace(/\$\{[^}]*\}/g, ' ').replace(/\{[A-Za-z0-9_]+\}/g, ' ');
const hasLetters = (text: string) => /[A-Za-z]{2,}/.test(words(text));
const invariant = (text: string) => INVARIANT.has(text.trim()) || !hasLetters(text);
const isProse = (text: string) => {
  const plain = words(text).trim();
  return /[A-Za-z]{2,}/.test(plain) && (/[A-Za-z]\s+[A-Za-z]/.test(plain) || /^[A-Z][a-z]/.test(plain));
};

// Displayed sinks. Strong: any word there is displayed text.
const STRONG_PROPS = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel', 'label', 'alt']);
const STRONG_CALLS = new Set(['flash', 'alert', 'confirm', 'prompt', 'notify', 'setStatus', 'showNotification', 'say', 'announce',
  'createTextNode']);
const STRONG_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'aria-description', 'aria-roledescription']);
// Node methods whose string arguments become text nodes. The same names on
// FormData, URLSearchParams or Headers take keys and values, not text.
const TEXT_NODE_CALLS = new Set(['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith']);
const NOT_A_NODE = /(form|params|search|query|headers|fd|url|body|data)$/i;
// Weak: object fields that usually carry a label; prose only.
const WEAK_KEYS = new Set(['label', 'title', 'text', 'message', 'placeholder', 'ariaLabel', 'hint', 'description', 'summary',
  'empty', 'detail', 'caption', 'heading', 'note', 'status', 'body', 'error', 'reason', 'name']);
// Error messages that are never the displayed text: programming errors (a
// missing element, a duplicate table entry) and transport diagnostics that are
// caught on the spot or shown only as the {error} detail of a translated
// message. Any other Error message is checked as a label.
const INTERNAL_ERRORS = new Set(['overview unavailable', 'terminal disconnected', 'catalog unavailable', 'invalid catalog',
  'Mesh already started', 'send refused', 'Demo history elements missing', 'Demo chooser elements missing',
  'Pane menu elements missing', 'Pane header element missing: ${}', 'duplicate Mesh action identifier',
  'duplicate Mesh action message key', 'duplicate Mesh capability identifier', 'unknown Mesh action: ${}',
  'unknown Mesh action message key: ${}', 'buffer row cell mapping unavailable']);
const internalError = (message: ts.Node) => INTERNAL_ERRORS.has(literalText(message));
// Calls whose result is localised text: translators, formatters, Intl output.
const TRANSLATORS = new Set(['t', 'translate', 'tr']);
const isLocalised = (name: string) => TRANSLATORS.has(name) || name === 'serverMessage' || name === 'ago'
  || /^fmt[A-Z]/.test(name) || /^toLocale/.test(name);

// Literal initialisers of plain variables, by name: `const label = "…"` then
// `el.textContent = label` is a displayed literal too. Only text is bound (no
// markup, no substitution): the binding ignores scopes, a name may be reused.
const plainText = (init: ts.Expression) => {
  const found = leaves(init);
  return found.length > 0 && found.every(leaf => !ts.isTemplateExpression(leaf) && !literalText(leaf).includes('<'));
};
type Bindings = Map<string, ts.Expression[]>;
function collectBindings(sf: ts.SourceFile): Bindings {
  const bindings: Bindings = new Map();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && plainText(node.initializer)) {
      bindings.set(node.name.text, [...(bindings.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bindings;
}

// The literals an expression can evaluate to: through parentheses, ternaries,
// ||, ?? and +, template substitutions and variables bound to literals.
function leaves(node: ts.Node, bindings?: Bindings, out: ts.Node[] = [], depth = 0): ts.Node[] {
  if (depth > 8) return out;
  const next = (child: ts.Node) => leaves(child, bindings, out, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node);
  else if (ts.isTemplateExpression(node)) { out.push(node); node.templateSpans.forEach(span => next(span.expression)); }
  else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) next(node.expression);
  else if (ts.isConditionalExpression(node)) { next(node.whenTrue); next(node.whenFalse); }
  else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) { next(node.left); next(node.right); }
  else if (ts.isIdentifier(node) && bindings?.has(node.text)) bindings.get(node.text)!.forEach(next);
  return out;
}
function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => '${}' + span.literal.text).join('');
  return '';
}
const calleeName = (expr: ts.Expression): string =>
  ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : '';
const receiverName = (expr: ts.Expression): string =>
  ts.isPropertyAccessExpression(expr) ? calleeName(expr.expression) : '';
const propName = (name: ts.PropertyName): string =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : '';

// Localised calls an expression yields without an esc() around them, directly
// or through a variable that holds one (`localised`: the names bound to one).
function unescapedLocalised(node: ts.Node, localised: Set<string>, out: ts.Node[] = []): ts.Node[] {
  const next = (child: ts.Node) => unescapedLocalised(child, localised, out);
  if (ts.isCallExpression(node)) { if (isLocalised(calleeName(node.expression))) out.push(node); }
  else if (ts.isIdentifier(node)) { if (localised.has(node.text)) out.push(node); }
  else if (ts.isTemplateExpression(node)) node.templateSpans.forEach(span => next(span.expression));
  else if (ts.isParenthesizedExpression(node)) next(node.expression);
  else if (ts.isConditionalExpression(node)) { next(node.whenTrue); next(node.whenFalse); }
  else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) {
    next(node.left); next(node.right);
  }
  return out;
}
function collectLocalised(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && unescapedLocalised(node.initializer, names).length) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}
const MARKUP = /<\/?[a-zA-Z]/;
const HTML_PROPS = new Set(['innerHTML', 'outerHTML']);

export type ScanResult = {findings: Finding[]; keys: Set<string>; prefixes: Set<string>; literals?: Set<string>};

type Scan = {
  result: ScanResult; strict: boolean; bindings: Bindings; localised: Set<string>; flagged: Set<ts.Node>;
  report(node: ts.Node, text: string, rule: string): void;
  sink(expr: ts.Node, strong: boolean): void;
};

function createScan(file: string, sf: ts.SourceFile, lineOffset: number, result: ScanResult, strict: boolean): Scan {
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
  const bindings = collectBindings(sf);
  const report = (node: ts.Node, text: string, rule: string) => { result.findings.push({file, line: at(node), text, rule}); };
  const sink = (expr: ts.Node, strong: boolean) => {
    if (!strict) return;
    for (const leaf of leaves(expr, bindings)) {
      const text = literalText(leaf);
      if (invariant(text)) continue;
      if (strong || isProse(text)) report(leaf, text, strong ? 'displayed literal' : 'labelled literal');
    }
  };
  return {result, strict, bindings, localised: collectLocalised(sf), flagged: new Set(), report, sink};
}

// Every literal: French anywhere, and in strict files markup built in a string.
function checkLiteral(scan: Scan, node: ts.Node) {
  const text = ts.isRegularExpressionLiteral(node) ? node.text : (node as ts.LiteralLikeNode).text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) (scan.result.literals ??= new Set()).add(text);
  if (looksFrench(text)) scan.report(node, text, 'French literal');
  if (!scan.strict || ts.isRegularExpressionLiteral(node)) return;
  for (const match of text.matchAll(/>([^<>]*)</g)) {
    if (!invariant(match[1]!) && /[A-Za-z]{2,}/.test(words(match[1]!))) scan.report(node, match[1]!.trim(), 'markup text');
  }
  for (const match of text.matchAll(/\b(title|aria-label|placeholder|alt)="([^"$]*)"/g)) {
    if (!invariant(match[2]!)) scan.report(node, match[2]!, 'markup attribute');
  }
}

// A catalog value or a localised format put into markup must go through esc().
function checkMarkup(scan: Scan, node: ts.Node) {
  let parts: ts.Node[] = [];
  if (ts.isTemplateExpression(node) && [node.head, ...node.templateSpans.map(span => span.literal)].some(part => MARKUP.test(part.text))) {
    parts = node.templateSpans.map(span => span.expression);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    && [node.left, node.right].some(side => ts.isStringLiteral(side) && MARKUP.test(side.text))) {
    parts = [node.left, node.right];
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && HTML_PROPS.has(node.left.name.text)) {
    parts = [node.right];
  } else if (ts.isCallExpression(node) && calleeName(node.expression) === 'insertAdjacentHTML' && node.arguments[1]) {
    parts = [node.arguments[1]];
  }
  for (const part of parts) {
    for (const call of unescapedLocalised(part, scan.localised)) {
      if (scan.flagged.has(call)) continue;   // a + chain or nested markup reaches it twice
      scan.flagged.add(call);
      scan.report(call, call.getText(), 'unescaped localised value');
    }
  }
}

function checkCall(scan: Scan, node: ts.CallExpression) {
  const name = calleeName(node.expression);
  const [first, second] = node.arguments;
  if (TRANSLATORS.has(name) && first) {
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) scan.result.keys.add(first.text);
    else if (ts.isTemplateExpression(first)) scan.result.prefixes.add(first.head.text);
    // t('family.' + key) names a family of keys, as t(`family.${key}`) does
    else if (ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(first.left)) {
      scan.result.prefixes.add(first.left.text);
    }
    else if (ts.isConditionalExpression(first)) {
      for (const leaf of leaves(first)) if (ts.isStringLiteral(leaf)) scan.result.keys.add(leaf.text);
    }
  } else if (STRONG_CALLS.has(name) && first) scan.sink(first, true);
  else if (name === 'setAttribute' && first && ts.isStringLiteral(first) && STRONG_ATTRS.has(first.text) && second) scan.sink(second, true);
  else if (name === 'insertAdjacentText' && second) scan.sink(second, true);
  else if (TEXT_NODE_CALLS.has(name) && !NOT_A_NODE.test(receiverName(node.expression))) node.arguments.forEach(arg => scan.sink(arg, true));
}

function checkNode(scan: Scan, node: ts.Node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) checkLiteral(scan, node);
  checkMarkup(scan, node);
  if (ts.isCallExpression(node)) checkCall(scan, node);
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments?.[0]) {
    // an Option shows its text; an Error's message ends up in a flash or a dialog
    if (node.expression.text === 'Option') scan.sink(node.arguments[0], true);
    else if (/Error$/.test(node.expression.text) && !internalError(node.arguments[0])) scan.sink(node.arguments[0], false);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && STRONG_PROPS.has(node.left.name.text)) scan.sink(node.right, true);
  if (ts.isPropertyAssignment(node) && WEAK_KEYS.has(propName(node.name))) scan.sink(node.initializer, false);
}

export function scanScript(file: string, source: string, kind: ts.ScriptKind, lineOffset = 0, result: ScanResult = {findings: [], keys: new Set(), prefixes: new Set()}, strict = true): ScanResult {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const scan = createScan(file, sf, lineOffset, result, strict);
  const visit = (node: ts.Node) => { checkNode(scan, node); ts.forEachChild(node, visit); };
  visit(sf);
  return result;
}

const DISPLAYED_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label'];
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

export function scanHtml(file: string, html: string, result: ScanResult, strict = true): ScanResult {
  // inline scripts are code
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=|type="application\/json"/.test(match[1]!)) continue;
    scanScript(file, match[2]!, ts.ScriptKind.JS, lineOf(html, match.index!) - 1, result, strict);
  }
  const masked = html.replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  const report = (index: number, text: string, rule: string) => result.findings.push({file, line: lineOf(html, index), text, rule});
  // each tag, then the text that follows it up to the next tag
  for (const match of masked.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>([^<]*)/g)) {
    const [, , attrs, following] = match;
    const index = match.index!;
    const key = attrs!.match(/\bdata-i18n="([^"]+)"/)?.[1];
    if (key) result.keys.add(key);
    for (const attr of DISPLAYED_ATTRS) {
      const value = attrs!.match(new RegExp(`(?:^|\\s)${attr}="([^"]*)"`))?.[1];
      const attrKey = attrs!.match(new RegExp(`\\bdata-i18n-${attr}="([^"]+)"`))?.[1];
      if (attrKey) result.keys.add(attrKey);
      if (value === undefined) continue;
      if (looksFrench(value)) report(index, value, 'French attribute');
      else if (strict && !attrKey && !invariant(value) && !value.includes('{{')) report(index, value, `${attr} without data-i18n-${attr}`);
    }
    const text = following!.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (looksFrench(text)) report(index, text, 'French text');
    else if (strict && !key && !invariant(text) && !text.includes('{{')) report(index, text, 'text without data-i18n');
  }
  // closing tags followed by text (e.g. "</span> more words")
  for (const match of masked.matchAll(/<\/[a-zA-Z][\w-]*>([^<]*)/g)) {
    const text = match[1]!.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (looksFrench(text)) report(match.index!, text, 'French text');
    else if (strict && !invariant(text) && !text.includes('{{')) report(match.index!, text, 'text without data-i18n');
  }
  return result;
}

function interfaceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['vendor', 'i18n', 'icons'].includes(entry.name)) walk(full); continue; }
      if (!/\.(js|mjs|ts|html|webmanifest)$/.test(entry.name) || GENERATED.has(entry.name)) continue;
      out.push(full);
    }
  };
  walk(STATIC);
  return out.sort();
}

test('generated Projects bundle is covered by every authored TypeScript module',()=>{
  const scanned=new Set(interfaceFiles());
  assert.equal(scanned.has(path.join(STATIC,'projects.js')),false);
  const sources=fs.readdirSync(STATIC).filter(name=>/^project.*\.ts$/.test(name));
  assert.ok(sources.includes('projects.ts'));
  for(const source of sources)assert.ok(scanned.has(path.join(STATIC,source)),`${source} must stay in the literal/key scan`);
});

test('generated Flow bundle is covered by its authored TypeScript modules', () => {
  const scanned = new Set(interfaceFiles());
  assert.equal(scanned.has(path.join(STATIC, 'flow-view.js')), false);
  for (const source of ['flow-view.ts', 'flow-model.ts']) assert.ok(scanned.has(path.join(STATIC, source)));
});

export function scanFiles(files: string[]): ScanResult {
  const result: ScanResult = {findings: [], keys: new Set(), prefixes: new Set()};
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const base = path.basename(file);
    const strict = !SERVER_RENDERED.has(base);
    const source = fs.readFileSync(file, 'utf8');
    if (base.endsWith('.html')) scanHtml(rel, source, result, strict);
    else if (base.endsWith('.webmanifest')) {
      for (const field of ['name', 'short_name', 'description']) {
        const value = (JSON.parse(source) as Record<string, string>)[field] ?? '';
        if (looksFrench(value)) result.findings.push({file: rel, line: 1, text: value, rule: 'French manifest field'});
      }
    } else scanScript(rel, source, base.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS, 0, result, strict);
  }
  return result;
}

const show = (findings: Finding[]) => findings.map(f => `${f.file}:${f.line} [${f.rule}] ${JSON.stringify(f.text)}`).join('\n');
const placeholders = (value: string | Record<string, string>) =>
  [...new Set([...(typeof value === 'string' ? [value] : Object.values(value)).join(' ').matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m => m[1]))].sort();

const only = process.env.I18N_SCAN?.split(',').filter(Boolean).map(file => path.resolve(file));

if (only) {
  test('work aid: literals left in the named files', () => {
    const result = scanFiles(only);
    const english = process.env.I18N_EN ? readJson(path.resolve(process.env.I18N_EN)) as Catalog : loadCatalog('en');
    const unknown = [...result.keys].filter(key => !(key in english));
    assert.deepEqual(unknown, [], `keys missing from the English catalog:\n${unknown.join('\n')}`);
    assert.equal(result.findings.length, 0, `${result.findings.length} literal(s) left:\n${show(result.findings)}`);
  });
} else {
  describe('catalogs', () => {
    const offered = readJson(path.join(I18N, 'languages.json')) as Record<string, string>;
    const english = loadCatalog('en');

    test('languages.json lists exactly the catalogs, English included', () => {
      assert.deepEqual(Object.keys(offered).sort(), catalogFiles().map(name => name.replace(/\.json$/, '')).sort());
      assert.ok('en' in offered && 'fr' in offered);
    });

    test('every catalog has the same keys, placeholders and plural shape as English', () => {
      for (const code of Object.keys(offered)) {
        const catalog = loadCatalog(code);
        assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), `${code}.json keys differ from en.json`);
        for (const [key, value] of Object.entries(catalog)) {
          const reference = english[key]!;
          // a language may vary with the count where another does not: a string or a plural object
          if (typeof value === 'object') assert.ok(typeof value.other === 'string' && value.other, `${code}:${key} needs "other"`);
          else assert.ok(value.length > 0, `${code}:${key} is empty`);
          assert.deepEqual(placeholders(value), placeholders(reference), `${code}:${key} placeholders differ`);
        }
      }
    });

    test('every language code is a lowercase BCP 47 tag that Intl accepts', () => {
      for (const code of Object.keys(offered)) {
        const [canonical] = Intl.getCanonicalLocales(code);
        assert.equal(canonical!.toLowerCase(), code, `${code}: not a lowercase canonical BCP 47 tag`);
        assert.deepEqual(Intl.PluralRules.supportedLocalesOf(code), [canonical], `${code}: no plural rules in Intl`);
      }
    });

    test('no catalog value carries markup (< or >): values reach the page as text', () => {
      for (const code of Object.keys(offered)) {
        for (const [key, value] of Object.entries(loadCatalog(code))) {
          for (const text of typeof value === 'string' ? [value] : Object.values(value)) {
            assert.ok(!/[<>]/.test(text), `${code}:${key} contains < or >: ${JSON.stringify(text)}`);
          }
        }
      }
    });

    test('a value that varies with the count in English varies in every catalog', () => {
      const plural = Object.keys(english).filter(key => typeof english[key] === 'object');
      for (const code of Object.keys(offered)) {
        const catalog = loadCatalog(code);
        const flat = plural.filter(key => typeof catalog[key] !== 'object');
        assert.deepEqual(flat, [], `${code}.json: plural in English, a single string here`);
      }
    });

    test('the server message table names known keys and binds their placeholders', () => {
      const rows = readJson(path.join(I18N, 'server-messages.json')) as Array<{pattern: string; key: string}>;
      for (const row of rows) {
        assert.ok(row.key in english, `server-messages: unknown key ${row.key}`);
        const groups = [...new RegExp(row.pattern).source.matchAll(/\(\?<([A-Za-z0-9_]+)>/g)].map(m => m[1]).sort();
        assert.deepEqual(groups, placeholders(english[row.key]!), `server-messages: ${row.key} groups vs placeholders`);
      }
    });
  });

  describe('interface files', () => {
    const result = scanFiles(interfaceFiles());
    const english = loadCatalog('en');
    const serverKeys = (readJson(path.join(I18N, 'server-messages.json')) as Array<{key: string}>).map(row => row.key);

    test('no displayed literal outside the catalogs', () => {
      assert.equal(result.findings.length, 0, `${result.findings.length} literal(s) outside the catalogs:\n${show(result.findings)}`);
    });

    test('every key named by the interface exists in English', () => {
      const unknown = [...result.keys].filter(key => !(key in english));
      assert.deepEqual(unknown, [], `unknown keys:\n${unknown.join('\n')}`);
      for (const prefix of result.prefixes) {
        assert.ok(Object.keys(english).some(key => key.startsWith(prefix)), `no key starts with ${prefix}`);
      }
    });

    test('every catalog key is used', () => {
      // named by a translator call, by the server table, or held in a table of keys
      const used = (key: string) => result.keys.has(key) || serverKeys.includes(key) || result.literals?.has(key)
        || [...result.prefixes].some(prefix => prefix && key.startsWith(prefix));
      const unused = Object.keys(english).filter(key => !used(key));
      assert.deepEqual(unused, [], `unused keys:\n${unused.join('\n')}`);
    });

    test('inline English fallbacks in the markup match the English catalog', () => {
      for (const file of interfaceFiles().filter(name => name.endsWith('.html'))) {
        const html = fs.readFileSync(file, 'utf8');
        for (const match of html.matchAll(/<[a-zA-Z][\w-]*([^>]*)\bdata-i18n="([^"]+)"([^>]*)>([^<]*)</g)) {
          const shown = match[4]!.replace(/\s+/g, ' ').trim();
          const value = english[match[2]!];
          if (shown && typeof value === 'string') assert.equal(shown, value, `${path.basename(file)}: inline text of ${match[2]}`);
        }
      }
    });
  });

  describe('the guard itself', () => {
    test('catches French and displayed English, lets code and translated text through', () => {
      const scan = (src: string) => scanScript('x.js', src, ts.ScriptKind.JS).findings.map(f => f.rule);
      assert.deepEqual(scan('el.textContent = "Fermer";'), ['displayed literal']);
      assert.deepEqual(scan('flash("Session déjà ouverte");').sort(), ['French literal', 'displayed literal'].sort());
      assert.deepEqual(scan('el.title = "Open the page";'), ['displayed literal']);
      assert.deepEqual(scan('x.innerHTML = `<b>Hello there</b>`;'), ['markup text']);
      assert.deepEqual(scan('el.textContent = t("pane.close"); q("#dlg-new [data-close]"); el.className = "btn ghost";'), []);
      const html = scanHtml('x.html', '<button title="Close">Close</button><b data-i18n="a" data-i18n-title="b" title="T">A</b>',
        {findings: [], keys: new Set(), prefixes: new Set()});
      assert.deepEqual(html.findings.map(f => f.rule), ['title without data-i18n-title', 'text without data-i18n']);
      assert.deepEqual([...html.keys].sort(), ['a', 'b']);
    });

    test('a key family is named by a template or a concatenation, not by a bare variable', () => {
      const prefixes = (src: string) => [...scanScript('x.ts', src, ts.ScriptKind.TS).prefixes];
      assert.deepEqual(prefixes('t(`cockpit.${key}`);'), ['cockpit.']);
      assert.deepEqual(prefixes("this.t('cockpit.' + key);"), ['cockpit.']);
      assert.deepEqual(prefixes('t(key + ".x");'), []);
    });

    const rules = (src: string) => scanScript('x.js', src, ts.ScriptKind.JS).findings.map(f => f.rule).sort();

    test('French without accents is caught, English prose is not', () => {
      assert.deepEqual(rules('const m = "Impossible de lire ce fichier";'), ['French literal']);
      assert.deepEqual(rules('const m = "session introuvable";'), ['French literal']);
      assert.deepEqual(rules('const m = "Tri : taille";'), ['French literal']);
      assert.deepEqual(rules('const m = "Open in a new tab"; const n = "no session is active, try again";'), []);
    });

    test('a literal reaches a sink through a variable, a template or a ternary', () => {
      assert.deepEqual(rules('const label = "Close the pane"; el.textContent = label;'), ['displayed literal']);
      assert.deepEqual(rules('flash(ok ? "Saved" : "Failed");'), ['displayed literal', 'displayed literal']);
      assert.deepEqual(rules('flash(`${ok ? "Saved" : "Failed"}`);'), ['displayed literal', 'displayed literal']);
      assert.deepEqual(rules('throw new Error("Could not open the session");'), ['labelled literal']);
    });

    test('text node sinks: insertAdjacentText, append, createTextNode', () => {
      assert.deepEqual(rules('el.insertAdjacentText("beforeend", "Hello there");'), ['displayed literal']);
      assert.deepEqual(rules('el.append("Hello there"); el.prepend("Done");'), ['displayed literal', 'displayed literal']);
      assert.deepEqual(rules('document.createTextNode("Hello there");'), ['displayed literal']);
      assert.deepEqual(rules('form.append("file", blob); params.append("q", "x y"); el.append(t("a.b"));'), []);
    });

    test('a catalog value or a localised format in markup must be escaped', () => {
      assert.deepEqual(rules('x.innerHTML = `<b>${t("a.b")}</b>`;'), ['unescaped localised value']);
      assert.deepEqual(rules('x.innerHTML = `<span class="ago">${ago(ts)}</span><i>${fmtBytes(n)}</i>`;'),
        ['unescaped localised value', 'unescaped localised value']);
      assert.deepEqual(rules('const when = ago(ts); x.innerHTML = `<i>${when}</i>`;'), ['unescaped localised value']);
      assert.deepEqual(rules('x.innerHTML = "<b>" + t("a.b") + "</b>";'), ['unescaped localised value']);
      assert.deepEqual(rules('x.innerHTML = ok ? t("a.b") : ""; x.insertAdjacentHTML("beforeend", fmtDate(ts));'),
        ['unescaped localised value', 'unescaped localised value']);
      assert.deepEqual(rules('x.innerHTML = `<b>${esc(t("a.b"))}</b><i>${esc(fmtN(n))}</i>`; y.textContent = `${t("a.b")}`;'), []);
    });
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's display name (static/operator-name.ts): the labels that name the operator when a name
// is set and fall back to the wording without one, the display sanitiser, the local check before saving,
// and the catalogs that give every label its three forms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {OPERATOR_LABELS, OPERATOR_NAME_MAX, cleanOperatorName, operatorLabel, operatorNameOfConfig,
  operatorNameProblem} from '../static/operator-name.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const catalog = (code: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'static', 'i18n', `${code}.json`), 'utf8')) as Record<string, string>;
const translator = (code: string) => {
  const entries = catalog(code);
  return (key: string, params: Record<string, string | number> = {}) => {
    const template = entries[key];
    assert.equal(typeof template, 'string', `${code}: ${key} exists`);
    return template!.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole);
  };
};
const fr = translator('fr');
const en = translator('en');

describe('operatorLabel', () => {
  test('names the operator when a name is set', () => {
    assert.equal(operatorLabel(fr, 'waiting', 'Mathias'), 'En attente de la réponse de Mathias');
    assert.equal(operatorLabel(en, 'waiting', 'Mathias'), 'Waiting for an answer from Mathias');
    assert.equal(operatorLabel(fr, 'relayed', 'Mathias', {session: 'agent-1'}), 'réponse de Mathias transmise par agent-1, non vérifiée');
    assert.equal(operatorLabel(fr, 'verified', 'Mathias'), 'réponse de Mathias, donnée dans cette vue (connecté)');
    assert.equal(operatorLabel(en, 'superseded', 'Mathias'), 'replaced by the answer from Mathias');
  });
  test('falls back to the wording without a name for an empty, blank or hidden-only name', () => {
    for (const name of ['', '   ', '‮​', '\n']) {
      assert.equal(operatorLabel(fr, 'waiting', name), "En attente de la réponse de l'opérateur");
      assert.equal(operatorLabel(en, 'verified', name), 'answered by the owner in this view (signed in)');
    }
    assert.equal(operatorLabel(fr, 'unrelayed', ''), "réponse de l'opérateur, session de transmission inconnue, non vérifiée");
  });
  test('French elides "de" before a vowel; English has one form', () => {
    assert.equal(operatorLabel(fr, 'waiting', 'Émile'), "En attente de la réponse d'Émile");
    assert.equal(operatorLabel(fr, 'superseded', 'alice'), "remplacée par la réponse d'alice");
    assert.equal(operatorLabel(fr, 'waiting', 'Ève'), "En attente de la réponse d'Ève");
    assert.equal(operatorLabel(fr, 'waiting', 'Œnone'), "En attente de la réponse d'Œnone");
    assert.equal(operatorLabel(fr, 'waiting', 'Yves'), 'En attente de la réponse de Yves');
    assert.equal(operatorLabel(fr, 'waiting', 'Hugo'), 'En attente de la réponse de Hugo');
    assert.equal(operatorLabel(en, 'waiting', 'Émile'), 'Waiting for an answer from Émile');
  });
  test('a name that looks like a parameter is shown as written, never substituted again', () => {
    assert.equal(operatorLabel(fr, 'relayed', '{session}', {session: 'agent-1'}), 'réponse de {session} transmise par agent-1, non vérifiée');
  });
});

describe('cleanOperatorName', () => {
  test('trims, drops control, format and bidirectional characters, and caps the length', () => {
    assert.equal(cleanOperatorName('  Mathias  '), 'Mathias');
    assert.equal(cleanOperatorName('Ma‮thi​as\u0007'), 'Mathias');
    assert.equal(cleanOperatorName('x'.repeat(60)), 'x'.repeat(OPERATOR_NAME_MAX));
    assert.equal([...cleanOperatorName('é'.repeat(50))].length, OPERATOR_NAME_MAX);
    for (const value of [null, undefined, 3, {}, ['Mathias']]) assert.equal(cleanOperatorName(value), '');
  });
});

describe('operatorNameProblem', () => {
  test('accepts up to the maximum after trimming, refuses longer names and hidden characters', () => {
    assert.equal(operatorNameProblem(''), null);
    assert.equal(operatorNameProblem(`  ${'x'.repeat(OPERATOR_NAME_MAX)}  `), null);
    assert.equal(operatorNameProblem('x'.repeat(OPERATOR_NAME_MAX + 1)), 'tooLong');
    for (const hidden of ['‮', '⁦', '​', '\u0000', '\n', ' ', '']) {
      assert.equal(operatorNameProblem(`Ma${hidden}thias`), 'invalid', JSON.stringify(hidden));
    }
  });
});

describe('operatorNameOfConfig', () => {
  test('reads runner_settings.values.operator_name and nothing else', () => {
    assert.equal(operatorNameOfConfig({runner_settings: {values: {operator_name: ' Mathias '}}}), 'Mathias');
    for (const raw of [null, {}, {runner_settings: null}, {runner_settings: {values: []}}, {operator_name: 'x'},
      {runner_settings: {values: {operator_name: 7}}}]) assert.equal(operatorNameOfConfig(raw), '');
  });
});

describe('the catalogs', () => {
  test('every operator label has its three forms in English and French, the named ones with {name}', () => {
    for (const code of ['en', 'fr']) {
      const entries = catalog(code);
      for (const keys of Object.values(OPERATOR_LABELS)) {
        assert.equal(typeof entries[keys.plain], 'string', `${code} ${keys.plain}`);
        assert.ok(!entries[keys.plain]!.includes('{name}'), `${code} ${keys.plain} has no name`);
        for (const key of [keys.named, keys.elided]) assert.ok(entries[key]?.includes('{name}'), `${code} ${key}`);
      }
    }
  });
  test('the French interface says "opérateur", never "propriétaire"', () => {
    const french = Object.values(catalog('fr')).map(value => typeof value === 'string' ? value : JSON.stringify(value));
    assert.deepEqual(french.filter(text => /propriétaire/i.test(text)), []);
  });
});

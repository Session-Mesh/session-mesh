// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's display name (static/operator-name.ts): the labels that name the operator when a name
// is set and fall back to the wording without one, the display sanitiser, the local check before saving,
// and the catalogs that give every label its three forms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {OPERATOR_LABELS, OPERATOR_NAME_MAX, cleanOperatorName, normalizeOperatorName, operatorLabel,
  operatorNameOfConfig, operatorNameProblem} from '../static/operator-name.ts';

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
/** The name as a label shows it: between FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE. */
const iso = (name: string) => `\u2068${name}\u2069`;

describe('operatorLabel', () => {
  test('names the operator when a name is set, isolated from the sentence direction', () => {
    assert.equal(operatorLabel(fr, 'waiting', 'Camille'), `En attente de la réponse de ${iso('Camille')}`);
    assert.equal(operatorLabel(en, 'waiting', 'Camille'), `Waiting for an answer from ${iso('Camille')}`);
    assert.equal(operatorLabel(fr, 'relayed', 'Camille', {session: 'agent-1'}), `réponse de ${iso('Camille')} transmise par agent-1, non vérifiée`);
    assert.equal(operatorLabel(fr, 'verified', 'Camille'), `réponse de ${iso('Camille')}, donnée dans cette vue (connecté)`);
    assert.equal(operatorLabel(en, 'superseded', 'Camille'), `replaced by the answer from ${iso('Camille')}`);
    // An earlier answer of the operator, corrected since (an edit): named like the answer it was.
    assert.equal(operatorLabel(fr, 'replaced', 'Camille'), `réponse antérieure de ${iso('Camille')} dans cette vue, remplacée par une correction`);
    assert.equal(operatorLabel(fr, 'replaced', 'alice'), `réponse antérieure d'${iso('alice')} dans cette vue, remplacée par une correction`);
    assert.equal(operatorLabel(fr, 'replaced', ''), "réponse antérieure de l'opérateur dans cette vue, remplacée par une correction");
    assert.equal(operatorLabel(en, 'replaced', 'Camille'), `earlier answer by ${iso('Camille')} in this view, replaced by a correction`);
  });
  test('a right-to-left name sits between one pair of first-strong isolate marks', () => {
    const label = operatorLabel(en, 'waiting', '\u05d3\u05e0\u05d4 2');
    assert.equal(label, 'Waiting for an answer from \u2068\u05d3\u05e0\u05d4 2\u2069');
    assert.equal([...label].filter(character => character === '\u2068').length, 1);
  });
  test('falls back to the wording without a name for an empty, blank, hidden-only or filler-only name', () => {
    for (const name of ['', '   ', '\u202e\u200b', '\n', '\u034f', '\ufe0f\u034f', '\u3164', '\uffa0\u115f', '\u2800', '\u180b\u180c', '\ufffc']) {
      assert.equal(operatorLabel(fr, 'waiting', name), "En attente de la réponse de l'opérateur", JSON.stringify(name));
      assert.equal(operatorLabel(en, 'verified', name), 'answered by the owner in this view (signed in)');
    }
    assert.equal(operatorLabel(fr, 'unrelayed', ''), "réponse de l'opérateur, session de transmission inconnue, non vérifiée");
  });
  test('French elides "de" before a vowel, an h and a y followed by a consonant; English has one form', () => {
    const waiting = (name: string) => operatorLabel(fr, 'waiting', name).replace(/[\u2068\u2069]/g, '');
    assert.equal(waiting('Émile'), "En attente de la réponse d'Émile");
    assert.equal(operatorLabel(fr, 'superseded', 'alice'), `remplacée par la réponse d'${iso('alice')}`);
    assert.equal(waiting('Ève'), "En attente de la réponse d'Ève");
    assert.equal(waiting('Œnone'), "En attente de la réponse d'Œnone");
    assert.equal(waiting('E\u0301lise'), "En attente de la réponse d'Élise", 'a decomposed accent counts');
    assert.equal(waiting('Hélène'), "En attente de la réponse d'Hélène");
    assert.equal(waiting('Hugo'), "En attente de la réponse d'Hugo");
    assert.equal(waiting('Yves'), "En attente de la réponse d'Yves");
    assert.equal(waiting('Yvonne'), "En attente de la réponse d'Yvonne");
    assert.equal(waiting('Yann'), 'En attente de la réponse de Yann', 'a y before a vowel is a consonant');
    assert.equal(waiting('Yolande'), 'En attente de la réponse de Yolande');
    assert.equal(waiting('Camille'), 'En attente de la réponse de Camille');
    assert.equal(operatorLabel(en, 'waiting', 'Émile'), `Waiting for an answer from ${iso('Émile')}`);
  });
  test('a name that looks like a parameter is shown as written, never substituted again', () => {
    assert.equal(operatorLabel(fr, 'relayed', '{session}', {session: 'agent-1'}),
      `réponse de ${iso('{session}')} transmise par agent-1, non vérifiée`);
  });
});

describe('cleanOperatorName', () => {
  test('trims, normalises to NFC, drops hidden characters and fillers, and caps the length', () => {
    assert.equal(cleanOperatorName('  Camille  '), 'Camille');
    assert.equal(cleanOperatorName('Ca\u202emil\u200ble\u0007'), 'Camille');
    assert.equal(cleanOperatorName('Ca\u034fmil\ufe0fle'), 'Camille');
    assert.equal(cleanOperatorName('Ca\u3164mi\u2800l\u180ble\ufffc'), 'Camille');
    assert.equal(cleanOperatorName('Re\u0301ne'), 'Réne', 'an ordinary combining accent is composed');
    assert.equal(cleanOperatorName('x'.repeat(60)), 'x'.repeat(OPERATOR_NAME_MAX));
    assert.equal([...cleanOperatorName('é'.repeat(50))].length, OPERATOR_NAME_MAX);
    assert.equal(cleanOperatorName('\u{1f600}'.repeat(40)), '\u{1f600}'.repeat(40), 'forty astral characters are forty characters');
    assert.equal(cleanOperatorName(`q${'\u0336'.repeat(30)}`), `q${'\u0336'.repeat(3)}`, 'a pile of marks is cut to three');
    for (const value of [null, undefined, 3, {}, ['Camille']]) assert.equal(cleanOperatorName(value), '');
  });
});

describe('operatorNameProblem', () => {
  test('accepts up to the maximum after trimming, refuses longer names, hidden characters and fillers', () => {
    assert.equal(operatorNameProblem(''), null);
    assert.equal(operatorNameProblem(`  ${'x'.repeat(OPERATOR_NAME_MAX)}  `), null);
    assert.equal(operatorNameProblem('x'.repeat(OPERATOR_NAME_MAX + 1)), 'tooLong');
    for (const hidden of ['\u202e', '\u2066', '\u200b', '\u0000', '\n', '\u2028', '\ue000', '\u034f', '\ufe0f', '\u{e0100}']) {
      assert.equal(operatorNameProblem(`Ca${hidden}mille`), 'invalid', JSON.stringify(hidden));
    }
    for (const filler of ['\u3164', '\uffa0', '\u115f', '\u1160', '\u2800', '\u180b', '\u180c', '\u180d', '\u180f', '\ufffc']) {
      assert.equal(operatorNameProblem(`Ca${filler}mille`), 'invalid', JSON.stringify(filler));
      assert.equal(operatorNameProblem(filler.repeat(2)), 'invalid', `${JSON.stringify(filler)} alone`);
    }
  });
  test('counts code points, not UTF-16 units: forty astral characters fit', () => {
    assert.equal(operatorNameProblem('\u{1f600}'.repeat(OPERATOR_NAME_MAX)), null);
    assert.equal(operatorNameProblem('\u{1f600}'.repeat(OPERATOR_NAME_MAX + 1)), 'tooLong');
  });
  test('measures after NFC, as the server does, and saves the NFC form', () => {
    const decomposed = 'é'.normalize('NFD').repeat(OPERATOR_NAME_MAX);
    assert.equal(operatorNameProblem(decomposed), null);
    assert.equal(normalizeOperatorName(`  ${decomposed} `), 'é'.normalize('NFC').repeat(OPERATOR_NAME_MAX));
  });
  test('allows three combining marks in a row, refuses more', () => {
    assert.equal(operatorNameProblem(`q${'\u0336'.repeat(3)}`), null);
    assert.equal(operatorNameProblem(`q${'\u0336'.repeat(4)}`), 'invalid');
    assert.equal(operatorNameProblem('x' + '\u0301'.repeat(39)), 'invalid');
    assert.equal(operatorNameProblem('Nguy\u1ec5n'.normalize('NFD')), null);
  });
});

describe('operatorNameOfConfig', () => {
  test('reads runner_settings.values.operator_name and nothing else', () => {
    assert.equal(operatorNameOfConfig({runner_settings: {values: {operator_name: ' Camille '}}}), 'Camille');
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

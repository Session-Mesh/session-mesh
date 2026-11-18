// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The retention and tag steps of nightly.yml and the start of release.yml, run with a recording gh in
// place of the real one. The tag job of release.yml: tests/nightly-release-tag.test.ts. Helpers:
// tests/nightly-test-scripts.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {type Release, stepScript, text, useScriptHarness} from './nightly-test-scripts.ts';

describe('the scripts of nightly.yml, run with a recording gh', () => {
  const {PREVIOUS, SHA, today, scratch, fixtures, run} = useScriptHarness();

  describe('the removal of old nightlies', () => {
    const script = stepScript(text, /Oldest first by date/);
    const nightly = (day: number) => `v0.2.0-nightly.202611${String(day).padStart(2, '0')}`;
    const others = ['v0.1.0', 'v0.1.3', 'v0.2.0', 'v0.2.0-rc.1', 'v0.2.0-nightly.2026111', 'v0.2.0-nightly.20261101x', 'vv0.2.0-nightly.20261101', 'v0.2.0-nightly.20261101.2'];
    const stable: Release[] = [{tag: 'v0.1.0', id: 1, prerelease: false}, {tag: 'v0.2.0-rc.1', id: 2}];
    const deletions = (calls: string) => calls.trim().split('\n').filter(Boolean).map((call) => call.replace('api -X DELETE repos/Session-Mesh/session-mesh/', '').replace(' --silent', ''));

    test('keeps the newest seven and deletes the older ones, at most three per run, and never another tag', () => {
      const days = Array.from({length: 12}, (_, index) => index + 1);
      const result = run(script, fixtures({tags: [...others, ...days.map(nightly)], releases: [...stable, ...days.map((day) => ({tag: nightly(day), id: 100 + day}))]}));
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), [101, 102, 103].flatMap((id, index) => [`releases/${id}`, `git/refs/tags/${nightly(index + 1)}`]));
      assert.match(result.summary, /Deletion cap of 3 reached/);
    });

    test('deletes nothing when there are seven nightlies or fewer', () => {
      const result = run(script, fixtures({tags: [...others, ...[1, 2, 3, 4, 5, 6, 7].map(nightly)], releases: stable}));
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls, '');
    });

    test('removes the bare tag of a nightly that has no release, and leaves a release that is not a pre-release', () => {
      const result = run(script, fixtures({tags: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(nightly),
        releases: [{tag: nightly(2), id: 12, prerelease: false}, ...[3, 4, 5, 6, 7, 8, 9].map((day) => ({tag: nightly(day), id: 100 + day}))]}));
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), [`git/refs/tags/${nightly(1)}`]);
      assert.match(result.output, /::warning::a release of v0\.2\.0-nightly\.20261102 is not a pre-release; it is left alone/);
    });

    test('does not rank a nightly-shaped tag whose release is not a pre-release among the kept seven', () => {
      // Day 9 is a protected newest tag: with eight eligible nightlies only the oldest one goes.
      const result = run(script, fixtures({tags: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(nightly),
        releases: [...[1, 2, 3, 4, 5, 6, 7, 8].map((day) => ({tag: nightly(day), id: 100 + day})), {tag: nightly(9), id: 109, prerelease: false}]}));
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), [`releases/101`, `git/refs/tags/${nightly(1)}`]);
      assert.match(result.output, /::warning::a release of v0\.2\.0-nightly\.20261109 is not a pre-release; it is left alone/);
    });

    test('deletes a draft nightly, which has no tag and is not seen by releases/tags, within the same cap', () => {
      // The draft is the oldest of nine: it is found only by listing the releases.
      const result = run(script, fixtures({tags: [2, 3, 4, 5, 6, 7, 8, 9].map(nightly),
        releases: [{tag: nightly(1), id: 51, draft: true}, ...[2, 3, 4, 5, 6, 7, 8, 9].map((day) => ({tag: nightly(day), id: 100 + day}))]}));
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), ['releases/51', `releases/102`, `git/refs/tags/${nightly(2)}`]);
    });

    test('counts drafts in the cap of deletions and never deletes a draft that is not a pre-release', () => {
      const days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const result = run(script, fixtures({releases: days.map((day) => ({tag: nightly(day), id: 100 + day, draft: day <= 4, prerelease: day !== 2}))}));
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), ['releases/101', 'releases/103', 'releases/104']);
      assert.match(result.summary, /Deletion cap of 3 reached/);
    });

    // The probe of the review: seven future-dated tags and the nightly of the run must not lead to
    // the deletion of the nightly just created.
    const todayMs = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)));
    const dayOf = (offset: number) => new Date(todayMs + offset * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
    const nightlyOn = (day: string, version = '0.2.0') => `v${version}-nightly.${day}`;
    const retention = (tags: string[], env: Record<string, string> = {}, releases: Release[] = []) => run(script, fixtures({tags, releases}), env);

    test('never deletes the nightly of the run, nor counts or deletes tags dated after today', () => {
      const future = [1, 2, 3, 4, 5, 6, 7].map((offset) => nightlyOn(`2099120${offset}`));
      const result = retention([...future, nightlyOn(today)]);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls, '');
      assert.match(result.output, /::warning::v0\.2\.0-nightly\.20991201 is dated after today/);
      // The seven newest real nightlies stay whatever the future tags are: only the eighth, the oldest, goes.
      const real = [7, 6, 5, 4, 3, 2, 1, 0].map((offset) => nightlyOn(dayOf(-offset)));
      const mixed = retention([...future, ...real]);
      assert.deepEqual(deletions(mixed.calls), [`git/refs/tags/${real[0]}`]);
    });

    test('never deletes NIGHTLY_TAG, even when it is the oldest or ties with another date', () => {
      const old = nightlyOn('20200101');
      const others = [1, 2, 3, 4, 5, 6, 7].map((offset) => nightlyOn(dayOf(-offset)));
      const result = retention([old, ...others], {NIGHTLY_TAG: old});
      assert.equal(result.status, 0, result.output);
      assert.ok(!deletions(result.calls).some((call) => call.endsWith(old)), result.calls);
      // Equal dates: the tag of the run sorts newest, so the other version of the same day is the older one.
      const sameDay = [nightlyOn(today, '0.2.0'), nightlyOn(today, '0.3.0')];
      const fiveOlder = [1, 2, 3, 4, 5].map((offset) => nightlyOn(dayOf(-offset)));
      assert.deepEqual(retention([...sameDay, ...fiveOlder], {NIGHTLY_TAG: sameDay[1]}).calls, '');
      // One too many: the oldest goes, whichever of the two tags of today is the run's.
      for (const own of sameDay) {
        const tie = retention([...sameDay, ...fiveOlder, nightlyOn(dayOf(-6))], {NIGHTLY_TAG: own});
        assert.deepEqual(deletions(tie.calls), [`git/refs/tags/${nightlyOn(dayOf(-6))}`]);
      }
    });

    test('counts the tag of the run as the newest of its day, so the other tag of that day is the one that goes', () => {
      // Keeping one of two tags of today: the run's own tag must sort last. A sort that put it first
      // would keep the other tag and delete nothing (the explicit guard only protects the own tag).
      const sameDay = [nightlyOn(today, '0.2.0'), nightlyOn(today, '0.3.0')];
      for (const own of sameDay) {
        const other = sameDay.find((tag) => tag !== own);
        assert.deepEqual(deletions(retention(sameDay, {NIGHTLY_TAG: own, NIGHTLY_KEEP: '1'}).calls), [`git/refs/tags/${other}`]);
      }
    });

    test('ignores a date that is not a real calendar date: never deleted, never counted', () => {
      const invalid = ['v0.2.0-nightly.20261399', 'v0.2.0-nightly.20260230', 'v0.2.0-nightly.00000000', 'v0.2.0-nightly.20261100'];
      const real = [0, 1, 2, 3, 4, 5, 6].map((offset) => nightlyOn(dayOf(-offset)));
      const result = retention([...invalid, ...real]);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls, '');
      assert.match(result.output, /::warning::v0\.2\.0-nightly\.20261399 has no valid calendar date/);
      const eight = retention([...invalid, ...real, nightlyOn(dayOf(-7))]);
      assert.deepEqual(deletions(eight.calls), [`git/refs/tags/${nightlyOn(dayOf(-7))}`]);
    });

    test('works with no nightly tag at all, and with only the nightly of the run', () => {
      for (const tags of [[], ['v0.1.0'], [nightlyOn(today)]]) {
        const result = retention(tags);
        assert.equal(result.status, 0, result.output);
        assert.equal(result.calls, '');
        assert.doesNotMatch(result.output, /::warning::/);
      }
    });

    test('keeps the cap of three deletions with many old nightlies and a future one among them', () => {
      const old = Array.from({length: 10}, (_, index) => nightlyOn(`202001${String(index + 1).padStart(2, '0')}`));
      const result = retention([...old, nightlyOn('20991231'), nightlyOn(today)]);
      assert.deepEqual(deletions(result.calls), old.slice(0, 3).map((tag) => `git/refs/tags/${tag}`));
      assert.match(result.summary, /Deletion cap of 3 reached/);
    });

    test('stops before any deletion, with a warning and a success status, when the releases cannot be listed', () => {
      const result = run(script, fixtures({tags: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(nightly), releasesFail: true}));
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls, '');
      assert.match(result.output, /::warning::the retention of old nightlies stopped at line \d+/);
    });

    test('a deletion that fails ends the step with a warning after the deletions already made, and no retry', () => {
      const fix = fixtures({tags: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(nightly), releases: [1, 2].map((day) => ({tag: nightly(day), id: 100 + day}))});
      // A gh that refuses the deletion of the second release, in front of the recording one.
      const failing = fs.readFileSync(path.join(scratch(), 'bin', 'gh'), 'utf8').replace('case "$args" in\n', 'case "$args" in\n  *"-X DELETE"*"releases/102"*) echo "gh: Forbidden (HTTP 403)" >&2; exit 1 ;;\n');
      fs.mkdirSync(path.join(fix, 'bin'));
      fs.writeFileSync(path.join(fix, 'bin', 'gh'), failing, {mode: 0o755});
      const result = run(script, fix, {PATH: `${path.join(fix, 'bin')}:${path.join(scratch(), 'bin')}:${process.env.PATH ?? ''}`});
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(deletions(result.calls), ['releases/101', `git/refs/tags/${nightly(1)}`]);
      assert.match(result.output, /::warning::the retention of old nightlies stopped/);
    });
  });

  describe('the refusal of a tag deletion', () => {
    test('does not stall the rest of the cleanup: a refused tag is a warning and the next nightly is still removed', () => {
      const days = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const day = (n: number) => `v0.2.0-nightly.202611${String(n).padStart(2, '0')}`;
      const fix = fixtures({tags: days.map(day), releases: [1, 2].map((n) => ({tag: day(n), id: 100 + n}))});
      const failing = fs.readFileSync(path.join(scratch(), 'bin', 'gh'), 'utf8').replace('case "$args" in\n', `case "$args" in\n  *"-X DELETE"*"git/refs/tags/${day(1)}"*) echo "gh: Forbidden (HTTP 403)" >&2; exit 1 ;;\n`);
      fs.mkdirSync(path.join(fix, 'bin'));
      fs.writeFileSync(path.join(fix, 'bin', 'gh'), failing, {mode: 0o755});
      const result = run(stepScript(text, /Oldest first by date/), fix, {PATH: `${path.join(fix, 'bin')}:${path.join(scratch(), 'bin')}:${process.env.PATH ?? ''}`});
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, new RegExp(`::warning::the tag ${day(1)} could not be deleted`));
      assert.doesNotMatch(result.output, /retention of old nightlies stopped/);
      const done = result.calls.trim().split('\n').map((call) => call.replace('api -X DELETE repos/Session-Mesh/session-mesh/', '').replace(' --silent', ''));
      assert.deepEqual(done, ['releases/101', 'releases/102', `git/refs/tags/${day(2)}`]);
    });
  });

  describe('the tag step', () => {
    const script = stepScript(text, /Subjects are data/);

    test('creates the annotated tag, then its ref, and writes the warning in the tag message', () => {
      const fix = fixtures();
      const result = run(script, fix, {NIGHTLY_TAG: 'v0.2.0-nightly.20261118', PREVIOUS_SHA: PREVIOUS, TAG_OBJECT: 'd'.repeat(40)});
      assert.equal(result.status, 0, result.output);
      const calls = result.calls.trim().split('\n');
      assert.equal(calls.length, 2);
      assert.match(calls[0], /-X POST repos\/Session-Mesh\/session-mesh\/git\/tags -f tag=v0\.2\.0-nightly\.20261118 -F message=@\S+ -f object=a{40} -f type=commit/);
      assert.match(calls[1], new RegExp(`-X POST repos/Session-Mesh/session-mesh/git/refs -f ref=refs/tags/v0\\.2\\.0-nightly\\.20261118 -f sha=${'d'.repeat(40)}`));
      assert.match(fs.readFileSync(path.join(fix, 'message.md'), 'utf8'), /untested-by-users build of the next version/);
    });

    test('creates nothing for an orphan tag that is started again, and keeps it as it is', () => {
      const result = run(script, fixtures(), {NIGHTLY_TAG: 'v0.2.0-nightly.20261118', PREVIOUS_SHA: '', REDISPATCH: 'true'});
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls, '');
      assert.match(result.summary, /orphan tag v0\.2\.0-nightly\.20261118 is kept as it is/);
    });

    test('refuses a name that is not a nightly tag, before any call', () => {
      for (const tag of ['v0.2.0', 'v0.2.0-nightly.2026', 'v0.2.0-rc.1', 'main']) {
        for (const redispatch of ['false', 'true']) {
          const result = run(script, fixtures(), {NIGHTLY_TAG: tag, PREVIOUS_SHA: '', REDISPATCH: redispatch});
          assert.notEqual(result.status, 0, tag);
          assert.equal(result.calls, '', tag);
        }
      }
    });
  });

  describe('the start of release.yml', () => {
    test('runs on the nightly tag, as the step before the retention', () => {
      const script = stepScript(text, /gh workflow run release\.yml/);
      const result = run(script, fixtures(), {NIGHTLY_TAG: 'v0.2.0-nightly.20261118'});
      assert.equal(result.status, 0, result.output);
      assert.equal(result.calls.trim(), 'workflow run release.yml --ref v0.2.0-nightly.20261118');
    });
  });
});

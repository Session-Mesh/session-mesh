// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The decision job of nightly.yml (the check gate, the tag name and the orphan handling), run with a
// recording gh in place of the real one. Helpers: tests/nightly-test-scripts.ts.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {type Fixtures, stepScript, text, useScriptHarness} from './nightly-test-scripts.ts';

describe('the scripts of nightly.yml and of the release tag job, run with a recording gh', () => {
  const {PREVIOUS, SHA, today, checkRun, green, without, fixtures, run} = useScriptHarness();

  describe('the decision job', () => {
    const script = stepScript(text, /Decide whether|decide\(\)|skip\(\) \{/);
    // The decision job has a read-only token: it cannot list draft releases.
    const decide = (options: Fixtures = {}) => run(script, fixtures(options), {HIDE_DRAFTS: '1'});
    const released = (...days: string[]) => days.map((day, index) => ({tag: `v0.2.0-nightly.${day}`, id: 10 + index}));
    const nightlyToday = `v0.2.0-nightly.${today}`;

    test('publishes the first nightly of a green main, one minor after the latest stable release', () => {
      const result = decide();
      assert.equal(result.status, 0, result.output);
      assert.equal(result.outputs, `publish=true\ntag=v0.2.0-nightly.${today}\nprevious=\nredispatch=false\n`);
    });

    test('takes the next minor as a number: 0.9 gives 0.10', () => {
      assert.match(decide({latest: 'v0.9.4'}).outputs, new RegExp(`tag=v0\\.10\\.0-nightly\\.${today}\\n`));
    });

    test('reads the commit of the newest nightly tag, by date, as the previous nightly', () => {
      // One distinct commit per tag: the answer names the tag that was asked for.
      const result = decide({tags: ['v0.1.0', 'v0.2.0-nightly.20200101', 'v0.2.0-nightly.20200103', 'v0.2.0-nightly.20200102'],
        releases: released('20200101', '20200102', '20200103'),
        commits: {'v0.2.0-nightly.20200101': '1'.repeat(40), 'v0.2.0-nightly.20200102': '2'.repeat(40), 'v0.2.0-nightly.20200103': '3'.repeat(40)}});
      assert.match(result.outputs, new RegExp(`previous=${'3'.repeat(40)}\\n`));
    });

    test('ignores a future-dated or calendar-invalid nightly tag when it looks for the previous nightly', () => {
      // previous is main's head here: a tag that counted would make the run skip as "main has not moved".
      for (const tag of ['v0.2.0-nightly.99991231', 'v0.2.0-nightly.20260230', 'v0.2.0-nightly.00000000']) {
        const result = decide({tags: [tag], previous: SHA});
        assert.equal(result.status, 0, result.output);
        assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=false\n`, tag);
      }
      const real = decide({tags: ['v0.2.0-nightly.99991231', 'v0.2.0-nightly.20200101'], releases: released('20200101'), previous: SHA});
      assert.match(real.summary, /main has not moved since v0\.2\.0-nightly\.20200101/);
    });

    const notGreen = (label: string, pages: object[][]) => {
      const result = decide({pages});
      assert.equal(result.status, 0, label);
      assert.equal(result.outputs, 'publish=false\n', label);
      assert.match(result.summary, /Nightly skipped: CI is not green/, label);
      return result;
    };

    test('does nothing, and says so, when a required check is red, still running or missing', () => {
      notGreen('red', [green.map((entry) => (entry.name === 'cla' ? checkRun('cla', 'completed', 'failure') : entry))]);
      notGreen('running', [green.map((entry) => (entry.name === 'frontend and Node tests' ? checkRun(entry.name, 'in_progress', null) : entry))]);
      assert.match(notGreen('missing', [without('browser tests (Chromium, shard 3 of 4)')]).summary, /shard 3 of 4\): no run yet/);
    });

    test('fails closed on a neutral, skipped, cancelled or queued run', () => {
      for (const [status, conclusion] of [['completed', 'neutral'], ['completed', 'skipped'], ['completed', 'cancelled'], ['completed', 'timed_out'], ['queued', null]] as const) {
        notGreen(`${status}/${conclusion}`, [green.map((entry) => (entry.name === 'leak check (public rules)' ? checkRun(entry.name, status, conclusion) : entry))]);
      }
    });

    test('a failure is not masked by a second run of the same check on the same commit, whatever the order', () => {
      // A second suite of public-ci.yml (a manual run on main) or a rerun: the failure stays decisive.
      notGreen('success then failure', [[checkRun('cla'), checkRun('cla', 'completed', 'failure'), ...without('cla')]]);
      notGreen('failure then success', [[checkRun('cla', 'completed', 'failure'), checkRun('cla'), ...without('cla')]]);
      notGreen('success then running', [[checkRun('cla'), checkRun('cla', 'in_progress', null), ...without('cla')]]);
    });

    test('accepts several runs of a check when every one is successful', () => {
      assert.match(decide({pages: [[...green, checkRun('cla'), checkRun('cla')]]}).outputs, /^publish=true\n/);
    });

    test('counts only the check runs of the GitHub Actions app the ruleset requires', () => {
      const other = 999;
      // A failure of the required app is not hidden by a success of another app, nor the reverse.
      notGreen('other app success after failure', [[checkRun('cla', 'completed', 'failure'), checkRun('cla', 'completed', 'success', other), ...without('cla')]]);
      assert.match(decide({pages: [[checkRun('cla', 'completed', 'failure', other), ...green]]}).outputs, /^publish=true\n/);
      // A name that only another app reports does not count as a run.
      assert.match(notGreen('only another app', [[checkRun('cla', 'completed', 'success', other), ...without('cla')]]).summary, /cla: no run yet/);
    });

    test('reads every page of the check runs: a failure on a later page is seen (the stub gives page one only without --paginate)', () => {
      notGreen('failure on page 2', [green.slice(0, 5), [...green.slice(5), checkRun('browser tests (Chromium, shard 0 of 4)', 'completed', 'failure')]]);
      assert.match(decide({pages: [green.slice(0, 5), green.slice(5)]}).outputs, /^publish=true\n/);
    });

    test('asks for every check run of the commit (filter=all), so a re-run does not replace a failure', () => {
      const failed = [checkRun('cla', 'completed', 'failure'), ...without('cla')];
      // With the API default (filter=latest) the failure would be replaced by the re-run's success.
      const result = decide({pages: [failed], latestPages: [green]});
      assert.equal(result.outputs, 'publish=false\n', 'a request without filter=all would have published');
      assert.match(result.summary, /cla: not green: completed\/failure/);
      assert.match(result.queries, /check-runs\?filter=all&per_page=100/);
      assert.doesNotMatch(result.queries, /check-runs\?per_page/);
    });

    describe('an orphan tag of today', () => {
      const ORPHAN_COMMIT = 'c'.repeat(40);
      const orphan = (options: Fixtures = {}) => decide({tags: [nightlyToday], ...options});
      const refused = (label: string, options: Fixtures, reason: RegExp) => {
        const result = orphan(options);
        assert.equal(result.status, 0, `${label}: ${result.output}`);
        assert.equal(result.outputs, 'publish=false\n', label);
        assert.match(result.summary, reason, label);
        assert.match(result.summary, /not started again/, label);
        assert.equal(result.calls, '', label);
      };

      test('is started again when it is an annotated tag of github-actions[bot] on main\'s head', () => {
        assert.equal(orphan().outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=true\n`);
      });

      test('is started again when it points at an ancestor of main whose CI is green', () => {
        const result = orphan({tagObject: {sha: ORPHAN_COMMIT}, compare: 'ahead', tagChecks: [green]});
        assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=true\n`);
      });

      test('is refused when the CI of its own commit is red, missing or unfinished, though main\'s head is green', () => {
        const red = [checkRun('cla', 'completed', 'failure'), ...without('cla')];
        refused('red', {tagObject: {sha: ORPHAN_COMMIT}, compare: 'ahead', tagChecks: [red]}, /CI is not green on c{40}, the commit of the orphan tag .*cla: not green/);
        refused('missing', {tagObject: {sha: ORPHAN_COMMIT}, compare: 'ahead', tagChecks: [without('frontend and Node tests')]}, /frontend and Node tests: no run yet/);
        refused('running', {tagObject: {sha: ORPHAN_COMMIT}, compare: 'ahead', tagChecks: [[checkRun('cla', 'in_progress', null), ...without('cla')]]}, /cla: not green: in_progress/);
        refused('no run at all', {tagObject: {sha: ORPHAN_COMMIT}, compare: 'ahead', tagChecks: [[]]}, /cla: no run yet/);
      });

      test('is refused when it is a lightweight tag (its ref names a commit)', () => {
        refused('lightweight', {tagRef: {type: 'commit', sha: SHA}}, /is not an annotated tag \(commit\)/);
      });

      test('is refused when its tagger is not github-actions[bot], missing or lookalike', () => {
        for (const tagger of ['Some Contributor', 'github-actions', 'github-actions[bot] ', null]) {
          refused(`tagger ${tagger}`, {tagObject: {tagger}}, /was not created by github-actions\[bot\] \(tagger: /);
        }
      });

      test('is refused when the tag object names another tag or does not point at a commit', () => {
        refused('other name', {tagObject: {name: 'v0.2.0-nightly.20200101'}}, /tag object behind .* names v0\.2\.0-nightly\.20200101/);
        refused('tree', {tagObject: {type: 'tree'}}, /does not point at a commit/);
        refused('tag of tag', {tagObject: {type: 'tag'}}, /does not point at a commit/);
      });

      test('is refused when its commit is not main\'s head or an ancestor of it', () => {
        for (const status of ['diverged', 'behind']) {
          refused(status, {tagObject: {sha: ORPHAN_COMMIT}, compare: status, tagChecks: [green]}, new RegExp(`is not main's head or an ancestor of it \\(${status}\\)`));
        }
      });

      test('is refused when the ref, the tag object or the position cannot be read', () => {
        refused('ref', {tagRef: null}, /ref of the orphan tag .* cannot be read/);
        refused('object', {tagObject: null}, /tag object of .* cannot be read/);
        refused('compare', {tagObject: {sha: ORPHAN_COMMIT}, compare: null, tagChecks: [green]}, /position of c{40} against main cannot be read/);
      });
    });

    test('does nothing when main has not moved since the previous nightly', () => {
      const result = decide({tags: ['v0.2.0-nightly.20200101'], releases: released('20200101'), previous: SHA});
      assert.equal(result.outputs, 'publish=false\n');
      assert.match(result.summary, /main has not moved since v0\.2\.0-nightly\.20200101/);
    });

    describe('an orphan tag of an earlier day', () => {
      const ORPHAN = 'v0.2.0-nightly.20200102';
      const COMMITS = {'v0.2.0-nightly.20200101': PREVIOUS, [ORPHAN]: SHA};

      test('does not block the nightly when main has not moved: it is no previous nightly', () => {
        // The orphan names main's head; if it counted as the previous nightly the run would skip.
        const result = decide({tags: [ORPHAN], previous: SHA});
        assert.equal(result.status, 0, result.output);
        assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=false\n`);
        assert.match(result.summary, /Ignored v0\.2\.0-nightly\.20200102 as the previous nightly: it has no published release and no running release\.yml/);
        assert.equal(result.calls, '');
      });

      test('leaves the newest released nightly as the previous one, and does not start the orphan again', () => {
        const result = decide({tags: ['v0.2.0-nightly.20200101', ORPHAN], releases: released('20200101'), commits: COMMITS});
        assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=${PREVIOUS}\nredispatch=false\n`);
      });

      test('still counts as the previous nightly while release.yml is running on it', () => {
        const result = decide({tags: [ORPHAN], runs: [[ORPHAN, 'in_progress']], previous: SHA});
        assert.equal(result.outputs, 'publish=false\n');
        assert.match(result.summary, /main has not moved since v0\.2\.0-nightly\.20200102/);
      });
    });

    test('never overwrites: a nightly tag of today\'s date that has a published release ends the run', () => {
      const result = decide({tags: [nightlyToday], releases: [{tag: nightlyToday, id: 5}]});
      assert.equal(result.outputs, 'publish=false\n');
      assert.match(result.summary, /already released \(one nightly per UTC day/);
    });

    test('does not see a draft (read-only token): a tag of today with a draft only follows the orphan path', () => {
      // release.yml itself refuses to overwrite the draft; the retention step of start sees drafts.
      const result = decide({tags: [nightlyToday], releases: [{tag: nightlyToday, id: 5, draft: true}]});
      assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=true\n`);
      assert.doesNotMatch(result.summary, /already released/);
    });

    test('leaves a tag of today alone while release.yml is running on it', () => {
      for (const status of ['queued', 'in_progress', 'waiting']) {
        const result = decide({tags: [nightlyToday], runs: [[nightlyToday, status]]});
        assert.equal(result.outputs, 'publish=false\n', status);
        assert.match(result.summary, /release\.yml is still running on/, status);
      }
    });

    test('starts release.yml again on an orphan tag: no release and no running release.yml', () => {
      const result = decide({tags: [nightlyToday], runs: [['v0.1.9', 'in_progress'], ['main', 'completed']]});
      assert.equal(result.status, 0, result.output);
      assert.equal(result.outputs, `publish=true\ntag=${nightlyToday}\nprevious=\nredispatch=true\n`);
      assert.match(result.summary, /has no release and no running release\.yml \(0 earlier runs\)/);
    });

    test('starts an orphan again once after one failed run, and stops the loop after MAX_REDISPATCH runs', () => {
      assert.match(decide({tags: [nightlyToday], runs: [[nightlyToday, 'completed']]}).outputs, /^publish=true\n.*redispatch=true\n$/s);
      const stopped = decide({tags: [nightlyToday], runs: [[nightlyToday, 'completed'], [nightlyToday, 'completed']]});
      assert.equal(stopped.status, 0, stopped.output);
      assert.equal(stopped.outputs, 'publish=false\n');
      assert.match(stopped.summary, /already ran 2 times on it/);
      assert.match(stopped.output, /::warning::.*not started again/);
    });

    test('does not start anything when the releases cannot be read', () => {
      const result = decide({tags: [nightlyToday], releasesFail: true});
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.outputs, /publish=true/);
    });

    test('derives no version from a latest release that is not a stable tag', () => {
      const result = decide({latest: 'v0.2.0-rc.1'});
      assert.equal(result.outputs, 'publish=false\n');
      assert.match(result.summary, /not a stable release tag/);
    });
  });
});

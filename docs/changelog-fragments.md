# Changelog fragments

A pull request does not edit `CHANGELOG.md`. It adds one file under [`changelog.d/`](../changelog.d/)
that holds its changelog bullet, and the bullets are moved into `CHANGELOG.md` when a release is
cut. Two pull requests then never change the same lines, so merging one never makes the other
conflict in the "Unreleased" section.

The format of a fragment is in [changelog.d/README.md](../changelog.d/README.md). The tool is
`tools/changelog/changelog.ts`, run with Node's type stripping like the other tools of the
repository:

```sh
node --experimental-strip-types tools/changelog/changelog.ts check              # validate the fragments
node --experimental-strip-types tools/changelog/changelog.ts assemble           # the Unreleased text, fragments merged in
node --experimental-strip-types tools/changelog/changelog.ts cut 0.2.0 --dry-run # the CHANGELOG.md a cut would write
```

## In a pull request

- A change a user or an operator notices (a feature, a behaviour change, a fix, a security fix,
  user documentation) adds one fragment, `changelog.d/<number>-<slug>.md`. A pull request that
  makes several changes worth a bullet each adds one fragment per bullet, all with its number and
  different slugs (`412-idle-codex.md`, `412-idle-claude.md`): a fragment holds exactly one bullet.
- A change no user sees (tests, CI, internal documentation, a refactoring) adds none, and its
  description holds a line `Changelog: none: <reason>`, for example `Changelog: none: tests only`.
  The line counts only as rendered text: inside a fenced code block or an HTML comment it does not,
  and the template's placeholder `Changelog: none: <reason>` is refused.
- A fragment never needs rebasing: it is a new file of its own name.

### Moving an open pull request to a fragment

A pull request opened before fragments added its bullet to `CHANGELOG.md`. At its next rebase on
`main`:

1. Take `main`'s side of `CHANGELOG.md`: resolve the conflict that way, or run
   `git checkout origin/main -- CHANGELOG.md` after the rebase.
2. Move the bullet (or bullets) into `changelog.d/<number>-<slug>.md`, one bullet per file,
   re-wrapped to 100 columns with two-space continuation lines.
3. Run `npm run check:changelog`, then commit.

`tests/changelog-fragments.test.ts` fails on a bullet added by hand under "Unreleased" (it compares
the bold leads of that section with the list frozen when fragments were introduced), so a
pull request that skipped step 1 does not pass CI.

The Node tests of the `frontend and Node tests` job of `public-ci` validate every fragment present in the tree
(`tests/changelog-fragments.test.ts`), so a malformed fragment fails CI like any other test. The
rule "a fragment or `Changelog: none`" is checked by `changelog.ts check-pr`; it is not wired into
a workflow yet (see [Not done yet](#not-done-yet)).

## Kinds and order

The optional front matter `kind:` is one of `security`, `added`, `changed` (the default), `fixed`,
`docs` and `internal`. `assemble` and `cut` list the entries in that order of kinds, then by pull
request number, the fragments without a number last, then by file name. The kind is not printed:
the released section stays one flat list of bullets, as in the sections before the move to
fragments.

## The transition

The bullets that were already under "Unreleased" in `CHANGELOG.md` when fragments were introduced
stay there; nothing was converted. `assemble` prints the section's preamble, those bullets, then
the fragments, and `cut` moves both. Once the next minor release is cut, the "Unreleased" section
holds only its preamble, a fixed paragraph that points here.

`tests/changelog-fragments.test.ts` keeps it that way: the bold leads of the bullets under
"Unreleased" must be among those present when fragments were introduced (a list in the test, never
extended), the preamble must be the fixed paragraph, and a cut of every entry must leave the
preamble alone. A pull request that adds a bullet there by hand fails the Node tests of CI.

## Cutting a release

**A minor release (0.x.0) on `main`.** On a branch from `main`:

```sh
node --experimental-strip-types tools/changelog/changelog.ts cut 0.2.0 --intro "One-sentence summary."
```

It writes `## 0.2.0` right below the "Unreleased" section, with the intro paragraph, the bullets
that were under "Unreleased" and every fragment, and deletes the fragments it used. `--date
YYYY-MM-DD` writes `## 0.2.0 (YYYY-MM-DD)`; the existing headings have no date. The pull request
says `Changelog: none: release cut`.

**A patch release (0.x.y).** The backports of `semver: patch` pull requests bring their fragments
to `release/latest` as new files: a cherry-pick of an added file applies cleanly. The fragments of
the patch release are therefore exactly the files of `changelog.d/` on `release/latest`. On a
branch from `main`:

```sh
git fetch origin release/latest
node --experimental-strip-types tools/changelog/changelog.ts cut 0.1.2 \
  --only $(git ls-tree --name-only origin/release/latest:changelog.d | grep -vx README.md)
```

`--only` takes file names of `changelog.d/`, never paths (`changelog.d/12-fix.md` is refused, not
shortened), hence `release/latest:changelog.d`, which lists bare names. A version ends the list,
so `cut --only 12-fix.md 0.1.2` works as well. `--only` moves the named fragments alone; the
bullets under "Unreleased" on `main` belong to the next minor version and stay. The pull request
deletes those fragments and adds `## 0.1.2` right below the "Unreleased" section.

If a minor cut on `main` already deleted a fragment that `release/latest` still holds (a fix
backported before the minor cut, released in a patch after it), `cut` refuses its name as "not a
fragment of changelog.d/" and writes nothing. Restore it first with
`git checkout origin/release/latest -- changelog.d/<name>`, or cut the patch release before the
minor one.

`release/latest` then needs the same section and the same deletions. How depends on the line:

- **The 0.2 line and later** (`release/latest` made from a `main` that has the fragments and the
  "Unreleased" preamble): the changelog pull request to `main` is labelled `semver: patch` and
  backported like any fix (see
  [Backports to the maintenance branch](development.md#backports-to-the-maintenance-branch)). Its
  cherry-pick applies cleanly, because the lines around the insertion are the same on both
  branches, as long as `main`'s "Unreleased" section holds its preamble alone (the minor cut leaves
  it so, and `tests/changelog-fragments.test.ts` refuses new bullets there).
- **The 0.1 line** (`release/latest` from v0.1.0, which has no "Unreleased" section): the backport
  of the `CHANGELOG.md` hunk conflicts every time, since `main`'s side brings the whole
  "Unreleased" block. Two ways:
  - Backport and resolve: during the conflicted cherry-pick, keep `release/latest`'s
    `CHANGELOG.md` with `git checkout --ours CHANGELOG.md`, insert the new section right above
    `## 0.1.1` (the block printed by
    `git show <cut commit>:CHANGELOG.md | sed -n '/^## 0.1.2$/,/^## 0.1.1$/p' | sed '$d'`), then
    `git add CHANGELOG.md` and continue. The fragment deletions apply as they are.
  - Two pull requests, no backport: a pull request to `release/latest` that adds the section above
    `## 0.1.1` and deletes the same fragments, and the `cut --only` pull request to `main`, with no
    backport. This is how 0.1.1 was released (one commit on each branch, before fragments existed).

The tool is not on `release/latest` of the 0.1 line and is not needed there: the cut is made on
`main`.

`cut` refuses a version already in `CHANGELOG.md`, a cut with nothing to move, and any invalid
fragment, before writing anything.

**If `cut` cannot delete a fragment.** `cut` writes `CHANGELOG.md` first (an atomic rename), then
deletes the fragments it moved. If a deletion fails (a read-only `changelog.d/`, for example), it
deletes every other one, prints `CHANGELOG.md now has "## <version>", but <n> fragment(s) it moved
could not be deleted` with the list, and exits 1. The new section is complete; only those files
are left over. Recover by deleting exactly the files it names (the `rm` command it prints) and
nothing else. Do not run `cut` again first: the same version is refused as already present, and
another version would list those entries a second time. `git checkout -- CHANGELOG.md changelog.d`
also undoes the whole cut, to start again.

## Release notes

No workflow reads `CHANGELOG.md`: `release.yml` writes the release notes from the installation
facts, and a nightly's notes are the message of its tag (the commits since the previous nightly,
written by `nightly.yml`). The site (`site/tools/changelog-to-history.mjs`) reads the `## `
sections of `CHANGELOG.md` and the bold leads of their bullets, which `cut` keeps unchanged. So the
move to fragments changes no workflow.

## Not done yet

- **The `check-pr` rule in CI.** `changelog.ts check-pr --event <event file> --changes <file>`
  judges a pull request from its GitHub event and the list of files it changes. Running it means a
  step in a workflow, for example a warning-mode step in `pr-description.yml` first, made blocking
  later. It is not wired yet: the existing `semver label` job is a required check, and its
  merge-queue step runs the copy of its tool from the queue's base, which would not hold a new tool
  until this change is merged. A step that wires it:
  - Lists the changes from the merge base, three dots, with `BASE_SHA` and `HEAD_SHA` taken from
    `pull_request.base.sha` and `pull_request.head.sha` of the event:

    ```sh
    git diff --name-status --no-renames "$BASE_SHA"..."$HEAD_SHA" > changes.txt
    ```

    Never the two-dot form `"$BASE_SHA" "$HEAD_SHA"`: when `main` has cut a release since the
    branch was made, a two-dot diff lists every fragment the cut deleted as added by the pull
    request, and `check-pr` accepts a pull request without a fragment
    (`tests/changelog-pr-check.test.ts` shows both). The checkout needs the history down to the
    merge base (`fetch-depth: 0`, or a fetch of both commits deep enough).
  - Runs on the `pull_request` types `opened`, `edited`, `synchronize`, `reopened`, `labeled` and
    `unlabeled`: the labels and the description are read from the event, so a later edit of either
    is judged only by a new run.
  - Skips `merge_group` events: they carry no `pull_request`, and `check-pr` exits 2 on them,
    which would block the merge queue. The rule was judged on the pull request already.
  - Knows what the rule does not see: changing an existing fragment counts as having one, even a
    fragment of another pull request; a pull request without a `semver: patch` or `semver: minor`
    label is not judged (the `semver label` check deals with its label); a bot pull request needs
    the opt-out line or an exemption by label.
- **Fragments in the nightly notes.** `assemble --entries-only` prints the unreleased bullets; the
  nightly tag message could include them.

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
  user documentation) adds one fragment, `changelog.d/<number>-<slug>.md`.
- A change no user sees (tests, CI, internal documentation, a refactoring) adds none, and its
  description holds a line `Changelog: none: <reason>`, for example `Changelog: none: tests only`.
- A fragment never needs rebasing: it is a new file of its own name.

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
the patch release are therefore exactly the files of `changelog.d/` on `release/latest`. The
changelog pull request is still made to `main` and backported (see
[Backports to the maintenance branch](development.md#backports-to-the-maintenance-branch)). On a
branch from `main`:

```sh
git fetch origin release/latest
node --experimental-strip-types tools/changelog/changelog.ts cut 0.1.2 \
  --only $(git ls-tree --name-only origin/release/latest changelog.d/ | grep -v README.md)
```

`--only` moves the named fragments alone; the bullets under "Unreleased" on `main` belong to the
next minor version and stay. The pull request deletes those fragments and adds `## 0.1.2` right
below the "Unreleased" section; its backport deletes the same files on `release/latest` and adds
the same section there. The deletions always apply. The `CHANGELOG.md` hunk applies cleanly only
when the lines around the insertion are the same on both branches: `release/latest` of the 0.1
line has no "Unreleased" section, so on that line the hunk may conflict as it does today, and is
resolved by hand by keeping the new section right above `## 0.1.1`. The tool itself is not on
`release/latest` of the 0.1 line and is not needed there: the cut is made on `main`.

`cut` refuses a version already in `CHANGELOG.md`, a cut with nothing to move, and any invalid
fragment, before writing anything.

## Release notes

No workflow reads `CHANGELOG.md`: `release.yml` writes the release notes from the installation
facts, and a nightly's notes are the message of its tag (the commits since the previous nightly,
written by `nightly.yml`). The site (`site/tools/changelog-to-history.mjs`) reads the `## `
sections of `CHANGELOG.md` and the bold leads of their bullets, which `cut` keeps unchanged. So the
move to fragments changes no workflow.

## Not done yet

- **The `check-pr` rule in CI.** `changelog.ts check-pr --event <event file> --changes <file>`
  judges a pull request from its GitHub event and `git diff --name-status --no-renames <base>
  <head>`. Running it means a step in a workflow, for example a warning-mode step in
  `pr-description.yml` first, made blocking later. It is not wired yet: the existing
  `semver label` job is a required check, and its merge-queue step runs the copy of its tool from
  the queue's base, which would not hold a new tool until this change is merged.
- **Fragments in the nightly notes.** `assemble --entries-only` prints the unreleased bullets; the
  nightly tag message could include them.

# Development and tests

This page is for contributors: how to run the test suite locally and what it needs on a fresh
machine. The rules for contributions (languages, commits, the CLA) are in
[CONTRIBUTING.md](../CONTRIBUTING.md); a development install from a clone is in
[install.md](install.md#other-ways-to-install).

## Running the suite

`scripts/test-local.sh` runs the complete local suite: the OCaml build and its tests (which
installs the native PTY host that the other tests start), frontend checks, Node tests, `ruff`, the
Python suite including browser tests, then the gate of the native PTY host. The tests that start
the host take it from `MESH_PTYHOST_CMD` (the absolute path of the executable, nothing else), else
`mesh-ptyhost` on `PATH`, and fail with a message naming both when neither exists; to run `pytest`
or the Node tests by hand, point it at a build:
`MESH_PTYHOST_CMD="$PWD/ocaml/_build/default/bin/mesh_ptyhost_main.exe"`
([CONTRIBUTING.md](../CONTRIBUTING.md#which-pty-host-the-tests-run) has the rules).

```sh
scripts/test-local.sh --preflight-only   # checks prerequisites only
scripts/test-local.sh                    # everything
scripts/test-local.sh -k menu            # extra arguments go to pytest
```

It needs Node 22.13+ or 24+, npm, git, opam, Python 3 and bubblewrap. It uses `MESH_PYTHON`,
otherwise a `.venv/` it creates with `python3` from `requirements-dev.txt` and
`requirements-browser.txt`. That `python3` must be Python 3.10 to 3.14, the versions the pinned
packages install on; with another, the script stops and shows how to create `.venv` with a
supported one (for example `python3.14`). A `.venv` is ready once the packages are installed in
it (the script then writes `.venv/.test-local-installed`); one without that file, whose install
failed or that you made by hand, is completed by the next run once you fix the cause. Browser
tests use `MESH_CHROMIUM`, otherwise the newest Playwright Chromium in `~/.cache/ms-playwright`,
installed if missing. OCaml uses `MESH_OPAM_SWITCH`, otherwise the current switch, which must use
OCaml 5.3 and read only the opam repository commit of `scripts/release-pins.sh` (a missing switch is
created that way; see [Native PTY host](install.md#native-pty-host) for an existing one).
`scripts/bootstrap.sh` takes its dependencies from that commit, except `mcp-kit`, pinned to a public
source revision until a release has the API it needs.

On macOS the script runs with the system bash 3.2 and needs no bubblewrap: there the demo compiler
launcher refuses to run, and its tests check that refusal ([bubblewrap](#bubblewrap-and-ubuntu-2404)).
Its Playwright Chromium goes to `~/.cache/ms-playwright` there too, where the tests look for it.
The test sockets need a short temporary directory: when `TMPDIR` is unset or is the default per-user
directory under `/var/folders`, the script uses `/private/tmp` instead; another `TMPDIR` is kept.
The script creates `.venv/` with the `python3` on your `PATH`, which on macOS can be the system
Python 3.9 or a Homebrew Python newer than the pinned test packages support. Before the first run,
check `python3 --version`, or create `.venv/` with Homebrew's `python@3.14` yourself:
`python3.14 -m venv .venv && .venv/bin/python -m pip install -r requirements-dev.txt -r requirements-browser.txt`.

The public CI (`.github/workflows/public-ci.yml`) runs the same suite in parallel jobs, plus a leak
check of the tree and, on pull requests, the contributor license agreement check `cla`
([CONTRIBUTING.md](../CONTRIBUTING.md#the-cla-check-blocks-the-merge)).

The suite runs with any recent git. The optional local leak-check hooks
([tools/leak-guard/README.md](../tools/leak-guard/README.md#hooks)) need **Git 2.54 or later**: with
an older git, such as the 2.43 of Ubuntu 24.04, `hooks install` refuses and says so, and the tests
that need git to run those hooks are reported as skipped with that reason. The hooks are optional
for contributors. The CI leak check scans the files of your pull request, not its commit messages
or identities.

## Test tools on a fresh machine

| Distribution | Command |
|---|---|
| Debian, Ubuntu | `sudo apt update && sudo apt install git curl python3 python3-venv bubblewrap opam build-essential libgmp-dev libsqlite3-dev pkg-config` |
| Fedora | `sudo dnf install git curl python3 nodejs npm bubblewrap opam gcc make gmp-devel pkgconf-pkg-config` |
| Arch | `sudo pacman -S git curl python nodejs npm bubblewrap opam base-devel gmp pkgconf` |
| macOS (Homebrew) | `xcode-select --install`, then `brew install opam node gmp pkgconf sqlite python@3.14` |

- **Node.** Ubuntu 24.04 and Debian 12 package Node 18, too old: install Node 24 from
  [nodejs.org](https://nodejs.org/en/download) (prebuilt binary, nvm or the NodeSource packages),
  which includes npm. Check that `node --version` prints 22.13 or later.
- **OCaml.** `scripts/bootstrap.sh` needs the GMP headers and `pkg-config` from the system for one
  OCaml dependency, `zarith` (opam packages `conf-gmp` and `conf-pkg-config`): without them, opam
  stops there. After installing opam, run `opam init`; the bootstrap creates the 5.3 switch named
  as in [Native PTY host](install.md#native-pty-host).
- **Chromium for the browser tests.** Playwright downloads its own Chromium, but the system
  libraries it needs come from your distribution. On Debian and Ubuntu, after a first run has
  created `.venv/`, install them with `sudo .venv/bin/python -m playwright install-deps chromium`.
  Elsewhere, see [the Playwright system requirements](https://playwright.dev/python/docs/browsers#install-system-dependencies).

## bubblewrap and Ubuntu 24.04

The demo compiler test runs `scripts/compile-demo-tsx.sh`, which compiles a TSX source inside a
bubblewrap sandbox with its own user and network namespaces
([demo-compiler/README.md](../demo-compiler/README.md)). Only the tests use it: the installed
service never calls the demo compiler. The launcher runs `node` from your `PATH`, or the absolute
path in `MESH_NODE`.

Ubuntu 24.04 forbids unprivileged user namespaces to programs without an AppArmor profile that
allows them (`kernel.apparmor_restrict_unprivileged_userns=1`), and bubblewrap then fails with
`loopback: Failed RTM_NEWADDR: Operation not permitted`. `scripts/test-local.sh --preflight-only`
detects it. Two ways out, narrowest first:

1. **An AppArmor profile for bubblewrap only.** Ubuntu ships one as an extra profile: it lets
   `/usr/bin/bwrap` create the namespaces and runs the sandboxed program without any capability.

   ```sh
   sudo apt install apparmor-profiles
   sudo cp /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/
   sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
   ```

   Every local program can still use bubblewrap to obtain a namespace, but without capabilities
   inside it. On Ubuntu 24.04.5 this was enough for the preflight and the complete suite; if the
   preflight still fails, use the second way.
2. **Lift the restriction for the whole machine**, until the next boot:
   `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. Every program regains
   unprivileged user namespaces, which is the kernel attack surface Ubuntu closed. Prefer a
   development machine or VM, and do not make it permanent on a machine you share.

opam's own build sandbox also uses bubblewrap, so the same restriction can stop `opam switch create`;
the same two ways apply.

## Backports to the maintenance branch

For maintainers. The rules for contributors (target `main`, the `semver:` labels, `release/latest`)
are in [CONTRIBUTING.md](../CONTRIBUTING.md#branches-and-versions). Four workflows implement
them: `branch-policy.yml` (the checks `semver label` and `release branch guard`, from
`tools/branch-policy/branch-policy.ts`), `backport.yml` (the cherry-pick and the pull request to
`release/latest`), `backport-register.yml` (the CLA register files of any other merged pull
request, alone) and `release.yml` (a tag on `release/latest` is accepted).
`tests/backport-workflow.test.ts`, `tests/backport-register-workflow.test.ts` and
`tests/branch-policy.test.ts` keep their safety rules; `tests/backport-register-replay.test.ts`
runs the register script on a repository and checks that the `cla` check accepts its result.

**Limits of the register backport.** It replays the commits that "Rebase and merge" landed on
`main`, found from the merge commit id and the commit count of the event, and checks first that
their authors and author dates are those of the pull request's commits: a pull request merged
another way is refused, and its register files are backported by hand. A rename into a register
path brings its new content and a rename out of one deletes it; the job also refuses a result that
changes any other path (a directory named like a register file, for example) or leaves a register
path as a symbolic link or a submodule, in any replayed commit and not only in the final tree. A
rerun after a push whose pull request was not opened reuses the pushed branch when it is the same
replay and stops on any other branch of that name, never force-pushing over it. Each replayed
commit keeps its author, because the `cla` check accepts a signatory line only from a commit
authored with its address: a backport by hand does the same, for example with
`git diff <commit>^ <commit> -- <register files> | git apply --index` then
`git commit --reuse-message=<commit>` for each commit. Register changes merged to `main` before
`backport-register.yml` existed may not be on `release/latest`: compare the two branches on the
register files first (`git diff origin/release/latest origin/main -- <register files>`; an earlier
`semver: patch` backport, or the cut itself, may already have carried some of them) and replay
only what is missing.

**The replay rule and its refusals.** The workflow replays the landed commits that change a register
file onto `release/latest` by plain patches, as the first version did, and compares whole files, never
lines. For each register file that a landed commit changed, two exact comparisons (mode and blob id)
must hold, and any failure stops the job:

1. before the replay, the file on `release/latest` is the file that `main` held before the range (at
   the parent of the oldest landed commit);
2. after the replay, the file is the file of `main` now.

On a failure the job posts a comment on the original pull request naming the file, pushes nothing and
fails. The cases it refuses:

- a line, a revocation or a duplicated line that only `release/latest` holds (rule 1), including one
  that the commits would add, remove and add again (a net change of another line, or `-Nora/+Nora`
  from a pull request that merely moves a maintainer): nothing is explained away, nothing is erased or
  reinstated;
- a change of an earlier pull request not yet backported (rule 1), or of a later one already on `main`
  (rule 2);
- a removal whose line `release/latest` lacks, because the pull request that adds it is not backported
  yet: the replayed removal is a no-op ("already has"), the file differs from what `main` held, and the
  later backport of the addition would bring a line that `main` no longer has (rules 1 and 2);
- a patch that does not apply (its own comment), a commit of the pull request that cannot be fetched or
  whose change differs from its landed commit (patch id), a mode that only `release/latest` changed (a
  mode change made on `main` is replayed like any other change), a path that is not a regular file. A
  git error while comparing fails the job and is never read as "equal". A rerun after the backport has
  merged also fails, with a comment that reads as drift: the addition is already there.

A register file that no landed commit changed is not compared, so a difference there stays as it is.

**The workflow no longer self-heals a drifted register.** An earlier version brought the touched files
to their state on `main` when the difference was explained by the range. Three reviews each found a
case where that judgement was wrong, so it was removed: when `release/latest` and `main` differ in a
register file for any reason other than the commits being backported, a human resolves it.

Manual path after a refusal: compare `git diff origin/release/latest origin/main -- <file>` and decide
for each differing line whether `release/latest` or `main` is right; backport the pull request by hand
as described below (a pull request to `release/latest` with only the register paths, each commit with
its author, the label `semver: patch` and the line `Backport of #<number>`), and backport first any
earlier pull request that the refusal pointed at. Backports of two pull requests that touch the same
file in close succession are refused until the earlier one is merged to `release/latest`; rerun the
workflow of the later one then, or backport by hand.

Two cases are left to a maintainer. A pull request that lists 3000 files (the most the API returns)
fails the read-only job with an explicit message, because its list may be cut: backport its
register files by hand. If `release/latest` advances between the push of the backport branch and a
rerun that must open its pull request, the rerun stops with an explicit error, because the saved
branch is no longer a straight line on the current base and an old base would fail the CLA
ancestry check: delete that branch (it holds only a replay) or rebase it by hand, then rerun the
workflow; the workflow never force-pushes. The release guard reads the labels from the event
payload of its run: if a held run was approved before the label `semver: patch` was on the pull
request and the guard fails for a missing label, remove and re-apply the label to run it again.

When the patch does not apply (the same register line changed differently on `main` and on
`release/latest`), finish the backport by hand: create a branch from `origin/release/latest`; run
`git apply --3way --index` and resolve the conflict in the register file; stage only the intended
register paths (`git add -- <register files>`, never `git add -A`) and check with
`git diff --cached --name-only` that nothing else is staged; then commit with the original message
and author, `git commit --reuse-message=<commit>` (it keeps the author of `<commit>`; do not use
`--reset-author`). Repeat for each commit that changes a register file, in order, and open a pull
request to `release/latest` with the label `semver: patch` and the line `Backport of #<number>`.

The maintenance branch is a single moving branch, `release/latest`. It points at the current minor
line: today the tag `v0.1.0`, so it receives the 0.1.x patches. Tags (`v0.1.0`, `v0.1.1`, ...) are
immutable; only the branch moves, at each new minor release (see "At each new minor release").

**One-time setup of the backport workflow.**

1. Register a GitHub App owned by the organisation, without webhook, with the repository
   permissions Contents and Pull requests set to read and write, and Workflows too if backports may
   change `.github/workflows`; install it on this repository only.
2. Store its numeric App ID as the repository secret `BACKPORT_APP_ID` and a generated private key
   as `BACKPORT_APP_PRIVATE_KEY`. With them, the backport pull request is opened by the App and
   its CI starts. Without them the workflow uses the run's own token: the pull request is opened
   and its CI does not start by itself. On a register backport (`backport-register.yml`) GitHub
   holds the workflow runs until they are approved, and a comment on the pull request asks a
   maintainer with write access to select "Approve workflows to run"; closing and reopening it is
   not needed. `backport.yml` gives the same instruction. That fallback also needs the repository setting "Allow GitHub Actions to create
   and approve pull requests" (Settings, Actions, General, Workflow permissions) to be on: while it
   is off, the run's token cannot open the pull request at all, and the GitHub App is required.
3. The workflow runs on `pull_request_target`, which GitHub blocks on public repositories from
   2026-12-02 unless an Actions policy allows it: add a policy for `.github/workflows/backport.yml`
   and `.github/workflows/backport-register.yml` that allows `pull_request_target`.
4. Put the workflows on `release/latest` before anything is required of it. A workflow of a
   pull request runs as it is in the merge of the pull request into its base branch, and a tag
   push runs the workflow of the tagged commit, so a maintenance branch cut before these workflows
   existed has none of them: the first backport pull request would get no CI, no `semver label` and
   no `release branch guard`, and a tag on it would not build. A maintainer who may push to the
   branch cherry-picks onto `release/latest` the commits that add or change `branch-policy.yml`,
   `public-ci.yml`, `release.yml` and the files they run (`tools/branch-policy`, `tools/cla-check`,
   the scripts under `scripts/` and `.github/scripts/` that they call). This cannot go through a
   normal pull request: the `release branch guard` refuses a pull request that is not a backport.
   `backport.yml` and `backport-register.yml` stay on `main`: they run on `pull_request_target`,
   which reads the workflow of the base branch of the merged pull request, `main`. The release
   branch guard of a register backport runs `tools/branch-policy/branch-policy.ts` as it is on
   `release/latest`: until the version that accepts a register-only backport is there, it refuses
   one whose source is not `semver: patch`.
5. Only then add the checks `semver label` and `release branch guard` to the required checks of
   `main`, and the same two, `cla` and the CI jobs to those of `release/**`.

**One-time migration from `release/0.1`.** If the maintenance branch exists under the name
`release/0.1`, the owner renames it to `release/latest` (Settings, Branches, or the branch rename
of the GitHub API). A GitHub rename keeps the branch protection rules that name it, and retargets
the open pull requests; it does not touch the tags. Do it once, at the merge of the pull request
that introduces `release/latest`, then do step 4 above if the workflows are not on the branch yet.

**Safety of `pull_request_target`.** The job checks out the base branch, never the pull request,
runs none of its code, reads only booleans, the number and label names of the event, and gives a
write token to a third-party action pinned by commit SHA (`korthout/backport-action`).
The action also adds, by default, a target branch for every label of the merged pull request that
matches `backport <branch>`; the workflow sets `label_pattern: ""` so that `release/latest` is the
only target, and `tests/backport-workflow.test.ts` requires that empty value.
The cherry-picked commits keep their authors; their committer is `GitHub <noreply@github.com>`,
which the `cla` job accepts. The `release branch guard` only checks that the description points
to a merged `semver: patch` pull request: the review of the backport pull request is what checks
that the changes are the same.

**Cutting a patch release (0.x.y).** The changelog entry of the release is prepared as a pull
request to `main`, labelled `semver: patch`, that adds the heading of the release and its entries
to `CHANGELOG.md` and nothing else: merged to `main`, it is backported to `release/latest` like any
fix. If its cherry-pick conflicts (the `main` changelog may carry entries of the next minor
version above the release heading), the workflow comments with the commands to do it by hand:
resolve it so that `release/latest` only holds the entries of its own line. Then:

1. Merge the backports of the fixes, and the backport of the changelog pull request.
2. Tag the tip of `release/latest` `v0.x.y` (a tag of a commit that `release/latest` holds):
   `release.yml` publishes it, and as a version older than the latest release it is not marked
   latest once a newer minor exists.
3. Add the release to `site/releases.json` by a pull request to `main` labelled `semver: minor`:
   the site is deployed from `main` only, and is not backported. The changelog heading is on `main`
   already, from the first step.

**At each new minor release (v0.2.0, ...).** `release/latest` moves to the new minor line; the
previous line is then no longer maintained (no more backports to it, no more 0.1.x tags).
This is an owner action, a reset of a protected branch:

1. Before moving it, wait for or close the open backport pull requests (pull requests whose base
   is `release/latest`): after the move their commits would sit on the wrong line.
2. Tag the new minor version `v0.2.0` on `main` (the tag job accepts a commit of `main`); the tag
   is immutable and stays where it is.
3. Move `release/latest` to that tag's commit. GitHub's web interface cannot reset a branch to
   an earlier or unrelated commit, and the protection rule forbids force pushes: the owner
   allows force pushes on the rule of `release/**` for themselves only, runs
   `gh api -X PATCH repos/Session-Mesh/session-mesh/git/refs/heads/release/latest -f sha=<commit of v0.2.0> -F force=true`,
   then turns the force push permission off again. The required checks and the other
   rules of the branch stay as they are.
4. Check that `release/latest` and `v0.2.0` name the same commit. From here on, the backports
   go to the 0.2.x line, and the 0.2.y patches are tagged on `release/latest`.

## Languages

The web server is written in Python, but no new Python is accepted: the project is converging on
OCaml on the server side, where the native PTY host and the MCP servers already are, and on
TypeScript in the browser and the tests. New code is written in those two languages, and the Python
modules are replaced over time ([CONTRIBUTING.md](../CONTRIBUTING.md#no-new-python)).

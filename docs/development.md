# Development and tests

This page is for contributors: how to run the test suite locally and what it needs on a fresh
machine. The rules for contributions (languages, commits, the CLA) are in
[CONTRIBUTING.md](../CONTRIBUTING.md); a development install from a clone is in
[install.md](install.md#other-ways-to-install).

## Running the suite

`tests/historical-snapshot-migration.test.ts` optionally exercises real historical Linux x86-64
source releases and their PTY host binaries against the current web source and a selected native
host. Place the source archives for `v0.1.1` and `v0.2.0-nightly.20261124`, and the former's
`mesh-ptyhost-linux-x86_64`, in a scratch artifact directory; place the latter host under its
`nightly-20261124/` subdirectory. The test verifies pinned SHA-256 hashes before extraction.
Set `MESH_HISTORICAL_ARTIFACTS` to that directory, `MESH_PTYHOST_CMD` to the candidate binary,
and `MESH_REQUIRE_HISTORICAL_MIGRATION=1` to make missing inputs fail instead of skip. Optionally
set `MESH_CANDIDATE_PTYHOST_SHA256` to bind the candidate binary to a known digest. Run with
`node --experimental-strip-types --test tests/historical-snapshot-migration.test.ts`.
Each case uses a disposable home and checks two shell sessions, unavailable-host snapshot
preservation, restoration offers and successful restore. This does not qualify account profiles,
real agent credentials, the release installer or rollback.

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
| Debian, Ubuntu | `sudo apt update && sudo apt install git curl python3 python3-venv bubblewrap opam build-essential libgmp-dev libsqlite3-dev pkg-config jq` |
| Fedora | `sudo dnf install git curl python3 nodejs npm bubblewrap opam gcc make gmp-devel pkgconf-pkg-config jq` |
| Arch | `sudo pacman -S git curl python nodejs npm bubblewrap opam base-devel gmp pkgconf jq` |
| macOS (Homebrew) | `xcode-select --install`, then `brew install opam node gmp pkgconf sqlite python@3.14 jq` |

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

## The macOS job

`public-ci-macos.yml` holds one job, `macos (arm64, informational)`, on the GitHub-hosted `macos-15`
arm64 runner (standard, free for a public repository). It is **informational**: `continue-on-error: true`,
and its name is not in the ruleset's required checks, so a failure is visible on the pull request
but never blocks the merge. It runs in parallel with `public-ci.yml` and nothing waits for it. It is
in a workflow of its own so that the `public-ci` run ends with its own jobs: a failed job there can
be re-run at once instead of after the macOS runner, which may queue and run for up to 45 minutes.
The workflow has the triggers of `public-ci.yml` except `merge_group`, and the same concurrency
rule under its own group (`public-ci-macos-${{ github.ref }}`: a new event of a pull request
cancels its macOS run in progress; pushes to `main` and release branches are not cancelled). It does
not run the browser tests. In the system bash 3.2, with the macOS 13 deployment target of the
release programs and the pinned SQLite of `mesh-history`, it runs:

- the SPDX header check (`scripts/check-copyright.sh`, with BSD `stat`);
- `scripts/bootstrap.sh --deps-only`, then `scripts/bootstrap.sh --install-only` (`dune build` and
  install, a step of its own), then `dune runtest` of the native tests as a separate step, so that a
  red native test fails the job without hiding the other results. The native test "actual pure
  validator cancellation keeps lane independent" (`ocaml/test/project_host_test.ml`) failed on the
  first run on macOS 15 arm64 (`observation cancelled: not within 15 s`); its cause is not established
  and it is not skipped, so the job stays red until it is fixed;
- the release link and deployment-target checks (`scripts/release-check-macos.sh`) on the built programs;
- the Node tests and the pytest files listed in `tests/macos-ci-tests.txt` (the allow-list below).
  The installer tests (`tests/install-*.test.ts`, `tests/test_install_backend.py`, ...) are not in
  the allow-list: they assume Linux coreutils paths and GNU tools (the file's comments list them).

**The allow-list.** Part of the test suite assumes Linux (`/proc`, Linux process and socket
behaviour, GNU tools); run in full, the job would stay red and hide a real macOS regression. The
job therefore runs only the files of `tests/macos-ci-tests.txt`: one path per line, `#` starts a
comment, blank lines are ignored; a `.py` entry is run by pytest (`-m 'not browser'`), any other
entry by `node --test`. A workflow-structure test checks that the job reads the file and that every
listed path exists. The job validates each line itself (`^tests/[A-Za-z0-9._/-]+\.(ts|py)$`, no
`..`) and fails on an absent or empty list instead of running everything. The Node and pytest steps
are independent of each other and of the native tests, and run only when the build step succeeded.
A test that fails on the runner for a macOS-only reason is a finding: fix the code, or
the test if it wrongly assumes Linux, and add it to the list in the same pull request.

To add a file: run it on a Mac (or read the job's result on your pull request), with
`MESH_BASH32=/bin/bash`, a free `MESH_PORT` and `MESH_SESSION_TOKEN` unset; list it only if it passes
twice in a row. Keep the comments of the file: they say, by cause, what is not listed yet.

The opam state is cached under a key of its own and saved from `main` only, like the Linux one; a
run without a cache entry builds the compiler and may reach its 45-minute timeout, and the next
run on `main` then starts from the saved state (a manual `workflow_dispatch` on `main` seeds it).

**Step budgets.** The job keeps its 45-minute timeout, but a job timeout cancels the job and the
workflow run then ends `cancelled` (push run 44388497934 on `main`, after the native tests hung for
30 minutes; issue #77). Each long step therefore has a `timeout-minutes` of its own, well above its
normal duration (cold cache: `setup-ocaml` 6 min, dependencies 7 min, whole job 15 min; warm cache:
Node tests 2 min, pytest 1.5 min): `setup-ocaml` 15, opam dependencies 15, build 15, Python
dependencies 10, opam repository 10, `dune runtest` 15, link checks 10, Node tests 10, pytest 10
minutes. A step that exceeds its budget is killed and fails; the later steps (`!cancelled()`) still
run, the job ends in failure and `continue-on-error` keeps the run's conclusion `success`. The
budgets add up to more than 45 minutes, but only one step hangs at a time: the checker requires
that the typical durations of all the steps (generous figures, with 2 minutes for the unbudgeted
ones) plus the largest overrun of one step (its budget minus its typical duration) fit in the job
timeout, so a hanging step always fails on its own timeout before the job is cancelled; the job
timeout remains the last safety net. `tests/public-ci-macos-checks.ts` (`MACOS_STEP_BUDGETS`)
requires the budgets and the invariant.

To make it required: first let it stay green on `main` and on pull requests for a while (the
allow-list is what makes that possible; widen it before promoting), then remove its `continue-on-error: true` and the exception for it in
`tests/public-ci-macos-checks.ts` (the public rules then apply to it like to the other jobs, with the
`macos-15` runner kept), give `public-ci-macos.yml` the `merge_group` trigger (a required check must
report on the queue's commit), have a maintainer add the check name to the ruleset (the name appears on
pull requests; rename the job first if the label should not say "informational", and update
`MACOS_JOB_NAME` in the same file and the table in CONTRIBUTING.md), and move its timeout to the
other jobs' safety net if the cold build needs it.

## The apt steps of the Ubuntu jobs

Every job on an Ubuntu runner that installs packages first runs
`bash .github/scripts/fast-apt-mirror.sh` (mirror and apt retries), then installs every package through
`bash .github/scripts/apt-install.sh` (bounded retries, a clear failure), in `public-ci.yml` and in the
two install steps of `release.yml`. No workflow runs `apt-get` itself or `playwright install --with-deps`.

Why: the hosted images read `/etc/apt/sources.list.d/ubuntu.sources` with
`URIs: mirror+file:/etc/apt/apt-mirrors.txt`, and the mirror that list gives varies from job to job.
Measured on two runs (44388371635 and 44380708745, 2026-11-18), not more: where the log shows
`azure.archive.ubuntu.com`, packages came in 0 to 2 s and `playwright install --with-deps` took 19 to 29 s;
where it shows `us-east-2.ec2.archive.ubuntu.com`, the same installs ran at 57 to 99 kB/s with stalls of
20 to 200 s per package (setup-ocaml 492 s, 436 s of it in apt; Playwright installs of 300 to 630 s).
The pull request wall-clock median over 12 runs of the same day was 992 s (16.5 min), against 435 s for
the one run with the fast mirror everywhere. The causal link is shown on those two runs; the other
runs were read from step durations only. Compare the first runs after the change with that median.

What the script does: it writes `/etc/apt/apt.conf.d/zzz-ci-retries` (`Acquire::Retries "3"`, and a 20 s
`Acquire::http::Timeout` and `Acquire::https::Timeout`, which bound a stalled transfer, not a whole
download); then, on x86_64 with a DEB822 `ubuntu.sources`, it points every Ubuntu URI (the archive
stanza and the security stanza, which named `security.ubuntu.com`) at `azure.archive.ubuntu.com`, which
carries the `-security` suites too (CI runners therefore get security updates from that mirror, which can lag
`security.ubuntu.com` by a few hours; signatures still verify), and checks that with an
`apt-get update` limited to `ubuntu.sources`, bounded to 120 s and run with `--error-on=any` (without it a failed fetch is only a warning and the dead mirror would be kept). If that fails, the original file is
restored and the job goes on with the runner's own mirror. `Acquire::ForceIPv4` is not set: nothing in the
logs points to IPv6. It never fails the job, apt still verifies every signature, and it does nothing off
Linux, nothing to the mirror on a runner without that file (the 22.04 and arm runners of `release.yml` get
the retries only), and nothing on a second run. To disable it, remove the step or set
`CI_APT_MIRROR_DISABLE: "1"` in its `env` (and in the `env` of the `apt-install.sh` steps, or at job level, to disable the fallback too). `tests/ci-apt-mirror.test.ts` checks the step order of every
job and the script with a fake `sudo`, `apt-get` and `uname`.

Why the second script: on 2026-11-19 a mirror outage turned at least six jobs red with no code failure:
`security.ubuntu.com` answered 503 for a dozen font packages of the Playwright install, and
`azure.archive.ubuntu.com` refused connections during setup-ocaml's `apt-get install`. apt's own
retries are a few seconds apart; such outages last minutes.

What `apt-install.sh PACKAGE...` does: up to 3 attempts, each an `apt-get update` (bounded to 120 s) and
an `apt-get install --download-only` (bounded to 600 s; killing a download is safe and the next attempt
resumes it). Once everything is downloaded, the real install runs from the local archive, without a
bound and without the network. An attempt that failed with a mirror error is retried, the first time after 30 s
and the second after 60 s. A mirror error is the time bound (status 124, or 137 when apt-get had to be killed), or a
failed fetch (5xx, connection or name resolution error, hash mismatch) from an Ubuntu host (`*.ubuntu.com`), the
mirror hosts of `fast-apt-mirror.sh`, or the hosted runner's `mirror+file:/etc/apt/apt-mirrors.txt` list (apt
names that list instead of the host). Only the error lines (`Err:`, `E:`, `Failed to fetch`) of the failing
command count, so a warning such as apt's `_apt` sandbox notice does not hide a mirror error, and `apt-get update` runs
with `--error-on=any`, so an incomplete index fails the attempt instead of making `--if-available` skip a package.
Before the last attempt `fast-apt-mirror.sh --fallback` points the Ubuntu URIs at `archive.ubuntu.com`, a second
host (not when `CI_APT_MIRROR_DISABLE=1` is set in the environment of the `apt-install.sh` step). Any other error
(an unknown package, a conflict, a full disk, a lock, an error from another repository) fails at once. Each
command runs under `timeout -k 30` and takes `DPkg::Lock::Timeout=120`. When every attempt
fails, the step fails with one annotation, `Package mirror unavailable`, naming the hosts in the errors:
re-run the job. `apt-install.sh --playwright-deps chromium` installs the list printed by
`playwright install-deps --dry-run chromium`; the Chromium download itself is `playwright install
chromium`, kept by the cache keyed on `requirements-browser.txt` (which pins Playwright).
`ocaml/setup-ocaml` installs `bubblewrap musl-tools rsync`, and `darcs g++-multilib gcc-multilib mercurial`
when `apt-cache show` finds them (Ubuntu 24.04 has no `darcs`), with a plain `apt-get install` that cannot
be wrapped; the `ocaml` and `native` jobs install the same list, the second part after `--if-available`,
through `apt-install.sh` just before it, so its own install has nothing left to fetch (setup-ocaml may still run its own
`apt-get update`, in apt's default mode where a transient fetch error is a warning; in the observed job it did not run, everything
was already installed). A new setup-ocaml pin must be
checked against its `src/system-packages.ts`: `tests/ci-apt-mirror.test.ts` pins the SHA and the list.

Cost: nothing when the mirror answers (the update and download that `apt-get install` did anyway, split
in two). A mirror that errors fails each attempt in seconds: about 1.5 min of pauses plus apt's own
retries before the job fails. The bound case, every attempt hanging until its timeouts, is
3 x (120 + 600 + 2 x 30 s kill grace) + 90 s = 40.5 min, under the 45 min job timeout. The settings are environment
variables (`CI_APT_ATTEMPTS`, `CI_APT_PAUSES`, `CI_APT_UPDATE_SECONDS`, `CI_APT_DOWNLOAD_SECONDS`, `CI_APT_KILL_GRACE`).
`tests/ci-apt-install.test.ts` runs the script with a fake `apt-get` on `PATH` that fails a given number
of times with the 503 output of that day, hangs, or reports an unknown package; the same fake is the
way to simulate an outage locally. `tests/ci-apt-mirror.test.ts` refuses, in any workflow and in the
`scripts/` and `.github/scripts/` helper scripts a workflow runs (directly or through another one), a bare
`apt-get`, `apt install` or `apt update` (also with an option before the verb, as in `apt -y install`),
`dpkg -i`, `aptitude`, `--with-deps` or `playwright install-deps`.

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

**Cutting a patch release (0.x.y).** The entries of the fixes are changelog fragments
(`changelog.d/`, [Changelog fragments](changelog-fragments.md)), which their backports bring to
`release/latest` as new files. Once the backports of the fixes are merged, the changelog of the
release is prepared as a pull request to `main`, labelled `semver: patch`, made by
`tools/changelog/changelog.ts cut 0.x.y --only $(git ls-tree --name-only
origin/release/latest:changelog.d | grep -vx README.md)` (the fragments present on
`release/latest`, as bare file names): it adds the heading of the release and its entries to
`CHANGELOG.md`, deletes those fragments, and changes nothing else. `release/latest` gets the same
change in one of two ways
([Changelog fragments, "A patch release"](changelog-fragments.md#cutting-a-release)):

- **From the 0.2 line on**, the changelog pull request is backported like any fix; its cherry-pick
  applies cleanly while the "Unreleased" section of `main` holds its preamble alone.
- **On the 0.1 line**, whose `CHANGELOG.md` has no "Unreleased" section, that backport always
  conflicts on `CHANGELOG.md`. Either resolve it with `git checkout --ours CHANGELOG.md` and insert
  the new section by hand right above `## 0.1.1`, or skip the backport and open a second pull
  request to `release/latest` that adds the section and deletes the same fragments. 0.1.1 was
  released the second way (one commit on `main`, one on `release/latest`, no backport).

A fix backported to `release/latest` before fragments existed has its bullet under "Unreleased" in
`main`'s `CHANGELOG.md`, not a fragment, so `--only` cannot take it: move that bullet from
"Unreleased" into the patch section by hand, in the same pull request. Then:

1. Merge the backports of the fixes, and the backport (or the `release/latest` pull request) of the
   changelog.
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

## The merge queue

For maintainers. As of 22 November 2026, the GitHub merge queue is enabled by a separate
`main merge queue` ruleset for `refs/heads/main` only. It uses rebase, one pull request per
group and one concurrent build. The existing rules require no approving review; maintainers
still review changes before enqueueing them. Release branches are not queued. A first queued
merge must verify the live queue and all 12 required checks; the ruleset cannot be changed by
these workflows.

**Do not enable "Require merge queue" in the existing ruleset "main and release".** That ruleset targets
both `refs/heads/main` and `refs/heads/release/**`, so the queue rule would apply to the release
branches too. There the workflows have no `merge_group` trigger yet, and `tools/branch-policy/` is
the old copy: on a `merge_group` event it exits with status 2. No required check would be reported,
and every pull request to a release branch would wait in the queue until it times out (it fails
closed, nothing lands, but the release branches are blocked until the rule is removed). A rule
cannot be restricted to one branch inside a ruleset, so the queue is a separate ruleset that targets
`main` only; or the workflows and the tool are backported to the release branches first.

**Operating and changing the queue.**

1. Test the active queue with a harmless pull request (a documentation correction with a `semver`
   label): enqueue it, check that all 12 required checks report on the queue commit, and confirm it lands.
2. If the queue is wanted on `release/latest` as well, first backport the three workflows and
   `tools/branch-policy/` and `tools/cla-check/`, and merge the backport by hand. Only then create or
   extend a queue ruleset for release branches. Until then leave release branches out.
3. To disable quickly, disable or delete the separate `main merge queue` ruleset in Settings, Rules,
   Rulesets. Pull requests then merge by hand as before; the existing `main and release` ruleset stays.

**Current queue settings** (on `main`):

- merge method: **Rebase and merge** (the only method the repository allows; the `cla` check
  assumes it);
- build concurrency and group size: **maximum concurrent builds = 1** and a group of 1 (maximum and
  minimum group size 1), so each entry is judged and landed alone on the current tip of `main`.
  Both are required: with a build concurrency above 1 the entries stack, even with a group of 1, and
  an entry's `base_sha` is the previous entry's commit, not the tip of `main` (see the residual risk
  of `cla` below). 2 or 3 per group is possible once the backport workflows have been seen on queued
  merges (see below);
- minimum time in the queue before merging: 0 for a group of 1; wait time for the minimum group
  size otherwise;
- status check timeout: more than the slowest required job (the jobs have a 45-minute safety
  net; ten minutes is only a target), for example 60 minutes;
- "Only merge non-failing pull requests" or "all entries": the first, so that a failed entry does not
  take the entries behind it with it.

The 12 required status checks stay as they are.

**What runs on the queue's commit.** `public-ci.yml`, `branch-policy.yml` and `pr-description.yml` have
the trigger `merge_group: types: [checks_requested]`; every job that produces a required check name
runs on it, and no job that provides a required name can be skipped (see "Failed or skipped dependency" below). Details in
[CONTRIBUTING.md](../CONTRIBUTING.md#merge-queue); the rules are pinned by
`tests/merge-queue-workflow.test.ts`.

- `cla` re-runs the checker of the base over the range `merge_group.base_sha..head_sha`. The checker
  takes a test merge commit of (base, head); the queue has none, so the job builds one locally with
  `git commit-tree` from the head's tree (a linear head's own tree, which is what the checker checks
  and the check of a pull request relies on too). The maintainers' list and the checker come from
  `base_sha`. The commit ids reach the script through environment variables, never through the
  script text. *Residual risk*: with "maximum concurrent builds" above 1 (the documented setting is 1),
  `base_sha` is the commit of the entry ahead in the queue, not the tip of `main`, so the maintainers'
  list, the register and the checker are read on a commit that holds an unmerged change. Probe: entry 1
  adds a name to `tools/cla-check/MAINTAINERS`; entry 2, by that person, fails on a base of `main` and
  passes on a base of entry 1. If entry 1 then leaves the queue, entry 2's result is stale. Entry 1's
  change was judged on its own entry, but entry 2 would rely on it before it is merged: keep the
  concurrency at 1.
- `semver label` and `release branch guard` judge the queued pull request again. The queue's commit has no
  pull request, so the base's copy of `tools/branch-policy/branch-policy.ts` (read with `cat-file` from
  `base_sha`, never the queued commits' copy) parses the number from `merge_group.head_ref`
  (`gh-readonly-queue/<base>/pr-<number>-<sha>`, a strict pattern; no match is an error), reads the pull
  request through the API with the job's read-only token (`pull-requests: read`, named only in that
  step), requires its base to be the one the queue built on, and applies the same functions
  (`semverLabelProblems`, `releaseGuardProblems`) as at the pull request's own event. The labels and
  the base are read when the queue runs the checks (once per `merge_group` event); a change made
  after that read does not rerun them and does not fail the queued entry. A label removed or
  duplicated before the read is refused; so is a changed description of a backport. A refusal or an
  unreadable API fails the check, so the entry leaves the queue.
- `PR description (no personal details)` is a job whose only step on the queue echoes a line (it
  reports its name with a success; every other step is skipped by
  `if: github.event_name != 'merge_group'`). The description is not checked again there; the check
  is warning-only.
- `macos (arm64, informational)` is excluded: its workflow, `public-ci-macos.yml`, has no
  `merge_group` trigger.
- The concurrency groups stay `<workflow>-${{ github.ref }}`: the queue's ref differs from the pull
  request's, and `cancel-in-progress` is off for `merge_group`, so neither event cancels the other.
- `backport.yml` and `backport-register.yml` run on `pull_request_target` (`closed`); that event
  still fires when the queue merges the pull request, and `pull_request_target` workflows never run on
  `merge_group`. `release.yml`, `site.yml`, `site-preview*.yml` have no `merge_group` trigger.

**Failed or skipped dependency.** The documentation of the forge says that a required status check
with the status `success`, `skipped` or `neutral` satisfies a rule ("Successful check statuses are
success, skipped, and neutral"; also in "About protected branches"), so a skipped required job lets a
merge through. `frontend and Node tests`, `ruff and pytest (without browser)` and the four browser
shards wait for the `native PTY host (linux-x86_64)` job (`needs: native`, for the built host
artifact), and that job is not one of the 12 required names: if it failed, the six required jobs
would be skipped, and the queue, which has no human watching the run, would see no red check. Each
of the six therefore has `if: "!cancelled()"` (it runs even when `native` failed or was skipped)
and a first step that fails when `needs.native.result` is not `success`, so a failed or skipped
`native` makes the six checks red, never skipped. What is guaranteed now: no job that provides a
required name carries a condition that can skip it, except `!cancelled()`, and a required job that
needs a non-required job fails when that job did not succeed (`tests/merge-queue-workflow.test.ts`).
What is not: a cancelled run (a newer push on a pull request, a manual cancel) leaves its jobs
cancelled, which is not a success either. The other required jobs (`cla`, `leak check`, `OCaml`, the
two branch-policy jobs and the description job) have no `needs`.

**Backports.** `backport-register.yml` replays the commits a rebase merge landed, found from the
event's merge commit id and commit count. With a group of 1 that is the same shape as a manual
rebase merge; with larger groups the landed commits of one pull request may not be the last ones on
`main` when the workflow starts, and the script's checks (authors, dates, patch ids) refuse such a
replay with a comment and push nothing. Watch the first queued merges of a `semver: patch` pull
request and of a register change before raising the group size. A backport pull request to
`release/latest` can be queued like any other, once the queue is enabled on `release/**` (see the owner steps above, not before): open it,
check it, then "Merge when ready" (or `gh pr merge --auto --rebase <number>`).

**Dequeue.** "Remove from merge queue" on the pull request page. `gh pr merge --disable-auto` only
cancels an auto-merge that has not entered the queue yet; it does not take an entry out of it.
A pull request that fails a check on the queue's commit is removed by GitHub; pushing a fix and
queueing again starts a new entry.

**Not verified offline.** The facts below come from GitHub's documentation as known to the
author, not from a run: that a required check must report on `merge_group` (`checks_requested`) for
an entry to proceed; the queue ref name and the event's `base_sha`, `head_sha` and `head_ref` fields;
that the queue's temporary branch holds the entry's commits as a straight line on `base_sha` when
the method is rebase (if it holds a merge commit instead, `cla` refuses the entry: it fails safe);
that `pull_request_target` workflows do not start on `merge_group`; and the `merge_commit_sha` of
a pull request merged by the queue. Also the committer identity of the commits the queue rebases (expected: GitHub <noreply@github.com>; if it differs, `cla` refuses every entry: it fails closed), and the behaviour of a required job skipped because a job it needs failed (the documentation is read, no run reproduced it). A first queued merge of a harmless pull request is the test.

## Nightly pre-releases

`nightly.yml` publishes a pre-release of the tip of `main` once a night (02:17 UTC, plus a manual
run on `main`), so that users can try the next version. It runs on `schedule` and
`workflow_dispatch` only, never on a pull request or a fork, and uses no action and no secret: the
`gh` CLI of the runner and the run's own token.

- **Tag.** `v<next minor>.0-nightly.<YYYYMMDD>`: the minor after the latest stable release
  (`/releases/latest`, which never names a pre-release), with the UTC date. The hyphen suffix makes
  it a pre-release for GitHub and for the update notice, which ignores pre-releases
  (`mesh_update_check.ml`); `release.yml` never marks it the latest release. At most one nightly per
  UTC date: if a tag for the date exists and has a release, or `release.yml` is running on it, the
  run does nothing and says so. The `decide` job has a read-only token, which cannot list draft
  releases: it sees published releases only, and a draft is seen by the retention step of the
  `start` job (write permission). `release.yml` itself refuses to overwrite an existing release for
  a tag, a draft included. A tag with neither a release nor a running `release.yml` is an orphan (an
  earlier run died after tagging it): the run starts `release.yml` on it again instead of skipping,
  at most twice per tag in all (`MAX_REDISPATCH`), so a nightly that keeps failing does not loop; it
  then stays as it is, with a warning, until a maintainer looks at the runs. An orphan is published
  by a scheduled run, so it is checked like a new tag: it must be an annotated tag whose tagger is
  `github-actions[bot]` (read through the API tag object; a lightweight tag is refused), its commit
  must be `main`'s head or an ancestor of `main`, and the same CI gate must pass on that commit.
  Anything that cannot be read, and any failed check, means the job does not start `release.yml` and
  writes the reason in its summary. The tagger name is written by whoever creates a tag object, so it
  is a consistency check, not an authentication: what bounds a hand-made tag is the CI gate on its
  commit, the ancestry check and the exact tag pattern.
- **When.** The `decide` job (read-only token) publishes only when the tip of `main` differs from the
  commit of the previous nightly tag and every check that `public-ci.yml` runs on a push to `main`
  and that the ruleset requires (the table in [CONTRIBUTING.md](../CONTRIBUTING.md#required-checks):
  all but the pull request only checks) is completed and successful on that commit. Only check runs
  of the GitHub Actions app (the `integration_id` 15368 the ruleset requires) count. The check runs
  API is asked with `filter=all` (its default, `filter=latest`, keeps only the newest run of each
  name and would let a re-run replace a failure), and every run of a required name must be
  successful, with at least one: a second suite on the same commit (a manual run of `public-ci.yml`
  on `main`) or a re-run does not supersede an earlier failure, which keeps blocking until `main`
  moves. If CI is red, still running, skipped, cancelled or missing,
  nothing is published and the job summary says which check. The check
  names are copied in `nightly.yml`: rename a job of `public-ci.yml` and the nightly stops until
  the list follows.
- **How.** The `start` job, the only one with a write token (`contents` and `actions`), creates an
  annotated tag on that commit through the API, whose message is the opening of the release notes
  (a warning that it is a build untested by users, and the commits since the previous nightly),
  starts `release.yml` on the tag, then removes the old nightlies (that cleanup comes last and may
  fail without failing the run, so it can never leave a tag with no started release). A tag created with the run's
  token starts no workflow, so nothing runs twice; `release.yml` refuses a push of a nightly tag.
  `release.yml` then builds, qualifies, attests and publishes exactly what a release is, signed
  from `refs/tags/<tag>` by `release.yml`, so `install.sh` verifies a nightly like any release.
  The green-CI check is made by `nightly.yml` before it tags; `release.yml` does not repeat it. A
  person with write access can run `release.yml` directly on a nightly-shaped tag that names any
  ancestor of `main`, red CI included, or move the tag between the `decide` job and the start of
  `release.yml`, which re-verifies only that the tag is the built commit and on `main`. The real
  frontier is the write-access boundary, not these checks.
  A pushed tag containing `-nightly` anywhere (for example `v0.2.0-nightly.x`, which a ruleset
  excluding `v*-nightly.*` does not cover) is refused by the tag job whatever its form.
  The tag job of `release.yml` accepts a manual run on a tag of exactly the nightly form and
  checks that the tag names the built commit and that this commit is `main`'s head or an ancestor
  of `main`: for a nightly, `release/latest` is not accepted (a stable tag may still name a commit
  of `release/latest`).
- **Retention.** The newest seven nightlies are kept. Older ones (release and tag) are deleted by
  the `start` job: a tag is only ever matched by the exact pattern
  `^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}$`, a release is deleted only if it is a pre-release,
  and a run deletes at most three. The releases are listed (not looked up by tag, which does not
  see a draft), so a draft nightly is deleted with its tag within the same cap. The nightly of the
  run is never deleted (it sorts last among equal dates). Only tags with a real calendar date
  (`20261399` is not one) that is not after today's UTC date take part: a tag with an invalid or
  future date is ignored, which means kept, not counted among the newest seven and not deletable,
  and a warning names it for a maintainer. Ignoring was chosen over deleting or counting because a
  misdated tag can then neither displace a real nightly nor be removed by the job. A failure of
  this step is logged and does not fail the run.
- **Concurrency.** One group, `nightly`, never cancelled.

What the owner configures on GitHub, none of which the repository can do itself:

- Actions: the workflow permissions of the repository must allow the run's token to be given the
  `contents: write` and `actions: write` scopes the workflow requests (the repository default may
  stay read-only; the workflow asks per job).
- Tag rulesets. Today there is no tag ruleset: the only rule is the branch ruleset of `main`
  (27540466). Anyone with write access can therefore create a tag of the nightly form and run
  `release.yml` on it. That is no privilege gain over pushing a stable `v*` tag, which such a person
  can already do, but it is a gap. What GitHub's documentation says about bypass (checked
  2026-11-18, "About rulesets" and "Creating rulesets for a repository" on docs.github.com):
  a bypass list can name roles, teams and GitHub Apps, for branch and tag rulesets alike. It does
  not say that the GitHub Actions app, nor the `GITHUB_TOKEN` of a workflow run, is an app that can
  be selected in that list or that the token acts as an actor of the list. That could not be
  verified from the documentation, and was not tried on the repository. Until someone has tried it
  in the ruleset settings, assume the run's token cannot bypass a tag ruleset: then any ruleset that
  restricts creation or deletion of `v*-nightly.*` tags would make the nightly impossible (the
  `start` job could neither create nor delete them). So:
  - Do not put a restriction on creation, update or deletion on `v*-nightly.*`. Leave those tags to
    the workflows, and rely on the exact-pattern checks in code: the tag names matched by one
    pattern, `release.yml` refusing a push of a nightly tag, requiring the tag's commit to be on
    `main`, and the orphan checks of the `decide` job. This leaves the gap above open for
    nightly-shaped tags.
  - Protect the stable `v*` tags with a ruleset restricted to the maintainers (creation, update and
    deletion), excluding `v*-nightly.*` from its target. No workflow and no contributor can then
    create or move a stable tag, and no bypass for the Actions app is needed or wanted: a bypass for
    it on `v*` would let any workflow on any branch create stable tags.
  - If a maintainer finds that the Actions app can be added to a ruleset's bypass list and that the
    run's token then bypasses it, a ruleset on `v*-nightly.*` only, restricting creation, update and
    deletion, with a bypass for that app and the maintainers, closes the nightly gap; it would not
    stop another workflow on a branch from creating a nightly-shaped tag, which is why `release.yml`
    also requires the tag's commit to be on `main`. Test that the nightly still runs before relying
    on it.
  If no tag ruleset exists, the `start` job works as it does today.
- Immutable releases, if enabled: check that a published pre-release and its tag can still be
  deleted. If not, the retention step fails on the oldest nightly (logged, the run itself still
  succeeds because `release.yml` is started before the retention) and old nightlies accumulate
  until the setting allows the deletion.
- The required checks of the `main` ruleset must keep the names listed in `nightly.yml`.

Known limitation: a pull request whose head is the tip of `main` (for example a pull request toward
a `release/**` branch opened from `main`'s head) attaches its `pull_request` check runs to the same
commit. With `filter=all`, a pending or failed run of such a pull request under a required name
blocks the nightly while it lasts. This fails closed and costs availability only (no nightly that
night, with the check named in the job summary); it ends when the pending run turns green or when
`main` moves; a failed or cancelled run keeps blocking until `main` moves. It is not handled in code.

A user installs a nightly with `install.sh --upgrade --to <nightly tag>`
([Upgrading a release install](operations.md#upgrading-a-release-install)).
## Automatic issue triage

For maintainers. `.github/workflows/issue-triage.yml` classifies each new issue with
Ollama's decision API (System One, model `clef`) and adds at most one label. The rules are in
`tools/issue-triage/issue-triage.ts`; `tests/issue-triage.test.ts` (against a fake decision API and a
fake GitHub API) and `tests/issue-triage-workflow.test.ts` (the workflow file) enforce them.

What it does: on `issues: opened` it reads the issue and the repository labels through the GitHub API,
then sends one `POST <base URL>/v1/systemone` with ONE `choice` question. The `state` is the issue as
JSON (title cut to 200 characters, body cut to 4000, control characters removed, author association,
labels already on the issue). The options are `other` (none of the labels) plus the labels `bug`,
`enhancement`, `documentation` and `question` that exist in the repository, and the criteria of each
option is the description of that label in the repository (a built-in default when the description is
empty). Descriptions are untrusted, because a triager can edit them: they are cleaned like the issue
text and cut to 200 characters. If fewer than two of the four labels exist, nothing is asked. The
model has no tool and no access to the repository, the secrets or other issues. The script, not the
model, decides: the answer must be exactly one answer for the question, with a choice among the options
sent and probabilities in 0..1 for those options only, otherwise nothing is added. It adds the chosen
label only when it is one of the four labels, it exists in the repository, its probability is at least
0.7 (`PROBABILITY_THRESHOLD`, the probability of the chosen option), the `confidence` of the answer is at
least 0.5 (`CONCENTRATION_GUARD`; `confidence` only measures how concentrated the probabilities are, it
is not the chance of being right) and the issue has none of those four labels yet. The job summary
gives the model, the option names sent, the chosen option, its probability, the confidence and the
decision, or why nothing was added.

What it never does: add any other label (`wontfix`, `invalid`, `duplicate`, `good first issue`,
`help wanted`, `accessibility`, a `semver:` label), remove or replace a label, close, lock, assign,
comment or edit. Issues filed through the bug-report template already carry the `bug` label
(`.github/ISSUE_TEMPLATE/bug_report.yml` sets `labels: ["bug"]`), so they count as already labelled and are not
triaged: in practice the triage covers blank issues. It skips issues opened by a bot or by an owner, member or collaborator (maintainers
label by hand), and it never fails the job: a missing key, a timeout, an HTTP error or a garbled
answer is a warning and no label. It runs on `issues: opened` and on a manual dispatch only: no
`edited`, `reopened`, pull request or schedule trigger. The job token is limited to `issues: write`, `contents: read` (needed to check out the public repository) and `actions: read` (needed to count the runs of the last 24 hours, see "Abuse and cost controls").

Enable it:

1. In the repository settings, create the environment `issue-triage`, add the secret
   `OLLAMA_API_KEY` to it (an Ollama API key), and restrict the environment to the branch `main` so
   that a workflow run from another branch cannot read the key. The repository does not rely on this
   setting alone: the job runs only when the workflow ref is the default branch (the `if:` of the job, also for a
   dispatch) and the script refuses to run, with no model call and no label, when `GITHUB_REF` is not
   `refs/heads/<default branch>`, so code pushed to a writer's branch is never started with the key. The
   deployment-branch restriction to `main` stays recommended as a second layer; it is an administrator setting
   that this repository cannot verify.
2. Optionally set the variables `OLLAMA_MODEL` (default `clef`) and `OLLAMA_BASE_URL`. Each may be a
   repository variable or a variable of the `issue-triage` environment: the job declares that
   environment, so both are exposed through `vars`. The script removes a trailing `:cloud` from the
   model name (`clef:cloud` is called as `clef`): the direct cloud API takes the plain name, and
   `:cloud` is the tag a local Ollama uses to offload to the cloud. The documentation is ambiguous:
   the OpenAPI cites `clef:cloud` as a model name while the direct-call example uses `clef`. With this
   script `clef` and `clef:cloud` both call the model `clef`; a name such as `clef:27b-cloud` is
   passed unchanged. The model actually used, and a
   note when the variable is empty and the default is used, appear in the job summary and in the
   warnings.
   The base URL must be `https` on exactly `ollama.com` (no subdomain, port or credentials), otherwise nothing is sent: a variable
   cannot redirect the key elsewhere, and the key does not depend on what Ollama hosts under its subdomains. The script calls `<base URL>/v1/systemone` with a `Bearer` key.
3. Have a paid Ollama plan or purchased usage credits: the documentation says cloud access requires
   one. Without them the call fails, and the job only warns (the documentation names HTTP 401 for a
   refused key and HTTP 402 for missing credits; no other code is promised). Cost: `clef` is listed at about 0.24 USD per million input tokens (input only); an issue
   is a few thousand tokens at most, so a triage costs a fraction of a cent. The pay-as-you-go plan
   allows 3 concurrent requests: according to ollama.com/pricing, requests above that are queued, and an
   HTTP 429 only happens when the queue is full. Automatic runs (new issues) execute one at a time (see "Abuse and cost controls"), so a queue
   is unlikely; manual dispatches use per-issue groups and can run alongside them and each other, so more than 3 concurrent
   requests need several maintainer dispatches at once; a 429 (or any failure) adds no label.

Test it without changing anything: start the workflow by hand (Actions, issue-triage, Run workflow;
it needs write access to the repository, which GitHub enforces), give an existing issue number and
leave `dry_run` checked. The job triages that issue like a new one, except that the maintainer and
bot skip does not apply, and writes the model, the options sent, the chosen option with its
probability and confidence, and the label it would add to the job summary. It adds nothing. Uncheck
`dry_run` to add the label for real.

Disable it: set the variable `TRIAGE_ENABLED` to `false`, or delete the secret `OLLAMA_API_KEY` (the job then does nothing and says so), or delete the
workflow file. Deleting the secret or setting the variable only prevents future runs: a run already in progress keeps the key it started with, so, to stop at once, also cancel the in-flight `issue-triage` runs from the Actions tab.

Data: the text of each triaged issue (title and the first 4000 characters of the body), its author
association, its existing label names and the descriptions of the four labels are sent to Ollama, a
third party. Issues are public, but a secret pasted into an issue would be sent as well: revoke any
secret that is pasted in an issue. Ollama states that cloud prompts are not stored or used for
training; that is its claim, not something this repository checks.

### Abuse and cost controls

The issue text is written by strangers and every triage is a call to an account that has limits (3
concurrent requests, a paid plan or credits). At about 0.24 USD per million input tokens one triage
costs roughly 0.00024 USD, so the risk of spam is availability and quota rather than money; a burst must
be cheap and bounded. The guards below are listed in the order they act, as the code runs them; none of
them echoes issue text in the job summary, and all of them act before any Ollama call.

- **Global concurrency (before the script starts).** All runs started by `issues: opened` share one
  concurrency group (`issue-triage-global`, `cancel-in-progress: false`), declared on the job: a run whose job is
  skipped by the `if:` guard (an issue of a maintainer or a bot) does not join the group, so it cannot take the
  pending slot of someone else's run (GitHub documentation, not reproduced on a real run). According to the GitHub
  documentation (using concurrency), at most one run is running and at most one is pending in a group, and
  when a newer run queues, an existing pending run of the group is cancelled; the running one is never
  cancelled. In a burst of issues, one run executes, one waits and the excess is dropped without cost. A
  dropped run is a cancelled run: that issue is simply never triaged and stays unlabelled (nothing else
  happens to it); a maintainer can start the workflow by hand on it (dispatch). A dispatch has its own
  group per issue number and dry-run value (`dispatch-<issue>-<dry_run>`), so it never cancels a pending issue run, and a
  later dry run never replaces a pending real dispatch of the same issue. Limit: an outsider who opens an issue right
  after another one replaces the pending run of that earlier issue, which then stays unlabelled; this costs availability
  of the label only.
- **Kill switch (first thing the script does).** The repository (or `issue-triage` environment) variable
  `TRIAGE_ENABLED`: the value `false` stops everything, compared after trimming whitespace and ignoring
  case, so `False` or ` false ` also stop it (a typo must not leave the triage on). The script writes a
  summary line, makes no request at all (GitHub or Ollama) and adds no label. `0`, `no`, `off` and any
  other value are NOT kill values: the switch is `false`. Absent or empty means enabled. It does not touch
  the secret.
- **Issue read.** The script reads the issue through the API (its JSON may be up to 256 KiB; the Ollama
  answer is capped at 64 KiB). An issue that cannot be read is not triaged.
- **Issues that do not deserve a call.** Skipped: a pull request number, a locked issue, an empty title and
  a body that is empty or shorter than 15 characters after trimming (all four also on a dispatch), then,
  on the `issues` event only, an issue opened by a bot or by an owner, member or collaborator.
- **Label already present.** An issue that already has one of the four labels is kept as it is.
- **Account age filter (off by default).** `TRIAGE_MIN_ACCOUNT_AGE_DAYS`: a positive integer skips
  issues whose author account is younger than that many days (`created_at` read from the users API with the
  same token). 0, absent or invalid means off; a failure to read the account never blocks the triage. This
  slows a naive spammer, not an organised one (accounts can be aged in advance), and it penalises real new
  contributors, which is why it is off by default. Not applied to a dispatch.
- **Daily cap (last guard before the model call).** On an `issues` event, the script counts the runs of
  this workflow created in the last 24 hours (`GET /repos/{owner}/{repo}/actions/workflows/issue-triage.yml/runs?created=>=<time>&per_page=100`,
  at most 10 pages: the API returns at most 1000 results for a filtered listing). The current run and
  cancelled or skipped runs are not counted. When the count reaches `TRIAGE_DAILY_CAP` (repository
  variable, default 100, an integer from 1 to 10000; anything else is the default) the call is skipped and
  the summary says so. Because the API caps the listing, a full last page counts as the cap reached, so no
  setting above about 1000 is ever reached. If the count cannot be made (HTTP error, unreadable answer),
  the call is skipped with a warning and the job still exits 0: the cap is a cost control, so it fails
  closed. A manual dispatch is not subject to the cap, because only users with write access can start one.
  Reading the listing needs the `actions: read` permission, which is the only permission added to the job.
  **The cap counts runs, not model calls.** A run that stops inside the script (short body, locked issue,
  too-young account, cap already reached) concludes `success` and is counted like a run that called the
  model. So 100 empty issues from strangers within 24 hours fill the cap and block the triage of real
  issues for the rest of the window, although they cost nothing. This is an availability limit, not a cost
  one; the runs of maintainers and bots, whose job is skipped by the `if:` guard, are not counted. A
  maintainer can still triage an issue by dispatch, which is exempt from the cap.
- **Then**: the four labels are looked up in the repository (one `GET /repos/{owner}/{repo}/labels/{name}`
  each, a 404 meaning that the label does not exist), the model is called, and, only when the decision
  holds, the issue is read again just before the write: if a label of the list appeared during the model
  call (up to a minute) nothing is written. This narrows the window in which a maintainer's label and the
  automatic one could both be set; it is not atomic. A refused write (for example HTTP 403) or a failed
  re-read is reported as a warning.

The job timeout is 8 minutes. The calls of the script time out at 15 s (GitHub) and 60 s (Ollama): in the
worst case (issue, account, 10 run pages, 4 label lookups, Ollama, re-read, write) about 5.5 minutes, plus
the checkout and the Node setup, so 8 leaves room without letting a stuck job run long.

Stop everything at once: set `TRIAGE_ENABLED` to `false` (no redeploy, the secret is kept), or delete the
secret `OLLAMA_API_KEY`, or delete the workflow file.

Owner side, outside this repository: use prepaid credits without automatic reload, so that the worst case
is bounded by what was bought; use an API key dedicated to this repository, so that it can be revoked or
rate-limited without touching anything else.

## Languages

The web server is written in Python, but no new Python is accepted: the project is converging on
OCaml on the server side, where the native PTY host and the MCP servers already are, and on
TypeScript in the browser and the tests. New code is written in those two languages, and the Python
modules are replaced over time ([CONTRIBUTING.md](../CONTRIBUTING.md#no-new-python)).

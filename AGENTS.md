# Instructions for coding agents

These rules apply to any automated tool that changes this repository. They summarise
[CONTRIBUTING.md](CONTRIBUTING.md), which is authoritative; follow its links for the reasons.

## Code

- **Do not add Python** files, modules or scripts. New code and tests are OCaml (under `ocaml/`,
  built with dune) or TypeScript (`tests/**/*.test.ts`, run by Node's type stripping). A small fix
  inside an existing Python file is acceptable.
- Interface text goes through `static/i18n/`; add every new key to both `en.json` and `fr.json`.
- Some `static/*.js` files are built from the `.ts` file of the same name: edit the `.ts` source.
- Add or update tests with every behaviour change.

## Tests

Run the complete local suite before proposing a change, in English (the browser tests compare
English interface text, and some of them take Chromium's language from the environment):

```sh
scripts/test-local.sh --preflight-only
LANG=C.UTF-8 LANGUAGE=en scripts/test-local.sh
```

Then the leak check with the public rules, the one CI runs on the tree:

```sh
node --experimental-strip-types tools/leak-guard/cli.ts worktree
```

CI also runs an informational, non-required job `macos (arm64, informational)` (workflow
`public-ci-macos.yml`): when it fails on your pull request, fix the macOS breakage it reports (shell scripts must stay bash 3.2 and BSD-tool
compatible) or say in the description why it is unrelated. It runs only the tests listed in
`tests/macos-ci-tests.txt`; a new test that is portable to macOS goes in that file. See
[docs/development.md](docs/development.md#the-macos-job).

## Branches, commits and pull requests

- Every pull request targets `main`. Fixes reach `release/latest` through the backport workflow; open
  a pull request against it by hand only when that workflow reports a conflicting cherry-pick on the
  original pull request, following CONTRIBUTING.md, "Branches and versions".
- A pull request to `main` carries exactly one label, `semver: patch` (a fix the released line should
  also get, backported automatically after the merge) or `semver: minor` (everything else). If you
  cannot set labels, state the intended one in the description. Changes to the CLA register files
  (`CONTRIBUTORS.md`, `CLA.md`, `CLA-SIGNATORIES.md`, `tools/cla-check/MAINTAINERS`,
  `.github/CODEOWNERS`) reach `release/latest` whatever the label: after the merge, a workflow opens
  a pull request with these files alone.
- Keep the branch linear on top of the tip of `main`: rebase, never merge `main` into it, no merge
  commits. The `cla` check refuses anything else; the merge method is "Rebase and merge" only.
- Every commit author and committer address must be a maintainer's or have a line in
  `CLA-SIGNATORIES.md`. Never add or edit a line in that file for someone else: each contributor
  adds their own line in a commit authored with that address.
- Write commit messages and pull request descriptions in English, about the change only. Leave out
  machine names, user names, home paths, IP or internal host names, tokens, personal e-mail
  addresses, and how the change was produced. Fill in the pull request template, keeping "How to
  check".
- Do not change `.github/`, `tools/cla-check/`, `CLA.md`, `CLA-SIGNATORIES.md`, `CONTRIBUTORS.md`
  or `.gitattributes` unless the task is about them; the maintainers review those paths
  ([.github/CODEOWNERS](.github/CODEOWNERS)).

## Security

Do not report a vulnerability in an issue or a pull request: follow [SECURITY.md](SECURITY.md).
Changes on a trust boundary (authentication, `/view`, session tokens, the route table, the PTY host,
sandboxes) are stated in the pull request and checked against the threat model in SECURITY.md.

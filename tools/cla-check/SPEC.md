# CLA check: specification

`cla-check.ts` decides whether a pull request may be merged with respect to the
[Contributor License Agreement](../../CLA.md). Pull requests are integrated by **"Rebase and merge"
only**. The branch rule of `main` does not require a branch to be up to date before merging. The
check accepts only a **linear pull request**: a straight line of ordinary commits. When the branch
contains the tip of the base, the tree GitHub's test merge holds is the head's tree, and it is also
the tree the rebase lands as long as the base has not moved; the check judges that tree. A branch
that does not contain the tip of the base is accepted only when **no commit of it changes the
register**: the register that lands is then the base's, whatever the rebase does to the other
files, and the check judges that register (see "Why a branch behind the base is accepted only when
it leaves the register alone", and "Re-running the check" when the base moves).

Why linear: a rebase replays ordinary commits and drops merge commits. If a merge commit of the pull
request undid, in the judged tree, what an ordinary commit did to the register, the check would see
one register and `main` would receive another. For example, a commit removes Bob's line and a merge
commit puts it back: the judged tree keeps Bob's line, and the rebase lands its removal.

## Why a branch behind the base is accepted only when it leaves the register alone

What the check depends on is: the commits the rebase replays and their author and committer
addresses, the register that lands, and `MAINTAINERS` on the base. For a linear pull request the
first is the same whether or not the branch contains the tip of the base: the rebase replays the
commits of `base..head`, which are the commits of the pull request, keeps their authors, and makes
the integrator their committer. The register is what differs.

- **The pull request changes the register.** The rebase replays its commits one by one, each with a
  three-way merge (and the union driver of `.gitattributes` on the register when a commit conflicts
  with the base); GitHub's test merge applies the whole pull request in one three-way merge. The two
  can disagree on the register. Example: Eve adds a line for Mallory at the end of the table in one
  commit and removes it in the next; meanwhile `main` gained Carol's line at the end. The test
  merge sees no change from Eve and keeps `main`'s register; the replay of the first commit
  conflicts with Carol's line and the union driver keeps both, the replay of the second conflicts
  again and the union driver keeps Mallory's line. Mallory's line would land without any commit of
  Mallory's and without the check seeing it. So a pull request that changes the register must
  contain the tip of the base, as before: then the test merge, the head and the rebase hold the same
  tree.
- **No commit of the pull request changes the register.** The entry of `CLA-SIGNATORIES.md` (its
  mode and object, or its absence) is the same in every commit of `base..head` as in its parent.
  The replay of such a commit leaves the register as it finds it, so the register that lands is the
  base's; and the test merge, in which only the base's side changed it, holds the base's register
  too (the checker verifies it). Rule 2 has nothing to judge; rule 1 judges every commit against
  the base's register, which is the one that lands. What the rebase does to the other files does
  not enter the verdict.

In both cases the verdict is about the base the check ran on; when `main` moves afterwards, see
"Re-running the check" and "The merge queue".

## Inputs

```text
node --experimental-strip-types cla-check.ts --base SHA --head SHA --merge SHA [--repo DIR] [--queue true]
```

- `--base`: the tip of the base branch.
- `--head`: the head of the pull request.
- `--merge`: the **test merge commit** GitHub builds for a `pull_request` event and checks out as
  `HEAD`. Its parents must be exactly the base, then the head; anything else is exit 2.

The CI job derives the three from `HEAD^1`, `HEAD^2` and `HEAD`, never from the event payload or
from branch names, and runs the copy of the checker found on the base. All three are full object
ids.

Exit status: 0 accepted, 1 refused, 2 usage error, Git error, unreadable commit header, or a merge
commit whose tree is not the head's (rule 0).

## Rule 0: a linear pull request

Checked first; when it fails, the other rules are not evaluated.

- Every commit of `base..head` has exactly one parent. A commit with more than one parent is
  refused: "rebase your branch on main; merge commits are not allowed in a pull request". A commit
  without parent is refused too.
- The base is an ancestor of the head, **or** the range `base..head` is not empty and none of its
  commits changes the entry of `CLA-SIGNATORIES.md` against its parent (mode and object id, or
  absence, compared as `git ls-tree` gives them). Otherwise the branch is behind `main` and is
  refused with a request to update it by rebasing it on `main`.

When the base is an ancestor of the head, the tree of the test merge commit must equal the head's
tree. When it is not, the entry of `CLA-SIGNATORIES.md` in the test merge commit must equal the
base's. Either mismatch is exit 2: GitHub builds no other.

## The register

The register that counts is `CLA-SIGNATORIES.md` **in the tree of the test merge commit**, and only
as a regular file (a symbolic link or a directory is an empty register). A line is a signatory
line when all of this holds:

- it starts at the first column with `|` and has exactly four cells: public name, commit address,
  CLA version, date;
- it is outside a fenced code block (```` ``` ```` or `~~~`) and outside an HTML comment; a line
  that opens or closes a comment is not a signatory line;
- the name is not empty; the address has the shape `local@domain` and is made of printable ASCII
  characters other than space, `<`, `>`, `|` and backquote (one pair of backquotes around it is
  allowed);
- the version is a published one (`1.0`);
- the date is `YYYY-MM-DD` and exists in the calendar.

Addresses, in the register, in `MAINTAINERS` and in commits, compare without case for the ASCII
letters only: no other character is folded, so a Kelvin sign (U+212A) is not a `k` and a
zero-width space makes a different address, which the register cannot hold.

A line is identified by its four normalised cells: a line changed in any cell is another line.

## Maintainers

Maintainer addresses come from one place, `tools/cla-check/MAINTAINERS` **as it stands on the
base**, one `Name <address>` per line (`#` starts a comment). A pull request therefore cannot make
its own author a maintainer. A missing or malformed file is exit 2.
`tests/cla-check-maintainers.test.ts` keeps that file, the "Maintainers" list of `CONTRIBUTORS.md`
and the accounts of `.github/CODEOWNERS` in step.

## Rule 1: identities

For every commit of `base..head`, the author address and the committer address must be a
maintainer's or carry a signatory line in the register of the test merge commit. The committer
`GitHub <noreply@github.com>` (web edits) is accepted, as committer only.

For a `merge_group` check only, the checker additionally accepts a committer named `login` at
`login@users.noreply.github.com` when the base's maintainer list contains the corresponding
`numeric-id+login@users.noreply.github.com`. The login-only form is not accepted as an author,
signatory or maintainer for register changes, nor on a pull-request check. No alias is derived
from changes in the queued commits.

## Rule 2: integrity of the register

Compare the signatory lines of the base (B) with those of the test merge commit (M). A commit of
`base..head` adds the lines its tree has and its parent's has not, and removes the opposite.

- A line in B and not in M must be removed by a commit of the range whose author address is the
  line's or a maintainer's.
- A line in M and not in B must be added by a commit of the range whose author address is the
  line's. A maintainer may also add it in a commit that removes another line with the same
  address: a correction that keeps the address.

A rebase on `main` can bring back a line its holder withdrew there, or drop one added there (the
union driver of `.gitattributes` keeps both sides' lines, an edited conflict may keep fewer): the
replayed commit then adds or removes a line that is not its author's, and is refused.

## Reading a commit

The header is read from the raw object (`git cat-file commit`), without format strings or mailmap,
in the order Git itself reads it: `tree`, then `parent` lines, then `author`, then `committer`.

- Parents are the `parent` lines **before** `author`. A `parent` line elsewhere is not a parent.
- The whole header holds exactly one `author` line and one `committer` line.
- A name that contains `<` or `>` (a header with two addresses) is refused.

Any other shape is exit 2.

## Output

On refusal, standard output lists only the offending addresses and commit ids, each on a line that
starts with two spaces and a dash, with control characters replaced and the length bounded. No
line starts with `::`. The text points to `CLA.md`. Names and file contents are never printed or
evaluated; Git runs without a shell.

## Re-running the check

The workflow runs on the `pull_request` types `opened`, `synchronize`, `reopened` and `edited`.

- **`main` moves after the check ran.** The check does not run again, and the branch rule does not
  require an up-to-date branch, so the earlier verdict stays on the pull request. The rebase then
  lands the same commits on a tree the check did not judge: a register line removed from `main` in
  the meantime is not seen. Any later event of the pull request (a push, a change of base, an edit
  of its title or description, closing and reopening it) runs the check against the current `main`;
  a pull request that does not change the register passes it without being rebased. "Re-run jobs"
  re-runs on the test merge commit of the original event, so on the former base. The merge queue,
  when it is enabled, judges what lands on the current `main` (see "The merge queue").
- **The base branch of the pull request is changed.** That is an `edited` event: the check runs
  again against the new base. Every job of the workflow runs on it, since a job skipped by a
  condition would count as a passed required check; editing the title or the description of a pull
  request therefore re-runs the whole CI.

## The merge queue

On the `merge_group` event the workflow runs this same checker over the queued commits: `--base` is the
event's `base_sha`, `--head` its `head_sha` (the checked-out commit), and `--merge` a local commit of
(base, head) with the head's tree, built by the job because the queue provides none. Rule 0 refuses a
head that is not a straight line on the base, so the check fails safe when the queue's commit is
not one. The checker and `MAINTAINERS` are the base's copies. The queue's commits are built on the
base, so the base is always an ancestor of the head there: the relaxation for a branch behind the
base never applies, and the run judges the exact commits and tree that land.

## Known limits

- **Git does not verify addresses.** A commit can carry anyone's address, a maintainer's included.
  The queue-only committer alias is also an address convention, not proof of GitHub account ownership.
  The maintainers compare the account that opened the pull request with the addresses its commits
  use; signed commits make that immediate. "Rebase and merge" rewrites the commits: new ids, the
  maintainer who integrates as committer (with their account's commit address), no signature. A
  signature's "Verified" mark is therefore visible on the pull request only. (The committer
  `GitHub <noreply@github.com>` comes from a squash merge or a web-interface edit.)
- **`Co-authored-by` trailers are not read.** Only the author and committer addresses are judged.
- **Between a change of base and the start of the new run**, the result shown is the one against
  the former base. A maintainer who merges in that interval merges on a verdict about another
  base.
- **A pull request can edit the workflow that calls the checker.** The checker itself is taken
  from the base, the workflow is not. Review by the maintainers covers it.
- **The check assumes "Rebase and merge".** For a linear, up-to-date pull request, a squash merge
  or a merge commit would land the same tree as the one judged, but under other commits (a squash
  keeps one author only). The project uses neither.
- **A rename on `main` into the register.** For a branch behind the base that does not change the
  register, the argument above assumes that no commit of `main` since the branch point renamed
  another file to `CLA-SIGNATORIES.md` (rename detection could then carry the pull request's change
  of that file into the register). The checker refuses with exit 2 when the test merge's register
  differs from the base's; the rebase's own rename detection is not observed. Such a rename on
  `main` would itself be a reviewed change of the CLA files.
- Markup that hides a line in the rendered page without a code block or an HTML comment (for
  example a `<details>` element) is not detected; the raw file is what counts.

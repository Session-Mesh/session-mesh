#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Maintain the previews of the showcase site in a checkout of the staging repository
# (Session-Mesh/site-staging, served by GitHub Pages): one folder pr-<number>/ per pull request.
# Used by .github/workflows/site-preview.yml and site-preview-cleanup.yml, which run it from a
# checkout of main, never from the pull request's branch; tests/site-preview-workflow.test.ts runs it.
#   site-preview.sh guard <pr> <head-sha>                          decide whether a run may publish
#   site-preview.sh publish <staged-dir> <checkout> <pr> [now]     copy a staged site into pr-<pr>/
#   site-preview.sh remove <checkout> <pr>                         delete pr-<pr>/
#   site-preview.sh expire <checkout> <days> [now]                 delete previews older than <days>
#   site-preview.sh expire-push <checkout> <days> [now]            expire and push, again on the new tip
#   site-preview.sh push <checkout>                                push, rebasing on a concurrent push
# Each change is one commit by the Actions bot. <checkout> is the root of a git worktree whose index
# is empty. `now` (epoch seconds) defaults to the current time; the tests pass it. A preview carries
# its publication time in pr-<pr>/.published and a robots noindex tag in its home page, so that
# search engines leave it out. `guard` asks GitHub (gh, GH_TOKEN, GITHUB_REPOSITORY) whether the pull
# request is still open and its head is <head-sha>, and writes proceed=true or proceed=false to
# $GITHUB_OUTPUT: a run for a closed pull request or an outdated revision must not publish.
set -euo pipefail

# The scratch folder of publish, removed on exit (global so that the exit trap sees it).
work=""

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

usage() {
  echo "usage: site-preview.sh guard <pr> <head-sha>" >&2
  echo "       site-preview.sh publish <staged-dir> <checkout> <pr> [now]" >&2
  echo "       site-preview.sh remove <checkout> <pr>" >&2
  echo "       site-preview.sh expire <checkout> <days> [now]" >&2
  echo "       site-preview.sh expire-push <checkout> <days> [now]" >&2
  echo "       site-preview.sh push <checkout>" >&2
  exit 2
}

# A pull request number or a count: digits only, so that it never names another path.
number() {
  [[ "$2" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "site-preview: $1 must be a positive number, got '$2'" >&2; exit 2; }
}

# The argument must be the root of a git worktree (not a sub-folder of one), with nothing staged, so
# that a commit holds the preview change alone.
checkout_dir() {
  local top given
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || { echo "site-preview: $1 is not a git checkout" >&2; exit 2; }
  given="$(cd "$1" && pwd -P)"
  [ "$given" = "$(cd "$top" && pwd -P)" ] || { echo "site-preview: $1 is not the root of its git worktree ($top)" >&2; exit 2; }
}

clean_index() {
  git -C "$1" diff --cached --quiet || { echo "site-preview: $1 has staged changes; refusing to commit them with a preview" >&2; exit 2; }
}

now_or() {
  if [ -n "${1:-}" ]; then number now "$1"; echo "$1"; else date +%s; fi
}

commit() {
  if git -C "$1" diff --cached --quiet; then echo "site-preview: nothing to change"; return 0; fi
  git -C "$1" commit -q -m "$2"
  echo "site-preview: $2"
}

guard() {
  [ "$#" -eq 2 ] || usage
  local pr="$1" head="$2" repo="${GITHUB_REPOSITORY:-}" live state sha
  number pr "$pr"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || { echo "site-preview: head must be a 40-digit hexadecimal revision, got '$head'" >&2; exit 2; }
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "site-preview: GITHUB_REPOSITORY is not owner/name" >&2; exit 2; }
  live="$(gh api "repos/$repo/pulls/$pr" -q '[.state,.head.sha]|@tsv')"
  state="${live%%$'\t'*}"
  sha="${live#*$'\t'}"
  local proceed=false
  if [ "$state" != "open" ]; then
    echo "::notice title=site-preview::pull request #$pr is $state, so no preview is published"
  elif [ "$sha" != "$head" ]; then
    echo "::notice title=site-preview::this run built $head but pull request #$pr is now at $sha; the run for that revision publishes"
  else
    proceed=true
  fi
  echo "site-preview: pull request #$pr is $state at $sha; proceed=$proceed"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "proceed=$proceed" >> "$GITHUB_OUTPUT"; fi
}

# Insert the robots tag after the first charset declaration (any case and spacing, self-closing or
# not) or, failing that, right after the first opening <head> tag; a match inside an HTML comment is
# skipped. perl does it because GNU and BSD sed differ on first-match and case-insensitive addresses;
# it is on the runners and on macOS.
insert_after_first() {
  ANCHOR="$2" TAG='<meta name="robots" content="noindex">' perl -0777 -i -pe '
    BEGIN { $done = 0 }
    s{(<!--(?:-?>|.*?(?:-->|\z)))|($ENV{ANCHOR})}{
      defined $1 ? $1 : ($done++ ? $2 : "$2\n$ENV{TAG}")
    }gise;
    END { $? = $done ? 0 : 3 }
  ' "$1"
}

add_robots_tag() {
  local page="$1"
  insert_after_first "$page" '<meta[[:space:]]+charset[[:space:]]*=[^>]*>' && return 0
  insert_after_first "$page" '<head([[:space:]][^>]*)?>' && return 0
  echo "site-preview: no <head> in the home page to anchor the robots tag" >&2
  return 1
}

# The replacement is built beside the checkout's files first and swapped in only once complete, so
# that a refused page leaves the previous preview in place.
publish() {
  [ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
  local staged="$1" checkout="$2" pr="$3" now
  number pr "$pr"
  now="$(now_or "${4:-}")"
  checkout_dir "$checkout"
  clean_index "$checkout"
  [ -f "$staged/index.html" ] || { echo "site-preview: $staged/index.html missing" >&2; exit 2; }
  if [ -n "$(find "$staged" -type l -print -quit)" ]; then echo "site-preview: $staged holds a symbolic link" >&2; exit 2; fi
  work="$(mktemp -d "$(git -C "$checkout" rev-parse --absolute-git-dir)/preview-XXXXXX")"
  trap 'rm -rf "${work:-}"' EXIT
  cp -a "$staged"/. "$work"/
  add_robots_tag "$work/index.html" || exit 1
  rm -f "$work/CNAME"
  echo "$now" > "$work/.published"
  rm -rf "${checkout:?}/pr-$pr"
  mv "$work" "$checkout/pr-$pr"
  git -C "$checkout" add -A -- "pr-$pr"
  commit "$checkout" "Publish the preview of pull request #$pr"
}

remove() {
  [ "$#" -eq 2 ] || usage
  local checkout="$1" pr="$2"
  number pr "$pr"
  checkout_dir "$checkout"
  clean_index "$checkout"
  if [ ! -e "$checkout/pr-$pr" ]; then echo "site-preview: no preview of pull request #$pr"; return 0; fi
  git -C "$checkout" rm -r -q --ignore-unmatch -- "pr-$pr"
  rm -rf "${checkout:?}/pr-$pr"
  commit "$checkout" "Remove the preview of pull request #$pr"
}

expire() {
  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
  local checkout="$1" days="$2" now
  number days "$days"
  now="$(now_or "${3:-}")"
  checkout_dir "$checkout"
  clean_index "$checkout"
  local limit=$((now - days * 86400)) dir name stamp removed=0
  for dir in "$checkout"/pr-*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [[ "$name" =~ ^pr-[1-9][0-9]*$ ]] || continue
    stamp="$(cat "$dir/.published" 2>/dev/null || true)"
    # A preview without a valid publication time is as good as expired.
    if [[ "$stamp" =~ ^[0-9]{1,12}$ ]] && [ "$stamp" -ge "$limit" ]; then continue; fi
    git -C "$checkout" rm -r -q --ignore-unmatch -- "$name"
    rm -rf "${checkout:?}/$name"
    removed=$((removed + 1))
  done
  if [ "$removed" -eq 0 ]; then echo "site-preview: no preview older than $days days"; return 0; fi
  commit "$checkout" "Expire $removed preview(s) older than $days days"
}

# Previews of different pull requests live in different folders, so a push refused because another
# run pushed first is rebased and tried again; a real conflict (the same folder) fails the run.
push() {
  [ "$#" -eq 1 ] || usage
  local checkout="$1" branch attempt
  checkout_dir "$checkout"
  branch="$(git -C "$checkout" symbolic-ref --short HEAD)"
  for attempt in 1 2 3; do
    if git -C "$checkout" push -q origin "HEAD:refs/heads/$branch"; then echo "site-preview: pushed"; return 0; fi
    echo "site-preview: push refused (attempt $attempt), rebasing on $branch"
    if ! git -C "$checkout" pull -q --rebase origin "$branch"; then
      git -C "$checkout" rebase --abort 2>/dev/null || true
      echo "site-preview: conflict with a concurrent change of the staging repository" >&2
      return 1
    fi
  done
  echo "site-preview: push still refused after 3 attempts" >&2
  return 1
}

# An expiry decision depends on the files it reads (a preview refreshed meanwhile must stay), so
# when the push is refused the local commit is dropped, the checkout moves to the new tip of the
# branch and the selection runs again there, up to three times.
expire_push() {
  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
  local checkout="$1" days="$2" now attempt branch
  number days "$days"
  now="$(now_or "${3:-}")"
  checkout_dir "$checkout"
  branch="$(git -C "$checkout" symbolic-ref --short HEAD)"
  # The retry resets the branch to the remote tip, so it must not hold a commit of another command.
  if [ -n "$(git -C "$checkout" rev-list -n 1 "origin/$branch..HEAD" 2>/dev/null)" ]; then
    echo "site-preview: $checkout holds commits not on origin/$branch; expire-push needs a fresh checkout" >&2
    exit 2
  fi
  for attempt in 1 2 3; do
    expire "$checkout" "$days" "$now"
    if git -C "$checkout" push -q origin "HEAD:refs/heads/$branch"; then echo "site-preview: pushed"; return 0; fi
    echo "site-preview: push refused (attempt $attempt), expiring again on the new tip of $branch"
    git -C "$checkout" fetch -q origin "$branch"
    git -C "$checkout" checkout -q -B "$branch" FETCH_HEAD
  done
  echo "site-preview: push still refused after 3 attempts" >&2
  return 1
}

[ "$#" -ge 1 ] || usage
command="$1"
shift
case "$command" in
  guard) guard "$@" ;;
  publish) publish "$@" ;;
  remove) remove "$@" ;;
  expire) expire "$@" ;;
  expire-push) expire_push "$@" ;;
  push) push "$@" ;;
  *) usage ;;
esac

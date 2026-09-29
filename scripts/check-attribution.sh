#!/bin/sh
# Attribution integrity check.
#
# Purpose: prevent an AI tool identity from being recorded as a Git
# contributor. GitHub derives the contributors graph from commit metadata,
# so a single `Co-authored-by: Claude ...` trailer is enough to create a
# permanent contributor entry that later needs a history rewrite to remove.
#
# Scope is deliberately narrow. This check reads ONLY commit metadata:
# author identity, committer identity, and Co-authored-by trailers. It
# never reads file contents, so documentation, prose, or a legitimate
# human co-author is never rejected. Mentioning an AI product in a commit
# message body is not attribution and is not flagged.
#
# Usage:
#   scripts/check-attribution.sh [rev-range]
#
# With no argument every commit reachable from HEAD is checked, which
# also re-validates the repository's full history.

set -eu

RANGE="${1:-HEAD}"
rc=0
checked=0

# AI identities that must never appear as author, committer, or co-author.
# Matched case-insensitively against the full "Name <email>" identity.
identity_is_ai() {
  _who=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$_who" in
    *claude* | *anthropic* | *opencode* | *copilot* | *gpt-* | *gemini*)
      return 0
      ;;
  esac
  case "$_who" in
    *@anthropic.com* | *@opencode.ai* | *@noreply.github.com* | *users.noreply.github.com*)
      return 0
      ;;
  esac
  return 1
}

# Walk SHAs and inspect each commit object directly. Per-commit `git show`
# keeps the trailer check anchored to real commit metadata rather than to
# the output of one large log stream.
for sha in $(git rev-list "$RANGE"); do
  checked=$((checked + 1))
  author=$(git show -s --format='%an <%ae>' "$sha")
  committer=$(git show -s --format='%cn <%ce>' "$sha")
  subject=$(git show -s --format='%s' "$sha")

  if identity_is_ai "$author"; then
    printf 'FAIL %s: AI author identity: %s\n' "$sha" "$author" >&2
    printf '      subject: %s\n' "$subject" >&2
    rc=1
  fi

  if identity_is_ai "$committer"; then
    printf 'FAIL %s: AI committer identity: %s\n' "$sha" "$committer" >&2
    printf '      subject: %s\n' "$subject" >&2
    rc=1
  fi

  # Co-authored-by trailers only, never the free-text body.
  git show -s --format='%B' "$sha" |
    grep -i '^co-authored-by:' |
    while IFS= read -r trailer; do
      if identity_is_ai "$trailer"; then
        printf 'FAIL %s: AI co-author trailer: %s\n' "$sha" "$trailer" >&2
        printf '      subject: %s\n' "$subject" >&2
        exit 1
      fi
    done || rc=1
done

if [ "$rc" -ne 0 ]; then
  printf '\nAttribution check FAILED.\n' >&2
  printf 'AI tooling must never be recorded as author, committer, or co-author.\n' >&2
  printf 'Remove the trailer with "git commit --amend" (use --no-edit) and try again.\n' >&2
  printf 'See CONTRIBUTING.md#authorship-and-attribution.\n' >&2
  exit 1
fi

printf 'attribution: %s commit(s) checked, no AI author/committer/co-author found\n' "$checked"

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
#
# The deny list is deliberately restricted to identities that are *evidence of
# AI authorship*.  An earlier version of this script also rejected any address
# containing "noreply.github.com" or "users.noreply.github.com", on the theory
# that a noreply address looked machine-made.  That is wrong: GitHub issues
# `ID+USERNAME@users.noreply.github.com` to every human who enables "Keep my
# email addresses private", and it is the canonical address of bots including
# Dependabot itself.  The check therefore failed PR #15
# (dependabot/github_actions/actions-0e3d324e1b) on a commit authored by
# `dependabot[bot] <...@users.noreply.github.com>`, and would have rejected any
# legitimate privacy-preserving human co-author as well.
#
# Noreply addresses are now allowed.  Only these specific identities fail:
identity_is_ai() {
  _who=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  # Vendors and products.  These are specific enough that a real person's
  # name would have to contain the product name verbatim to collide.
  case "$_who" in
    *claude* | *anthropic* | *opencode* | *copilot* | *cursor* | *windsurf* | *devin* | *aider* | *gemini* | *codeium* | *tabnine*)
      return 0
      ;;
  esac
  # OpenAI-style author strings, e.g. "gpt-4" / "GPT-4o" in a bot name.
  case "$_who" in
    *gpt-3* | *gpt-4* | *gpt-5* | *"openai"* | *chatgpt*)
      return 0
      ;;
  esac
  # AI-specific email domains.  `anthropic.com` and `openai.com` are only ever
  # present on an AI identity; no GitHub-hosted human identity uses them.
  case "$_who" in
    *@anthropic.com* | *@openai.com* | *@opencode.ai* | *@copilot.*)
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

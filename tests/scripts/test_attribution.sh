#!/bin/sh
# Attribution gate contract tests.
#
# WHY THIS SUITE EXISTS
# ---------------------
# `scripts/check-attribution.sh` is a CI gate on commit metadata.  It exists to
# stop an AI tool identity from being recorded as a GitHub contributor, because
# GitHub derives the contributors graph from commit metadata and a single
# `Co-authored-by:` trailer is effectively permanent.
#
# An earlier version of the gate also rejected any identity containing
# `noreply.github.com`.  That is not evidence of AI authorship: GitHub issues
# `<id>+<login>@users.noreply.github.com` to every human who enables "Keep my
# email addresses private", and it is the address Dependabot commits with.  The
# over-broad rule failed PR #15, a Dependabot branch, on a commit the bot itself
# authored.  These tests pin the corrected boundary so the regression cannot
# come back unnoticed in either direction.
#
# The tests build throwaway repositories in a temporary directory.  They never
# write to the real repository and never create a commit in it.
#
# Usage: sh tests/scripts/test_attribution.sh [path/to/check-attribution.sh]

set -eu

SCRIPT="${1:-scripts/check-attribution.sh}"
case "$SCRIPT" in
  /*) ;;
  *) SCRIPT="$(pwd)/$SCRIPT" ;;
esac

if [ ! -f "$SCRIPT" ]; then
  printf 'test_attribution: cannot find %s\n' "$SCRIPT" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

passed=0
failed=0

# Create a repository whose single commit has the given author/committer
# identity and body.  Echoes the repository directory.
make_repo() {
  _author="$1"
  _email="$2"
  _body="${3:-subject line}"
  _dir="$TMP/repo$((passed + failed + 1))"
  mkdir -p "$_dir"
  git -C "$_dir" init -q
  git -C "$_dir" -c user.name="Test" -c user.email="test@example.invalid" \
    commit -q --allow-empty --no-gpg-sign \
    --author="$_author <$_email>" \
    -m "$_body" >/dev/null 2>&1
  printf '%s' "$_dir"
}

# The gate walks `git rev-list HEAD` in the *current* working directory, so
# every assertion runs it from inside the throwaway repository.
expect_pass_in() {
  _label="$1"
  _dir="$2"
  if ( cd "$_dir" && sh "$SCRIPT" HEAD >/dev/null 2>&1 ); then
    printf 'ok       accept %s\n' "$_label"
    passed=$((passed + 1))
  else
    printf 'NOT OK   accept %s (gate rejected a legitimate identity)\n' "$_label" >&2
    failed=$((failed + 1))
  fi
}

expect_fail_in() {
  _label="$1"
  _dir="$2"
  if ( cd "$_dir" && sh "$SCRIPT" HEAD >/dev/null 2>&1 ); then
    printf 'NOT OK   reject %s (gate allowed a prohibited identity)\n' "$_label" >&2
    failed=$((failed + 1))
  else
    printf 'ok       reject %s\n' "$_label"
    passed=$((passed + 1))
  fi
}

# --------------------------------------------------------------- must accept

# 1. An ordinary human with a normal address.
d=$(make_repo "Karka Shivareddy" "karka@example.com")
expect_pass_in "human author with a normal email address" "$d"

# 2. A human who enabled GitHub's "Keep my email addresses private".  This is
#    the case the over-broad rule broke.
d=$(make_repo "Karka Shivareddy" "12345678+karka@users.noreply.github.com")
expect_pass_in "human author with a GitHub noreply address" "$d"

# 3. The legacy form of the same address.
d=$(make_repo "Karka Shivareddy" "karka@users.noreply.github.com")
expect_pass_in "human author with a legacy GitHub noreply address" "$d"

# 4. Dependabot itself.  PR #15 was failed by exactly this identity.
d=$(make_repo "dependabot[bot]" "49699333+dependabot[bot]@users.noreply.github.com")
expect_pass_in "dependabot bot author" "$d"

# 5. A legitimate human co-author trailer, including one on a noreply address.
d=$(make_repo "Karka Shivareddy" "karka@example.com" \
  "subject

Co-authored-by: Reviewer Person <98765+reviewer@users.noreply.github.com>")
expect_pass_in "human co-author trailer on a noreply address" "$d"

# 6. A commit whose *message body* merely mentions an AI product.  The gate
#    reads metadata, not prose, so documentation commits must not be rejected.
d=$(make_repo "Karka Shivareddy" "karka@example.com" \
  "docs: document that the gateway refuses Claude-style attribution")
expect_pass_in "prose mentioning an AI product in the body" "$d"

# --------------------------------------------------------------- must reject

# 7. An AI tool as the commit author.
d=$(make_repo "Claude" "noreply@anthropic.com")
expect_fail_in "AI author identity (anthropic)" "$d"

# 8. An AI tool as the committer.
d=$(make_repo "Karka Shivareddy" "karka@example.com")
( cd "$d" && git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
    commit -q --amend --no-edit --allow-empty --reset-author --no-gpg-sign \
    >/dev/null 2>&1 ) || true
expect_fail_in "AI committer identity" "$d"

# 9. A Co-authored-by trailer naming an AI tool.  This is the specific case
#    that creates a permanent GitHub contributor entry.
d=$(make_repo "Karka Shivareddy" "karka@example.com" \
  "subject

Co-authored-by: Claude <noreply@anthropic.com>")
expect_fail_in "AI co-author trailer" "$d"

# 10. Other named AI tools, to keep the deny list from being one entry deep.
for ident in "GitHub Copilot copilot@github.com" "opencode bot@opencode.ai" \
             "Gemini Assistant gemini@google.com" "GPT-4 gpt-4@openai.com" \
             "Cursor cursor@cursor.sh"; do
  set -- $ident
  d=$(make_repo "$1" "$2")
  expect_fail_in "AI author identity ($1)" "$d"
done

# ------------------------------------------------------------------ summary

printf '\n%d passed, %d failed\n' "$passed" "$failed"
if [ "$failed" -ne 0 ]; then
  printf 'ATTRIBUTION GATE TESTS FAILED\n' >&2
  exit 1
fi
printf 'ATTRIBUTION GATE TESTS PASSED\n'

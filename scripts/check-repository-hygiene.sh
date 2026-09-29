#!/bin/sh
# Repository hygiene: nothing generated, nothing local, nothing secret.
#
# The point is not to police style. It is to stop the class of file that makes
# a systems repository untrustworthy: a committed database, a build artifact, a
# screenshot of somebody's home directory, or a .env with a real token in it.
set -eu

fail=0
note() { printf '  %-58s %s\n' "$1" "$2"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

printf 'Repository hygiene\n'

# ---------------------------------------------------------------- artifacts
# Tracked files that a build or a run produces. These must be ignored, and
# they must never be committed: a committed binary is invisible in a diff and
# a committed database is a copy of somebody's real workload history.
artifacts='(^|/)(node_modules|dist|build)/|\.db$|\.db-(wal|shm)$|\.o$|\.d$|(^|/)caps$|(^|/)caps-asan$|\.exe$|\.pptx$|\.log$|\.tsbuildinfo$|^\.env($|\.)|\.pem$|\.key$'
tracked=$(git ls-files)
if [ -n "$tracked" ]; then
  hits=$(printf '%s\n' "$tracked" | grep -E "$artifacts" || true)
  if [ -n "$hits" ]; then
    printf 'FAIL tracked build/generated files:\n%s\n' "$hits" | sed 's/^/  /'
    fail=1
  else
    note "no tracked build artifacts, databases, or binaries" OK
  fi
fi

# The corresponding .gitignore coverage, so the next person does not have to
# rediscover it.
for pattern in 'node_modules/' '/build/' 'data/' '*.db' 'caps'; do
  if grep -qF -- "$pattern" .gitignore; then
    note ".gitignore covers $pattern" OK
  else
    bad ".gitignore does not cover $pattern"
  fi
done

# ------------------------------------------------------------- local paths
# An absolute path from one developer's machine is a leak of their directory
# layout at best and a broken path at worst. Repository-relative and generic
# absolute paths (/usr/bin, /proc) are fine.
localpaths='[A-Za-z]:\\\\?(Users|home)\\\\|/Users/[a-z]|/home/[a-z][a-z0-9_-]*/(Desktop|Documents|Downloads)|AppData'
hits=$(git grep -InE "$localpaths" -- . ':!docs/audit' 2>/dev/null || true)
if [ -n "$hits" ]; then
  printf 'FAIL local path references:\n%s\n' "$hits" | head -20 | sed 's/^/  /'
  fail=1
else
  note "no local machine paths in tracked source" OK
fi

# ---------------------------------------------------------------- secrets
# Only obvious shapes, checked against tracked content. This is a backstop,
# not a secret scanner; the real control is that the gateway never reads a
# token from a file and never logs one.
hits=$(git grep -InE '(BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|sk-[A-Za-z0-9]{32,})' -- . 2>/dev/null || true)
if [ -n "$hits" ]; then
  printf 'FAIL possible committed secret:\n%s\n' "$hits" | sed 's/^/  /'
  fail=1
else
  note "no committed private key or cloud token pattern" OK
fi

# The gateway must not log a token even if one is configured.
if grep -rn "authToken" web/backend/src --include=*.ts | grep -E 'logger\.(info|warn|error|debug)' >/dev/null 2>&1; then
  bad "the auth token appears in a log call"
else
  note "the auth token is never passed to the logger" OK
fi

# -------------------------------------------------------------- merge state
if [ -f .git/MERGE_HEAD ]; then
  bad "an unresolved merge is in progress"
else
  note "no unresolved merge in progress" OK
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
  echo "REPOSITORY HYGIENE FAILED"
  exit 1
fi
echo "Repository hygiene checks passed"

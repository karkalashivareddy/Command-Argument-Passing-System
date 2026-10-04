#!/bin/bash
#
# Does check-version.sh actually detect drift?
#
# A gate that only ever prints PASS proves nothing: the failure mode that matters
# is a drifted version being reported as consistent. So this deliberately breaks
# each location in turn, on a COPY of the tree, and requires the gate to fail
# each time.
#
# Working on a copy is essential. Inducing drift in the real repository to test
# the gate would leave the tree modified if the script were interrupted, and a
# version check that can corrupt the version is not a check.
set -u

# node must be on PATH. The gate itself uses node to read JSON, so without it
# every JSON check reports "<unreadable>" and the gate fails on a pristine tree
# -- which looks like a version drift and is not one.
#
# This test is invoked as `bash scripts/check-version.test.sh` from a shell that
# may not have node exported, so it locates node the same way the Makefile does
# rather than assuming.
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node is required to run this test; the gate reads JSON with it" >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$SRC/scripts/check-version.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf 'PASS: %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'FAIL: %s\n' "$1"; fail=$((fail+1)); }

# Build a fresh copy for one mutation.
fresh() {
  rm -rf "$WORK/tree"
  mkdir -p "$WORK/tree"
  # Only the files the gate reads, so the copy is cheap and cannot be affected
  # by anything else in the tree.
  mkdir -p "$WORK/tree/scripts" "$WORK/tree/include" "$WORK/tree/web/backend/src/config"
  cp "$SRC/scripts/check-version.sh" "$WORK/tree/scripts/"
  cp "$SRC/include/version.h" "$WORK/tree/include/"
  cp "$SRC/README.md" "$WORK/tree/"
  cp "$SRC/CHANGELOG.md" "$WORK/tree/"
  for d in backend frontend; do
    mkdir -p "$WORK/tree/web/$d"
    cp "$SRC/web/$d/package.json" "$WORK/tree/web/$d/"
    cp "$SRC/web/$d/package-lock.json" "$WORK/tree/web/$d/"
  done
  cp "$SRC/web/backend/src/config/env.ts" "$WORK/tree/web/backend/src/config/"
}

# Confirm a mutation actually landed before judging the gate.
#
# Without this, a mutation that fails to apply -- a bad pattern, a typo -- is
# indistinguishable from a gate that does not work: both leave the tree correct
# and both make the gate pass. Asserting the mutation landed is what makes a
# gate failure mean something.
require_mutation_applied() {
  if grep -q -F -- "$2" "$1"; then
    ok "mutation landed in $1 before testing the gate"
  else
    bad "MUTATION DID NOT APPLY to $1, so this case would prove nothing"
  fi
}

# Run the gate against the copy and report whether it noticed.
expect_fail() {
  local label="$1"
  if sh "$WORK/tree/scripts/check-version.sh" >/dev/null 2>&1; then
    bad "$label was NOT detected; the gate reported a drifted version as consistent"
  else
    ok "$label is detected"
  fi
}

expect_pass() {
  local label="$1"
  if sh "$WORK/tree/scripts/check-version.sh" >/dev/null 2>&1; then
    ok "$label"
  else
    bad "$label; the gate fails on an unmodified copy, so its PASS means nothing"
  fi
}

echo "== the gate passes on an unmodified copy =="
fresh
expect_pass "an unmodified tree passes"

echo
echo "== each location is actually checked =="

# Use node to edit JSON, because a lockfile is JSON and sed would corrupt it.
bump() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = "9.9.9";
    if (j.packages && j.packages[""]) j.packages[""].version = "9.9.9";
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$1"
}

for target in web/backend/package.json web/frontend/package.json web/backend/package-lock.json web/frontend/package-lock.json; do
  fresh
  bump "$WORK/tree/$target"
  expect_fail "a drift in $target"
done

fresh
sed -i 's/"2.0.0"/"9.9.9"/' "$WORK/tree/web/backend/src/config/env.ts" 2>/dev/null || true
sed -i 's/PRODUCT_VERSION = "2.0.0"/PRODUCT_VERSION = "9.9.9"/' "$WORK/tree/web/backend/src/config/env.ts"
# The header is generated FROM the constant, so it will now disagree too. That is
# the drift this check exists to catch, and both failures are expected.
expect_fail "a drift in PRODUCT_VERSION itself"

fresh
sed -i 's/CAPS_VERSION "2.0.0"/CAPS_VERSION "9.9.9"/' "$WORK/tree/include/version.h"
expect_fail "a stale generated C header"

fresh
# Node rather than sed. A BRE pattern containing `\*` is a quantifier, and sed
# rejects it outright -- so the file silently went unmodified and the gate was
# cleared for the wrong reason. A literal string replace has no such ambiguity.
node -e '
const fs = require("fs");
const f = process.argv[1];
const before = fs.readFileSync(f, "utf8");
const after = before.replace("**Version: 2.0.0**", "**Version: 9.9.9**");
if (after === before) process.exit(2);
fs.writeFileSync(f, after);
' "$WORK/tree/README.md"
require_mutation_applied "$WORK/tree/README.md" '**Version: 9.9.9**'
expect_fail "a stale README version marker"

fresh
sed -i 's/^## 2.0.0 /## 9.9.9 /' "$WORK/tree/CHANGELOG.md"
expect_fail "a CHANGELOG whose newest entry is not the current version"

echo
echo "== the gate is not satisfied by an old version appearing anywhere =="
fresh
# A stale version mentioned in prose must not satisfy the marker check.
node -e '
const fs = require("fs");
fs.appendFileSync(process.argv[1], "\n**Version: 1.1.1**\n");
' "$WORK/tree/README.md"
require_mutation_applied "$WORK/tree/README.md" '**Version: 1.1.1**'
expect_fail "a README marker naming an older release"

echo
echo "== the gate works from any working directory =="
fresh
if (cd /tmp && sh "$WORK/tree/scripts/check-version.sh" >/dev/null 2>&1); then
  ok "the gate resolves its own location when invoked from elsewhere"
else
  bad "the gate fails when invoked from another directory, so it is not location-independent"
fi

fresh
if (cd /tmp && sed -i 's/CAPS_VERSION "2.0.0"/CAPS_VERSION "9.9.9"/' "$WORK/tree/include/version.h" && cd /tmp && sh "$WORK/tree/scripts/check-version.sh" >/dev/null 2>&1); then
  bad "the gate missed a drift when invoked from another directory"
else
  ok "the gate still detects drift when invoked from another directory"
fi

echo
printf 'TOTAL: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

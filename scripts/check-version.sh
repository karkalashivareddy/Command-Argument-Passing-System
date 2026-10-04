#!/bin/sh
# One version, one source, checked in CI.
#
# WHY A GENERATED FILE AND NOT A RUNTIME LOOKUP
# ---------------------------------------------
# `web/backend/src/config/env.ts` holds PRODUCT_VERSION and the C engine reads
# a header generated from it. The problem is that a generated file is a copy, and
# a copy drifts silently: someone edits PRODUCT_VERSION, forgets to regenerate,
# and the engine reports a different version from the gateway that spawned it.
# The drift is invisible until a bug report quotes two different numbers.
#
# So this script checks the copies rather than trusting them. It is deliberately
# exhaustive about WHERE the version appears, because each place it can hide is a
# place a reader will eventually consult:
#
#   - the backend package manifest, which npm publishes
#   - the frontend package manifest, which npm publishes
#   - the backend lockfile, which is what `npm ci` installs from
#   - the frontend lockfile
#   - the generated C header, which the engine compiles in
#   - README.md, which is the first thing a reader sees
#   - CHANGELOG.md, which claims to record this release
#
# A version that appears in one place and not another is not a cosmetic
# inconsistency. It is two claims about which software is running.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Recorded so a failure report says which checkout was checked. Two checkouts of
# the same branch producing different results is otherwise very confusing.
echo "checking $ROOT"

SOURCE="web/backend/src/config/env.ts"
HEADER="include/version.h"

rc=0

# node must be on PATH. A gate that cannot read the JSON manifests
# reports all four as "<unreadable>", which looks exactly like a version drift and
# is not one -- the failure mode this script had more than once.
#
# The Makefile exports node's directory, so this is only a fallback for a bare
# `sh scripts/check-version.sh` invocation.
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
  echo "FATAL: node is required; the manifest and README checks parse JSON with it" >&2
  exit 1
fi


# ---------------------------------------------------------------------------
# 1. Read the authoritative version.
# ---------------------------------------------------------------------------
if [ ! -f "$SOURCE" ]; then
  echo "FAIL $SOURCE does not exist; there is no authoritative version to check against"
  exit 1
fi

version=$(sed -n 's/^export const PRODUCT_VERSION = "\([0-9][0-9.]*\)";.*/\1/p' "$SOURCE" | head -1)
if [ -z "$version" ]; then
  echo "FAIL could not read PRODUCT_VERSION from $SOURCE"
  exit 1
fi

case "$version" in
  *[!0-9.]*) echo "FAIL PRODUCT_VERSION \"$version\" is not a dotted numeric version"; rc=1 ;;
  *.*.*) : ;;
  *) echo "FAIL PRODUCT_VERSION \"$version\" needs at least major.minor.patch"; rc=1 ;;
esac

echo "authoritative version: $version (from $SOURCE)"

# ---------------------------------------------------------------------------
# 2. Every place that must agree.
# ---------------------------------------------------------------------------
# Each entry is "path|how to extract". `:` in a path would break the split, and
# no path here contains one.
# Each manifest is read with node rather than grepped, because a lockfile is
# JSON and its version appears in more than one place. Reading it is also the only
# way to be sure the file is parseable at all.
#
# node writes the version with NO trailing newline, so `$(...)` captures it
# exactly. An earlier version of this block used `printf '%s'`-style output
# through a helper whose exit status was swallowed, so a successful read looked
# like an empty string and four files reported "<unreadable>" while parsing
# perfectly well.
json_version() {
  # The argument is passed through the environment rather than interpolated
  # into the program text. A path containing a quote or a space would otherwise
  # change the program, and a path containing `$` or a backtick would be
  # expanded by the shell before node ever saw it -- which is how a read that
  # looks like it failed actually succeeded on the wrong file.
  CAPS_VERSION_FILE="$ROOT/$1" node -e 'process.stdout.write(String(require(process.env.CAPS_VERSION_FILE).version))'
}

for spec in \
  "web/backend/package.json:backend/package.json" \
  "web/frontend/package.json:frontend/package.json" \
  "web/backend/package-lock.json:backend/package-lock.json" \
  "web/frontend/package-lock.json:frontend/package-lock.json"
do
  jf="${spec%%:*}"
  label="${spec##*:}"
  if [ ! -f "$jf" ]; then
    printf 'FAIL %-46s missing\n' "$label"
    rc=1
    continue
  fi
  found="$(json_version "$jf" 2>/dev/null || true)"
  if [ "$found" != "$version" ]; then
    printf 'FAIL %-46s %s (expected %s)\n' "$label" "${found:-<unreadable>}" "$version"
    rc=1
  else
    printf '  %-46s %s\n' "$label" "$version"
  fi
done

# ---------------------------------------------------------------------------
# 3. The C engine's generated header.
# ---------------------------------------------------------------------------
if [ ! -f "$HEADER" ]; then
  printf 'FAIL %-46s missing; run scripts/generate-version.sh\n' "$HEADER"
  rc=1
else
  header_version=$(sed -n 's/^#define CAPS_VERSION "\([^"]*\)".*/\1/p' "$HEADER" | head -1)
  if [ "$header_version" != "$version" ]; then
    printf 'FAIL %-46s %s (expected %s). Run: scripts/generate-version.sh\n' "$HEADER" "${header_version:-<none>}" "$version"
    rc=1
  else
    printf '  %-46s %s\n' "$HEADER" "$version"
  fi
fi

# ---------------------------------------------------------------------------
# 4. The documents a reader is most likely to quote.
# ---------------------------------------------------------------------------
# The README is checked for a CURRENT version marker rather than for the absence
# of the old one, because the README legitimately mentions superseded releases
# in its history section. The marker is what a reader takes as the answer.
if [ -f README.md ]; then
  # EVERY marker is read, not just the first, and they must all agree.
  #
  # Taking only the first line means a second marker elsewhere in the document
  # goes unchecked, so a README carrying both 2.0.0 and 1.1.1 markers would be
  # reported as consistent. A reader who finds two different version claims in
  # one document has been given two answers, and that is the defect here.
  #
  # The scan runs in node rather than sed because the marker is `**Version: x**`
  # and a BRE cannot spell a literal `**` after a group without escaping each
  # asterisk; getting that wrong makes sed abort, output nothing, and report the
  # marker as absent. In a regex the asterisks are literal and a missing match is
  # distinguishable from a failed read.
  readme_versions=$(CAPS_README="$ROOT/README.md" node -e '
const FS = require("fs");
const text = FS.readFileSync(process.env.CAPS_README, "utf8").replace(/\r/g, "");
const found = new Set();
for (const line of text.split("\n")) {
  const m = /^\*\*Version:\s*([0-9][0-9.]*)\*\*/.exec(line);
  if (m !== null) found.add(m[1]);
}
process.stdout.write([...found].sort().join("\n"));
' 2>/dev/null || echo "")
  readme_version=$(printf '%s\n' "$readme_versions" | sed -n '1p')
  if [ -z "$readme_version" ]; then
    printf 'FAIL %-46s has no "**Version:** x.y.z" marker to check\n' "README.md"
    rc=1
  elif [ "$(printf '%s\n' "$readme_versions" | wc -l | tr -d ' ')" -gt 1 ]; then
    printf 'FAIL %-46s declares more than one version: %s\n' "README.md" "$(printf '%s' "$readme_versions" | tr '\n' ' ')"
    rc=1
  elif [ "$readme_version" != "$version" ]; then
    printf 'FAIL %-46s %s (expected %s)\n' "README.md" "$readme_version" "$version"
    rc=1
  else
    printf '  %-46s %s\n' "README.md" "$version"
  fi
fi

if [ -f CHANGELOG.md ]; then
  # The changelog's newest entry names the release. Anything else would mean the
  # version was bumped without a changelog entry, which is how a release ships
  # unrecorded.
  # CRLF-safe for the same reason as the README check.
  top_version=$(tr -d '\r' < CHANGELOG.md | sed -n 's/^## \[\?\([0-9][0-9.]*\)\]\?.*/\1/p' | head -1)
  if [ -z "$top_version" ]; then
    printf 'FAIL %-46s has no parseable "## x.y.z" heading\n' "CHANGELOG.md"
    rc=1
  elif [ "$top_version" != "$version" ]; then
    printf 'FAIL %-46s newest entry is %s (expected %s). Every release needs one.\n' "CHANGELOG.md" "$top_version" "$version"
    rc=1
  else
    printf '  %-46s %s\n' "CHANGELOG.md" "$version"
  fi
fi

# ---------------------------------------------------------------------------
# 5. The API's advertised version comes from the same constant.
# ---------------------------------------------------------------------------
# Not a separate check: PRODUCT_VERSION IS what the API serves, so verifying the
# constant is verifying the response. The comment here records why no further
# check is needed.
echo "  /api/health and /api/capabilities serve PRODUCT_VERSION by construction"

if [ "$rc" -ne 0 ]; then
  echo ""
  echo "VERSION CHECK FAILED"
  echo "Authoritative source: $SOURCE"
  echo "Fix: edit PRODUCT_VERSION there, then run scripts/generate-version.sh, then"
  echo "update both package manifests and CHANGELOG.md."
  exit 1
fi

echo ""
echo "Version is consistent across every declared location: $version"

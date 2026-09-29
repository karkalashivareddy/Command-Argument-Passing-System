#!/bin/sh
# Generate include/version.h from the single canonical product version.
#
# CAPS_VERSION used to be a hard-coded literal in src/main.c that said 0.1.0
# while the gateway and both npm packages said 1.0.0, so `caps --version` and
# the running service described different products. The canonical source is
# PRODUCT_VERSION in web/backend/src/config/env.ts; this script projects it
# into the C engine, and scripts/check-lockfiles.sh verifies the two agree.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$ROOT/web/backend/src/config/env.ts"
OUT="$ROOT/include/version.h"

if [ ! -f "$SOURCE" ]; then
  echo "cannot find the canonical version source: $SOURCE" >&2
  exit 1
fi

version=$(sed -n 's/^export const PRODUCT_VERSION = "\([0-9][0-9.]*\)";.*/\1/p' "$SOURCE" | head -1)
if [ -z "$version" ]; then
  echo "could not read PRODUCT_VERSION from $SOURCE" >&2
  exit 1
fi

cat > "$OUT" <<EOF
/* GENERATED FILE - do not edit.
 *
 * Produced by scripts/generate-version.sh from
 * web/backend/src/config/env.ts (PRODUCT_VERSION).
 * Regenerate with: make version
 */
#ifndef CAPS_VERSION_H
#define CAPS_VERSION_H

#define CAPS_VERSION "$version"

#endif /* CAPS_VERSION_H */
EOF

printf 'include/version.h: CAPS_VERSION "%s"\n' "$version"

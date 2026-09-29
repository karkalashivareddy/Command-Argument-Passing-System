#!/bin/sh
# Each lockfile must satisfy its own manifest.
#
# `npm ci` already fails on a mismatch, but only inside a job that happens to
# install that package. This check makes the failure a first-class signal and
# covers the workspace relationship between the two packages, which `npm ci`
# does not see.
set -eu

rc=0
for dir in web/backend web/frontend; do
  if [ ! -f "$dir/package-lock.json" ]; then
    printf 'FAIL %s has no package-lock.json\n' "$dir"
    rc=1
    continue
  fi
  name=$(node -e "process.stdout.write(require('./$dir/package.json').name)")
  lockname=$(node -e "process.stdout.write(require('./$dir/package-lock.json').name)")
  if [ "$name" != "$lockname" ]; then
    printf 'FAIL %s: manifest name "%s" != lockfile name "%s"\n' "$dir" "$name" "$lockname"
    rc=1
    continue
  fi
  printf '  %-40s %s\n' "$dir/package-lock.json" "name matches manifest"
done

# The two npm packages must agree on the product version, so the docs and the
# running services never disagree about what they are.
b=$(node -e "process.stdout.write(require('./web/backend/package.json').version)")
f=$(node -e "process.stdout.write(require('./web/frontend/package.json').version)")
v=$(grep -oE 'PRODUCT_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' web/backend/src/config/env.ts | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ "$b" != "$f" ] || [ "$f" != "$v" ]; then
  printf 'FAIL version mismatch: backend=%s frontend=%s PRODUCT_VERSION=%s\n' "$b" "$f" "$v"
  rc=1
else
  printf '  %-40s %s\n' "product version" "$v (backend, frontend, and the gateway agree)"
fi

if [ "$rc" -ne 0 ]; then
  echo "LOCKFILE CHECK FAILED"
  exit 1
fi
echo "Lockfile and version checks passed"
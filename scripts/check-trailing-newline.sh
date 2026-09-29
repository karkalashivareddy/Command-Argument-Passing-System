#!/bin/sh
# Every tracked text file ends with exactly one newline.
#
# A missing trailing newline is not a style preference: it makes `git diff`
# show a spurious "\ No newline at end of file" hunk, which is exactly where a
# real change gets missed during review.
set -eu

rc=0
count=0
for f in $(git ls-files); do
  [ -f "$f" ] || continue
  [ -s "$f" ] || continue
  if git check-attr binary -- "$f" | grep -q 'binary: set'; then continue; fi
  count=$((count + 1))
  if [ "$(tail -c1 "$f" | wc -l)" -ne 1 ]; then
    printf 'missing trailing newline: %s\n' "$f"
    rc=1
  fi
done

if [ "$rc" -ne 0 ]; then
  echo "TRAILING NEWLINE CHECK FAILED"
  exit 1
fi
printf 'trailing newline: %d text file(s) checked, all end with a newline\n' "$count"
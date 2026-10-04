#!/bin/sh
# Verify every relative link, image reference, and file path in the
# documentation actually resolves.
#
# A broken link in a README is a small defect, but it is the kind that teaches
# a reader to stop trusting the document, so it is checked mechanically rather
# than by eye.
set -eu

cd "$(dirname "$0")/.." || exit 1

rc=0
checked=0
broken=0

# Every markdown file in the repository, documentation or not.
find . -name '*.md' -not -path './node_modules/*' -not -path '*/node_modules/*' \
  -not -path './.git/*' -not -path './web/frontend/dist/*' -not -path './web/backend/dist/*' \
  -print | sort > /tmp/caps-md-files.txt

printf 'Documentation link check\n'
printf 'markdown files: %s\n' "$(wc -l < /tmp/caps-md-files.txt | tr -d ' ')"
printf '\n'

while IFS= read -r md; do
  dir=$(dirname "$md")
  # Inline links and images: [text](target) and ![alt](target)
  # Reference definitions: [label]: target
  targets=$(sed -nE 's/.*\]\(([^)]+)\).*/\1/p; s/^\[[^]]*\]:[[:space:]]*(\S+).*/\1/p' "$md" | sort -u)
  for t in $targets; do
    case "$t" in
      http://*|https://*|mailto:*|'#'*) continue ;;
    esac
    # Strip an anchor and a title.
    path=${t%%#*}
    path=${path%% *}
    [ -z "$path" ] && continue
    checked=$((checked + 1))
    if [ ! -e "$dir/$path" ]; then
      printf 'BROKEN  %s -> %s\n' "$md" "$t"
      broken=$((broken + 1))
      rc=1
    fi
  done
done < /tmp/caps-md-files.txt

# Bare file references inside code spans, e.g. `src/process.c`. Only check the
# ones that look like repository paths, and only for directories that exist.
printf '\nReferenced repository paths (code spans and prose):\n'
missing=0
while IFS= read -r md; do
  paths=$(grep -ohE '`(src|include|tests|workloads|scripts|docs|web)/[A-Za-z0-9_./*-]+`' "$md" 2>/dev/null |
    sed 's/^`//; s/`$//' | sort -u)
  for p in $paths; do
    # Skip globs: they name a shape, not a file.
    case "$p" in *'*'*) continue ;; esac
    # Skip the project-tree diagram in the README, where paths are drawn with
    # box characters and are illustrative of the layout, not quoted as files.
    [ "$md" = "./README.md" ] && case "$p" in */*/*) continue ;; esac
    # Skip declared build outputs.
    #
    # `web/frontend/dist/` is where the production bundle lands, so
    # docs/DEPLOYMENT.md names it -- and requiring it to be present meant this
    # gate passed only on a machine where someone had just run a build, and
    # failed on a fresh CI checkout. An absent gitignored path is not a broken
    # reference; it is a documented destination, and its absence is the normal
    # state of a clean tree.
    #
    # Both spellings are probed because a .gitignore rule written `dist/` matches
    # the directory only when the path is given with its trailing slash.
    probe=${p%/}
    if git check-ignore -q -- "$probe" 2>/dev/null || git check-ignore -q -- "$probe/" 2>/dev/null; then
      continue
    fi
    if [ ! -e "$p" ] && [ ! -e "${p%.md}" ] && [ ! -e "${p%.*}" ]; then
      printf 'MISSING  %s -> %s\n' "$md" "$p"
      missing=$((missing + 1))
      rc=1
    fi
  done
done < /tmp/caps-md-files.txt
if [ "$missing" -eq 0 ]; then
  printf '  every referenced path resolves\n'
fi

printf '\n'
printf 'relative links/images checked: %s\n' "$checked"
if [ "$broken" -gt 0 ]; then
  printf 'BROKEN LINKS: %s\n' "$broken"
fi
if [ "$rc" -ne 0 ]; then
  echo "DOCUMENTATION LINK CHECK FAILED"
  exit 1
fi
echo "Documentation link check passed"

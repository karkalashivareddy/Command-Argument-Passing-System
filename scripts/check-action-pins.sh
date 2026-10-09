#!/bin/sh
# Every workflow action must be pinned to an immutable commit and retain a
# version comment so Dependabot can propose reviewed updates.
set -eu

workflow_dir=${1:-.github/workflows}
[ -d "$workflow_dir" ] || {
    echo "action pin check: workflow directory not found: $workflow_dir" >&2
    exit 1
}

found=0
for file in "$workflow_dir"/*.yml "$workflow_dir"/*.yaml; do
    [ -f "$file" ] || continue
    while IFS= read -r line; do
        case "$line" in
            *uses:*) ;;
            *) continue ;;
        esac
        found=1
        if ! printf '%s\n' "$line" | grep -Eq '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^[:space:]@]+@[0-9a-f]{40}[[:space:]]+# v[0-9]+([.][0-9]+)*([[:space:]]|$)'; then
            echo "action pin check: expected a full commit SHA and version comment: $file: $line" >&2
            exit 1
        fi
    done < "$file"
done

[ "$found" -eq 1 ] || {
    echo "action pin check: no workflow action references found in $workflow_dir" >&2
    exit 1
}

echo "action pin check: all workflow actions use full commit SHAs with version comments"

#!/bin/sh
set -eu

gate=${1:-scripts/check-action-pins.sh}
case "$gate" in
    /*) ;;
    *) gate="$(pwd)/$gate" ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/workflows"

cat > "$tmp/workflows/pinned.yml" <<'EOF'
jobs:
  example:
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7
        with:
          fetch-depth: 0
      - name: Setup
        uses: actions/setup-node@abcdef0123456789abcdef0123456789abcdef01 # v7
EOF
sh "$gate" "$tmp/workflows" >/dev/null

cat > "$tmp/workflows/unpinned.yml" <<'EOF'
jobs:
  example:
    steps:
      - uses: actions/checkout@v7
EOF
if sh "$gate" "$tmp/workflows" >/dev/null 2>&1; then
    echo "action pin test: accepted a mutable tag" >&2
    exit 1
fi
rm "$tmp/workflows/unpinned.yml"

cat > "$tmp/workflows/missing-version.yml" <<'EOF'
jobs:
  example:
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
EOF
if sh "$gate" "$tmp/workflows" >/dev/null 2>&1; then
    echo "action pin test: accepted a pin without a Dependabot version comment" >&2
    exit 1
fi

echo "action pin tests: pinned refs accepted; mutable and unmaintainable refs rejected"

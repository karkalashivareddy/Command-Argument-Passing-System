## What changed and why

<!-- The mechanism, not a restatement of the diff. -->

## Evidence

- [ ] A new observation, a new guarantee, or a bug fix is backed by a test
      that fails without this change.
- [ ] Failures are covered, not just successes: an error path with a real
      cause produces a real, distinguishable result.
- [ ] Nothing claims a capability the system does not have. A missing value is
      `UNAVAILABLE` with a reason, never a zero, a guess, or an optimistic
      default.

## Boundaries

- [ ] If this changes the security boundary (allowlist, executable resolution,
      redirection, bind mode, authentication), the change is described in
      `SECURITY.md` and that file is updated.
- [ ] If this changes what the observatory observes, the matching sentence in
      `docs/observability-model.md` and `README.md` is updated in the same PR.
- [ ] The event stream's invariants still hold (contiguous sequences, one
      terminal event, terminal last, no snapshot after terminal).

## Verification

Commands run, with their results:

```
```

- [ ] `make && make test && make test-asan && make test-workloads && make test-workloads-asan`
- [ ] `cd web/backend && npm ci && npm run typecheck && npm run build && npx vitest run`
- [ ] `cd web/frontend && npm ci && npm run typecheck && npm run build && npx vitest run`
- [ ] `sh scripts/check-attribution.sh` and `sh scripts/check-repository-hygiene.sh`

## Known limitations

<!-- What this change does NOT make true. Remove only if genuinely none. -->

# Contributing to CAPS

CAPS is a Linux process-execution observatory: a C engine that runs commands
with `fork()`/`execvp()`/`waitpid()`, a Fastify gateway that turns those
executions into a canonical event store, and a React UI that presents only
what the kernel actually reported.

## Build and verify

```sh
make                 # C engine + controlled workloads
make test            # C unit/integration suite
make test-asan       # same suite under ASan + UBSan
make test-workloads  # real workload binaries
```

```sh
cd web/backend  && npm ci && npm run typecheck && npm run build && npx vitest run
cd web/frontend && npm ci && npm run typecheck && npm run build && npx vitest run
```

Linux is the only supported platform for the engine. On WSL2 the full
gateway integration suite runs against the real `caps` binary.

## Code of conduct

Be precise and honest. This project's value is that its claims are backed by
observations, so a comment, a UI label, or a test that states something the
system does not actually do is a defect.

## Authorship and attribution

**All work in this repository is authored by human contributors.** AI coding
tools may help write code, but they are never recorded as contributors.

* Do not add `Co-authored-by: Claude`, `Co-authored-by: Anthropic`,
  `Co-authored-by: opencode`, or any equivalent AI identity.
* Do not set an AI tool as commit author or committer.
* Do not use an AI vendor email (`*@anthropic.com`, `*@opencode.ai`, …) in
  any commit identity field.

This is a repository hygiene rule, not a claim about how the code was
produced. It exists for a concrete reason: GitHub derives its contributors
graph from commit metadata, and one AI trailer creates a permanent
contributor entry that can only be removed by rewriting published history.

`scripts/check-attribution.sh` enforces this in CI. It inspects only author,
committer, and `Co-authored-by` trailers, so writing about AI tooling in
documentation or in a commit message body is never rejected.

```sh
scripts/check-attribution.sh            # every commit reachable from HEAD
scripts/check-attribution.sh HEAD~5..   # only the commits a PR adds
```

### Identity

Set the identity that maps to your GitHub account for this repository:

```sh
git config user.name  "Your Name"
git config user.email "you@example.com"
```

### Removing an unwanted trailer from your own unpushed commit

```sh
git commit --amend --no-edit   # after editing the message
```

Once a commit is pushed, correcting it requires a coordinated history
rewrite. Ask before doing that; do not force-push unilaterally.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). The gateway executes commands and
must only be reachable from loopback; report any way around that.

## Observability contract

Anything that changes what CAPS claims to observe needs three things
together:

1. the code,
2. a test that would fail if the claim became false,
3. the matching sentence in `docs/`.

A capability the system does not have must be reported as `UNAVAILABLE` with
a reason, never as a zero, a guess, or an optimistic default.

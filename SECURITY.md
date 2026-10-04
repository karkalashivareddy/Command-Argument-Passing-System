# Security Policy

## Supported versions

CAPS is a research and teaching project. Only the current `main` branch is
supported; there are no release branches and no backports.

| Version | Supported |
| --- | --- |
| `main` | yes |

## Reporting a vulnerability

**Do not open a public issue.** Email the maintainer, or use GitHub's private
vulnerability reporting for this repository if it is enabled.

Include, if you can:

* what an attacker gains,
* the exact request or command line that demonstrates it,
* whether it requires a non-default configuration,
* the CAPS version (`caps --version`, `GET /api/health`) and platform.

You can expect an acknowledgement within a few days. Please allow a reasonable
window for a fix before disclosing publicly.

## The threat model, stated precisely

CAPS is a **local, single-user process-execution observatory**. The threat
model follows from that, and CAPS is not designed to defend against anything
outside it.

### In scope — CAPS tries to prevent these

1. **Network exposure of an execution endpoint.**
   The gateway refuses to start on a non-loopback address unless
   `CAPS_BIND_MODE=remote` is set, and remote mode refuses to start without a
   `CAPS_AUTH_TOKEN` of at least 32 characters. Every request is then checked
   against a constant-time bearer comparison. Independently of the bind
   address, a request arriving from a non-loopback peer is refused.
   A `CAPS_AUTH_TOKEN` set in local mode is *rejected*, because a token the
   service never checks is worse than no token: it looks like hardening.

2. **Executing something other than the approved binary.**
   Every allowlisted command is resolved once to an absolute path that the
   gateway has verified: `realpath` to canonicalise, `lstat` to confirm a
   regular file, `access(X_OK)` to confirm it is executable, and a symlinked
   binary is refused rather than followed. The engine's `argv[0]` is that
   absolute path, so `execvp()` cannot re-resolve the name against `PATH`.
   Shells are not on the allowlist, because `sh -c` would turn an argv
   allowlist into arbitrary execution even with `shell: false`.

3. **Path escape through redirection.**
   Redirection targets must be plain relative names inside the workspace, with
   no `..`, no absolute path, no symlink component, and no empty or
   whitespace-only value. The engine re-verifies at the moment of open with
   `O_NOFOLLOW` plus a regular-file check on the descriptor it holds, so a
   symlink planted between the gateway's check and the engine's `open()` is
   refused rather than followed.

4. **Killing an unrelated process.**
   Termination captures the target's kernel identity — PID plus the start-time
   field of `/proc/<pid>/stat` — when the first signal is sent, and re-verifies
   it before every delayed escalation. If the PID was recycled, the escalation
   is refused and the reason is logged. Refusing is always the safe direction:
   an un-killed workload leaks a process, a wrong kill destroys an unrelated
   one.

5. **A secret reaching a child process or a log.**
   The engine and its children receive only `PATH`, `LANG`, `HOME`, and `TERM`.
   The bearer token is never logged; the logger takes validated configuration
   and redacts by key.

6. **Claiming a capability the system does not have.** See
   [docs/observability-model.md](docs/observability-model.md). A missing value
   is `UNAVAILABLE` with a reason, never a zero.

### Out of scope — CAPS does not try to prevent these

These are deliberate, documented limits, not oversights.

1. **A local attacker who can read your files.** CAPS runs as your user. Anyone
   who can read the workspace can also replace the allowlisted binaries or the
   engine itself. There is no sandbox, no container, no user namespace, and no
   MAC policy.

2. **Anything the allowlisted program does.** `cat` can read any file the
   gateway user can read, if it is reachable through the workspace policy.
   `echo` and `printf` write wherever the redirection policy allows. CAPS
   executes programs; it does not constrain them.

3. **A hostile `CAPS_WORKSPACE` or `CAPS_EXECUTABLE` setting.** If you point
   the gateway at a directory or a binary you do not control, you have removed
   the boundary yourself.

4. **Denial of service by a local client.** A request that runs a long workload
   holds a concurrency slot until its timeout. The bounds are generous on
   purpose, and they are enforced, but they are not a rate limit.

5. **Kernel or container vulnerabilities.** CAPS reads `/proc` and calls
   `kill()`. It does not attempt to harden the kernel.

6. **Anything past the single sampled PID.** Only the CAPS-reported child is
   observed. Descendants it forks are not discovered, not sampled, and not
   drawn. See the limitations section of
   [docs/observability-model.md](docs/observability-model.md).

## Hardening in this repository

The controls above are enforced in code and covered by tests, not only in
documentation:

| Control | Where it lives | Where it is tested |
| --- | --- | --- |
| Loopback/remote bind refusal | `web/backend/src/config/env.ts`, `web/backend/src/server.ts` | `web/backend/tests/unit/config.test.ts` |
| Bearer token required in remote mode | `web/backend/src/config/env.ts`, `web/backend/src/server.ts` | `web/backend/tests/unit/config.test.ts` |
| Verified absolute executable resolution | `web/backend/src/security/policy.ts` | `web/backend/tests/unit/policy.test.ts` |
| Redirect path policy | `web/backend/src/security/policy.ts`, `src/process.c` | `policy.test.ts`, `tests/test_redirection.sh` |
| `O_NOFOLLOW` at open time | `src/process.c` | `tests/test_lifecycle.sh` |
| PID-reuse-safe termination | `web/backend/src/execution/terminator.ts` | `web/backend/tests/unit/infrastructure.test.ts` |
| Fail-closed signal model | `src/main.c`, `src/process.c` | `tests/test_lifecycle.sh` |
| No secrets in child env or logs | `web/backend/src/execution/runner.ts`, `web/backend/src/utils/logger.ts` | `scripts/check-repository-hygiene.sh` |
| No committed secrets or local paths | `scripts/check-repository-hygiene.sh` | CI `repository-hygiene` job |

## GitHub security configuration

### Enabled on this repository

| Feature | State | Why |
| --- | --- | --- |
| Secret scanning | enabled | Detects committed credentials. |
| Push protection | enabled | Blocks a secret before it reaches history. |
| Dependency graph | enabled | 503 packages resolved from the two lockfiles. |
| Dependabot alerts | enabled | Six open advisories, all triaged below. |
| CodeQL (C/C++, JavaScript/TypeScript) | enabled, buildless | Runs on every push to `main`. |
| Ruleset `main-destructive-update-guard` | active on the default branch | Blocks **branch deletion** and **force pushes**. It deliberately does *not* require reviews or status checks: this is a single-owner project, and a required-review rule would lock the owner out of their own repository. |

### Still manual

* **Dependabot security updates** (`dependabot_security_updates`) — this
  repository's Dependabot config is present and version updates work, but turning
  on automatic security-update PRs requires the `admin:repo_hook` OAuth scope,
  which has not been granted to the automation used here.

### Open advisories, triaged

Six open Dependabot alerts, all **medium**, all the same advisory
(`GHSA-82fw-gwwq-j7x9` / `CVE-2026-84373`) against `vitest` /
`@vitest/mocker` in both packages.

* **It is a development-dependency issue.** `vitest` is a `devDependency`; it is
  never bundled, never installed by `npm ci --omit=dev` in a deployment, and never
  loaded by the gateway or the frontend at runtime.
* **It is a dev-server issue.** The advisory requires an attacker who can reach a
  running Vitest/Vite dev server's unauthenticated HMR WebSocket. CAPS's CI runs
  the test suite on an ephemeral runner with no exposed port, and the product
  ships a static production bundle.
* **There is no fix in the line this repository is on.** The advisory is fixed in
  Vitest 4.1.11 and 5.0.0, and states that the 3.x line is not maintained and will
  not receive the fix. Moving to the fix therefore means a semver-major migration
  of the test runner, which `.github/dependabot.yml` deliberately routes through
  human review rather than through config.
* **CI fails the build on anything worse.** The `dependency audit` job runs
  `npm audit --audit-level=high` for both packages, so a high or critical
  advisory — in a dev dependency or a runtime one — breaks the build.

This is an accepted, documented risk rather than an unexamined one. It is
revisited whenever the test runner is next upgraded for other reasons.

## Verifying the boundary yourself

```sh
# The gateway refuses a non-loopback bind in the default local mode.
CAPS_HOST=0.0.0.0 node web/backend/dist/server.js
# -> Refusing to bind a loopback-mode gateway to "0.0.0.0".

# Remote mode refuses to start without a token.
CAPS_BIND_MODE=remote CAPS_HOST=0.0.0.0 node web/backend/dist/server.js
# -> Unsafe or inconsistent CAPS configuration: CAPS_AUTH_TOKEN is required.

# Readiness reports each dependency separately.
curl -s http://127.0.0.1:3000/api/ready | jq .checks
```

# Security Model

## Threat Model

The CAPS Observatory executes user-supplied commands on the host system. This document describes the security boundaries, mitigations, and assumptions.

### Assets Protected

| Asset | Classification |
|-------|----------------|
| Host filesystem (outside workspace) | **Critical** |
| Host processes (outside gateway children) | **Critical** |
| Gateway database (session history) | **High** |
| Network services on host | **High** |
| Gateway configuration | **Medium** |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                               │
│  React SPA — no execution capability                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS / SSE (same-origin)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     NODE GATEWAY                             │
│  Fastify — validation, policy, spawning, normalization      │
│  SQLite — persistence                                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ spawn (execvp, no shell)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      CAPS ENGINE                             │
│  C/POSIX — fork/exec/wait, monitor JSON events on stderr    │
└──────────────────────┬──────────────────────────────────────┘
                       │ child process (user program)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    USER PROGRAM                              │
│  echo, sleep, true, false, pwd, cat, uname                 │
│  (confined to workspace)                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Command Execution Policy

### Allowlist (Hardcoded)

Only these commands may be executed:

```c
Gateway PATH allowlist: `echo`, `printf`, `sleep`, `true`, `false`,
`pwd`, `cat`, `uname`. The optional fixed `status_probe` helper is
resolved to its repository build path when present.
```

- **No shell** — shells are excluded from the gateway allowlist; `sh -c`
  would otherwise allow arbitrary commands despite `shell:false`.
- **No `system()` or `popen()`** — execution uses structured argv.
- **Allowlist before PATH lookup** — the requested name must be allowed before `execvp()` resolves it through the sanitized PATH.
- **Workspace-only `cat` reads** — the gateway accepts only existing regular files that resolve inside the workspace; flags and paths through escaping symlinks are rejected.
- **No arguments injection** — argv passed as array, not joined string

### Workspace Confinement

```bash
CAPS_WORKSPACE=/var/lib/caps/work  # Default: <repo>/data/work
```

All redirection targets are **relative paths** resolved within workspace:

| Input | Result |
|-------|--------|
| `output.txt` | ✅ Allowed |
| `subdir/file.txt` | ✅ Allowed (subdir created) |
| `../escape.txt` | ❌ Rejected (`..` not allowed) |
| `/absolute/path` | ❌ Rejected (absolute) |
| `~/.bashrc` | ❌ Rejected (tilde) |
| `foo//bar` | ❌ Rejected (empty segment) |
| `NUL` / `CON` | ❌ Rejected (reserved names) |

Policy enforced in `security/policy.ts` → `isSafeRedirTarget()`.

---

## Process Isolation

### What the Child Sees

| Aspect | Configuration |
|--------|---------------|
| **CWD** | `CAPS_WORKSPACE` |
| **ENV** | Minimal: `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, `TERM=dumb`, `HOME=/tmp` |
| **FD 0** | `/dev/null` (unless `--redir-in`) |
| **FD 1** | Pipe to parent (unless `--redir-out`) |
| **FD 2** | Monitor JSON stream (always) |
| **RLIMIT** | Default (no explicit limits — consider adding `RLIMIT_CPU`, `RLIMIT_AS`) |

### Parent-Child Relationship

```
Gateway (Node)
    │ spawn
    ▼
CAPS Monitor (./caps --monitor --json)
    │ fork()
    ├─► Parent (CAPS) ── waitpid() ──► reaps child
    │
    └─► Child ── execvp(user_program) ──► runs user program
         │
         ├─ stdout → pipe → CAPS → gateway → stdout buffer
         ├─ stderr → monitor JSON → gateway → events
         └─ exit → CAPS waitpid → session summary event
```

### Signals

| Signal | Source | Delivery |
|--------|--------|----------|
| `SIGINT` | User clicks Terminate | `kill(child_pid, SIGINT)` |
| `SIGTERM` | Gateway shutdown | `kill(child_pid, SIGTERM)` then `SIGKILL` after 2s |
| `SIGKILL` | Force stop | `kill(child_pid, SIGKILL)` |

Only the gateway can send signals — no user-controlled signal delivery.

---

## Network Security

### Binding

```bash
CAPS_HOST=127.0.0.1   # Default — loopback only
CAPS_PORT=3000
```

### Defense in Depth

Even though bound to loopback, the gateway validates `req.socket.remoteAddress`:

```typescript
if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    return reply.code(403).send({ error: "Observatory only accepts loopback connections." });
}
```

### Headers

```
x-caps-observatory: CAPS Process Execution Observatory
Cache-Control: no-store
```

### SSE Security

- SSE endpoint `/api/sessions/:id/events` uses native `EventSource`
- `Last-Event-ID` replay supported (no auth token — relies on loopback binding)
- No CORS — same-origin only

---

## Input Validation

### Session Creation

```json
POST /api/sessions
{
  "command": "echo",           // Must be in allowlist
  "args": ["hello", "world"],  // Array of strings, max 32 args
  "redirections": {            // Optional
    "in": "input.txt",         // Relative path, validated
    "out": "output.txt",
    "append": "log.txt"
  },
  "timeoutMs": 30000           // 1000–120000, clamped
}
```

Validation layers:
1. **Zod schema** — type/structure
2. **Allowlist check** — command must be permitted
3. **Args length** — max 32
4. **Redirection policy** — `isSafeRedirTarget()` on each
5. **Timeout bounds** — 1s to 120s

### Rate Limiting

Not implemented in gateway (assumes internal/trusted use). Add via reverse proxy if exposed.

---

## Data Protection

### Database

- SQLite with WAL mode
- File permissions: `0640` (owner read/write, group read)
- No encryption at rest (assumes trusted host)
- No PII stored — only command strings, args, exit codes, timestamps

### Logs

- Structured JSON to stdout
- No secrets in logs
- Log level: `CAPS_LOG_LEVEL` (debug/info/warn/error)

---

## Known Limitations & Mitigations

| Limitation | Risk | Mitigation |
|------------|------|------------|
| No authentication | Anyone with loopback access can execute | Bind to loopback; use SSH tunnel or VPN for remote access |
| No TLS | Traffic visible on localhost | Run behind TLS-terminating reverse proxy (nginx) |
| No rate limiting | DoS via many executions | Reverse proxy rate limit; `CAPS_MAX_CONCURRENT` |
| Child runs as gateway user | Escape = full user access | Run gateway as dedicated low-privilege user; consider containers |
| No seccomp/namespace | Child has full syscall access | Future: add `--seccomp` profile to caps engine |
| SQLite single-writer | No horizontal scaling | Migrate to PostgreSQL for multi-instance |

---

## Hardening Checklist (Production)

- [ ] Run gateway as dedicated `caps` user (not root)
- [ ] Set `CAPS_WORKSPACE` to dedicated partition with `noexec,nodev,nosuid`
- [ ] Add `RLIMIT_CPU=30` and `RLIMIT_AS=100M` to child via `prlimit` or engine
- [ ] Deploy behind TLS-terminating nginx with rate limiting
- [ ] Restrict SSH/VPN access to host
- [ ] Monitor `/api/health` and `/api/processes` for anomalies
- [ ] Regular `sqlite3 integrity_check` on database
- [ ] Audit allowlist quarterly
- [ ] Keep Node.js and C compiler updated

---

## Incident Response

1. **Unexpected child process**: Check `/api/processes` → `POST /api/sessions/:id/terminate`
2. **Gateway unresponsive**: `systemctl restart caps-observatory`
3. **Database corruption**: Restore from `.backup` + `PRAGMA integrity_check`
4. **Allowlist bypass attempt**: Check logs for `COMMAND_NOT_ALLOWED` (403)
5. **Redirection escape attempt**: Check logs for `REDIRECTION_REJECTED` (422)

Procfs telemetry is scoped to child PIDs emitted by CAPS and held in the active execution registry. The gateway does not provide arbitrary PID inspection. Before accepting a snapshot it checks that procfs PPID matches the gateway-spawned CAPS process PID and that the process start ticks remain stable; mismatched identities are recorded as unavailable.

---

## Security Contacts

Report vulnerabilities to the project maintainers. No bug bounty program.

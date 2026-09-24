# CAPS — Process Execution Observatory

A real-time observability system for Linux process execution. Type a command, watch it fork → exec → wait → exit with live telemetry, then replay the complete flight recorder.

```
┌─────────────────────────────────────────────────────────────────────┐
│ CAPS Process Execution Observatory                        ● ONLINE   │
│                                                                     │
│ See what a command becomes.                                         │
│                                                                     │
│ [ echo Hello Shiva                                          ] [ RUN ]│
│                                                                     │
│ ───── LIVE EXECUTION PATH ─────────────────────────────────────── │
│                                                                     │
│ INPUT → PARSE → ARGV → FORK → EXEC → RUN → WAIT → RESULT        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## What It Does

The Observatory captures the complete lifecycle of a command execution:

| Stage | What Happens | Visualized As |
|-------|--------------|---------------|
| **INPUT** | CAPS receives `(argc, argv)` directly | Pipeline node |
| **PARSE** | Command line tokenized into argv | Pipeline node |
| **FORK** | `fork()` clones the monitor as child | Process topology split |
| **EXEC** | `execvp()` replaces child image (same PID) | Process topology transition |
| **RUN** | Program runs; parent blocked in `waitpid()` | Live PID + timer |
| **WAIT** | Parent reaps child termination status | Pipeline node |
| **RESULT** | Exit code / signal reported | Status banner + event stream |

Every event is real — no mocks, no fake data. Empty states are honest ("No output on this channel — the program genuinely wrote nothing here").

## Quick Start

### Prerequisites
- Linux (or WSL2 on Windows)
- `cc` compiler, `make`
- Node.js 22+ (for the gateway + frontend)

### Build & Run

```bash
# 1. Build the C engine (required)
make caps

# 2. Install frontend deps (once)
make web-install

# 3a. Start everything (two terminals)
# Terminal 1 — backend gateway
make web-backend

# Terminal 2 — frontend dev server
make web-frontend

# 3b. Or open http://127.0.0.1:5173 in your browser
```

The frontend proxies `/api/*` to the backend at `http://127.0.0.1:3000`.

### Try It

1. Open **Execute** (shortcut: `E`)
2. Run `echo Hello Shiva` → opens the **Flight Recorder**
3. Watch the pipeline animate: INPUT → PARSE → ARGV → FORK → EXEC → RUN → WAIT → RESULT
4. Open **History** (`H`) to see all recorded sessions
5. Open **Signals** → spawn `sleep 30` → deliver SIGINT → watch the signal flow diagram

## Project Structure

```
caps-observatory/
├── src/                    # C engine (monitor + execution)
│   ├── main.c
│   ├── exec.c
│   └── monitor.c
├── include/                # C headers
├── tests/                  # Shell test harness
├── web/
│   ├── backend/            # Node gateway (Fastify + node:sqlite)
│   │   ├── src/
│   │   │   ├── api/        # REST + SSE routes
│   │   │   ├── db/         # SQLite repositories
│   │   │   ├── execution/  # Runner, registry, normalizer
│   │   │   ├── events/     # EventBus, SSE
│   │   │   └── utils/      # Logger
│   │   └── tests/          # Unit + integration tests (Vitest)
│   └── frontend/           # React 19 + Vite + Tailwind v4 + Motion
│       ├── src/
│       │   ├── components/
│       │   │   ├── execution/  # Pipeline, ProcessGraph, ArgvView, EventStream…
│       │   │   ├── layout/     # Sidebar, Topbar, CommandPalette
│       │   │   └── ui/         # Button, Card, StatusDot…
│       │   ├── pages/          # Overview, Execute, FlightRecorder, History…
│       │   ├── store/          # Zustand (ui, execution)
│       │   ├── api/            # REST + SSE hooks
│       │   └── lib/            # Formatters, stage model
│       └── dist/               # Production build output
└── docs/                   # Architecture, API, Design System
```

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Engine availability + version |
| `GET` | `/api/capabilities` | Allowlist, limits, workspace |
| `POST` | `/api/sessions` | Create execution `{command, args, redirections?, timeoutMs?}` |
| `GET` | `/api/sessions/:id` | Full session record |
| `GET` | `/api/sessions/:id/events` | SSE stream (`execution.received`, `execution.ended`) |
| `GET` | `/api/sessions/:id/replay` | Complete event timeline for replay |
| `GET` | `/api/sessions/:id/argv` | Parsed argument vector |
| `GET` | `/api/sessions/:id/output` | Captured stdout/stderr |
| `POST` | `/api/sessions/:id/terminate` | Send signal (`SIGINT`, `SIGTERM`, `SIGKILL`…) |
| `GET` | `/api/processes` | Live process table |
| `GET` | `/api/analytics/overview` | Counts, percentiles, exit/signal distributions |

## Security

- **No shell ever** — commands are spawned directly via `execvp` with `shell: false`
- **Allowlist only** — `echo`, `printf`, `sleep`, `true`, `false`, `pwd`, `cat`, `uname`, `sh`, `status_probe`
- **Workspace confinement** — all paths resolved against a configured workspace root; `..`, `~`, absolute paths rejected
- **Loopback-only** — gateway binds `127.0.0.1`; defense-in-depth hook rejects non-loopback peers
- **Resource limits** — 4 concurrent, 30s default timeout (max 120s), 64KB output cap

## Development

```bash
# Run C tests
make test
make test-asan

# Run backend tests (Vitest)
cd web/backend && npm test

# Frontend typecheck + build
cd web/frontend && npm run typecheck && npm run build

# Frontend dev server
cd web/frontend && npm run dev
```

## Documentation

| Document | Description |
|----------|-------------|
| `docs/web-architecture.md` | Full system architecture & data flow |
| `docs/web-api.md` | Complete API reference |
| `docs/design-system.md` | Visual tokens, components, motion principles |
| `docs/dashboard-information-architecture.md` | Page layouts, information hierarchy |
| `docs/web-product-plan.md` | Product strategy & roadmap |

## Design Principles

- **Real data only** — every visualization backed by genuine telemetry
- **Graphite foundation** — `#07090D` / `#0C1016` / `#11161D` / `#171D25` / `#202731`
- **Semantic color** — cyan (active), violet (execution), green (success), amber (signal), red (failure)
- **Motion from events** — animations triggered by real event arrival, never decorative
- **Developer density** — compact, information-rich, not dashboard-card fluff
- **Flight recorder metaphor** — execution = primary visual object; timeline = first-class citizen

## License

MIT
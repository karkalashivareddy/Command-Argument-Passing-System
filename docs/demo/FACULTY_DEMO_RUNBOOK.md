# CAPS Observatory — Faculty Demo Runbook

See what a command becomes. One real Linux process, made inspectable, made replayable, made verifiable.

## 1. Prerequisites

* Ubuntu WSL (Node/npm and Linux-native `node_modules` required).
* Built C engine at `./caps` in the repository root.
* Backend and frontend dependencies installed.
* The production frontend build (`web/frontend/dist/`) is available.

## 2. Start the system

### Terminal 1 — Backend (gateway)
```bash
cd /mnt/c/Users/karka/Command-Argument-Passing-System/web/backend
CAPS_DATABASE_PATH=/tmp/caps-demo.db CAPS_WORKSPACE=/tmp/caps-demo-work CAPS_LOG_LEVEL=info node --disable-warning=ExperimentalWarning --import tsx src/server.ts
```
Expect: `listening on http://127.0.0.1:3000` or `... :3100` depending on `CAPS_PORT`.

### Terminal 2 — Production frontend (recommended for demo)
```bash
cd /mnt/c/Users/karka/Command-Argument-Passing-System/web/frontend
CAPS_PROXY_TARGET=http://127.0.0.1:3100 npm run preview -- --host 127.0.0.1 --port 4173
```
Or run `build-preview.sh`. Gateway should be `3100`.

## 3. 5-minute faculty demo (essential)

1. **Overview (`/`)** — Communicate "See what a command becomes". Explain the evidence-first surface.
2. **Terminal (`/terminal`)** — Run a trivial safe workload (e.g. `seq 1 10`). Show structured argv, not shell-reconstructed command.
3. **Live execution** — Watch fork/exec/wait, PID, events, timeline.
4. **Process Space 3D (`/processes/space` or execution 3D)** — Show real process position/lifecycle. Orbit/fit/focus/reset.
5. **Event Console** — Click an event; show cross-view sync (timeline/inspector/3D).
6. **Flight Recorder** — Scrub persisted events. No fabricated `RUNNING` state.
7. **Evidence/Provenance** — Show OBSERVED/DERIVED/UNAVAILABLE are distinguished.

## 4. 10-minute technical demo (detailed)

* **Identity** — Real PID. Same PID appears across explorer/detail/events/replay.
* **/proc telemetry** — Distinguish kernel-observed vs derived. UNAVAILABLE never becomes 0.
* **Event stream (SSE)** — Ordered canonical events; replay uses persisted events, never re-executes.
* **Process topology** — Parent/child links where observable.
* **Signals/termination** — Real exit status; timeouts produce exactly one terminal event.
* **3D correctness** — Honest mapping, camera presets, focus-vs-reset correct.
* **Presentation Mode** — 12-step faculty narrative (WHAT → COMMAND → ARGV → FORK → EXEC → REAL PID → PROCFS → LIVE EVENTS → 3D → TERMINATION → FLIGHT RECORDER → EVIDENCE/PROVENANCE).

## 5. Verification commands (quick)

```bash
# Sanity checks
CAPS_GATEWAY_URL=http://127.0.0.1:3100 bash scripts/cross-view-proof.sh
CAPS_GATEWAY_URL=http://127.0.0.1:3100 CAPS_FRONTEND_URL=http://127.0.0.1:4173 bash scripts/browser-smoke.sh
```

All must PASS.

## 6. Truthful answers to common questions

* **Why not `ps`?** CAPS captures execution-time evidence (events + /proc + identity) and makes it replayable; ps is a snapshot.
* **What is observed vs derived?** OBSERVED = directly from kernel/state; DERIVED = computed from observed; UNAVAILABLE = not recorded.
* **How identified?** `(pid, start_ticks, boot_id)` with guards against PID reuse where applicable.
* **Security boundaries**: `shell:false`, allowlist, workspace confinement, `O_NOFOLLOW`, limits, process-group termination verified.
* **Replay**: reads persisted canonical events; no re-execution, no fake `RUNNING`.
* **3D**: observability visualization; not decorative animation.

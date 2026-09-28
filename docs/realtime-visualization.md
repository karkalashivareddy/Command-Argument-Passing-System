# Real-time visualization

The browser treats stored and streamed canonical events as the lifecycle source of truth. It never advances a stage on a timer. Recorded replay uses the same stored events and never starts a process.

## Observable web execution

1. The gateway validates a structured `{ command, args }` request and starts `./caps --monitor --json` with an argv array and `shell: false`.
2. CAPS emits monitor JSON on stderr as the actual operation reaches parser wrapper events, redirection, `fork()`, and `waitpid()` result handling.
3. The gateway normalizes known event names, adds session ID, sequence, and receive timestamp, then persists before publishing to SSE.
4. The client deduplicates by event ID and applies the canonical events to the flight recorder and event inspector.
5. After `process.started`, one backend sampler reads the tracked child's procfs files immediately and then every 500 ms. It publishes `process.snapshot` through the same persistence-before-SSE path. Sampling stops on the corresponding process exit or exec error.
6. Reconnect sends `Last-Event-ID`; the gateway replays persisted sequences (including snapshots) before subscribing to new events.

`command.parsed` is the CAPS monitor's marker around a web request's already structured argv. The web path does not send a command string through `parser_parse()`, so the UI marks raw command tokenization unavailable. CAPS reports exec failures through a close-on-exec status pipe but has no separate successful `execvp()` event. A later ordinary exit supports an inferred successful exec; a signal leaves the outcome unavailable.

## Connection status

`CONNECTED` means the browser's EventSource `open` callback fired. On transport error it displays disconnected while the browser retries. Receiving no events does not mean disconnected, and receiving an old persisted event is not used as a connection check.

## Motion policy

Motion can follow newly received rows or changed event-backed state. No infinite pipeline sweep or simulated execution progress is used. Reduced-motion preferences are handled globally in `src/styles/index.css`.

## Procfs sampling and replay

The backend owns one sampling interval per runner rather than a timer in each browser component. It only considers `childPid` values supplied by CAPS `PROCESS_STARTED`; it never accepts a PID from a request. Before accepting resource data it verifies `/proc/<pid>/status` PPid equals the gateway-spawned CAPS process PID and checks that `/proc/<pid>/stat` start ticks remain stable. A missing procfs entry, parse failure, PID mismatch, permission error, or missing field is persisted as `UNAVAILABLE` with a reason.

Snapshots are canonical events with increasing session sequence numbers and are inserted into SQLite before the event bus publishes them. Replay therefore replays recorded snapshot payloads; it does not poll procfs or re-execute the process. CPU utilization is unavailable until two valid CPU-time samples exist. Resource charts contain only collected values and state â€œInsufficient samplesâ€ when fewer than two values are available.
## Canonical persisted evidence is the source of truth

Every visual surface - live or replayed, 2D or 3D - is a projection of the same
persisted canonical event store. Synchronization never creates a parallel value:

- The **only** telemetry sampler is the backend one described above. The frontend
  has no sampler, no `/proc` access, and no polling loop that stands in for one.
  Charts re-read the canonical events they were given; they do not fetch fresh
  data on a timer.
- Frontend polling is limited to a status check on a still-running session, so the
  header can stop showing a finished execution as live. It never produces
  telemetry.
- The rendered state of a process at a cursor is the **latest recorded sample at
  or before that cursor**, taken from the same sample set every time. Two views
  at the same cursor cannot disagree about a process's CPU or RSS.

## Two cursor policies, one cursor

There is a single execution-time cursor, and its *policy* differs by mode:

| Mode | Cursor policy |
| --- | --- |
| Live | `null` means "follow the newest recorded evidence", including lifecycle events that arrived after the last snapshot. A finished execution therefore reads as finished rather than still running. |
| Pinned | Once the reader seeks - a chart, a peak card, the replay scrubber, or the arrow keys - the cursor holds that position and the source is recorded (`user` or `replay`). |
| Replay | The scrubber owns the cursor. Arrow keys and Space drive the same playback the on-screen button drives, and stepping only ever lands on a recorded time. |

The cursor's recorded *source* is what prevents feedback. The replay panel's own
cursor updates come back tagged `replay` and are therefore not fed back into the
panel as a seek; only a cursor another surface moved is followed. That is why the
scrubber and the shared cursor cannot oscillate against each other.

## Replay performs reconstruction, not collection

Entering replay changes what is *displayed*, never what is *collected*:

- it executes no process and launches no CAPS child;
- it starts no telemetry sampler and reads no live procfs;
- it creates no new events and no new snapshots, and mutates no persisted
  evidence - the persisted event stream is byte-for-byte identical before and
  after a replay pass;
- it reconstructs the scene from the events visible at the cursor, so a partially
  replayed record shows a genuinely partial state rather than its future.

Selecting an event during replay moves the cursor to that event's own recorded
timestamp and resolves the process only through the verified correlation layer.
A PID on its own never selects a process.
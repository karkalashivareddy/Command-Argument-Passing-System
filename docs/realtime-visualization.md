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

Snapshots are canonical events with increasing session sequence numbers and are inserted into SQLite before the event bus publishes them. Replay therefore replays recorded snapshot payloads; it does not poll procfs or re-execute the process. CPU utilization is unavailable until two valid CPU-time samples exist. Resource charts contain only collected values and state “Insufficient samples” when fewer than two values are available.

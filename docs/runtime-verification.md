# CAPS Linux Runtime Verification

This record describes the Linux runtime and browser checks run on 2026-09-24. Linux execution used the installed Ubuntu WSL2 distribution, not Git Bash or MinGW.

## Environment

- Ubuntu 26.04 LTS on WSL2; Linux kernel `6.18.33.2-microsoft-standard-WSL2`
- GCC, GNU Make, Node.js 22.14.0, npm 10.9.2
- Chrome connected to the WSL loopback-forwarded Vite frontend and Fastify gateway
- CAPS and the gateway bound to `127.0.0.1`; SQLite stored in the Linux workspace

## Verified execution matrix

| Case | Result and evidence |
| --- | --- |
| `echo hello` | PASS — browser submitted `echo Hello Shiva`; CAPS reported `PROCESS_STARTED` with PID 646, then `PROCESS_EXITED` 0. Persisted flight contained 8 ordered events. |
| `printf` | PASS — `tests/test_execution.sh` ran real printf option/argument cases. |
| `false` | PASS — gateway API test observed normal process exit code 1. |
| Application exit 127 | PASS — allowlisted `status_probe exit 127` reached `PROCESS_EXITED` with code 127; no `EXEC_ERROR`. A new API integration test verifies SQLite replay, full SSE, and `Last-Event-ID` recovery. |
| Missing executable | PASS at C monitor — `tests/test_monitor.sh` observed `EXEC_ERROR` for a missing executable. Web API behavior is policy rejection (403) before CAPS starts, by design. |
| `sleep 10` live lifecycle | PASS — browser showed RUNNING with Linux PID 4060 and the first five events while it was still running; after about 10 seconds it showed `PROCESS_EXITED` 0 and `execution.completed`. |
| SIGINT | PASS — browser sent SIGINT to the real sleeping child PID 768; CAPS emitted `signal.received` (2), `process.exited` (130), and the gateway finalized CANCELLED. Backend API suite repeats this with a real `sleep 30`. |
| Timeout | PASS — backend integration suite configured 1200 ms; gateway emitted timeout, delivered SIGTERM (15), persisted TIMED_OUT, and reported exit status 143. |
| Stdout redirection | PASS — browser wrote `captured by CAPS\n` to the workspace file; CAPS emitted `REDIRECTION_OPENED`. |
| Append redirection | PASS — second browser run appended `captured by CAPS (append)\n`; file contents were read back from WSL. API integration also checks `first\nsecond\n`. |
| Stdin redirection | PASS — browser ran `cat` with `observatory.txt` on stdin and displayed both stored lines. API integration checks the same flow. |
| Stderr redirection | NOT SUPPORTED — the current gateway contract has no stderr redirection mode; strict request validation now rejects an unsupported `err` field with 400. |
| Invalid command / empty command | PASS — empty command gets 400; unknown web executable gets 403 before process creation; shell/command bypass is rejected. |
| Long arguments/output | PASS — C monitor tests a long command label without truncating execution; gateway integration sends 80,004 argv bytes and confirms captured stdout is capped at 64 KiB. |
| Restricted executable and shell bypass | PASS — API integration verifies off-allowlist `rm`, `sh -c`, and a nonexistent name are rejected. |
| Workspace traversal | PASS — `../escape` rejected; an in-workspace symlink to an outside file is rejected and the outside content remains unchanged. |

## Persistence, streaming, and replay

- Browser execution events arrived incrementally over the session SSE stream; PID and RUNNING state appeared before the `sleep 10` process exited.
- API integration checks monotonically ordered sequence numbers and reconnect after event ID 3, receiving only sequences 4 through 7 plus the stream terminator.
- Stopping and restarting the gateway against the same SQLite file preserved all 3 browser executions. After reload, history, analytics, and the global SSE feed showed their stored data.
- While stopped, the UI reported ENGINE OFFLINE and SSE RECONNECTING. The global feed reconnected after the gateway returned; engine health was refreshed after page reload.
- Replay displayed persisted event envelopes only; browser replay controls now include Play/Pause, Previous/Next event, Restart, Jump to end, and speed. Manual stepping changed the visible sequence from 8/8 to 7/8 and back without creating an execution.
- Raw event copy was clicked in Chrome; the clipboard contained canonical JSON including a persisted `process.exited` event envelope.

## Browser and security checks

- All 14 routes (`/`, `/execute`, `/processes`, `/playground`, `/live`, `/history`, `/analytics`, `/architecture`, `/signals`, `/redirection`, `/demo`, `/settings`, `/about`, `/raw`) loaded at 390, 768, 1280, 1440, and 1920 CSS pixels. No document-level horizontal overflow was measured.
- Browser QA found and fixed two integration faults: the frontend expected an `{ event }` SSE wrapper that the gateway does not send, and `/playground` treated the `{ examples }` response as an array.
- The built backend entrypoint previously did not start because its main-module guard matched only `.ts`; the guard now recognizes built `.js` as well.
- The repository helper `status_probe` was allowlisted but not searchable by `execvp()`; the gateway now adds only its trusted helper directory to the sanitized PATH while retaining the caller's `argv[0]`.
- Redirection targets now reject existing symlink components. Gateway spawn logs record argument count/byte count rather than argument contents.
- Individual `open()`, `dup2()`, and `close()` calls are not monitor events. The UI labels that sequence as POSIX explanation, separate from the observed `REDIRECTION_OPENED` event.

## Runtime telemetry extension (2026-09-24)

The Linux backend now samples only the child PID reported by CAPS, at a controlled 500 ms interval. Procfs data is persisted as `process.snapshot` events through the existing sequence, SQLite, SSE, and replay path. No user-supplied PID inspection endpoint was added.

- Browser `sleep 10` run: execution `exec_mufq91cn579c96c172`; gateway/CAPS engine PID 563; CAPS-reported child PID 564; `/proc` PPID 563. The UI showed RUNNING while the process was active.
- The event stream displayed 29 ordered events: 4 startup/lifecycle events, 21 `process.snapshot` events, `process.exited` with exit code 0 and duration 10006 ms, `session.summary`, and `execution.completed`.
- The active microscope showed Linux state `S`, elapsed time, observed RSS and thread count, and derived CPU utilization. The persisted run exposed 21 real snapshots and 20 valid CPU deltas. No resource values were synthesized.
- Replay switched the UI to `REPLAY`, read the same persisted events and samples, and showed an honest insufficient-samples state when its cursor included only two snapshots. Replay did not submit another command.
- Analytics loaded three persisted executions and reported 42 procfs snapshots from two sampled executions; RSS and CPU figures included their valid sample counts.
- Updated route smoke check: `/execute`, `/execution/<id>`, replay mode, and `/analytics` rendered from the current WSL build. The earlier full 14-route responsive pass remains the baseline; this extension pass did not repeat all viewport/route combinations.
- Sampling is Linux-only and scoped to active CAPS-owned PIDs. PPID/process group/session are available only while procfs data is readable. CPU milliseconds derive from kernel ticks and clock-tick rate; CPU utilization derives from successive samples. RSS, virtual memory, thread count, state and context switches are procfs observations. Disappeared/malformed/permission-denied proc entries remain unavailable with reasons.

## Remaining limits

- Web requests cannot produce `EXEC_ERROR` for arbitrary missing names because the gateway rejects unlisted executable names before fork; the C monitor tests cover true `execvp()` failure.
- Stderr redirection and individual low-level file descriptor syscall events are unsupported.
- The process graph shows the observed CAPS engine/target parent-child relation only when procfs PPID matches the gateway-spawned CAPS PID. It does not discover arbitrary descendants.
- The browser-level gateway restart during an active child and dedicated long-duration memory profiling were not exercised. Backend restart persistence, SSE recovery, and replay remain covered by the prior verification pass.

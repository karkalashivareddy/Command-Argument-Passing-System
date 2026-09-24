# CAPS Observatory — Dashboard Information Architecture

## 1. Route structure

| Route | Page | Purpose |
| ----- | ---- | ------- |
| `/` | Overview | primary screen: status, live pipeline, quick execute, recent executions, mini analytics |
| `/execute` | Execute | command workspace with structured argv + redirection builders |
| `/live` | Live | real-time flight recorder for the most recent/active execution |
| `/processes` | Processes | real process table from the gateway registry |
| `/execution/:id` | Execution detail | full record: flight recorder, topology, argv, events, stdout/stderr, JSON |
| `/arguments/:id` | argv inspector | dedicated argument-vector view for an execution |
| `/signals` | Signal lab | run a process, send a real signal, observe termination |
| `/redirection` | Redirection | fd visualizer with real open/dup2/close flow |
| `/history` | History | searchable persisted executions |
| `/analytics` | Analytics | real metrics + charts from stored sessions |
| `/architecture` | Architecture | interactive system/call explainer |
| `/playground` | Playground | curated educational scenarios |
| `/settings` | Settings | local prefs (theme, reduced motion, limits display) |
| `/demo` | Demo | guided faculty presentation flow |

## 2. Application shell

- Left **sidebar**: brand (CAPS mark + “PROCESS EXECUTION OBSERVATORY”),
  nav (Overview, Execute, Live, Processes, History, Analytics,
  Architecture, Playground, Signals, Redirection, Settings); collapsible
  to icon rail; shows engine status + version at bottom.
- **Topbar**: context title, global command quick-execute input, engine
  status dot, live-stream dot, theme switch, keyboard-hint chip.
- Drawers/panels slide over content; dialogs for confirmations.

## 3. Overview layout

```
┌ Status strip: ENGINE ● ONLINE | STREAM ● CONNECTED | LINUX/POSIX | ACTIVE SESSION ┐
│ Hero: CAPS — Process Execution Observatory — "See what a command becomes."        │
│ $ [command ..........]                     [EXECUTE]                              │
├ Execution Pipeline (signature component) ────────────────────────────────────────┤
│ INPUT → PARSE → ARGV → FORK → EXEC → WAIT → RESULT (live, animated)              │
├──────────────┬──────────────────────────────┬────────────────────────────────────┤
│ MetricCards  │ RECENT EXECUTIONS (table)    │ MINI ANALYTICS (success rate,      │
│ (total,      │ command/status/pid/exit/     │  avg duration, top command)        │
│  active, ...)│ duration/time                │                                    │
└──────────────┴──────────────────────────────┴────────────────────────────────────┘
```

## 4. Information hierarchy rules

1. Status first (is the engine alive? is the stream live?).
2. Current action second (execute + live pipeline).
3. Real evidence third (recent executions, analytics).
4. Education fourth (architecture, playground, explanations).

## 5. Page templates

### Execute
Command field (with examples) → structured args chips → optional
redirection builders (`>`, `>>`, `<`) → option row (timeout) → EXECUTE →
live-preview panel (pipeline mini + latest events) + link to “Open in Live”.

### Execution detail
Header (command string, StatusBadge, pid, exit, signal, duration,
session id) → tabs: Flight Recorder | Process Graph | argv | Events |
Output | JSON.

### Live
Active session hero (pipeline + process countdown) → flight recorder
timeline → process topology → argv table → event console (auto-scroll,
pause, filter, JSON toggle).

### Processes
Live table: PID, COMMAND, STATE, START, DURATION, SESSION, STATUS;
row click → detail drawer. Empty/limited states honest.

### History
Filter bar (All/Success/Failed/Signals/Running + search) + sortable
table; row click → execution detail; inline replay action.

### Analytics
Metric row (total, success rate, failed, signalled, avg, p50/p95/p99) →
charts (duration over time, success/failure, exit-code distribution,
signal distribution, command frequency, redirection usage). All real;
empty state = “No executions recorded yet.”

### Signals
Scenario builder (default `sleep 10`) → process card (PID, RUNNING) →
`SEND SIGINT` → real event flow (SIGNAL_RECEIVED → PROCESS_EXITED
exit_code=130) → explanation panel.

### Redirection
Scenario builder (`echo Hello > demo.txt`) → fd graph
(open → dup2 → close → execvp) → flag table (O_TRUNC/O_APPEND/O_RDONLY)
from real parsed redirections → file reveal.

### Playground
Curated cards: Arguments, Process, Signal, Redirection, Exit status;
each with Run / Explain / Inspect argv / View lifecycle.

### Demo
Sequential guided scenarios with Next/Reset; each step executes a real
command and lands on the relevant view.

## 6. Navigation guard rails

- The Execute input in the topbar and Overview share one execution action
  model; starting an execution from anywhere navigates to `/live` with
  that session focused (unless the user stays via a toast on Overview).
- History/detail keep working while a session is running (write-ahead).
- Replay never re-executes; it replays stored telemetry only.

## 7. State vocabulary

A single `ExecutionView` object describes what the UI must render:
`session`, `events`, `activeStage`, `processes`, `argv`,
`streamState`. Screens never parse ad-hoc JSON themselves; they use the
same normalized types the API returns.

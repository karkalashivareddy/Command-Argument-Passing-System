export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const mmm = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat().format(n);
}

export function exitStatusLabel(exitCode: number | null, signal: number | null): string {
  if (signal !== null && signal > 0) {
    return `signal ${signal} (${signalName(signal)})`;
  }
  if (exitCode === null) return "no status";
  return `exit code ${exitCode}`;
}

export function signalName(sig: number): string {
  const table: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    4: "SIGILL",
    6: "SIGABRT",
    7: "SIGBUS",
    8: "SIGFPE",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    14: "SIGALRM",
    15: "SIGTERM",
    17: "SIGCHLD",
    18: "SIGCONT",
    19: "SIGSTOP",
    20: "SIGTSTP",
    21: "SIGTTIN",
    22: "SIGTTOU",
    30: "SIGUSR1",
    31: "SIGUSR2",
  };
  return table[sig] ?? `SIG${sig}`;
}

export function signalDescription(sig: number): string {
  const table: Record<number, string> = {
    1: "Hangup detected on controlling terminal or death of controlling process.",
    2: "Interrupt from keyboard (Ctrl+C). Previously installed handlers are reset before delivery.",
    6: "Abnormal termination triggered by abort().",
    9: "Kill signal; cannot be caught or ignored.",
    11: "Invalid memory reference (segmentation fault).",
    13: "Broken pipe; write to a pipe with no readers.",
    15: "Termination request — polite way to ask a process to stop.",
    19: "Stop the process; cannot be caught or ignored.",
    20: "Stop signal issued from keyboard (Ctrl+Z).",
  };
  return table[sig] ?? `Signal ${sig} delivered to the process.`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
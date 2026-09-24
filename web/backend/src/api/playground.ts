export interface PlaygroundExample {
  id: string;
  title: string;
  category: "arguments" | "process" | "signal" | "redirection" | "exit";
  command: string;
  args: string[];
  redirections?: { in?: string; out?: string; append?: string };
  explanation: string;
  tryIt?: string;
}

export const playgroundExamples: PlaygroundExample[] = [
  {
    id: "argv-basic",
    title: "Argument passing",
    category: "arguments",
    command: "echo",
    args: ["Hello", "Shiva"],
    explanation:
      "argv[0] is the program name, argv[1..] are the arguments. CAPS builds this vector and execvp() hands it to the target's main(argc, argv).",
    tryIt: "Watch argv[argc] == NULL and how each token becomes one argv entry.",
  },
  {
    id: "printf",
    title: "printf without a shell",
    category: "arguments",
    command: "printf",
    args: ["[%s]\\n", "Hello"],
    explanation:
      "printf is an external binary here — no shell formatting, no quoting layer. The bracket characters reach printf as literal argv entries.",
    tryIt: "Inspect argv to see that %s and \\n arrive untouched.",
  },
  {
    id: "sleep",
    title: "Running process lifecycle",
    category: "process",
    command: "sleep",
    args: ["5"],
    explanation:
      "The child is created with fork(), replaced by execvp() into /usr/bin/sleep, and the parent blocks in waitpid() until it exits.",
    tryIt: "Watch the pipeline reach WAIT and stay there for the full 5 seconds.",
  },
  {
    id: "success-exit",
    title: "Exit status 0",
    category: "exit",
    command: "true",
    args: [],
    explanation: "true is a program that always exits 0. waitpid() reaps it and WEXITSTATUS reads 0.",
    tryIt: "Session completes as successful.",
  },
  {
    id: "failure-exit",
    title: "Exit status 1",
    category: "exit",
    command: "false",
    args: [],
    explanation: "false always exits 1. The child is not killed — it returns 1 to the parent through its exit status.",
    tryIt: "The session exits with code 1 and is recorded as failed.",
  },
  {
    id: "signal-int",
    title: "SIGINT termination",
    category: "signal",
    command: "sleep",
    args: ["30"],
    explanation:
      "CAPS resets SIGINT to its default in the child, so sending SIGINT really ends the process — the parent then reports 128 + 2 = 130.",
    tryIt: "After it starts, press Send SIGINT in the lab.",
  },
  {
    id: "status-probe",
    title: "Test helper: exit + signal",
    category: "exit",
    command: "status_probe",
    args: ["exit", "42"],
    explanation:
      "A deterministic helper compiled by the CAPS test harness: exits exactly 42 or, with 'signal N', kills itself with signal N.",
    tryIt: "exit 42; session exit_code = 42.",
  },
  {
    id: "redir-out",
    title: "Truncating output",
    category: "redirection",
    command: "echo",
    args: ["Hello"],
    redirections: { out: "demo.txt" },
    explanation:
      "CAPS reports the stdout redirection configuration and whether redirection setup succeeded. Its current event protocol does not emit separate open(), dup2(), or close() events; those POSIX steps are an educational explanation.",
    tryIt: "Open History to inspect the observed redirection event and the recorded output.",
  },
  {
    id: "redir-in",
    title: "Reading from a file",
    category: "redirection",
    command: "cat",
    args: ["demo.txt"],
    explanation:
      "cat reads its argument; the earlier redirect wrote the content. Run redir-out first, then read demo.txt.",
    tryIt: "Chain both playground cards.",
  },
  {
    id: "not-found",
    title: "Unlisted command policy rejection",
    category: "exit",
    command: "definitely_not_a_command",
    args: [],
    explanation:
      "The gateway rejects this executable because it is not on the allowlist. No CAPS child is started. Use the local C monitor test to observe execvp() failure; the web gateway does not expose arbitrary missing executable names.",
    tryIt: "Run it to see the gateway's COMMAND_NOT_ALLOWED response before fork().",
  },
];

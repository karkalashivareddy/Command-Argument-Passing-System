# Redirection

Feature: the interactive REPL and the terminal route support `>` (truncate),
`>>` (append), `<` (input), and the fd-2 forms `2>` and `2>>`.

Audience: a new systems programmer who knows `fork`/`exec`/`wait` and
wants to understand *why* a shell needs file descriptors, and how one
program's stdout becomes another program's input.

---

## 1. The problem

Every Unix process starts with three descriptor slots:

| fd  | name     | default                       |
| --- | -------- | ----------------------------- |
| 0   | stdin    | the terminal (read)           |
| 1   | stdout   | the terminal (write)          |
| 2   | stderr   | the terminal (write, errors)  |

`echo hello` writes to fd 1. To make `echo` write to a *file* instead,
a shell must point the child's fd 1 at that file *before* the child
calls `execvp()` — because once a program runs, it demands fd 1 and
does not ask where it points.

So redirection reduces to: **re-assign std fds in the interval between
`fork()` and `execvp()`**. Three system calls do this:

```text
open()   -> obtain a new descriptor for the file   (e.g. fd 3)
dup2(a,b)-> copy descriptor a onto slot b          (b = 0, 1, or 2)
close()  -> release a descriptor no longer needed  (closes the "a")
```

---

## 2. The five operators

| Token | Flags passed to `open()`                | Child target |
| ----- | ---------------------------------------- | ------------ |
| `<`   | `O_RDONLY`                               | fd 0 (stdin) |
| `>`   | `O_WRONLY | O_CREAT | O_TRUNC`           | fd 1 (stdout)|
| `>>`  | `O_WRONLY | O_CREAT | O_APPEND`          | fd 1 (stdout)|
| `2>`  | `O_WRONLY | O_CREAT | O_TRUNC`           | fd 2 (stderr)|
| `2>>` | `O_WRONLY | O_CREAT | O_APPEND`          | fd 2 (stderr)|

Notes:

- `<` must exist; `open()` fails with `ENOENT` otherwise.
- `>` and `>>` create the file if absent (mode 0644).
- `>` truncates; `>>` preserves prior content and writes at the end.
- `2>` and `2>>` are the same pair aimed at fd 2. Each parent directory is
  opened descriptor-relatively with `O_DIRECTORY | O_NOFOLLOW`; the final file
  uses `O_NOFOLLOW | O_NONBLOCK` and a regular-file check. This rejects symlink
  components and avoids blocking on a FIFO before it can be rejected.

`O_TRUNC` vs `O_APPEND` is checkable: create a file, then run the same
command twice with both spellings and inspect the contents.

---

## 3. The lifecycle in `process_exec`

```mermaid
sequenceDiagram
    participant P as caps (parent)
    participant F as fork boundary
    participant C as caps (child)
    participant T as target program

    P->>P: open("<") -> fd f0
    P->>P: open(">") -> fd f1  (O_TRUNC)
    P->>F: fork()
    F->>C: child continues (inherits f0, f1)
    F->>P: parent continues (inherits f0, f1)
    C->>C: dup2(f0, 0); close(f0)
    C->>C: dup2(f1, 1); close(f1)
    C->>C: execvp(argv[0], argv)
    C->>T: replaces child image
    T->>T: writes to fd 1 -> file
    P->>P: close(f0); close(f1)
    P->>P: waitpid(child)
```

Three rules make this safe:

1. **open in the parent, before fork.** If the file is missing or the
   path unwritable, the failure is discovered *before any child is
   created*; the command never runs and the REPL reports the error.
2. **dup2 in the child, between fork and exec.** The child's fd table
   is a copy of the parent's, so the opened descriptors are
   automatically available after fork. Only the child permanently
   rewires fd 0/1; the parent's stdio is untouched.
3. **close in both.** The original f3/f4-style descriptors are
   inherited by `exec` unless closed; a well-behaved runner closes them
   so no stray descriptors leak into the target program (and the parent
   drops its own copies as soon as the child is forked).

### The closed-standard-fd edge case (`fd == target`)

`open()` always returns the *lowest* free descriptor. If stdout was
already closed before the command ran, `open("> f")` can legitimately
return `1`. A naive child then does:

```c
dup2(1, 1);   /* no-op: fd 1 already is fd 1 */
close(1);     /* BUG: closes the file we just installed */
```

The program that runs next writes to a closed stdout; the file ends up
empty and the write fails. Because CAPS opens redirections with
`O_CLOEXEC`, simply skipping `dup2(1, 1)` would also leave stdout closed at
`exec`. CAPS clears `FD_CLOEXEC` explicitly when the opened descriptor is
already the destination:

```c
if (fd == target) {
    fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
    continue;             /* already the target; preserve it across exec */
}
dup2(fd, target);
close(fd);
```

`tests/test_fd_edge.sh` reproduces this by running a command with fd 0
or fd 1 closed and checking that the redirected file receives the
output, including when the open descriptor is exactly fd 0 or fd 1.

### `close()` policy

Closing the parent's copies is best-effort: the parent calls
`close(fd)` and ignores its return value. At that point `fork()` has
succeeded and the child owns the files, so a `close()` error is not
actionable and is deliberately not reported. `open()` errors, by
contrast, are actionable and are reported before any process is
created.

---

## 4. Why dup2 and not "just set fd 1"?

The classic first attempt:

```c
close(fd1);      /* close stdout ... */
fd = open(path); /* ... hoping open() reuses slot 1 */
```

This is fragile: `open()` returns the *lowest* free slot, which only
happens to be 1 if nothing else was closed first — surprising if
stderr's slot is free because fd 0 was also closed. `dup2()` is the
explicit, race-free spelling: it says *"copy descriptor a onto slot b,
whatever b currently holds."*

---

## 5. Parser contract

Redirection is a *second pass* over the token list
(`parser_split_redirections`), applied to argv already built by
`parser_tokenize()`:

1. Validate first: every `<`, `>`, `>>`, `2>`, `2>>` must be followed by
   a token, and an operator may never occupy the file-name slot.
   Any violation reports a syntax error and the line is left untouched.
2. Classify each operator and record `(type, fd, file)`.
3. Remove the operator tokens and move the file tokens into the
   redirection list, compacting the remaining argv in place;
   `argv[argc] == NULL` is re-established.

Redirection works on whole tokens, and the tokenizer never splits inside a
word: `echo hi >f` is two literal arguments, and `echo hi> f` is two literal
arguments. There is no `&>`, and no heredocs or process substitution.

### 5.1 fd-number syntax is partial, and the partiality is deliberate

The fd-number prefix is implemented for **2 only**:

| Form | Status |
| --- | --- |
| `2>` | implemented: fd 2, truncate |
| `2>>` | implemented: fd 2, append |
| `1<` | **not** implemented — the token is an ordinary word |

`2>` exists because the engine genuinely has to open a second descriptor for
stderr and `dup2()` it onto slot 2; that is a mechanism worth demonstrating and
it is the one the terminal grammar publishes. `1<` would spell out the default
that `<` already gives, so it is not special-cased — and leaving it literal is
documented here rather than left for a reader to discover by trying it.
`tests/test_lifecycle.sh` exercises the strong form of `2>`: it asserts the
program's stderr really lands in the named file and that stdout does not leak
into it.

### 5.2 Grammar: whitespace is required

The operator is recognized **only** as a token equal to exactly `>`,
`>>`, `<`, `2>`, or `2>>`, separated from its neighbours by whitespace. The
tokenizer never splits inside a word, so:

| Input          | Interpretation                                   |
| -------------- | ------------------------------------------------ |
| `echo hi > f`  | redirect stdout to `f` (operator is token `>`)   |
| `echo hi >f`   | literal arguments `hi` and `>f`; **no** redirect |
| `echo hi> f`   | literal arguments `hi>` and `f`; **no** redirect  |
| `echo hi 2> f` | redirect stderr to `f` (operator is token `2>`)  |

This mirrors the project's "explicit grammar, no operator merging and no
re-tokenization" rule.

### 5.3 Multiple redirections

A line may contain more than one redirection operator. All of them are
extracted; the command's argv keeps only non-redirection tokens:
`cat < in > out` becomes argv `["cat", NULL]` plus two entries:
`(<, "in")` and `(>, "out")`. Redirections attach to the stage they are
written on, so in `a | b > out 2> err` both forms belong to `b`.

The child applies them in the order the file tokens appeared on the
line. Because each operator targets a fixed slot (`<` → fd 0,
`>`/`>>` → fd 1, `2>`/`2>>` → fd 2), a repeated target means **last one
wins**: `echo hi > a > b` writes only to `b` (`a` is still
created/truncated, since the parent opens every file first, but fd 1 ends
up pointing at `b`). This is a deliberately simple, documented rule; it is
not an error.

---

## 6. Not supported (documented limitations)

| Case                       | Behavior                                            |
| -------------------------- | --------------------------------------------------- |
| Built-ins (`help`/`exit`/`cd`) with redirection | rejected with an error                  |
| One-shot `caps cmd > f`    | tokens passed literally to `cmd` (no REPL parsing)  |
| `1<` (explicit fd 1 for input) | treated as a literal word; only `2>`/`2>>` have fd-number syntax |
| `&>` (stdout+stderr)       | not recognized                                      |
| heredocs, process substitution | not recognized                                  |

Rationale: redirecting a built-in would require dup2() around a
parent-side call and complicates the "child between fork and exec"
story; the one-shot mode deliberately hands over argv as given by the
caller. Each is a clean teaching boundary, not an accident.

---

## 7. Testing

`tests/test_redirection.sh` covers:

- `>` truncation and overwrite of existing content;
- `>>` append preserving prior content;
- `<` feeding stdin;
- combined `cat < in > out`;
- operators before the command (`> f echo hi`);
- missing input file (command aborted, error reported, REPL alive);
- unwritable target (command aborted, error reported, REPL alive);
- symlinked parent and final components (no outside file modified);
- FIFO and character-device targets (rejected without blocking);
- syntax errors (`>`, `echo >`, and a redirection with no command);
- built-in + redirection rejection.

`tests/test_fd_edge.sh` additionally covers the closed-standard-fd case
(`fd == target`): a `>` or `>>` command run with fd 1 closed must still
write its output to the target file, and a `<` command run with fd 0
closed must still read input.

Run with the rest of the suite: `make test` and `make test-asan`.

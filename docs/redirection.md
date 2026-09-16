# Redirection

Feature: interactive REPL supports `>` (truncate), `>>` (append), and
`<` (input).

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

## 2. The three operators

| Token | Flags passed to `open()`                | Child target |
| ----- | ---------------------------------------- | ------------ |
| `<`   | `O_RDONLY`                               | fd 0 (stdin) |
| `>`   | `O_WRONLY | O_CREAT | O_TRUNC`           | fd 1 (stdout)|
| `>>`  | `O_WRONLY | O_CREAT | O_APPEND`          | fd 1 (stdout)|

Notes:

- `<` must exist; `open()` fails with `ENOENT` otherwise.
- `>` and `>>` create the file if absent (mode 0644).
- `>` truncates; `>>` preserves prior content and writes at the end.

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

The tokenizer stays dumb — it splits on whitespace only. Redirection is
a *second pass* over the token list (`parser_split_redirections`):

1. Validate first: every `<`, `>`, `>>` must be followed by a token.
   Any violation reports a syntax error and the line is left untouched.
2. Classify each operator and record `(type, file)`.
3. Remove the operator tokens and move the file tokens into the
   redirection list, compacting the remaining argv in place;
   `argv[argc] == NULL` is re-established.

Redirection only works on whole tokens: `echo 2>` writes `2>` to stdout
as a literal argument; there is no fd-number syntax (`2>`) and no
`&>`; a redirection operator cannot be embedded in a word (`x>`).

---

## 6. Not supported (documented limitations)

| Case                       | Behavior                                            |
| -------------------------- | --------------------------------------------------- |
| Built-ins (`help`/`exit`/`cd`) with redirection | rejected with an error                  |
| One-shot `caps cmd > f`    | tokens passed literally to `cmd` (no REPL parsing)  |
| fd numbers (`2>`, `1<`)    | treated as literal words                            |
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
- syntax errors (`>`, `echo >`, and a redirection with no command);
- built-in + redirection rejection.

Run with the rest of the suite: `make test` and `make test-asan`.
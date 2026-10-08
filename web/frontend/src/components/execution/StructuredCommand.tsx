/**
 * The structured command control, and why it is not a text box.
 *
 * THE DEFECT THIS REPLACES
 * -----------------------
 * The Overview hero had a single free-form input with the placeholder
 * `echo Hello Shiva`, and submitting it ran:
 *
 *     const parts = command.trim().split(/\s+/);
 *     navigate("/execute", { state: { command: parts[0], args: parts.slice(1) } });
 *
 * That looks like a shell, and a person uses it like one. It is not one, and the
 * whitespace split discards every rule the engine actually implements:
 *
 *     echo "two words"   -> argv: echo, "two, words"     (two arguments, quotes kept)
 *     echo 'a  b'        -> argv: echo, 'a, b'
 *     grep -e foo\ bar   -> argv: grep, -e, foo\, bar
 *
 * CAPS runs exactly that argv, the flight recorder records exactly that argv, and
 * the Execution page then labels it "Command + argv · VALIDATED GATEWAY REQUEST".
 * So the UI certified a vector as validated that a client-side, undocumented and
 * lossy splitter had produced -- on the product's primary entry point. That is
 * the same trap the terminal route warns about in its own comment, reproduced
 * where nobody would look for it.
 *
 * WHY STRUCTURED argv INSTEAD OF A SMARTER PARSER
 * ----------------------------------------------
 * CAPS already owns exactly one lexer -- the C engine's -- and the browser is not
 * allowed a second opinion. The only honest choices are (a) send a structured
 * argv the browser never splits, or (b) send the raw string to the route whose job
 * is to hand it to that lexer. This control is (a), because a demonstration
 * should never depend on the visitor typing quotes correctly, and (b) is one
 * click away for the cases that genuinely need pipelines or redirection.
 *
 * So: an explicit COMMAND cell, one input per argv element, and a label that says
 * shell syntax is not interpreted. Every element is a literal, exactly as argv is.
 */

import { Plus, Terminal, Trash2 } from "lucide-react";

import { Button } from "../ui";

export interface StructuredCommandProps {
  /** argv[0]. Must be a bare program name: no path, no arguments. */
  program: string;
  /** argv[1..argc-1]. Each element is one literal argument. */
  args: string[];
  onProgramChange: (value: string) => void;
  onArgsChange: (value: string[]) => void;
  /** Parsed by the engine, via POST /api/terminal/validate. Null to skip. */
  onGoToTerminal?: () => void;
  engineOnline: boolean;
  compact?: boolean;
}

const FIELD_CLS =
  "h-9 w-full rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2.5 font-mono text-[12.5px] text-[var(--fg-0)] placeholder:text-[var(--fg-4)] focus:border-[var(--accent)] focus:outline-none";

export function StructuredCommand({
  program,
  args,
  onProgramChange,
  onArgsChange,
  onGoToTerminal,
  engineOnline,
  compact = false,
}: StructuredCommandProps) {
  const setArg = (index: number, value: string) => {
    const next = args.slice();
    next[index] = value;
    onArgsChange(next);
  };

  const addArg = () => onArgsChange([...args, ""]);

  const removeArg = (index: number) => {
    const next = args.slice();
    next.splice(index, 1);
    onArgsChange(next);
    // Focus is not restored after the removal: the control is a list and the
    // removed row no longer exists to hold it. The keyboard user keeps whatever
    // focus they had, which is why the remove button is removed from the tab
    // order only when it is the only row.
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className={compact ? "min-w-[10rem] flex-1" : "min-w-[12rem] flex-1"}>
          <label htmlFor="caps-program" className="mb-1 block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">
            Command <span className="text-[var(--fg-4)] normal-case">argv[0]</span>
          </label>
          <input
            id="caps-program"
            value={program}
            onChange={(e) => onProgramChange(e.target.value)}
            placeholder="echo"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={FIELD_CLS}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">
            Arguments <span className="text-[var(--fg-4)] normal-case">argv[1..{Math.max(1, args.length)}]</span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={addArg}>
            <Plus className="h-3 w-3" /> Add argument
          </Button>
        </div>

        {args.length === 0 ? (
          <p className="rounded-[var(--r-sm)] border border-dashed border-[var(--line-0)] px-3 py-2 text-[11.5px] text-[var(--fg-3)]">
            No arguments. This program will be executed with an argv of exactly one element.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {args.map((arg, index) => (
              <li key={index} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="w-10 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-[var(--fg-4)]"
                >
                  argv[{index + 1}]
                </span>
                {/*
                  One label per input, addressed by id. The arguments are a
                  list of equal peers, so a wrapping <label> -- which may
                  contain only one labelable element -- would give every field
                  the same accessible name and associate none of them with the
                  argv index a sighted reader can see.
                */}
                <label htmlFor={`caps-arg-${index}`} className="sr-only">
                  Argument {index + 1}
                </label>
                <input
                  id={`caps-arg-${index}`}
                  value={arg}
                  onChange={(e) => setArg(index, e.target.value)}
                  placeholder={index === 0 ? "Hello CAPS" : "argument"}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={FIELD_CLS}
                />
                <button
                  type="button"
                  onClick={() => removeArg(index)}
                  aria-label={`Remove argument ${index + 1}`}
                  className="shrink-0 rounded-[var(--r-sm)] p-1.5 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--danger)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--fg-3)]">
        <strong className="font-semibold text-[var(--fg-2)]">Structured argv</strong> — each box is one literal element of
        the argument vector. <span className="text-[var(--fg-2)]">Shell syntax is not interpreted</span>: no quoting,
        no globbing, no <code className="font-mono">$VAR</code>, no{" "}
        <code className="font-mono">|</code>, no <code className="font-mono">&amp;&amp;</code>. A space you type
        inside a box is part of that argument. To use a pipeline or redirection, switch to the{" "}
        {onGoToTerminal ? (
          <button
            type="button"
            onClick={onGoToTerminal}
            className="inline-flex items-center gap-1 font-medium text-[var(--accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <Terminal className="h-3 w-3" /> terminal
          </button>
        ) : (
          "terminal"
        )}
        , which is parsed by the C engine itself.
      </p>

      {!engineOnline ? (
        <p className="text-[11.5px] text-[var(--warn)]" role="status">
          The engine is not online. This control will not submit until it is.
        </p>
      ) : null}
    </div>
  );
}

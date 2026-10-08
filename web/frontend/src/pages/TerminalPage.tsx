/**
 * Terminal surface: text mode and structured mode, both driven by the gateway.
 *
 * THE ONE RULE
 * ------------
 * This component never decides what is runnable. It calls `/api/terminal/validate`,
 * and the gateway calls the C engine's lexer, and the answer is rendered. The Run
 * button reflects the gateway's verdict.
 *
 * That is why there is no client-side parsing here despite this being a terminal
 * with a command line in it. A second lexer is how an argv allowlist gets
 * defeated: the two lexers disagree about one quoting case, and the disagreement
 * is always in the unsafe direction, because the component would be approving a
 * line the engine reads differently.
 *
 * TWO MODES, ONE TRUTH
 * --------------------
 * Text mode is a familiar single-line editor. Structured mode draws the pipeline
 * as stages. They show the same validation result from the same response, so the
 * structured view cannot drift from what text mode would have run.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  catalogApi,
  TerminalApiError,
  type CatalogResponse,
  type CommandHelp,
  type GrammarResponse,
  type TerminalExecuteAccepted,
  type TerminalValidation,
} from "../api/observability";
import {
  describeStdin,
  describeStdout,
  filterCommands,
  firstToken,
  formatArgv,
  groupByCategory,
  localLimitWarnings,
  nextCommandIndex,
  renderResolvedLine,
  resolutionDiffers,
  summariseRedirections,
} from "../lib/terminal";
import { StatusDot } from "../components/ui";

/**
 * Where the terminal is in its own lifecycle.
 *
 * Modelled explicitly because "no validation yet" and "valid" and "invalid" are
 * three different states, and collapsing them into a boolean would let the Run
 * button be enabled before the gateway had been asked -- the exact window in
 * which a line gets approved by default rather than by checking.
 */
type ValidationState =
  | { readonly kind: "unvalidated" }
  | { readonly kind: "validating" }
  | { readonly kind: "valid"; readonly validation: TerminalValidation }
  | { readonly kind: "invalid"; readonly message: string; readonly stageIndex: number | null; readonly hint: string | null };

type Mode = "text" | "structured";

/** Tab order matches visual order; arrow keys follow it and wrap. */
const MODES: readonly Mode[] = ["text", "structured"];

export interface TerminalPageProps {
  /**
   * Called with the accepted session id, so the app can follow the execution.
   *
   * This prop used to be declared and then never provided: `App.tsx` rendered
   * `<TerminalPage />` with no props, so the callback was always undefined and
   * the session id the gateway had just allocated was thrown away. Pressing Run
   * on the terminal started a real execution and then did nothing at all -- no
   * navigation, no link, no confirmation. The only route from `/terminal` to a
   * flight recorder had to be re-typed by hand.
   *
   * It is now supplied and the default navigates, so the route cannot silently
   * regress to "runs a command and shows nothing".
   */
  onExecuted?: (accepted: TerminalExecuteAccepted) => void;
}

export default function TerminalPage({ onExecuted }: TerminalPageProps = {}): React.JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("text");
  const [line, setLine] = useState<string>("seq 1 20 | grep 1 | wc -l");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [grammar, setGrammar] = useState<GrammarResponse | null>(null);
  const [selected, setSelected] = useState<CommandHelp | null>(null);
  const [state, setState] = useState<ValidationState>({ kind: "unvalidated" });
  const [executing, setExecuting] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const tabRefs = useRef<Partial<Record<Mode, HTMLButtonElement | null>>>({});

  /**
   * Arrow keys move between the mode tabs and select as they move, which is the
   * automatic-activation variant of the tabs pattern: the panel below is a
   * rendering of the same line the reader is editing, so showing the panel for
   * the tab the arrow landed on is the useful behaviour, and it means the panel
   * is never out of step with `aria-selected`.
   */
  const onTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const at = MODES.indexOf(mode);
    const next = MODES[(at + delta + MODES.length) % MODES.length]!;
    setMode(next);
    tabRefs.current[next]?.focus();
  }, [mode]);

  // Validation is requested per keystroke and superseded by whichever response
  // arrives last. The AbortController is what makes that safe: without it, a
  // slow validation of an early keystroke can land after a fast validation of a
  // later one and overwrite it, so the Run button reflects a line the user has
  // already edited away from.
  const validateAbort = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, g] = await Promise.all([catalogApi.catalog(), catalogApi.grammar()]);
        if (!cancelled) {
          setCatalog(c);
          setGrammar(g);
        }
      } catch {
        // A terminal that cannot reach the catalog cannot offer anything, and
        // saying so plainly is more useful than an empty picker.
        if (!cancelled) setCatalog(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const validate = useCallback(async (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed === "") {
      setState({ kind: "unvalidated" });
      return;
    }
    validateAbort.current?.abort();
    const controller = new AbortController();
    validateAbort.current = controller;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    setState({ kind: "validating" });
    try {
      const result = await catalogApi.validate(trimmed);
      // Discard a response that is no longer about the current line.
      if (seq !== requestSeq.current) return;
      setState({ kind: "valid", validation: result });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err instanceof TerminalApiError) {
        setState({ kind: "invalid", message: err.message, stageIndex: err.stageIndex, hint: err.hint });
      } else {
        setState({ kind: "invalid", message: String(err), stageIndex: null, hint: null });
      }
    }
  }, []);

  // Debounced so a burst of typing produces one engine invocation, not one per
  // keystroke. The delay is short enough to feel immediate and long enough that
  // the engine is not the bottleneck while typing.
  useEffect(() => {
    const handle = setTimeout(() => void validate(line), 180);
    return () => clearTimeout(handle);
  }, [line, validate]);

  useEffect(() => {
    return () => validateAbort.current?.abort();
  }, []);

  const execute = useCallback(async () => {
    if (state.kind !== "valid" || executing) return;
    setExecuting(true);
    try {
      const accepted = await catalogApi.execute(line.trim());
      // Follow the execution. Defaulting here rather than in App.tsx means the
      // route behaves correctly however it is mounted, including in a test that
      // renders the component alone.
      if (onExecuted) onExecuted(accepted);
      else navigate(`/execution/${accepted.sessionId}`);
    } catch (err) {
      setState({
        kind: "invalid",
        message: err instanceof Error ? err.message : String(err),
        stageIndex: err instanceof TerminalApiError ? err.stageIndex : null,
        hint: err instanceof TerminalApiError ? err.hint : null,
      });
    } finally {
      setExecuting(false);
    }
  }, [state, executing, line, onExecuted, navigate]);

  const available = useMemo(() => (catalog?.commands ?? []).filter((c) => c.availability === "AVAILABLE"), [catalog]);
  const matched = useMemo(() => filterCommands(available, firstToken(line) ?? ""), [available, line]);
  const warnings = useMemo(() => localLimitWarnings(line, grammar), [line, grammar]);
  const groups = useMemo(() => groupByCategory(available), [available]);
  const resolvedLine = state.kind === "valid" ? renderResolvedLine(state.validation) : null;
  const differs = state.kind === "valid" ? resolutionDiffers(line, state.validation) : false;
  const canRun = state.kind === "valid" && !executing;

  /*
   * Replace argv[0] only. The rest of the line is left byte-for-byte alone.
   *
   * This used to be `line.trim().split(/\s+/)`, assign into index 0, and
   * `join(" ")`. That round-trip rewrites the entire command: `seq '1  20' |
   * grep x` came back as `seq '1 20' | grep x`, so a quoted argument that had
   * contained two spaces was silently split into two argv elements. Nothing told
   * the user, and the validity hint compared against the already-mangled line,
   * so the corruption was invisible from every surface on the page.
   *
   * Only the leading token is replaced, which is the whole intent of clicking a
   * command in the catalog: keep the arguments, swap the program.
   */
const insertCommand = useCallback(
    (name: string) => {
      const trimmed = line.trimStart();
      const rest = trimmed.replace(/^\S+/, "");
      setLine(`${name}${rest}`);
    },
    [line],
  );

  return (
    <section aria-label="Terminal" className="caps-terminal">
      <header className="caps-terminal__bar">
        {/*
          Roving tabindex, per the tabs pattern: exactly one tab stop for the
          whole tablist, the selected tab, and arrow keys to move between them.
          With plain tabbable buttons a reader tabbed through both tabs before
          reaching the command line, and the two tabs pointed at nothing: there
          was no tabpanel, so selecting one announced a change with no panel to
          change. Arrow-key navigation and the panel below are added together.
        */}
        <div role="tablist" aria-label="Terminal mode" className="caps-terminal__modes" onKeyDown={onTabKeyDown}>
          {MODES.map((m) => (
            <button
              key={m}
              role="tab"
              id={`terminal-tab-${m}`}
              aria-selected={mode === m}
              aria-controls="terminal-mode-panel"
              tabIndex={mode === m ? 0 : -1}
              type="button"
              onClick={() => setMode(m)}
              ref={(element) => {
                if (mode === m) tabRefs.current[m] = element;
              }}
            >
              {m === "text" ? "Text" : "Structured"}
            </button>
          ))}
        </div>
        <span className="caps-terminal__status" role="status">
          {describeValidationState(state)}
        </span>
      </header>

      {/*
        One panel shared by both tabs: both modes edit the same command line and
        render the same verdict, they differ only in how the pipeline is drawn.
        `aria-labelledby` follows the selected tab so the panel is announced as
        the content of the tab that is actually open. The panel is not focusable
        because the command line inside it is the first thing a reader wants, and
        making the wrapper a tab stop would add a stop that does nothing.
      */}
      <div id="terminal-mode-panel" role="tabpanel" aria-labelledby={`terminal-tab-${mode}`}>
      <label className="caps-terminal__input">
        <span>Command line</span>
        <input
          type="text"
          value={line}
          spellCheck={false}
          autoComplete="off"
          placeholder="seq 1 20 | grep 1 | wc -l"
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canRun) void execute();
          }}
        />
      </label>

      {mode === "structured" ? (
        <StructuredPipeline state={state} differs={differs} resolvedLine={resolvedLine} />
      ) : (
        <p className="caps-terminal__hint">
          Quoting and <code>|</code>, <code>&gt;</code>, <code>&gt;&gt;</code>, <code>&lt;</code>, <code>2&gt;</code> and{" "}
          <code>2&gt;&gt;</code> are interpreted by the CAPS engine. Anything else is passed through as ordinary characters.
        </p>
      )}

      {warnings.map((w) => (
        <p key={w} className="caps-terminal__warning" role="alert">
          {w}
        </p>
      ))}

      {state.kind === "invalid" && (
        <div className="caps-terminal__error" role="alert">
          <strong>
            {state.stageIndex === null ? "Refused" : `Refused at stage ${state.stageIndex}`}
          </strong>
          <p>{state.message}</p>
          {state.hint !== null && <p className="caps-terminal__hint">{state.hint}</p>}
        </div>
      )}

      {state.kind === "valid" && differs && resolvedLine !== null && (
        <p className="caps-terminal__hint">
          The engine resolves this to <code>{resolvedLine}</code>. That argv is what will be executed.
        </p>
      )}

      <button type="button" disabled={!canRun} onClick={() => void execute()}>
        {executing ? "Starting…" : "Run"}
      </button>
      </div>

      {grammar !== null && (
        <details className="caps-terminal__grammar">
          <summary>What this terminal supports</summary>
          <p>{grammar.summary}</p>
          <h4>Operators</h4>
          <dl>
            {grammar.operators.map((op) => (
              <div key={op.syntax}>
                <dt>
                  <code>{op.syntax}</code>
                </dt>
                <dd>{op.meaning}</dd>
              </div>
            ))}
          </dl>
          <h4>Not implemented</h4>
          <dl>
            {grammar.notImplemented.map((n) => (
              <div key={n.syntax}>
                <dt>
                  <code>{n.syntax}</code>
                </dt>
                <dd>{n.reason}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {catalog !== null && (
        <section className="caps-terminal__catalog">
          <h3>
            Commands available on this host ({catalog.summary.available} of {catalog.summary.total})
          </h3>
          {catalog.summary.unavailable > 0 && (
            <p className="caps-terminal__hint">
              {catalog.summary.unavailable} command(s) are declared but unavailable here. They are listed with the reason,
              and cannot be run.
            </p>
          )}
          {[...groups.entries()].map(([category, commands]) => (
            <div key={category}>
              <h4>{category}</h4>
              <ul>
                {commands.map((c) => (
                  <li key={c.name}>
                    <button type="button" onClick={() => insertCommand(c.name)}>
                      {c.name}
                    </button>
                    <span className="caps-terminal__catalog-reason">{c.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {catalog.refusedByPolicy.length > 0 && (
            <details>
              <summary>Refused by policy ({catalog.refusedByPolicy.length})</summary>
              <dl>
                {catalog.refusedByPolicy.map((r) => (
                  <div key={r.name}>
                    <dt>
                      <code>{r.name}</code>
                    </dt>
                    <dd>{r.reason}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      )}

      {matched.length > 0 && selected === null && (
        <p className="caps-terminal__hint" aria-live="polite">
          {matched.length === 1
            ? `Did you mean ${matched[0]!.name}?`
            : `${matched.length} catalog commands start with that prefix.`}
        </p>
      )}

      {available.length > 0 && (
        <button
          type="button"
          onClick={() => setCommandIndex((i) => nextCommandIndex(i, available.length))}
          aria-label="Cycle through available commands"
        >
          Next command ({available[commandIndex]?.name ?? "none"})
        </button>
      )}

      {selected !== null && (
        <aside className="caps-terminal__detail">
          <h3>
            {selected.name}
            {/*
             * Availability as a tone, not a colour of its own invention. The
             * gateway's three states map onto the existing tones so a command
             * the host cannot run is visually consistent with every other
             * status indicator in the app.
             */}
            <StatusDot
              tone={
                selected.availability === "AVAILABLE"
                  ? "success"
                  : selected.availability === "UNAVAILABLE"
                    ? "warn"
                    : "danger"
              }
              label={selected.availability}
            />
          </h3>
          <p>{selected.description}</p>
          <h4>Why CAPS permits it</h4>
          <p>{selected.whyAllowed}</p>
          <h4>Availability on this host</h4>
          <p>
            <strong>{selected.availability}</strong> — {selected.availabilityReason}
          </p>
          <h4>Executable</h4>
          <p>
            <code>{selected.executable ?? "not resolved on this host"}</code>
          </p>
          <h4>Arguments</h4>
          <p>{selected.safeArguments}</p>
          <h4>Constraints</h4>
          <ul>
            {selected.securityRestrictions.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <h4>Telemetry relevance</h4>
          <p>{selected.telemetryRelevance}</p>
          <h4>Examples from the catalog</h4>
          <ul>
            {selected.examples.map((e) => (
              <li key={e.command}>
                <button
                  type="button"
                  onClick={() => {
                    setLine(e.command);
                    void catalogApi.help(selected.name).then(setSelected).catch(() => {});
                  }}
                >
                  <code>{e.command}</code>
                </button>
                <span>{e.note}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void catalogApi.help(selected.name).then(setSelected).catch(() => {})}>
            Refresh
          </button>
        </aside>
      )}
    </section>
  );
}

/** The structured pipeline view: one row per stage, from the engine's own words. */
function StructuredPipeline({
  state,
  differs,
  resolvedLine,
}: {
  state: ValidationState;
  differs: boolean;
  resolvedLine: string | null;
}): React.JSX.Element | null {
  if (state.kind === "unvalidated" || state.kind === "validating") {
    return <p className="caps-terminal__hint">Validating against the catalog…</p>;
  }
  if (state.kind === "invalid") return null;

  const { stages } = state.validation;
  return (
    <div className="caps-terminal__pipeline">
      <p className="caps-terminal__hint">
        {stages.length} stage{stages.length === 1 ? "" : "s"}, each a real process in one process group.
      </p>
      <ol>
        {stages.map((stage) => {
          const redirs = summariseRedirections(stage);
          return (
            <li key={stage.index}>
              <strong>
                stage {stage.index} — {stage.command}
              </strong>
              <dl>
                <div>
                  <dt>argv</dt>
                  <dd>
                    <code>{formatArgv(stage.argv)}</code>
                  </dd>
                </div>
                <div>
                  <dt>executable</dt>
                  <dd>
                    <code>{stage.resolvedExecutable}</code>
                  </dd>
                </div>
                <div>
                  <dt>stdin</dt>
                  <dd>{describeStdin(stage)}</dd>
                </div>
                <div>
                  <dt>stdout</dt>
                  <dd>{describeStdout(stage)}</dd>
                </div>
                {redirs.length > 0 && (
                  <div>
                    <dt>redirections</dt>
                    <dd>
                      {redirs.map((r) => `${r.stream} ${r.operator} ${r.target}`).join(", ")}
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
      {differs && resolvedLine !== null && (
        <p className="caps-terminal__hint">Executable form: <code>{resolvedLine}</code></p>
      )}
    </div>
  );
}

/** A short, honest description of the validation state. */
function describeValidationState(state: ValidationState): string {
  switch (state.kind) {
    case "unvalidated":
      return "Nothing validated yet";
    case "validating":
      return "Validating…";
    case "valid":
      return `Valid — ${state.validation.stages.length} stage(s)`;
    case "invalid":
      return state.stageIndex === null ? "Refused" : `Refused at stage ${state.stageIndex}`;
  }
}

import { clsx } from "clsx";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const btnBase =
  "inline-flex items-center justify-center gap-1.5 font-medium rounded-[var(--r-sm)] transition-[color,background-color,border-color,box-shadow,transform] duration-[var(--motion-instant)] cursor-pointer select-none active:translate-y-px active:scale-[0.985] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0 disabled:active:scale-100";
const btnVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--fg-inverse)] shadow-[0_2px_12px_-5px_var(--accent)] hover:-translate-y-px hover:brightness-110 hover:shadow-[0_5px_18px_-6px_var(--accent)] active:brightness-95 focus-visible:outline-[var(--accent)]",
  secondary: "border border-[var(--line-1)] bg-[var(--bg-3)] text-[var(--fg-0)] hover:-translate-y-px hover:border-[var(--line-2)] hover:bg-[var(--bg-4)] hover:shadow-[var(--shadow-raised)]",
  ghost: "bg-transparent text-[var(--fg-1)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]",
  danger: "bg-[var(--red)] text-[var(--fg-inverse)] hover:-translate-y-px hover:brightness-110 active:brightness-95",
  outline: "border border-[var(--line-2)] bg-transparent text-[var(--fg-1)] hover:-translate-y-px hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--fg-0)]",
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonProps) {
  const sizes = size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-sm";
  return <button className={clsx(btnBase, sizes, btnVariants[variant], className)} {...rest} />;
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

export const inputCls =
  "h-9 w-full rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-3)] transition-[border-color,box-shadow,background-color] duration-[var(--motion-instant)] focus:border-[var(--accent)] focus:bg-[var(--bg-3)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20";

/**
 * The visible caption above a form control group.
 *
 * It is kept as a bare `<span>` with a generated id rather than a `<label>`
 * wrapper because two of the call sites on ExecutePage pass SEVERAL
 * labelable controls as children: the N argument inputs with their N remove
 * buttons and the "Add argument" button, and the three redirection inputs. A
 * `<label>` may contain at most one labelable descendant, so wrapping them gave
 * every one of those inputs the same accessible name ("Arguments
 * (argv[1…argc-1])") and left none of them associated with its own visible
 * `argv[n]` caption. The caption text is unchanged; only the element and the
 * wiring differ, so nothing looks different on screen.
 *
 * Two ways to wire it, both supplied by the caller:
 *   - `controlId`: the single control owns the caption through `htmlFor`, which
 *     is the strongest association available.
 *   - `groupId`: the children are wrapped in `role="group" aria-labelledby`,
 *     for the call sites that legitimately hold several controls. Those
 *     controls still carry their own `aria-label` so each one is individually
 *     identifiable, which is what a screen reader announces per stop.
 */
const FIELD_LABEL_CLS = "mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[var(--fg-2)]";

export function Field({
  label,
  hint,
  children,
  controlId,
  groupId,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Set when exactly one control owns this caption. */
  controlId?: string;
  /** Set when several controls share this caption and form one labelled group. */
  groupId?: string;
}) {
  const generatedId = useId();
  const captionId = groupId === undefined ? generatedId : groupId;
  return (
    <div className="block">
      {controlId === undefined ? (
        <span id={captionId} className={FIELD_LABEL_CLS}>
          {label}
        </span>
      ) : (
        <label htmlFor={controlId} className={FIELD_LABEL_CLS}>
          {label}
        </label>
      )}
      {groupId === undefined ? (
        children
      ) : (
        <div role="group" aria-labelledby={captionId}>
          {children}
        </div>
      )}
      {hint ? <span className="mt-1 block text-[12px] text-[var(--fg-3)]">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card / Panel                                                        */
/* ------------------------------------------------------------------ */

export function Card({ title, subtitle, actions, children, className, pad = true }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={clsx("caps-card-surface rounded-[var(--r-lg)] border border-[var(--line-0)]", className)}>
      {title ? (
        <header className="flex items-start justify-between gap-3 border-b border-[var(--line-0)] px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-[var(--fg-0)] leading-tight">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[12px] text-[var(--fg-2)]">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Status dot + badge                                                  */
/* ------------------------------------------------------------------ */

export type Tone = "neutral" | "active" | "success" | "warn" | "danger" | "violet";

const toneDot: Record<Tone, string> = {
  neutral: "bg-[var(--fg-3)]",
  active: "bg-[var(--accent)]",
  success: "bg-[var(--green)]",
  warn: "bg-[var(--amber)]",
  danger: "bg-[var(--red)]",
  violet: "bg-[var(--violet)]",
};

const toneText: Record<Tone, string> = {
  neutral: "text-[var(--fg-2)]",
  active: "text-[var(--accent)]",
  success: "text-[var(--green)]",
  warn: "text-[var(--amber)]",
  danger: "text-[var(--red)]",
  violet: "text-[var(--violet)]",
};

export function StatusDot({ tone, pulse = false, label }: { tone: Tone; pulse?: boolean; label?: string }) {
  return (
    /*
     * aria-label on the wrapper plus a rendered `label` text node means a
     * screen reader announced the same words twice. The dot carries no
     * information a reader can get from the label, so it is hidden from the
     * accessibility tree and only the wrapper is named.
     */
    <span className={clsx("inline-flex items-center gap-1.5", toneText[tone])} aria-label={label ?? tone}>
      <span className="relative inline-flex h-2 w-2" aria-hidden="true">
        {pulse ? <span className={clsx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", toneDot[tone])} /> : null}
        <span className={clsx("relative inline-flex h-2 w-2 rounded-full", toneDot[tone])} />
      </span>
      {label ? <span className="text-[12px] font-medium">{label}</span> : null}
    </span>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-[var(--r-sm)] border px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "border-[var(--line-1)] bg-[var(--bg-3)] text-[var(--fg-1)]",
        tone === "active" && "border-[var(--accent-soft)] bg-[var(--accent-soft)] text-[var(--accent)]",
        tone === "success" && "border-[var(--green-soft)] bg-[var(--green-soft)] text-[var(--green)]",
        tone === "warn" && "border-[var(--amber-soft)] bg-[var(--amber-soft)] text-[var(--amber)]",
        tone === "danger" && "border-[var(--red-soft)] bg-[var(--red-soft)] text-[var(--red)]",
        tone === "violet" && "border-[var(--violet-soft)] bg-[var(--violet-soft)] text-[var(--violet)]",
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon ? <div className="text-[var(--fg-3)]">{icon}</div> : null}
      <p className="text-sm font-medium text-[var(--fg-1)]">{title}</p>
      {body ? <p className="max-w-sm text-[12.5px] leading-relaxed text-[var(--fg-3)]">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy button                                                         */
/* ------------------------------------------------------------------ */

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      // Fall back for browsers that expose Clipboard API without write access.
    }
    if (!ok) {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        textarea.remove();
      }
    }
    setCopied(ok);
    setCopyFailed(!ok);
    window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 1400);
  };
  return (
    <Button size="sm" variant="ghost" className={clsx("gap-1 text-[var(--fg-2)] hover:text-[var(--fg-0)]", className)} onClick={copy}>
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--green)]" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : copyFailed ? "Copy failed" : label}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[var(--fg-2)]">
      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" />
      {label ? <span className="text-[12.5px]">{label}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Code block                                                          */
/* ------------------------------------------------------------------ */

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={clsx("rounded-[var(--r-sm)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--fg-0)]", className)}>{children}</code>;
}

export function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-auto rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] p-3 font-mono text-[12px] leading-relaxed text-[var(--fg-1)]">
      {children}
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/* Live badge (pulses only while actually streaming)                   */
/* ------------------------------------------------------------------ */

export function LiveBadge({ live }: { live: boolean }) {
  return <StatusDot tone={live ? "success" : "neutral"} pulse={live} label={live ? "LIVE" : "OFF"} />;
}

/* ------------------------------------------------------------------ */
/* useInterval for elapsed clocks                                      */
/* ------------------------------------------------------------------ */

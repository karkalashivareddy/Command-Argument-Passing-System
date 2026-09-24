import { clsx } from "clsx";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const btnBase =
  "inline-flex items-center justify-center gap-1.5 font-medium rounded-[var(--r-sm)] transition-colors duration-[var(--dur-fast)] cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed";
const btnVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--fg-inverse)] hover:brightness-110 active:brightness-95 focus-visible:outline-[var(--accent)]",
  secondary: "bg-[var(--bg-3)] text-[var(--fg-0)] border border-[var(--line-1)] hover:bg-[var(--bg-4)]",
  ghost: "bg-transparent text-[var(--fg-1)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]",
  danger: "bg-[var(--red)] text-[var(--fg-inverse)] hover:brightness-110 active:brightness-95",
  outline: "bg-transparent border border-[var(--line-2)] text-[var(--fg-1)] hover:border-[var(--accent)] hover:text-[var(--fg-0)]",
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonProps) {
  const sizes = size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-sm";
  return <button className={clsx(btnBase, sizes, btnVariants[variant], className)} {...rest} />;
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

export const inputCls =
  "h-9 w-full rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-3)] transition-colors focus:border-[var(--accent)] focus:outline-none";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[var(--fg-2)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[12px] text-[var(--fg-3)]">{hint}</span> : null}
    </label>
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
    <section className={clsx("rounded-[var(--r-lg)] border border-[var(--line-0)] bg-[var(--bg-1)] shadow-[var(--shadow-panel)]", className)}>
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
    <span className={clsx("inline-flex items-center gap-1.5", toneText[tone])} aria-label={label ?? tone}>
      <span className="relative inline-flex h-2 w-2">
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

export function useNow(intervalMs = 250, active = true): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(performance.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

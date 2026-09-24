import { useState } from "react";

interface TooltipProps {
  title: string;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

/** Lightweight CSS tooltip (no portal, works inside overflow-y containers). */
export function Tooltip({ title, children, side = "top" }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="group relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? <span className="sr-only">{title}</span> : null}
      {open ? (
        <span
          className={`pointer-events-none absolute z-40 whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-3)] px-2 py-1 text-[11px] text-[var(--fg-0)] shadow-[var(--shadow-pop)] ${
            side === "top"
              ? "bottom-full left-1/2 mb-1.5 -translate-x-1/2"
              : side === "bottom"
                ? "top-full left-1/2 mt-1.5 -translate-x-1/2"
                : side === "left"
                  ? "right-full top-1/2 mr-1.5 -translate-y-1/2"
                  : "left-full top-1/2 ml-1.5 -translate-y-1/2"
          }`}
        >
          {title}
        </span>
      ) : null}
    </span>
  );
}

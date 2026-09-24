import { motion } from "motion/react";
import { Hash } from "lucide-react";

import { Tooltip } from "../misc/Tooltip";

const encoder = new TextEncoder();

/**
 * argv[0] = program path; argv[1..argc-1] = arguments; argv[argc] = NULL.
 * Cells come from the actual session argv; the trailing NULL cell is the
 * one invariant the kernel actually guarantees.
 */
export function ArgvView({ argv, eventCount }: { argv: string[]; eventCount: number }) {
  const argc = argv.length;
  const rows: Array<{ index: number; value: string; isProgram: boolean }> = argv.map((v, i) => ({
    index: i,
    value: v,
    isProgram: i === 0,
  }));
  rows.push({ index: argc, value: "NULL", isProgram: false });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
        <Hash className="h-3 w-3" />
        argv[{argc}] · {eventCount} events for this session
      </div>
      <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">Source · structured execution request</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((row, i) => (
          <motion.div
            key={`${row.index}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, delay: Math.min(i * 0.08, 1.1) }}
          >
            <Tooltip
              title={
                row.isProgram
                  ? `argv[0] — the program path; the name the child runs`
                  : row.value === "NULL"
                    ? `argv[argc] — the kernel reads exactly argc entries, then stops at the required NULL terminator`
                    : `argv[${row.index}] — argument ${row.index} of ${argc}`
              }
            >
              <span
                className={
                  row.isProgram
                    ? "inline-flex items-center rounded-[var(--r-sm)] border border-[var(--accent-soft)] bg-[var(--bg-3)] px-2 py-1 font-mono text-[12px] text-[var(--fg-0)]"
                    : row.value === "NULL"
                      ? "inline-flex items-center rounded-[var(--r-sm)] border border-dashed border-[var(--line-2)] px-2 py-1 font-mono text-[12px] text-[var(--fg-3)]"
                      : "inline-flex items-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 py-1 font-mono text-[12px] text-[var(--fg-1)]"
                }
              >
                {row.value}
                <span className="ml-1.5 text-[9.5px] font-semibold leading-3 text-[var(--fg-3)]">
                  #{row.index}
                </span>
              </span>
            </Tooltip>
          </motion.div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[10px] font-mono text-[var(--fg-3)]">
        {argv.map((value, index) => (
          <span key={`length-${index}`} className="rounded bg-[var(--bg-2)] px-1.5 py-0.5">
            argv[{index}] · {encoder.encode(value).length} bytes
          </span>
        ))}
      </div>
      <p className="flex items-center gap-1 text-[11px] text-[var(--fg-3)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--line-2)]" />
        Each argument is a separate cell on the stack — nothing is re-quoted or merged.
      </p>
    </div>
  );
}

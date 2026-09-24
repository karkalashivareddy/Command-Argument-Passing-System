import { clsx } from "clsx";
import { Info } from "lucide-react";
import { useState } from "react";

import { CopyButton } from "../ui";

type Channel = "stdout" | "stderr" | "merged";

/**
 * Real session output — the raw stdout/stderr bytes captured for this
 * session. Empty means genuinely no bytes were captured (said honestly).
 */
export function OutputPanel({ stdout, stderr }: { stdout: string; stderr: string }) {
  const [tab, setTab] = useState<Channel>("stdout");

  const text = tab === "merged" ? `${stdout}${stdout && stderr ? "\n" : ""}${stderr}` : tab === "stdout" ? stdout : stderr;
  const bytes = text.length;

  const tabCls = (t: Channel) =>
    clsx(
      "px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
      tab === t
        ? t === "stderr"
          ? "text-[var(--red)]"
          : t === "merged"
            ? "text-[var(--accent)]"
            : "text-[var(--green)]"
        : "text-[var(--fg-3)] hover:text-[var(--fg-1)]",
    );

  return (
    <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line-0)]">
      <div className="flex items-center border-b border-[var(--line-0)] bg-[var(--bg-2)]">
        <div className="flex">
          <button className={tabCls("stdout")} onClick={() => setTab("stdout")}>stdout{stdout.length > 0 ? ` · ${stdout.length}` : ""}</button>
          <button className={tabCls("stderr")} onClick={() => setTab("stderr")}>stderr{stderr.length > 0 ? ` · ${stderr.length}` : ""}</button>
          <button className={tabCls("merged")} onClick={() => setTab("merged")}>merged</button>
        </div>
        <div className="ml-auto flex items-center gap-1 pr-1">
          {bytes > 0 ? <CopyButton value={text} label="copy" /> : null}
        </div>
      </div>
      <div className="min-h-[72px]">
        {bytes === 0 ? (
          <div className="flex items-center justify-center gap-1.5 py-6 text-[12px] text-[var(--fg-3)]">
            <Info className="h-3.5 w-3.5" />
            <span>
              No output on this channel — the program genuinely wrote nothing here.
            </span>
          </div>
        ) : (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-1)] p-3 font-mono text-[12px] leading-relaxed text-[var(--fg-1)]">
            {text}
          </pre>
        )}
      </div>
      {bytes > 0 ? (
        <div className="flex items-center gap-2 border-t border-[var(--line-0)] bg-[var(--bg-2)] px-2.5 py-1 text-[10.5px] text-[var(--fg-3)]">
          <Info className="h-3 w-3" />
          <span>{bytes.toLocaleString()} bytes{tab === "merged" ? " (merged)" : ` on ${tab}`}</span>
        </div>
      ) : null}
    </div>
  );
}

import { Keyboard, Menu, Search } from "lucide-react";

import { useUi } from "../../store/ui";
import { StatusDot } from "../ui";

export function Topbar({ onToggleSidebar, onOpenPalette }: { onToggleSidebar: () => void; onOpenPalette: () => void }) {
  const engineState = useUi((s) => s.engineState);
  const engineDetail = useUi((s) => s.engineDetail);

  const tone = engineState === "online" ? "success" : engineState === "offline" ? "danger" : "neutral";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-0)] bg-[var(--bg-1)] px-4">
      <button
        onClick={onToggleSidebar}
        className="rounded-[var(--r-sm)] p-1.5 text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-4.5 w-4.5" />
      </button>

      <button
        onClick={onOpenPalette}
        className="flex h-8 max-w-md flex-1 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 text-left text-[12.5px] text-[var(--fg-3)] transition-colors hover:border-[var(--line-2)] hover:text-[var(--fg-2)]"
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1">Run a command or jump to a page…</span>
        <span className="hidden items-center gap-0.5 rounded border border-[var(--line-1)] px-1 py-0.5 text-[10px] sm:flex">
          <Keyboard className="h-3 w-3" /> K
        </span>
      </button>

      <div className="ml-auto flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-0)] bg-[var(--bg-2)] px-2.5 py-1.5">
        <StatusDot tone={tone} pulse={engineState === "online"} />
        <span className="hidden text-[11px] font-medium text-[var(--fg-1)] md:block" title={engineDetail}>
          CAPS {engineState === "online" ? "ONLINE" : engineState === "offline" ? "OFFLINE" : "CHECKING"}
        </span>
      </div>
    </header>
  );
}

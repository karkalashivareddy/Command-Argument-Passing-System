import { clsx } from "clsx";
import { Keyboard, Menu, Presentation, Search } from "lucide-react";

import { useGlobalFeed } from "../../api/sse";
import { useUi } from "../../store/ui";

/**
 * Connection state, as three facts rather than one.
 *
 * `SSE`, `CONNECTION` and `CAPS` are independent: the gateway process, the HTTP
 * API, and the event stream can each fail while the other two keep working. A
 * single combined badge cannot represent that, so each is shown separately and
 * each says only what it actually knows.
 *
 * The distinction that matters on a demo machine is the event stream: when SSE
 * reconnects, the live pages keep rendering whatever they already had while
 * silently going stale. Naming the state is what stops a presenter from showing a
 * frozen number and calling it live.
 */
type Indicator = { label: string; tone: string; detail: string };

function indicator(label: string, state: string, detail: string): Indicator {
  const tone =
    state === "ok"
      ? "text-[var(--role-success)]"
      : state === "bad"
        ? "text-[var(--role-danger)]"
        : state === "warn"
          ? "text-[var(--role-warning)]"
          : "text-[var(--fg-3)]";
  return { label, tone, detail };
}

function Chip({ item }: { item: Indicator }) {
  return (
    <span
      className="hidden items-center gap-1.5 lg:inline-flex"
      title={item.detail}
      aria-label={`${item.label}: ${item.detail}`}
    >
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-4)]">
        {item.label}
      </span>
      <span className={clsx("font-mono text-[10.5px] font-semibold", item.tone)}>{item.detail}</span>
    </span>
  );
}

export function Topbar({ onToggleSidebar, onOpenPalette, onOpenPresentation }: { onToggleSidebar: () => void; onOpenPalette: () => void; onOpenPresentation: () => void }) {
  const engineState = useUi((s) => s.engineState);
  const engineDetail = useUi((s) => s.engineDetail);
  const engine = useUi((s) => s.engine);
  const presentationOpen = useUi((s) => s.presentation.open);
  // `connection` is the real SSE state, taken from the same hook the live pages
  // use, rather than a duplicate subscription. A second EventSource would be a
  // second source of truth for the same fact.
  const { connection } = useGlobalFeed(1);

  const sse = indicator(
    "SSE",
    connection === "connected" ? "ok" : connection === "reconnecting" ? "warn" : "bad",
    connection === "connected" ? "CONNECTED" : connection === "reconnecting" ? "RECONNECTING" : "DISCONNECTED",
  );

  const engineChip = indicator(
    "ENGINE",
    engineState === "online" ? "ok" : engineState === "offline" ? "bad" : "warn",
    engineState === "online" ? "ONLINE" : engineState === "offline" ? "OFFLINE" : "CHECKING",
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-0)] bg-[var(--bg-1)]/80 px-4 backdrop-blur-[var(--glass-blur-md)]">
      <button
        onClick={onToggleSidebar}
        className="rounded-[var(--r-sm)] p-1.5 text-[var(--fg-2)] transition-colors duration-[var(--motion-quick)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-4.5 w-4.5" />
      </button>

      <button
        onClick={onOpenPalette}
        className="flex h-8 max-w-md flex-1 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 text-left text-[12.5px] text-[var(--fg-3)] transition-colors duration-[var(--motion-quick)] hover:border-[var(--line-2)] hover:text-[var(--fg-2)]"
        aria-label="Open command palette"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1">Run a command or jump to a page…</span>
        <span className="hidden items-center gap-0.5 rounded border border-[var(--line-1)] px-1 py-0.5 text-[10px] sm:flex">
          <Keyboard className="h-3 w-3" /> K
        </span>
      </button>

      {/*
        Presentation mode lives in the topbar rather than behind the palette or a
        shortcut alone, because the person who needs it most is often driving
        someone else's machine from the back of a room and will not read the
        shortcut list. `aria-pressed` reflects real state so the toggle announces
        itself as a toggle rather than as a button of unknown meaning.
      */}
      <button
        onClick={onOpenPresentation}
        aria-pressed={presentationOpen}
        aria-keyshortcuts="D"
        title="Presentation mode — twelve guided steps over the real product (D)"
        className={clsx(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] border px-2 text-[11.5px] font-medium transition-colors",
          presentationOpen
            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
            : "border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-2)] hover:border-[var(--line-2)] hover:text-[var(--fg-0)]",
        )}
      >
        <Presentation className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Present</span>
      </button>

      {/*
        Platform and version, stated once. Both come from the gateway's own
        /api/health response rather than from anything the browser can detect, so
        they describe the machine CAPS is actually observing.
      */}
      <div className="ml-auto flex items-center gap-4">
        <Chip item={indicator("PLATFORM", "ok", engine?.platform?.replace("/", " / ").toUpperCase() ?? "—")} />
        <Chip item={sse} />
        <Chip item={engineChip} />
        <span
          className="rounded-[var(--r-sm)] border border-[var(--line-0)] bg-[var(--bg-2)] px-2 py-1 font-mono text-[10.5px] font-semibold text-[var(--fg-2)]"
          title={engineDetail}
        >
          v{engine?.version ?? "—"}
        </span>
      </div>
    </header>
  );
}

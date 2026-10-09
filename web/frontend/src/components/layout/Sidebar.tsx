import { clsx } from "clsx";
import {
  Activity,
  BarChart3,
  BookOpen,
  CircuitBoard,
  Cog,
  Eye,
  FileCode2,
  FlaskConical,
  GitCompareArrows,
  LayoutGrid,
  Network,
  Play,
  Radio,
  Rows3,
  ServerCog,
  Settings,
  Signal,
  SquareTerminal,
  Terminal,
  Waypoints,
} from "lucide-react";
import { NavLink } from "react-router-dom";

import { useUi } from "../../store/ui";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Play;
  end?: boolean;
  /**
   * The route that actually carries this capability, when the nav label names a
   * concept rather than a page.
   *
   * "Flight Recorder" and "Process Space" are both concepts that live on a
   * parameterised route (`/execution/:id` and `/execution/:id/3d`), which cannot
   * be linked without a session. The label is kept in the sidebar because it is
   * the clearest name for the capability, and it resolves to the surface where a
   * session is chosen. Without this the two most distinctive features of the
   * product have no permanent place in the navigation at all.
   */
  hint?: string;
}

interface NavGroup {
  title: string;
  /** One line stating what this group is for, shown when not collapsed. */
  purpose: string;
  items: NavItem[];
}

/**
 * FIVE GROUPS, ORDERED BY WHAT THE USER IS TRYING TO DO
 * ------------------------------------------------------
 * The previous grouping was Execute / Observe / Learn / System, which described
 * the implementation ("here are the run pages, here are the read pages") rather
 * than the intent ("start something, watch it, study it, configure it"). A reader
 * who has never seen CAPS could not predict where a capability lived.
 *
 * The order below is a workflow: understand, run, watch, learn, configure. Each
 * group says what it is for in one line, because a group title alone ("LAB") does
 * not tell a first-time visitor whether to click it.
 */
const GROUPS: NavGroup[] = [
  {
    title: "Core",
    purpose: "Start here",
    items: [
      { to: "/", label: "Overview", icon: Eye, end: true },
      { to: "/terminal", label: "Terminal", icon: SquareTerminal },
      { to: "/execute", label: "Execute", icon: Terminal },
      { to: "/history", label: "Flight Recorder", icon: LayoutGrid, hint: "Open any recorded execution to replay it" },
      { to: "/demo", label: "Process Space", icon: Waypoints, hint: "Open any recorded execution as a 3D process graph" },
    ],
  },
  {
    title: "Observe",
    purpose: "Watch and analyse what ran",
    items: [
      { to: "/live", label: "Live", icon: Radio },
      { to: "/compare", label: "Compare", icon: GitCompareArrows },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
      { to: "/processes", label: "Processes", icon: Activity },
    ],
  },
  {
    title: "Lab",
    purpose: "Inspect the host and try things",
    items: [
      { to: "/processes/explorer", label: "Process Explorer", icon: Network },
      { to: "/system", label: "System", icon: ServerCog },
      { to: "/playground", label: "Playground", icon: FlaskConical },
    ],
  },
  {
    title: "Explain",
    purpose: "How the system works",
    items: [
      { to: "/architecture", label: "Architecture", icon: CircuitBoard },
      { to: "/signals", label: "Signals", icon: Signal },
      { to: "/redirection", label: "Redirection", icon: Rows3 },
    ],
  },
  {
    title: "System",
    purpose: "Configuration and raw evidence",
    items: [
      { to: "/settings", label: "Settings", icon: Settings },
      { to: "/raw", label: "Raw Events", icon: FileCode2 },
      { to: "/about", label: "About", icon: BookOpen },
    ],
  },
];

export function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const engineState = useUi((s) => s.engineState);

  const engineLabel =
    engineState === "online" ? "Engine online" : engineState === "offline" ? "Engine unavailable" : "Checking engine";

  return (
    <aside
      className={clsx(
        "flex h-full shrink-0 flex-col border-r border-[var(--line-0)] bg-[var(--bg-1)]/80 backdrop-blur-[var(--glass-blur-md)] transition-[width] duration-[var(--motion-base)] [transition-timing-function:var(--ease-standard)]",
        collapsed ? "w-16" : "w-[15.5rem]",
      )}
    >
      <div
        className={clsx(
          "flex h-14 shrink-0 items-center border-b border-[var(--line-0)]",
          collapsed ? "justify-center px-0" : "gap-2.5 px-4",
        )}
      >
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/20"
          aria-hidden="true"
        >
          <Terminal className="h-4 w-4" />
        </div>
        {!collapsed ? (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold tracking-tight text-[var(--fg-0)]">CAPS Observatory</div>
            <div className="truncate text-[10px] font-medium uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
              Process execution
            </div>
          </div>
        ) : null}
      </div>

      {/*
        The nav is a labelled landmark with three landmarks inside it, so a screen
        reader can jump between "Core", "Observe" and "Explain" instead of reading
        seventeen links in order. The collapsed variant drops the labels entirely
        and keeps the list, because a nav must remain navigable when there is no
        room for text -- and every collapsed link still carries its label in
        `title`, which the accessibility agent added and which is load-bearing here.
      */}
      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2.5" aria-label="Primary">
        {GROUPS.map((group) => (
          <div key={group.title} className={clsx("mb-2.5 last:mb-0", collapsed && "mb-1.5")}>
            {!collapsed ? (
              <div className="px-4 pb-1">
                <div className="text-[10px] font-semibold uppercase leading-tight tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  {group.title}
                </div>
                {/*
                  The purpose line is what makes the group labels navigable rather
                  than decorative. It costs one line per group, so the group rhythm
                  below is deliberately tight: seventeen links plus five headers and
                  five purpose lines has to fit a 900px-tall viewport without
                  scrolling, because a navigation that hides its last item behind a
                  scroll is a navigation a presenter will not find.
                */}
                <div className="truncate text-[10px] leading-tight text-[var(--fg-4)]">{group.purpose}</div>
              </div>
            ) : (
              <div className="mx-3 mb-1.5 border-t border-[var(--line-0)]" role="separator" />
            )}
            <ul>
              {group.items.map((item) => (
                <li key={`${group.title}-${item.to}`}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        /*
                         * The active marker is a left rail in the telemetry colour
                         * plus a tint, never a filled block: this nav is 17 items
                         * tall and a filled block at every level would make the
                         * whole column read as one solid shape. The rail is also
                         * shape rather than colour alone, so it survives a reader
                         * who cannot distinguish the hues.
                         */
                        "group relative flex items-center rounded-r-md text-[13px] font-medium leading-tight transition-colors duration-[var(--motion-quick)] [transition-timing-function:var(--ease-standard)]",
                        "py-1.5 transition-[background-color,color,transform] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
                        collapsed ? "mx-2 justify-center px-0" : "gap-3 px-4",
                        isActive
                          ? "bg-[var(--accent-soft)] text-[var(--fg-0)] before:absolute before:inset-y-0.5 before:left-0 before:w-[2px] before:rounded-full before:bg-[var(--accent)]"
                          : "text-[var(--fg-2)] hover:translate-x-0.5 hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          aria-hidden="true"
                          className={clsx(
                            "h-4 w-4 shrink-0 transition-colors duration-[var(--motion-quick)]",
                            isActive ? "text-[var(--accent)]" : "text-[var(--fg-3)] group-hover:text-[var(--fg-1)]",
                          )}
                        />
                        {!collapsed ? <span className="truncate">{item.label}</span> : null}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/*
        Engine state is duplicated in the topbar on wide screens and shown HERE
        alone when collapsed, because collapsing the sidebar must not remove the
        only signal that the thing being observed is actually available.
      */}
      <div className="shrink-0 border-t border-[var(--line-0)] p-3">
        <div
          className={clsx("flex items-center gap-2", collapsed && "justify-center")}
          title={engineLabel}
          aria-label={engineLabel}
        >
          {/*
            A state dot rather than the `Cog` icon the previous version used: an
            icon cannot change colour with state, and this element exists to carry
            state. It is aria-hidden because the wrapper is named.
          */}
          <span
            aria-hidden="true"
            className={clsx(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              engineState === "online"
                ? "bg-[var(--role-success)]"
                : engineState === "offline"
                  ? "bg-[var(--role-danger)]"
                  : "bg-[var(--role-warning)]",
            )}
          />
          {!collapsed ? <span className="text-[11px] text-[var(--fg-3)]">{engineLabel}</span> : null}
        </div>
      </div>
    </aside>
  );
}

/** Exported so the command palette can offer the same destinations as the nav. */
export const NAV_GROUPS = GROUPS;

/** Icon for a route, used by the command palette to avoid duplicating this map. */
export const NAV_ICONS: Record<string, NavItem["icon"]> = Object.fromEntries(
  GROUPS.flatMap((g) => g.items.map((i) => [i.to, i.icon])),
);

export { Cog };

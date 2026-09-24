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
  History,
  Play,
  Radio,
  Rows3,
  Settings,
  Signal,
  Terminal,
} from "lucide-react";
import { NavLink } from "react-router-dom";

import { useUi } from "../../store/ui";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Play;
  end?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    title: "Execute",
    items: [
      { to: "/", label: "Overview", icon: Eye, end: true },
      { to: "/execute", label: "Execute", icon: Terminal },
      { to: "/processes", label: "Processes", icon: Activity },
      { to: "/playground", label: "Playground", icon: FlaskConical },
    ],
  },
  {
    title: "Observe",
    items: [
      { to: "/live", label: "Live feed", icon: Radio },
      { to: "/history", label: "History", icon: History },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    title: "Learn",
    items: [
      { to: "/architecture", label: "Architecture", icon: CircuitBoard },
      { to: "/signals", label: "Signals", icon: Signal },
      { to: "/redirection", label: "Redirection", icon: Rows3 },
      { to: "/demo", label: "Demo", icon: Play },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/settings", label: "Settings", icon: Settings },
      { to: "/about", label: "About", icon: BookOpen },
      { to: "/raw", label: "Raw events", icon: FileCode2 },
    ],
  },
];

export function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const engineState = useUi((s) => s.engineState);

  return (
    <aside
      className={clsx(
        "flex h-full w-60 shrink-0 flex-col border-r border-[var(--line-0)] bg-[var(--bg-1)] transition-[width] duration-[var(--dur-med)]",
        collapsed && "w-14",
      )}
    >
      <div className="flex h-14 items-center gap-2.5 border-b border-[var(--line-0)] px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Terminal className="h-4 w-4" />
        </div>
        {!collapsed ? (
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight text-[var(--fg-0)]">CAPS Observatory</div>
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--fg-3)]">Execution</div>
          </div>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-3">
            {!collapsed ? (
              <div className="px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">{group.title}</div>
            ) : (
              <div className="mx-3 mb-1.5 border-t border-[var(--line-0)]" />
            )}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  clsx(
                    "group mb-0.5 flex items-center gap-3 rounded-r-md px-4 py-2 text-[13px] font-medium transition-colors",
                    collapsed && "justify-center px-0",
                    isActive
                      ? "border-l-2 border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg-0)]"
                      : "border-l-2 border-transparent text-[var(--fg-2)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-0)]",
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0 text-[var(--fg-3)] group-hover:text-[var(--fg-1)]" />
                {!collapsed ? <span>{item.label}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--line-0)] p-3">
        <div className={clsx("flex items-center gap-2", collapsed && "justify-center")}>
          <Cog className="h-3.5 w-3.5 text-[var(--fg-3)]" />
          {!collapsed ? (
            <span className="text-[11px] text-[var(--fg-3)]">
              {engineState === "online" ? "Engine online" : engineState === "offline" ? "Engine unavailable" : "Checking engine…"}
            </span>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
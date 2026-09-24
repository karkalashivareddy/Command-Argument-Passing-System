import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

import { useUi } from "../../store/ui";
import { useShortcuts } from "../../lib/shortcuts";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "./CommandPalette";
import { ShortcutHelp } from "./ShortcutHelp";

export function AppShell() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const openPalette = useUi((s) => s.openPalette);
  const toast = useUi((s) => s.toast);
  const clearToast = useUi((s) => s.clearToast);
  const fetchEngine = useUi((s) => s.fetchEngine);
  const [mobileNav, setMobileNav] = useState(false);

  useShortcuts();

  useEffect(() => {
    void fetchEngine();
  }, [fetchEngine]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(clearToast, 3200);
    return () => window.clearTimeout(t);
  }, [toast, clearToast]);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="hidden md:block">
        <Sidebar collapsed={collapsed} />
      </div>

      <AnimatePresence>
        {mobileNav ? (
          <motion.div className="fixed inset-0 z-[var(--z-overlay)] md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileNav(false)} />
            <motion.div
              className="absolute inset-y-0 left-0"
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            >
              <Sidebar collapsed={false} onNavigate={() => setMobileNav(false)} />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onToggleSidebar={() => (window.innerWidth < 768 ? setMobileNav(true) : toggleSidebar())} onOpenPalette={() => openPalette(!paletteOpen)} />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      <ShortcutHelp />

      <AnimatePresence>
        {toast ? (
          <motion.div
            className="fixed bottom-4 left-1/2 z-[var(--z-toast)] -translate-x-1/2"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--line-1)] bg-[var(--bg-3)] px-3.5 py-2 text-[13px] text-[var(--fg-0)] shadow-[var(--shadow-pop)]">
              {toast.kind === "success" ? <CheckCircle2 className="h-4 w-4 text-[var(--green)]" /> : toast.kind === "error" ? <XCircle className="h-4 w-4 text-[var(--red)]" /> : <Info className="h-4 w-4 text-[var(--accent)]" />}
              {toast.message}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
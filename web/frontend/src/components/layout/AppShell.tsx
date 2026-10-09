import { AnimatePresence, motion, useReducedMotion, useScroll, useSpring } from "motion/react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigationType } from "react-router-dom";

import { useUi } from "../../store/ui";
import { useShortcuts } from "../../lib/shortcuts";
import { AmbientField } from "./AmbientField";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "./CommandPalette";
import { PresentationOverlay } from "./PresentationOverlay";
import { ShortcutHelp } from "./ShortcutHelp";

export function AppShell() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const openPalette = useUi((s) => s.openPalette);
  const presentationOpen = useUi((s) => s.presentation.open);
  const openPresentation = useUi((s) => s.openPresentation);
  const toast = useUi((s) => s.toast);
  const clearToast = useUi((s) => s.clearToast);
  const fetchEngine = useUi((s) => s.fetchEngine);
  const location = useLocation();
  const navigationType = useNavigationType();
  const [mobileNav, setMobileNav] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const revealObserverRef = useRef<IntersectionObserver | null>(null);
  const savedScrollRef = useRef(new Map<string, number>());
  const previousLocationRef = useRef({ key: location.key, pathname: location.pathname });
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const { scrollYProgress } = useScroll({ container: mainRef });
  const scrollProgress = useSpring(scrollYProgress, { stiffness: 140, damping: 28, mass: 0.2 });
  const reducedMotion = useReducedMotion() ?? false;

  useShortcuts();

  /**
   * The mobile drawer behaves as a dialog.
   *
   * It is a full-height panel over the page, so without this a keyboard reader
   * tabbed straight past it into content underneath while it stayed on screen,
   * and Escape did nothing at all -- the only ways out were the scrim and a link
   * inside. Focus moves into the drawer on open, Tab is trapped inside it,
   * Escape closes it, and focus returns to the hamburger button that opened it.
   * The restore is keyed on `mobileNav` so every close path gets it.
   */
  useEffect(() => {
    if (!mobileNav) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => drawerRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [mobileNav]);

  useEffect(() => {
    if (!mobileNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileNav(false);
        return;
      }
      if (e.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (drawer === null) return;
      const focusable = drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !drawer.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !drawer.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNav]);

  useEffect(() => {
    void fetchEngine();
  }, [fetchEngine]);

  // The shell owns scrolling. Remember each history entry so Back/Forward can
  // return to the reader's context; a new workspace starts at its top. Query
  // changes within a workspace intentionally keep both scroll and page motion.
  useLayoutEffect(() => {
    const previous = previousLocationRef.current;
    const main = mainRef.current;
    if (main && previous.pathname !== location.pathname) {
      savedScrollRef.current.set(previous.key, main.scrollTop);
      main.scrollTop = navigationType === "POP" ? (savedScrollRef.current.get(location.key) ?? 0) : 0;
    }
    previousLocationRef.current = { key: location.key, pathname: location.pathname };
  }, [location.key, location.pathname, navigationType]);

  // Reveal only substantial content that starts below the visible workspace.
  // The main region is the observer root because it, not window, owns scrolling.
  useEffect(() => {
    if (reducedMotion || typeof IntersectionObserver === "undefined") return;
    const timer = window.setTimeout(() => {
      const root = mainRef.current;
      if (!root) return;
      const bottom = root.getBoundingClientRect().bottom;
      const targets = Array.from(
        root.querySelectorAll<HTMLElement>(".caps-route-stage > .overview-page > section, .caps-route-stage > div.mx-auto > section, .caps-route-stage .caps-card-surface"),
      ).filter((element) => element.getBoundingClientRect().top > bottom + 20);
      if (targets.length === 0) return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            (entry.target as HTMLElement).dataset.scrollReveal = "visible";
            observer.unobserve(entry.target);
          }
        },
        { root, threshold: 0.08, rootMargin: "0px 0px -8% 0px" },
      );
      for (const target of targets) {
        target.dataset.scrollReveal = "pending";
        observer.observe(target);
      }
      revealObserverRef.current = observer;
    }, 300);
    return () => {
      window.clearTimeout(timer);
      revealObserverRef.current?.disconnect();
      revealObserverRef.current = null;
      mainRef.current?.querySelectorAll<HTMLElement>('[data-scroll-reveal="pending"], [data-scroll-reveal="visible"]').forEach((element) => {
        delete element.dataset.scrollReveal;
      });
    };
  }, [location.pathname, reducedMotion]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(clearToast, 3200);
    return () => window.clearTimeout(t);
  }, [toast, clearToast]);

  return (
    <div className="caps-app-shell relative flex h-full overflow-hidden">
      {/*
        One ambient field for the whole application, mounted here rather than per
        page so it never remounts on navigation and never flashes.
      */}
      <AmbientField />

      <div className="caps-app-frame relative z-[1] flex h-full w-full">
        <div className="hidden md:block">
          <Sidebar collapsed={collapsed} />
        </div>

        <AnimatePresence>
          {mobileNav ? (
            <motion.div
              className="fixed inset-0 z-[var(--z-overlay)] md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2 }}
            >
              <div className="absolute inset-0 bg-black/50" onClick={() => setMobileNav(false)} />
              <motion.div
                ref={drawerRef}
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                tabIndex={-1}
                className="absolute inset-y-0 left-0 focus:outline-none"
                initial={{ x: reducedMotion ? 0 : -280 }}
                animate={{ x: 0 }}
                exit={{ x: reducedMotion ? 0 : -280 }}
                transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <Sidebar collapsed={false} onNavigate={() => setMobileNav(false)} />
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            onToggleSidebar={() => (window.innerWidth < 768 ? setMobileNav(true) : toggleSidebar())}
            onOpenPalette={() => openPalette(!paletteOpen)}
            onOpenPresentation={() => openPresentation(!presentationOpen)}
          />
          <main ref={mainRef} className="caps-main relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
            <div className="caps-scroll-track" aria-hidden="true">
              <motion.div
                className="caps-scroll-progress"
                style={{ transformOrigin: "0% 50%", scaleX: reducedMotion ? scrollYProgress : scrollProgress }}
              />
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                className="caps-route-stage"
                initial={reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -2 }}
                transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>

      {/*
        The presentation overlay sits above the palette and the help dialog in z
        order, because it is the one a presenter is driving: a modal that opens on
        top of the modal they are presenting through would swallow their arrow
        keys and they would not discover why for several seconds.

        It is mounted unconditionally and renders nothing when closed, so the
        `open` transition has one place to capture and restore focus (see the
        overlay). Mounting it conditionally instead would mean the overlay
        remounts on every open, and the focus-restore effect would run against a
        fresh ref with nothing to restore to.
      */}
      <CommandPalette />
      <ShortcutHelp />
      <PresentationOverlay />

      <AnimatePresence>
        {toast ? (
          <motion.div
            className="pointer-events-none fixed bottom-5 left-1/2 z-[var(--z-toast)] -translate-x-1/2"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {/*
              Glass, because a toast is the one element that floats above a page
              whose content it cannot see. Text stays fully opaque: blur behind a
              message is exactly the case where legibility must not depend on what
              happens to be underneath.
            */}
            <div className="glass-overlay pointer-events-auto flex items-center gap-2.5 rounded-[var(--r-md)] border border-[var(--line-1)] px-3.5 py-2.5 text-[13px] text-[var(--fg-0)]">
              {toast.kind === "success" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--role-success)]" aria-hidden="true" />
              ) : toast.kind === "error" ? (
                <XCircle className="h-4 w-4 shrink-0 text-[var(--role-danger)]" aria-hidden="true" />
              ) : (
                <Info className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
              )}
              {toast.message}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

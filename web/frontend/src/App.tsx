import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/layout/AppShell";
import { Spinner } from "./components/ui";

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const ExecutePage = lazy(() => import("./pages/ExecutePage"));
const LivePage = lazy(() => import("./pages/LivePage"));
const ProcessesPage = lazy(() => import("./pages/ProcessesPage"));
const ProcessExplorerPage = lazy(() => import("./pages/ProcessExplorerPage"));
const SystemControlPage = lazy(() => import("./pages/SystemControlPage"));
const ExecutionPage = lazy(() => import("./pages/ExecutionPage"));
const ProcessSpacePage = lazy(() => import("./pages/ProcessSpacePage"));
const ArgumentsPage = lazy(() => import("./pages/ArgumentsPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const ComparePage = lazy(() => import("./pages/ComparePage"));
const ArchitecturePage = lazy(() => import("./pages/ArchitecturePage"));
const SignalsPage = lazy(() => import("./pages/SignalsPage"));
const RedirectionPage = lazy(() => import("./pages/RedirectionPage"));
const PlaygroundPage = lazy(() => import("./pages/PlaygroundPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const DemoPage = lazy(() => import("./pages/DemoPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const RawPage = lazy(() => import("./pages/RawPage"));

function Fallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Loading…" />
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/terminal" element={<TerminalPage />} />
          <Route path="/execute" element={<ExecutePage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/processes" element={<ProcessesPage />} />
          {/* The host explorer and the system control center are separate surfaces
              from the CAPS-scoped process view: they read the host collector
              rather than the gateway's own child telemetry, and they distinguish
              CAPS-owned work from host processes. */}
          <Route path="/processes/explorer" element={<ProcessExplorerPage />} />
          <Route path="/system" element={<SystemControlPage />} />
          <Route path="/execution/:id" element={<ExecutionPage />} />
          <Route path="/execution/:id/3d" element={<ProcessSpacePage />} />
          <Route path="/arguments/:id" element={<ArgumentsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/architecture" element={<ArchitecturePage />} />
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/redirection" element={<RedirectionPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/raw" element={<RawPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

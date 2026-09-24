import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/layout/AppShell";
import { Spinner } from "./components/ui";

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const ExecutePage = lazy(() => import("./pages/ExecutePage"));
const LivePage = lazy(() => import("./pages/LivePage"));
const ProcessesPage = lazy(() => import("./pages/ProcessesPage"));
const ExecutionPage = lazy(() => import("./pages/ExecutionPage"));
const ArgumentsPage = lazy(() => import("./pages/ArgumentsPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
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
          <Route path="/execute" element={<ExecutePage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/processes" element={<ProcessesPage />} />
          <Route path="/execution/:id" element={<ExecutionPage />} />
          <Route path="/arguments/:id" element={<ArgumentsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
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

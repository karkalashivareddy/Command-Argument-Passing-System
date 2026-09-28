import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalEvent, TelemetryMetric } from "../../types/observability";
import { Timeline } from "./Timeline";
import { ProcessTelemetry } from "./ProcessTelemetry";
import { PeaksPanel } from "./PeaksPanel";

type Metric = TelemetryMetric<number>;

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc/100/status" });
const der = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "DERIVED", source: "sample delta" });
const none = (): Metric => ({ value: null, provenance: "UNAVAILABLE", source: "/proc/100/stat", reason: "First sample for this process: a rate needs two valid samples separated by a measured interval" });

const START = Date.parse("2026-01-01T10:00:00.000Z");

/** Three real samples 500 ms apart: an unavailable first sample, then two rates. */
const events: CanonicalEvent[] = [
  { id: "started", sessionId: "s1", sequence: 0, type: "process.started", source: "gateway", timestamp: new Date(START).toISOString(), monotonicMs: null, pid: 100, payload: { pid: 100 } },
  ...[
    { rss: 4, cpu: none(), wchar: 0, wcharRate: none(), minor: 100, minorRate: none() },
    { rss: 8, cpu: der(100), wchar: 65536, wcharRate: der(131072), minor: 200, minorRate: der(200) },
    { rss: 16, cpu: der(40), wchar: 65536, wcharRate: der(0), minor: 210, minorRate: der(20) },
  ].map((s, index) => ({
    id: `snap-${index}`,
    sessionId: "s1",
    sequence: index + 1,
    type: "process.snapshot" as const,
    source: "gateway" as const,
    timestamp: new Date(START + index * 500).toISOString(),
    monotonicMs: index * 500,
    pid: 100,
    payload: {
      pid: obs(100),
      capsEnginePid: obs(40),
      ppid: obs(40),
      processGroupId: obs(400),
      sessionId: obs(4),
      state: obs("R"),
      command: obs("caps_cpu_burn"),
      startTime: obs("2026-01-01T10:00:00.000Z"),
      elapsedMs: der(index * 500),
      cpuUserMs: obs(index * 400),
      cpuSystemMs: obs(index * 100),
      cpuTimeMs: obs(index * 500),
      cpuPercent: s.cpu,
      rssBytes: obs(s.rss * 1024 * 1024),
      virtualMemoryBytes: obs(32 * 1024 * 1024),
      threadCount: obs(2),
      voluntaryContextSwitches: obs(10),
      nonVoluntaryContextSwitches: obs(1),
      minorFaults: obs(s.minor),
      majorFaults: obs(0),
      minorFaultsPerSec: s.minorRate,
      majorFaultsPerSec: none(),
      readBytes: obs(0),
      writeBytes: obs(0),
      rcharBytes: obs(1024),
      wcharBytes: obs(s.wchar),
      readBytesPerSec: none(),
      writeBytesPerSec: none(),
      rcharBytesPerSec: none(),
      wcharBytesPerSec: s.wcharRate,
    },
  })),
];

afterEach(cleanup);

describe("shared execution-time cursor", () => {
  it("drives the resource tracks, the inspector, and the peaks from one value", () => {
    const onSeek = vi.fn();
    const { unmount } = render(<Timeline events={events} cursorMs={500} onSeek={onSeek} />);

    // Every track is present, with its own unit, so the reader can tell them apart.
    for (const unit of ["% of one core", "MiB", "KiB/s", "faults/s"]) {
      expect(document.body.textContent).toContain(unit);
    }
    expect(screen.getByText("3 persisted samples")).toBeTruthy();
    expect(document.body.textContent).toContain("cursor t = 0.50s");
    unmount();

    render(<ProcessTelemetry events={events} replay cursorMs={500} />);
    // The inspector shows exactly the sample under the cursor, not the newest one.
    expect(document.body.textContent).toContain("t=500ms");
    expect(document.body.textContent).toContain("100.0%");
    expect(document.body.textContent).toContain("8.00 MiB");
    cleanup();

    render(<PeaksPanel events={events} cursorMs={1000} onSeek={onSeek} />);
    // Peak cards report the real peak and offer to move the cursor to it.
    expect(document.body.textContent).toContain("16.00 MiB");
    expect(document.body.textContent).toContain("100.0%");
    const seekButtons = screen.getAllByTitle("Move the shared cursor to this moment");
    expect(seekButtons.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("cursor here");
  });

  it("says so instead of drawing a fake rate when only one sample exists", () => {
    render(<Timeline events={events.slice(0, 2)} cursorMs={null} onSeek={() => {}} />);
    expect(document.body.textContent).toContain("1 persisted sample");
    expect(document.body.textContent).toContain("only one sample: every rate is UNAVAILABLE by design");
    expect(document.body.textContent).toContain("cursor follows the newest sample");
  });

  it("moves the cursor when a track is clicked", () => {
    const onSeek = vi.fn();
    const { container } = render(<Timeline events={events} cursorMs={null} onSeek={onSeek} />);
    const tracks = container.querySelector('[role="group"][aria-label*="cursor"]');
    expect(tracks).not.toBeNull();
    tracks!.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 300, right: 1000, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    tracks!.dispatchEvent(new MouseEvent("click", { clientX: 500, bubbles: true }));
    // The click lands mid-span of a 1.0 s execution.
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onSeek.mock.calls[0]![0]).toBeGreaterThan(400);
    expect(onSeek.mock.calls[0]![0]).toBeLessThanOrEqual(1_000);
  });
});

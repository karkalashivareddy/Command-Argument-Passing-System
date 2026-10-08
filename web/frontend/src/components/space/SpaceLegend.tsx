import { AlertTriangle, Box, LineChart, MemoryStick, Radio, Tag } from "lucide-react";

import { LENS_ORDER, LENS_SPECS, spaceStateLegend, type MetricMode } from "../../lib/processSpace";
import { ProvenanceBadge } from "../evidence/Provenance";

/**
 * The encoding legend.
 *
 * It states three things, and every word in it is read out of the view-model
 * rather than written here:
 *
 *   PROCESS STATE  the colours `statePalette` actually assigns, with the meaning
 *                  each one carries. Generated from `spaceStateLegend()`, so a
 *                  state the model cannot produce cannot appear, and a state the
 *                  model adds cannot be left out of the legend.
 *   METRIC LENS    every lens, with the unit that lens genuinely uses. The I/O
 *                  lens's unit is the corrected one, because "bytes per second"
 *                  is a physical claim no single counter measured.
 *   PROVENANCE     the three classes, through the same badge components the
 *                  tooltip and the metrics use, so a reader learns the vocabulary
 *                  once.
 *
 * It sits BELOW the scene rather than over it. A legend drawn on top of the
 * evidence it explains hides the evidence, and in a product whose only claim is
 * that it shows the real record, occlusion is a cost with no benefit. Glass here
 * is the panel surface, not an overlay on the scene.
 */
export function SpaceLegend({ lens }: { lens: MetricMode }) {
  const spec = LENS_SPECS[lens];
  const states = spaceStateLegend();

  const encoding = [
    { icon: <Box className="h-3 w-3 text-[var(--accent)]" />, text: "Node — one observed process" },
    { icon: <LineChart className="h-3 w-3 text-[var(--blue)]" />, text: "Edge — verified parent/child (observed PPID match)" },
    { icon: <MemoryStick className="h-3 w-3 text-[var(--cyan)]" />, text: `Node size — ${spec.label}: ${spec.unit}` },
    { icon: <Radio className="h-3 w-3 text-[var(--green)]" />, text: "Ring — recorded activity for the active lens" },
    { icon: <Tag className="h-3 w-3 text-[var(--violet)]" />, text: "Ring — recorded execvp() image change (same PID)" },
    { icon: <AlertTriangle className="h-3 w-3 text-[var(--amber)]" />, text: "Diamond — recorded lifecycle event; click to select the event" },
  ];

  return (
    <section aria-label="Scene encoding legend" className="glass-panel rounded-[var(--r-md)] px-3 py-2.5 font-mono text-[9.5px] leading-relaxed text-[var(--fg-3)]">
      <div className="grid gap-x-6 gap-y-2.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.9fr)]">
        {/* --- what the shapes are --- */}
        <div>
          <LegendHeading>Geometry</LegendHeading>
          <ul className="space-y-0.5">
            {encoding.map((item) => (
              <li key={item.text} className="flex items-start gap-1.5">
                <span className="mt-px shrink-0">{item.icon}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[var(--fg-4)]">
            The CAPS engine node carries no procfs sample, so it is drawn at the minimum size with no activity ring; its colour is its own lifecycle
            state like every other node.
          </p>
          <p className="mt-1 text-[var(--fg-2)]">
            Positions, sizes, colours and activity are visualization mappings of recorded state, not physical properties.
          </p>
        </div>

        {/* --- what the colours mean --- */}
        <div>
          <LegendHeading>Process state — node colour</LegendHeading>
          <ul className="space-y-0.5">
            {states.map((entry) => (
              <li key={entry.state} className="flex items-start gap-1.5">
                <span aria-hidden="true" className="mt-[3px] h-2 w-2 shrink-0 rounded-[1px]" style={{ background: entry.color }} />
                <span>
                  <span className="font-semibold text-[var(--fg-2)]">{entry.label}</span> — {entry.meaning}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* --- what the lenses read, and how a number is classified --- */}
        <div>
          <LegendHeading>Metric lens — size and ring</LegendHeading>
          <ul className="space-y-0.5">
            {LENS_ORDER.map((id) => (
              <li key={id} className={id === lens ? "text-[var(--fg-1)]" : undefined}>
                <span className="font-semibold">{LENS_SPECS[id].label}</span> — {LENS_SPECS[id].unit}
                {id === lens ? <span className="ml-1 text-[var(--accent)]">· active</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[var(--fg-4)]">
            One lens drives both size and the ring, and it reads exactly one recorded metric. CPU, I/O and faults are rates derived from consecutive
            recorded samples; the I/O lens shows the largest of four counters, and the tooltip names which one.
          </p>

          <LegendHeading className="mt-2">Provenance of every number above</LegendHeading>
          <ul className="space-y-0.5">
            <li className="flex items-start gap-1.5">
              <ProvenanceBadge className="shrink-0" provenance="OBSERVED" source="/proc and the gateway's canonical event fields" />
              <span>read directly from the record.</span>
            </li>
            <li className="flex items-start gap-1.5">
              <ProvenanceBadge className="shrink-0" provenance="DERIVED" formula="computed from recorded samples (rates, elapsed time)" />
              <span>computed; the tooltip and table name the formula.</span>
            </li>
            <li className="flex items-start gap-1.5">
              <ProvenanceBadge className="shrink-0" provenance="UNAVAILABLE" reason="the kernel did not report it for that sample" />
              <span>not measured. It is never drawn or labelled as 0.</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function LegendHeading({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={`mb-1 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--fg-3)] ${className}`}>{children}</h3>
  );
}
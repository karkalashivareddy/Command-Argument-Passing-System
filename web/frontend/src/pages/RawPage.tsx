import { FileCode2 } from "lucide-react";
import { useState } from "react";

import { useGlobalFeed } from "../api/sse";
import { Badge, Card, CopyButton, EmptyState } from "../components/ui";
import { fmtTimestamp } from "../lib/format";

export default function RawPage() {
  const { events, connected } = useGlobalFeed(250);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? events.filter((e) => e.type.includes(query.trim()) || e.sessionId.startsWith(query.trim()))
    : events;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Raw mode</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Raw observability stream</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
            Expert view: the canonical event envelope exactly as the gateway wrote it — sequence, source, pid, monotonic
            time, full payload. Live over SSE.
          </p>
        </div>
        <Badge tone={connected ? "success" : "danger"}>{connected ? "streaming" : "reconnecting"}</Badge>
      </div>

      <div className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 focus-within:border-[var(--accent)]">
        <FileCode2 className="h-3.5 w-3.5 text-[var(--fg-3)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by event type or session id…"
          className="h-9 flex-1 bg-transparent font-mono text-[12.5px] text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
        />
      </div>

      <Card pad={false} title="Event lines" subtitle="One canonical event per line, newest first">
        {filtered.length === 0 ? (
          <div className="px-4">
            <EmptyState icon={<FileCode2 className="h-5 w-5" />} title="No events matching" body="Streaming is live; run a command to generate raw events." />
          </div>
        ) : (
          <div className="space-y-1 p-3">
            <div className="mb-1 flex items-center justify-end"><CopyButton value={filtered.map((e) => JSON.stringify(e)).join("\n")} label="copy all" /></div>
            {[...filtered].reverse().map((ev) => (
              <pre key={ev.id} className="overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-2)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--fg-2)]">
                <span className="text-[var(--fg-4)]">[{fmtTimestamp(ev.timestamp)}]</span> {JSON.stringify(ev)}
              </pre>
            ))}
          </div>
        )}
      </Card>

      <p className="text-[11px] text-[var(--fg-3)]">
        The <Code2Inline /> is the same record used by replay, analytics and the flight recorder — see a truth with your own eyes.
      </p>
    </div>
  );
}

function Code2Inline() {
  return <code className="mr-1 inline-block rounded-[var(--r-xs)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--fg-1)]">sequence</code>;
}
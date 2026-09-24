import { Copy, ExternalLink } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { useSession } from "../lib/useSession";
import { shortId } from "../lib/format";
import { ArgvView } from "../components/execution/ArgvView";
import { EventStream } from "../components/execution/EventStream";
import { Badge, Button, Card, EmptyState, Spinner, StatusDot } from "../components/ui";
import { STATUS_META } from "../lib/stages";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";

export default function ArgumentsPage() {
  const { id = "" } = useParams();
  const { session, events, loading, error } = useSession(id, { live: false });
  const pushToast = useUi((s) => s.pushToast);
  const executionId = useExecution((s) => s.sessionId);
  const navigateLink = executionId || id;

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-6">
        <EmptyState icon={<Copy className="h-5 w-5" />} title="Session unavailable" body={error} />
      </div>
    );
  }

  if (loading || !session) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-6">
        <Spinner label="Loading argument vector…" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Argument inspector</div>
          <h1 className="mt-1 truncate font-mono text-lg font-semibold text-[var(--fg-0)]">
            {session.command} {session.args.join(" ")}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot tone={STATUS_META[session.status].tone} label={STATUS_META[session.status].label} />
          <Link to={`/execution/${navigateLink}`}>
            <Button size="sm" variant="ghost">
              <ExternalLink className="h-3.5 w-3.5" /> Flight recorder
            </Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(session.argv, null, 2)).then(() => pushToast("argv copied to clipboard", "success"));
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Copy JSON
          </Button>
        </div>
      </div>

      <Card title="Argument vector" subtitle={`${session.argv.length} cells captured for session ${shortId(session.id)} — the exact array the child received`}>
        <ArgvView argv={session.argv} eventCount={events.length} />
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Structured execution request" subtitle="Source: gateway-validated command and arguments array">
          <div className="space-y-1.5">
            {session.argv.map((arg, i) => (
              <div key={i} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-2)] px-2 py-1 font-mono text-[12px]">
                <span className="w-10 shrink-0 text-[var(--fg-3)]">[{i}]</span>
                <span className={i === 0 ? "text-[var(--accent)]" : "text-[var(--fg-1)]"}>{arg}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] text-[var(--fg-3)]">
            argv[0] <span className="font-mono">({session.argv[0]})</span> is the program path; argv[{session.argv.length}] is the required NULL terminator.
          </p>
        </Card>

        <Card title="Shell-style tokenization" subtitle="Unavailable in the Observatory web execution path">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--fg-2)]">Tokenization</span>
            <Badge tone="neutral">UNAVAILABLE</Badge>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--fg-2)]">
            The gateway receives a structured argv array, not a shell command line. CAPS's one-shot PARSED monitor event
            reports that supplied vector; it does not mean shell quoting or tokenization occurred.
          </p>
          <p className="mt-3 font-mono text-[10.5px] uppercase tracking-wide text-[var(--fg-3)]">Monitor events · source CAPS</p>
          <EventStream events={events.filter((e) => e.type === "command.received" || e.type === "command.parsed" || e.type === "command.parse_error")} emptyLabel="No command receipt events are available for this session." />
        </Card>
      </div>
    </div>
  );
}

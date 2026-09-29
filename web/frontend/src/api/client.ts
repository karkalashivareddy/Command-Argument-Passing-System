import type {
  AnalyticsOverview,
  CapabilitiesResponse,
  CommandProfile,
  CreateSessionRequest,
  CreateSessionResponse,
  ProcessInfo,
  ReplayResponse,
  SessionComparison,
  SessionRecord,
} from "../types/observability";

const BASE = import.meta.env.VITE_CAPS_API ?? "";

/**
 * Every request is bounded in time.
 *
 * `fetch` has no timeout of its own: a hung gateway leaves a spinner running
 * forever and no error is ever surfaced, which is indistinguishable from a slow
 * but working backend. Each request therefore carries an `AbortController`
 * that fires after `DEFAULT_TIMEOUT_MS`, and the caller may supply its own
 * signal so a component that unmounts cancels immediately rather than waiting
 * out the timeout.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** True when the request was aborted by the timeout or the caller's signal. */
    public readonly aborted = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RequestInternal extends RequestOptions {
  /** Used by the raw (text) helpers, which are downloads rather than JSON. */
  expect?: "json" | "text";
}

function combineSignals(timeoutSignal: AbortSignal, callerSignal: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  if (callerSignal === undefined) return { signal: timeoutSignal, dispose: () => {} };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (callerSignal.aborted) controller.abort();
  else callerSignal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => callerSignal.removeEventListener("abort", onAbort),
  };
}

async function request<T>(path: string, options: RequestInternal = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const { signal, dispose } = combineSignals(timeoutController.signal, options.signal);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      signal,
      headers: {
        "content-type": "application/json",
        // A request id makes one call traceable in the gateway's structured log
        // without correlating on timing.
        "x-request-id": `req_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`,
        ...(options.body !== undefined ? {} : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    // A timeout and a caller-side abort are told apart from a transport
    // failure, because the reader's next step differs.
    if (timeoutController.signal.aborted) {
      throw new ApiError(0, "TIMEOUT", `Request timed out after ${timeoutMs}ms: ${path}`, true);
    }
    if (options.signal?.aborted) {
      throw new ApiError(0, "ABORTED", `Request cancelled: ${path}`, true);
    }
    throw new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : "Network request failed");
  } finally {
    clearTimeout(timer);
    dispose();
  }

  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `Request failed (${res.status})`);
  }
  if (options.expect === "text") return body as T;
  return body as T;
}

async function raw(path: string, options: RequestOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const { signal, dispose } = combineSignals(timeoutController.signal, options.signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { signal });
  } catch (err) {
    if (timeoutController.signal.aborted) throw new ApiError(0, "TIMEOUT", `Request timed out after ${timeoutMs}ms: ${path}`, true);
    if (options.signal?.aborted) throw new ApiError(0, "ABORTED", `Request cancelled: ${path}`, true);
    throw new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : "Network request failed");
  } finally {
    clearTimeout(timer);
    dispose();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.text();
}

export const api = {
  health: (o?: RequestOptions) => request<HealthResponse>("/api/health", o),
  ready: (o?: RequestOptions) => request<ReadinessResponse>("/api/ready", o),
  capabilities: (o?: RequestOptions) => request<CapabilitiesResponse>("/api/capabilities", o),

  createSession: (req: CreateSessionRequest, o?: RequestOptions) =>
    request<CreateSessionResponse>("/api/sessions", { ...o, method: "POST", body: req }),

  listSessions: (opts?: { limit?: number; offset?: number; status?: string; q?: string }, o?: RequestOptions) => {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    if (opts?.status) p.set("status", opts.status);
    if (opts?.q) p.set("q", opts.q);
    return request<{ sessions: SessionRecord[]; total: number; limit: number; offset: number }>(`/api/sessions?${p.toString()}`, o);
  },

  getSession: (id: string, o?: RequestOptions) => request<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`, o),
  deleteSession: (id: string, o?: RequestOptions) => request<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { ...o, method: "DELETE" }),

  argv: (id: string, o?: RequestOptions) =>
    request<{ sessionId: string; argc: number; argv: string[]; argvDisplay: string[] }>(
      `/api/sessions/${encodeURIComponent(id)}/argv`, o,
    ),

  output: (id: string, o?: RequestOptions) =>
    request<{ sessionId: string; stdout: string; stderr: string; live: boolean; stdoutTruncated: boolean; stderrTruncated: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/output`, o,
    ),

  replay: (id: string, o?: RequestOptions) => request<ReplayResponse>(`/api/sessions/${encodeURIComponent(id)}/replay`, o),

  terminate: (id: string, signal = "SIGINT", o?: RequestOptions) =>
    request<{ sessionId: string; signal: string; status: string }>(`/api/sessions/${encodeURIComponent(id)}/terminate`, {
      ...o, method: "POST", body: { signal },
    }),

  processes: (o?: RequestOptions) => request<{ processes: ProcessInfo[]; capacity: number }>("/api/processes", o),
  analytics: (o?: RequestOptions) => request<AnalyticsOverview>("/api/analytics/overview", o),
  commandProfiles: (o?: RequestOptions) => request<{ commands: CommandProfile[]; totalCommandRuns: number }>("/api/analytics/commands", o),
  compare: (left: string, right: string, o?: RequestOptions) =>
    request<SessionComparison>(`/api/analytics/compare?ids=${encodeURIComponent(left)},${encodeURIComponent(right)}`, o),

  exportJson: (id: string, o?: RequestOptions) => raw(`/api/sessions/${encodeURIComponent(id)}/export?format=json`, o),
  exportCsv: (id: string, o?: RequestOptions) => raw(`/api/sessions/${encodeURIComponent(id)}/export?format=csv`, o),
  report: (id: string, o?: RequestOptions) => raw(`/api/sessions/${encodeURIComponent(id)}/report`, o),

  examples: (o?: RequestOptions) =>
    request<{ examples: Array<{ id: string; title: string; category: string; command: string; args: string[]; redirections?: Record<string, string>; explanation: string }> }>(
      "/api/playground/examples", o,
    ),
};

export interface HealthResponse {
  status: string;
  version: string;
  platform: string;
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  ready: boolean;
  version: string;
  checks: {
    engine: { available: boolean; detail: string };
    database: { available: boolean; detail: string };
    workspace: { available: boolean; detail: string };
    telemetry: { available: boolean; detail: string };
  };
  retention: { days: number; enabled: boolean; policy: string };
  storage: { sessions: number; events: number; dbBytes: number | null } | null;
}

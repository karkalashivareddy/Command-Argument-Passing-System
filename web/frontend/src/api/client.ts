import type {
  AnalyticsOverview,
  CapabilitiesResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HealthResponse,
  ProcessInfo,
  ReplayResponse,
  SessionRecord,
} from "../types/observability";

const BASE = import.meta.env.VITE_CAPS_API ?? "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  capabilities: () => request<CapabilitiesResponse>("/api/capabilities"),

  createSession: (req: CreateSessionRequest) =>
    request<CreateSessionResponse>("/api/sessions", { method: "POST", body: JSON.stringify(req) }),

  listSessions: (opts?: { limit?: number; offset?: number; status?: string; q?: string }) => {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    if (opts?.status) p.set("status", opts.status);
    if (opts?.q) p.set("q", opts.q);
    return request<{ sessions: SessionRecord[]; total: number }>(`/api/sessions?${p.toString()}`);
  },

  getSession: (id: string) => request<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) => request<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  argv: (id: string) =>
    request<{ sessionId: string; argc: number; argv: string[]; argvDisplay: string[] }>(
      `/api/sessions/${encodeURIComponent(id)}/argv`,
    ),

  output: (id: string) =>
    request<{ sessionId: string; stdout: string; stderr: string; live: boolean }>(`/api/sessions/${encodeURIComponent(id)}/output`),

  replay: (id: string) => request<ReplayResponse>(`/api/sessions/${encodeURIComponent(id)}/replay`),

  terminate: (id: string, signal = "SIGINT") =>
    request<{ sessionId: string; signal: string; status: string }>(`/api/sessions/${encodeURIComponent(id)}/terminate`, {
      method: "POST",
      body: JSON.stringify({ signal }),
    }),

  processes: () => request<{ processes: ProcessInfo[]; capacity: number }>("/api/processes"),
  analytics: () => request<AnalyticsOverview>("/api/analytics/overview"),

  examples: () =>
    request<Array<{ id: string; title: string; category: string; command: string; args: string[]; redirections?: Record<string, string>; explanation: string }>>(
      "/api/playground/examples",
    ),
};

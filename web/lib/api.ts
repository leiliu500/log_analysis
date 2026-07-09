import type {
  Finding,
  ChatResponse,
  SimulateResult,
  RouteDecision,
  AgentActivity,
  AgentBatch,
} from '@log/shared';

const BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  /**
   * Read current findings. By default this does NOT run analysis — findings are
   * produced by the scheduled ingestion poller (agentic analysis). Pass
   * `analyze=true` only for an explicit, on-demand "Analyze now".
   */
  findings: (analyze = false) =>
    req<{
      findings: Finding[];
      analysis?: {
        bySource: Record<string, { parsed: number; spawned?: number; findings: number }>;
        pruned: number;
      };
    }>(`/findings?limit=100&analyze=${analyze}`),
  clearFindings: () =>
    req<{ deleted: number; activityDeleted?: number }>('/findings', { method: 'DELETE' }),
  /** Agent dynamics: recent per-agent activity + ingest-cycle roll-ups. */
  agentsActivity: (limit = 200) =>
    req<{ activity: AgentActivity[]; batches: AgentBatch[] }>(
      `/agents/activity?limit=${limit}`,
    ),
  chat: (sessionId: string, message: string) =>
    req<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, scoped: true }),
    }),
  simulate: (body: unknown) =>
    req<SimulateResult>('/simulate', { method: 'POST', body: JSON.stringify(body) }),
  /**
   * Natural-language simulate. Flows Supervisor Agent → Simulator Agent only;
   * no analysis is triggered (the poller does that). Returns the routing
   * decision + a note about what happens next.
   */
  simulatePrompt: (prompt: string) =>
    req<{
      route: RouteDecision;
      note: string;
      results: {
        instruction: string;
        spec: {
          count: number;
          messageTypes: string[];
          ackStatus: 'success' | 'failure';
          startMessageId?: string;
          logGroup?: string;
        };
        result: SimulateResult;
      }[];
    }>('/simulate/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  /** POST a JSON payload (+ optional file) to a real app endpoint (e.g. scp). */
  invokeApp: (body: {
    application?: string;
    url?: string;
    request: unknown;
    file?: { name: string; contentBase64: string; contentType?: string };
    asForm?: boolean;
  }) =>
    req<{ application: string; status: number; response: unknown; latencyMs: number }>('/invoke-app', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

import type { Finding, ChatResponse, SimulateResult, RouteDecision, Agent, PollerRun } from '@log/shared';

const BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON content-type when we actually send a body. Otherwise
  // Fastify rejects bodyless requests (e.g. DELETE /data, DELETE /findings) with
  // FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty ...") → 400.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' });
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
        bySource: Record<string, { parsed: number; findings: number }>;
        agents?: { spawned: number; advanced: number; closed: number; findings: number };
        pruned: number;
      };
      // "Analyze now" looks back 60 min (vs the scheduled poller's 5) so it also
      // catches logs simulated a little while ago.
    }>(`/findings?limit=100&analyze=${analyze}&window=60`),
  clearFindings: () =>
    req<{ deleted: number; agentsDeleted?: number }>('/findings', { method: 'DELETE' }),
  /** Full reset: findings + logs + agents + scheduled-run history. */
  clearAllData: () =>
    req<{ findingsDeleted: number; logsDeleted: number; scheduleDeleted?: number }>('/data', {
      method: 'DELETE',
    }),
  /** Stateful agent lifecycle: active agents (cards) + closed agents (history). */
  agents: () => req<{ active: Agent[]; history: Agent[] }>('/agents'),
  /** Scheduled-ingestion run history for the Schedule tab. */
  schedule: () => req<{ runs: PollerRun[] }>('/schedule?limit=100'),
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

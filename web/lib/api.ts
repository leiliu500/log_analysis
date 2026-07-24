import type {
  Anomaly,
  ChatResponse,
  SimulateResult,
  RouteDecision,
  Agent,
  PollerRun,
  ValidationAgent,
  BacktestSummary,
} from '@log/shared';

const BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON content-type when we actually send a body. Otherwise
  // Fastify rejects bodyless requests (e.g. DELETE /data, DELETE /anomalies) with
  // FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty ...") → 400.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  /**
   * Read current anomalies. By default this does NOT run analysis — anomalies are
   * produced by the scheduled ingestion poller (agentic analysis). Pass
   * `analyze=true` only for an explicit, on-demand "Analyze now".
   */
  anomalies: (analyze = false) =>
    req<{
      anomalies: Anomaly[];
      analysis?: {
        bySource: Record<string, { parsed: number; anomalies: number }>;
        agents?: { spawned: number; advanced: number; closed: number; anomalies: number };
        pruned: number;
      };
      // "Analyze now" looks back 60 min (vs the scheduled poller's 5) so it also
      // catches logs simulated a little while ago. limit is high to include history.
    }>(`/anomalies?limit=300&analyze=${analyze}&window=60`),
  clearAnomalies: () =>
    req<{ deleted: number; agentsDeleted?: number }>('/anomalies', { method: 'DELETE' }),
  /** Full reset: anomalies + logs + agents + scheduled-run history. */
  clearAllData: () =>
    req<{ anomaliesDeleted: number; logsDeleted: number; scheduleDeleted?: number }>('/data', {
      method: 'DELETE',
    }),
  /** Stateful agent lifecycle: active agents (cards) + closed agents (history). */
  agents: () => req<{ active: Agent[]; history: Agent[] }>('/agents'),
  /**
   * Validation agents: the autonomous 1:1 shadow of the agent lifecycle. Active
   * (pending, shadowing active agents) + history (each success/failure + delta).
   */
  validationAgents: () =>
    req<{ active: ValidationAgent[]; history: ValidationAgent[] }>('/validation-agents'),
  /** On-demand "Validate now" — the scheduled validation Lambda runs this autonomously. */
  validateNow: () =>
    req<{
      checked: number;
      passed: number;
      issues: number;
      failed: number;
      pending: number;
      byApplication: Record<
        string,
        { checked: number; passed: number; issues: number; failed: number; pending: number }
      >;
    }>('/validate', { method: 'POST', body: JSON.stringify({}) }),
  /**
   * Run the validation BACKTEST on demand — replays the gold-set corpus through the
   * real validation engine and returns the FP/FN/hallucination summary for the
   * /backtest page. Pure/in-process on the API; no data is written.
   */
  runBacktest: () => req<BacktestSummary>('/backtest', { method: 'POST', body: JSON.stringify({}) }),
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

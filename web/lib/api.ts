import type { Finding, ChatResponse, SimulateResult, RouteDecision } from '@log/shared';

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
  /** Loading the dashboard re-runs analysis across all sources, then returns findings. */
  findings: () =>
    req<{
      findings: Finding[];
      analysis?: { bySource: Record<string, { parsed: number; findings: number }>; pruned: number };
    }>('/findings?limit=100'),
  clearFindings: () => req<{ deleted: number }>('/findings', { method: 'DELETE' }),
  chat: (sessionId: string, message: string) =>
    req<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, scoped: true }),
    }),
  simulate: (body: unknown) =>
    req<SimulateResult>('/simulate', { method: 'POST', body: JSON.stringify(body) }),
  /** Natural-language simulate: the LLM parses the prompt into command specs. */
  simulatePrompt: (prompt: string) =>
    req<{
      results: {
        instruction: string;
        spec: {
          count: number;
          messageTypes: string[];
          ackStatus: 'success' | 'failure';
          startMessageId?: string;
        };
        result: SimulateResult;
      }[];
    }>('/simulate/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  /** POST a JSON payload to a real app endpoint (e.g. scp) via the API. */
  invokeApp: (body: { application?: string; url?: string; request: unknown }) =>
    req<{ application: string; status: number; response: unknown; latencyMs: number }>('/invoke-app', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

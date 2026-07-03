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
  findings: () => req<{ findings: Finding[] }>('/findings?limit=100'),
  chat: (sessionId: string, message: string) =>
    req<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message, scoped: true }),
    }),
  simulate: (body: unknown) =>
    req<SimulateResult>('/simulate', { method: 'POST', body: JSON.stringify(body) }),
  /** Natural-language simulate: the supervisor LLM parses the prompt. */
  simulatePrompt: (prompt: string) =>
    req<{ route: RouteDecision; result: SimulateResult }>('/simulate/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  invokeApp: (application: string, request: unknown) =>
    req<unknown>('/invoke-app', {
      method: 'POST',
      body: JSON.stringify({ application, request }),
    }),
};

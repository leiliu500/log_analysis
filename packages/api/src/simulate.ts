import { z } from 'zod';
import { SimulateRequest, type RouteDecision, type SimulateResult } from '@log/shared';
import { routeRequest } from '@log/agents';
import { simulate, DEFAULT_CASHMESSAGE_SAMPLES } from '@log/simulator';

/** Regex fallbacks so simulation is robust even if the LLM omits a param. */
export function parseCount(message: string, fromLlm: unknown): number {
  if (typeof fromLlm === 'number' && fromLlm >= 1) return Math.floor(fromLlm);
  if (typeof fromLlm === 'string' && /^\d+$/.test(fromLlm)) return Number(fromLlm);
  const m = message.match(/\b(\d{1,4})\s*(?:request|ack|response|set|message|msg|log)/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

export function parseStartId(message: string, fromLlm: unknown): string | undefined {
  if (typeof fromLlm === 'string' && fromLlm.trim()) return fromLlm.trim();
  const m = message.match(/message[_\s-]?id\s*(?:=|:|\s|from)\s*([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

export const hasCashXml = (s: string): boolean => /<(?:[\w.-]+:)?cashMessage[\s>]/i.test(s);

/**
 * Build a SimulateRequest from a natural-language message + the supervisor's
 * routing decision. count/startMessageId come from the LLM (regex fallback);
 * the sample template is the pasted XML if present, else the built-in one.
 */
export function buildSimulateRequest(message: string, route: RouteDecision): SimulateRequest {
  const p = route.parameters;
  return SimulateRequest.parse({
    application:
      route.targetApplication?.trim() ||
      (typeof p.application === 'string' ? p.application.trim() : '') ||
      'cashMessage',
    samples: hasCashXml(message) ? message : DEFAULT_CASHMESSAGE_SAMPLES,
    sinks: (Array.isArray(p.sinks) ? p.sinks : undefined) ?? (route.sources.length ? route.sources : ['cloudwatch']),
    count: parseCount(message, p.count),
    startMessageId: parseStartId(message, p.startMessageId),
    spreadMinutes: Number(p.spreadMinutes ?? 0),
  });
}

/**
 * Natural-language simulate path for the Simulator UI: route the prompt through
 * the Supervisor (LLM) to understand it, then run the Simulator Agent. Returns
 * the routing decision (so the UI can show what the LLM understood) + result.
 */
export async function handleSimulatePrompt(
  input: unknown,
): Promise<{ route: RouteDecision; result: SimulateResult }> {
  const { prompt } = z.object({ prompt: z.string().min(1) }).parse(input);
  const route = await routeRequest(prompt);
  const req = buildSimulateRequest(prompt, route);
  const result = await simulate(req);
  return { route, result };
}

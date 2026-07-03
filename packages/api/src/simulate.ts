import { z } from 'zod';
import { SimulateRequest, type RouteDecision, type SimulateResult } from '@log/shared';
import { routeRequest } from '@log/agents';
import { simulate, DEFAULT_CASHMESSAGE_SAMPLES } from '@log/simulator';

/**
 * How many sets to generate. The explicit "N request/ack/response/sets" phrase
 * in the text wins over the LLM (it confuses id ranges like "001 to 004" with
 * the set count); the LLM value is only a fallback.
 */
export function parseCount(message: string, fromLlm: unknown): number {
  const m = message.match(/\b(\d{1,4})\s*(?:request|ack|response|set|message|msg|log|transaction)/i);
  if (m) return Math.max(1, Number(m[1]));
  if (typeof fromLlm === 'number' && fromLlm >= 1) return Math.floor(fromLlm);
  if (typeof fromLlm === 'string' && /^\d+$/.test(fromLlm)) return Number(fromLlm);
  return 1;
}

export function parseStartId(message: string, fromLlm: unknown): string | undefined {
  if (typeof fromLlm === 'string' && fromLlm.trim()) return fromLlm.trim();
  const m = message.match(/message[_\s-]?id\s*(?:=|:|\s|from)\s*([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

/** Which message types to emit, from phrases like "without response". */
export function parseMessageTypes(message: string): ('REQUEST' | 'ACK' | 'RESPONSE')[] {
  const m = message.toLowerCase();
  if (/\b(request)\s*only\b|\bonly\s*(a\s*)?request\b|\bjust\s*(a\s*)?request\b/.test(m)) return ['REQUEST'];
  let types: ('REQUEST' | 'ACK' | 'RESPONSE')[] = ['REQUEST', 'ACK', 'RESPONSE'];
  if (/\b(without|no|missing|w\/o)\s+(a\s+)?response\b/.test(m)) types = types.filter((t) => t !== 'RESPONSE');
  if (/\b(without|no|missing|w\/o)\s+(an?\s+)?ack\b/.test(m)) types = types.filter((t) => t !== 'ACK');
  // "request/ack" (with no mention of response) also implies no response.
  if (/\brequest\s*[/&+]\s*ack\b/.test(m) && !/response/.test(m)) types = ['REQUEST', 'ACK'];
  return types.length ? types : ['REQUEST', 'ACK', 'RESPONSE'];
}

/**
 * Success vs failure ack. Failure words ("failure", "rejected", "nack", …) count
 * only when NOT negated by "no/without/zero/not", so "success and no error"
 * stays success while "ack with failure" is failure.
 */
export function parseAckStatus(message: string): 'success' | 'failure' {
  const m = message.toLowerCase();
  const failure =
    /(?<!\b(?:no|without|zero|not)\s+)(fail(?:ure|ed)?|reject(?:ed)?|\bnack\b|unsuccessful|declined|negative\s+ack)/.test(
      m,
    );
  return failure ? 'failure' : 'success';
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
    messageTypes: parseMessageTypes(message),
    ackStatus: parseAckStatus(message),
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

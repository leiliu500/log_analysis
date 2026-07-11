import { converseJson } from '@log/analysis';
import { RouteDecision, loadPrompt } from '@log/shared';

const SUPERVISOR_SYSTEM = loadPrompt('bedrock/supervisor.md');

/**
 * Deterministic signal that a message is an analytical query over RAW LOGS
 * (count / list messageId / recent-window), which must be routed to analyze_logs
 * — a live source pull — rather than query_findings (semantic search over stored
 * findings/logs, which can surface stale rows). The LLM router mis-picks this,
 * so we override it. Questions about findings/anomalies themselves are excluded.
 */
export function isAnalyticalLogQuery(message: string): boolean {
  const s = message.toLowerCase();
  if (/\bsimulate\b|\binvoke\b/.test(s)) return false;
  // Questions about the findings/anomalies store itself stay on query_findings.
  if (/\bfindings?\b|\banomal(y|ies)\b/.test(s)) return false;
  // "requests/acks/responses/messages/logs/transactions/messageId" — raw-log subjects.
  const subject =
    /\brequests?\b|\bresponses?\b|\backs?\b|\bmessages?\b|\bmessage[_\s-]?id|\blogs?\b|\btransactions?\b/.test(s);
  const quant = /\bhow many\b|\bhow much\b|\bnumber of\b|\bcount\b|\blist\b|\bshow\b|\bwhich\b/.test(s);
  const window = /\b(last|past|recent|within|latest|previous)\s+\d+\s*(second|sec|minute|min|hour|hr|day)/.test(s);
  // Failure / completeness questions about logs (may omit a count word or window).
  const problem = /\b(exception|errors?|failure|failures|failed|faults?|reject(ed)?|nack|unsuccessful|declined)\b/.test(s);
  const completeness = /(no|without|missing|only)\b[^.?!]*\b(response|ack)\b|incomplete/.test(s);
  return (subject && (quant || window)) || problem || completeness;
}

/**
 * Deterministic signal that a message is a request to SIMULATE/generate logs —
 * an unmistakable "simulate" verb or a pasted cashMessage XML. The LLM router
 * occasionally mislabels these (e.g. as query_findings), so the Supervisor
 * corrects it here rather than in the dispatcher.
 */
export function isSimulateRequest(message: string): boolean {
  return /\bsimulate\b/i.test(message) || /<(?:[\w.-]+:)?cashMessage[\s>]/i.test(message);
}

/** Supervisor routing corrections for the two paths the LLM router may misroute. */
function applyRoutingOverride(message: string, decision: RouteDecision): RouteDecision {
  // Simulate is the most specific signal — check it first.
  if (decision.intent !== 'simulate_logs' && isSimulateRequest(message)) {
    return {
      ...decision,
      intent: 'simulate_logs',
      targetAgent: 'simulator-agent',
      rationale: `Deterministic override → simulate_logs. ${decision.rationale ?? ''}`.trim(),
    };
  }
  if (
    decision.intent !== 'simulate_logs' &&
    decision.intent !== 'invoke_application' &&
    isAnalyticalLogQuery(message)
  ) {
    return {
      ...decision,
      intent: 'analyze_logs',
      targetAgent: 'analysis-agent',
      sources: decision.sources?.length ? decision.sources : ['cloudwatch'],
      rationale: `Deterministic override → analyze_logs (analytical log query). ${decision.rationale ?? ''}`.trim(),
    };
  }
  return decision;
}

/**
 * Local supervisor routing (used by the API for fast, testable routing without
 * a round-trip to the native Bedrock Agent). Mirrors the instructions given to
 * the provisioned Bedrock Supervisor Agent, so behaviour is consistent.
 */
export async function routeRequest(message: string): Promise<RouteDecision> {
  try {
    const raw = await converseJson<unknown>(message, {
      system: SUPERVISOR_SYSTEM,
      temperature: 0,
    });
    return applyRoutingOverride(message, RouteDecision.parse(raw));
  } catch {
    return applyRoutingOverride(message, {
      intent: 'query_findings',
      targetAgent: 'analysis-agent',
      sources: [],
      parameters: {},
      rationale: 'Fell back to findings query (router could not classify).',
      confidence: 0.3,
    });
  }
}

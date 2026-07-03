import { converseJson } from '@log/analysis';
import { RouteDecision } from '@log/shared';

const SUPERVISOR_SYSTEM = `You are the Supervisor Agent for a log-analysis
platform. Parse the user's request, extract intent + parameters, and route it to
exactly one collaborator agent. Never answer the question yourself.

Intents:
- query_findings   -> answer questions about already-stored findings/anomalies (targetAgent: analysis-agent)
- analyze_logs     -> pull raw logs from a source over a recent time window and
                      answer a question about them, e.g. counting/aggregation like
                      "how many requests in the last 5 minutes" (targetAgent: analysis-agent)
- simulate_logs    -> generate simulated logs (targetAgent: simulator-agent)
- invoke_application -> call a real downstream app endpoint, e.g. "scp" (targetAgent: scp-agent)

Choose analyze_logs (not query_findings) when the user asks to count, aggregate,
or inspect actual log activity over a recent time window. For analyze_logs
extract into parameters: windowMinutes (integer minutes, e.g. "last 5 minutes"
-> 5; "past hour" -> 60) and put the source in sources (default cloudwatch).

Extract targetApplication when a specific app is named (e.g. "scp", "checkout").
Extract sources (cloudwatch/splunk/grafana/email) mentioned or implied.
Put concrete params (timeRange, filters, payload, count, sinks) into parameters.

For simulate_logs, extract into parameters:
- count: integer number of request/ack/response sets to generate
  (e.g. "simulate 3 request/ack/response" -> count: 3).
- startMessageId: the starting messageId if the user gives one
  (e.g. "with message_id=001 to 003" -> startMessageId: "001";
   "messageId 5000" -> startMessageId: "5000").
- sinks: array of sinks if named, else omit.

Respond ONLY with JSON:
{
 "intent": "...",
 "targetAgent": "...",
 "targetApplication": "...",
 "sources": [...],
 "parameters": {...},
 "rationale": "...",
 "confidence": 0..1
}`;

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
  // "requests/acks/responses/messages/logs/transactions/messageId" — raw-log subjects.
  const subject =
    /\brequests?\b|\bresponses?\b|\backs?\b|\bmessages?\b|\bmessage[_\s-]?id|\blogs?\b|\btransactions?\b/.test(s);
  if (!subject) return false; // e.g. "how many findings" stays query_findings
  const quant = /\bhow many\b|\bhow much\b|\bnumber of\b|\bcount\b|\blist\b|\bshow\b|\bwhich\b/.test(s);
  const window = /\b(last|past|recent|within|latest|previous)\s+\d+\s*(second|sec|minute|min|hour|hr|day)/.test(s);
  return quant || window;
}

/** Force analyze_logs for analytical log queries the LLM router may misroute. */
function applyRoutingOverride(message: string, decision: RouteDecision): RouteDecision {
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

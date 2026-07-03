import { converseJson } from '@log/analysis';
import { RouteDecision } from '@log/shared';

const SUPERVISOR_SYSTEM = `You are the Supervisor Agent for a log-analysis
platform. Parse the user's request, extract intent + parameters, and route it to
exactly one collaborator agent. Never answer the question yourself.

Intents:
- query_findings   -> answer questions about stored logs/findings (targetAgent: analysis-agent)
- analyze_logs     -> run analysis over a source/time window (targetAgent: <source>-log-agent)
- simulate_logs    -> generate simulated logs (targetAgent: simulator-agent)
- invoke_application -> call a real downstream app endpoint, e.g. "scp" (targetAgent: scp-agent)

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
    return RouteDecision.parse(raw);
  } catch {
    return {
      intent: 'query_findings',
      targetAgent: 'analysis-agent',
      sources: [],
      parameters: {},
      rationale: 'Fell back to findings query (router could not classify).',
      confidence: 0.3,
    };
  }
}

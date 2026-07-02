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

import { converseJson } from '@log/analysis';
import { RouteDecision, loadPrompt } from '@log/shared';

const SUPERVISOR_SYSTEM = loadPrompt('bedrock/supervisor.md');

/**
 * The Supervisor's routing. The LLM — driven entirely by the routing rules in
 * prompts/bedrock/supervisor.md — classifies the request into one intent +
 * parameters. Routing logic lives in the prompt, not in code; the dispatcher
 * (chat.ts) only switches on the returned intent. Falls back to query_findings
 * only when the model errors or returns an unparseable reply.
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

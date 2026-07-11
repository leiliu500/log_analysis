/**
 * Bedrock Agent Action-Group Lambda for the scp collaborator agent. It invokes a
 * real downstream application (the /invoke-app tool). The analysis + simulator
 * collaborator agents were removed, so their tools (/findings/search,
 * /logs/analyze, /simulate) are gone; the live app uses in-process equivalents.
 */
import { InvokeAppRequest } from '@log/shared';
import { invokeApplication } from '@log/app-scp';

interface BedrockAgentEvent {
  actionGroup: string;
  apiPath: string;
  httpMethod: string;
  parameters?: { name: string; type: string; value: string }[];
  requestBody?: {
    content?: Record<string, { properties?: { name: string; value: string }[] }>;
  };
  sessionId?: string;
}

function readParams(event: BedrockAgentEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of event.parameters ?? []) out[p.name] = p.value;
  const props = event.requestBody?.content?.['application/json']?.properties ?? [];
  for (const p of props) out[p.name] = p.value;
  return out;
}

function envelope(event: BedrockAgentEvent, status: number, body: unknown) {
  return {
    messageVersion: '1.0',
    response: {
      actionGroup: event.actionGroup,
      apiPath: event.apiPath,
      httpMethod: event.httpMethod,
      httpStatusCode: status,
      responseBody: { 'application/json': { body: JSON.stringify(body) } },
    },
  };
}

export async function handler(event: BedrockAgentEvent): Promise<unknown> {
  const params = readParams(event);
  try {
    switch (event.apiPath) {
      // Invoke a real downstream application.
      case '/invoke-app': {
        const req = InvokeAppRequest.parse({
          application: params.application,
          request: params.request ? JSON.parse(params.request) : {},
        });
        return envelope(event, 200, await invokeApplication(req));
      }

      default:
        return envelope(event, 404, { error: `Unknown apiPath ${event.apiPath}` });
    }
  } catch (err) {
    return envelope(event, 500, { error: (err as Error).message });
  }
}

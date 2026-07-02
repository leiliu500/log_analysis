/**
 * Bedrock Agent Action-Group Lambda. A single handler backs all collaborator
 * tools; it dispatches on apiPath. Deployed by infra/ and wired to the agent's
 * action groups. Returns the Bedrock-Agent response envelope.
 */
import { embed } from '@log/analysis';
import { runPipeline } from '@log/analysis';
import { searchFindingsByEmbedding, recentFindings } from '@log/db';
import { connectorFor } from '@log/ingestion';
import { simulate } from '@log/simulator';
import { SimulateRequest, InvokeAppRequest, type LogSourceType } from '@log/shared';
import { invokeApplication } from './scp.js';

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
  const props =
    event.requestBody?.content?.['application/json']?.properties ?? [];
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
      // Query stored findings semantically (scoped chat / analysis-agent).
      case '/findings/search': {
        const q = params.query ?? '';
        if (!q) return envelope(event, 200, { findings: await recentFindings(20) });
        const vec = await embed(q).catch(() => []);
        const findings = vec.length
          ? await searchFindingsByEmbedding(vec, 10)
          : await recentFindings(20);
        return envelope(event, 200, { findings });
      }

      // Pull logs from a source + run the full analysis pipeline.
      case '/logs/analyze': {
        const source = (params.source ?? 'cloudwatch') as LogSourceType;
        const since = Number(params.since ?? Date.now() - 15 * 60_000);
        const connector = connectorFor(source);
        const records = await connector.pull({ since, limit: Number(params.limit ?? 1000) });
        const result = await runPipeline(records, { embedLogs: params.embed === 'true' });
        return envelope(event, 200, {
          parsed: result.parsed,
          anomalies: result.anomalies.length,
          findings: result.findings,
        });
      }

      // Trigger the simulator agent.
      case '/simulate': {
        const req = SimulateRequest.parse({
          application: params.application ?? 'demo-service',
          sampleRequest: params.sampleRequest ? JSON.parse(params.sampleRequest) : {},
          sampleResponse: params.sampleResponse ? JSON.parse(params.sampleResponse) : {},
          sinks: (params.sinks ?? 'cloudwatch').split(','),
          count: Number(params.count ?? 25),
          injectAnomalies: params.injectAnomalies === 'true',
          spreadMinutes: Number(params.spreadMinutes ?? 5),
        });
        return envelope(event, 200, await simulate(req));
      }

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

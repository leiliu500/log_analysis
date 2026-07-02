import { converseJson } from '@log/analysis';
import type { SimulateRequest } from '@log/shared';

const SIM_SYSTEM = `You are a log-simulation agent. Given an application name and a
sample request/response, produce a representative SET of realistic log lines the
application would emit while handling such traffic. Vary levels, messages, and
fields the way a real service does (request received, validation, downstream
calls, timing, completion). If asked to inject anomalies, include a minority of
error/timeout/latency-spike lines.

Return ONLY JSON: { "templates": LogTemplate[] } where LogTemplate is
{ "level": "info|warn|error", "message": string, "fields": object }.
Use placeholder tokens {reqId}, {userId}, {latencyMs}, {status} in messages/fields
where a real log would vary — the caller expands them.`;

export interface LogTemplate {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

/** Ask the model for a set of log templates tailored to the app + sample I/O. */
export async function generateTemplates(req: SimulateRequest): Promise<LogTemplate[]> {
  const prompt = `Application: ${req.application}
Inject anomalies: ${req.injectAnomalies}
Sample request:
${JSON.stringify(req.sampleRequest, null, 2)}
Sample response:
${JSON.stringify(req.sampleResponse, null, 2)}

Produce ${Math.min(req.count, 40)} varied templates.`;

  const { templates } = await converseJson<{ templates: LogTemplate[] }>(prompt, {
    system: SIM_SYSTEM,
    temperature: 0.7,
    maxTokens: 3000,
  });
  return templates?.length ? templates : fallbackTemplates(req);
}

function fallbackTemplates(req: SimulateRequest): LogTemplate[] {
  return [
    { level: 'info', message: `${req.application} request received {reqId}`, fields: { app: req.application } },
    { level: 'info', message: `${req.application} completed {status} in {latencyMs}ms {reqId}`, fields: {} },
    { level: 'error', message: `${req.application} downstream timeout {reqId}`, fields: {} },
  ];
}

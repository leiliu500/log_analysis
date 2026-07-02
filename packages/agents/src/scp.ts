import type { InvokeAppRequest, InvokeAppResult } from '@log/shared';

/** Resolve the endpoint map from APP_ENDPOINTS_JSON. */
function endpoints(): Record<string, string> {
  try {
    return JSON.parse(process.env.APP_ENDPOINTS_JSON ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * scp-agent's tool: call a REAL downstream application endpoint with the
 * user's request (requirement 10/11). The supervisor routes e.g. "scp" here.
 */
export async function invokeApplication(req: InvokeAppRequest): Promise<InvokeAppResult> {
  const map = endpoints();
  const url = map[req.application];
  if (!url) {
    throw new Error(
      `No endpoint configured for application "${req.application}". Known: ${Object.keys(map).join(', ') || '(none)'}`,
    );
  }
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.APP_AUTH_HEADER
        ? { Authorization: process.env.APP_AUTH_HEADER }
        : {}),
    },
    body: JSON.stringify(req.request),
  });
  const latencyMs = Date.now() - started;
  const contentType = res.headers.get('content-type') ?? '';
  const response = contentType.includes('application/json')
    ? await res.json()
    : await res.text();

  return { application: req.application, status: res.status, response, latencyMs };
}

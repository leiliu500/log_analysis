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
  // An explicit URL (e.g. entered in the SCP UI) wins over the configured map.
  const map = endpoints();
  const url = req.url ?? map[req.application];
  if (!url) {
    throw new Error(
      `No endpoint for application "${req.application}". Provide a url, or configure one. Known: ${Object.keys(map).join(', ') || '(none)'}`,
    );
  }
  const headers: Record<string, string> = {};
  if (process.env.APP_AUTH_HEADER) headers.Authorization = process.env.APP_AUTH_HEADER;

  // When a file is attached (or asForm), POST multipart/form-data with two
  // fields: `payload` (the JSON) and `file` (the upload). Otherwise a JSON body.
  let body: FormData | string;
  if (req.asForm || req.file) {
    const form = new FormData();
    form.append('payload', JSON.stringify(req.request));
    if (req.file) {
      const bytes = Buffer.from(req.file.contentBase64, 'base64');
      const blob = new Blob([bytes], { type: req.file.contentType || 'application/octet-stream' });
      form.append('file', blob, req.file.name);
    }
    body = form; // fetch sets the multipart Content-Type + boundary
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.request);
  }

  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body });
  const latencyMs = Date.now() - started;
  const contentType = res.headers.get('content-type') ?? '';
  const response = contentType.includes('application/json')
    ? await res.json()
    : await res.text();

  return { application: req.application, status: res.status, response, latencyMs };
}

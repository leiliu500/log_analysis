'use client';

import { useRef, useState } from 'react';
import { api } from '../../lib/api';

const SAMPLE_PAYLOAD = JSON.stringify(
  {
    transactionType: 'USSS',
    messageId: 'FCC-USSS-28090845',
    payload: { frbOfficeId: '1', districtId: '01', businessDate: '12292025' },
  },
  null,
  2,
);

interface Result {
  application: string;
  status: number;
  response: unknown;
  latencyMs: number;
}

export default function ScpPage() {
  const [url, setUrl] = useState('');
  const [payload, setPayload] = useState(SAMPLE_PAYLOAD);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // (1) Attach file: load its text into the JSON payload box.
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    const text = await f.text();
    setPayload(text);
    setFileName(f.name);
  }

  // (4) Submit: POST the JSON payload to the scp endpoint URL.
  async function submit() {
    if (busy) return;
    setError(null);
    setResult(null);
    const endpoint = url.trim();
    if (!endpoint) {
      setError('Enter the SCP endpoint URL.');
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(payload);
    } catch (err) {
      setError(`Payload is not valid JSON: ${(err as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.invokeApp({ application: 'scp', url: endpoint, request });
      setResult(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-2xl font-semibold text-white">SCP</h1>
      <p className="mb-6 text-sm text-slate-400">
        Trigger the real <b>scp</b> application: attach or type a JSON payload, set the endpoint URL,
        and submit an HTTP <code>POST</code>. The request is proxied through the API (scp-agent).
      </p>

      {/* (3) Endpoint URL */}
      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        SCP endpoint URL
      </label>
      <input
        className="mb-4 w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
        placeholder="https://scp.example.gov/api/transaction"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />

      {/* (1) Attach file */}
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-edge px-3 py-1.5 text-sm text-slate-300 hover:bg-edge"
        >
          📎 Attach file
        </button>
        <input ref={fileRef} type="file" accept=".json,.txt,application/json" hidden onChange={onFile} />
        {fileName && <span className="text-xs text-slate-400">Loaded: {fileName}</span>}
      </div>

      {/* (2) JSON payload */}
      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        JSON payload
      </label>
      <textarea
        rows={14}
        className="mb-4 w-full resize-y rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-xs outline-none focus:border-sky-500"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        spellCheck={false}
      />

      {/* (4) Submit */}
      <button
        onClick={() => void submit()}
        disabled={busy}
        className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Posting…' : 'Submit POST'}
      </button>

      {error && <p className="mt-4 text-sm text-red-400">⚠️ {error}</p>}

      {result && (
        <div className="mt-6">
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            <span
              className={`rounded px-2 py-0.5 ${
                result.status >= 200 && result.status < 300
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-red-500/20 text-red-300'
              }`}
            >
              HTTP {result.status}
            </span>
            <span className="rounded bg-edge px-2 py-0.5 text-slate-300">{result.latencyMs} ms</span>
            <span className="rounded bg-edge px-2 py-0.5 text-slate-300">app: {result.application}</span>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-edge bg-panel p-3 text-xs text-slate-200">
            {typeof result.response === 'string'
              ? result.response
              : JSON.stringify(result.response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

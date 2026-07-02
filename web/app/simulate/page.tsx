'use client';

import { useState } from 'react';
import { api } from '../../lib/api';

const SOURCES = ['cloudwatch', 'splunk', 'grafana', 'email'] as const;

export default function SimulatePage() {
  const [application, setApplication] = useState('scp');
  const [sampleRequest, setSampleRequest] = useState('{\n  "method": "POST",\n  "path": "/transfer",\n  "body": { "amount": 100 }\n}');
  const [sampleResponse, setSampleResponse] = useState('{\n  "status": 200,\n  "body": { "ok": true }\n}');
  const [sinks, setSinks] = useState<string[]>(['cloudwatch']);
  const [count, setCount] = useState(50);
  const [injectAnomalies, setInjectAnomalies] = useState(true);
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult('');
    try {
      const res = await api.simulate({
        application,
        sampleRequest: JSON.parse(sampleRequest),
        sampleResponse: JSON.parse(sampleResponse),
        sinks,
        count,
        injectAnomalies,
        spreadMinutes: 5,
      });
      setResult(JSON.stringify(res, null, 2));
    } catch (e) {
      setResult(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-2xl font-semibold text-white">Simulator Agent</h1>
      <p className="mb-6 text-sm text-slate-400">
        Generate realistic logs from a sample request/response and write them to the
        selected sinks. They flow through the same analysis pipeline as real logs.
      </p>

      <label className="mb-1 block text-sm text-slate-400">Application</label>
      <input
        className="mb-4 w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm"
        value={application}
        onChange={(e) => setApplication(e.target.value)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-slate-400">Sample request</label>
          <textarea
            className="h-40 w-full rounded-lg border border-edge bg-panel p-3 font-mono text-xs"
            value={sampleRequest}
            onChange={(e) => setSampleRequest(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-400">Sample response</label>
          <textarea
            className="h-40 w-full rounded-lg border border-edge bg-panel p-3 font-mono text-xs"
            value={sampleResponse}
            onChange={(e) => setSampleResponse(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex gap-2">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() =>
                setSinks((cur) =>
                  cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
                )
              }
              className={`rounded-lg border px-3 py-1 text-xs ${
                sinks.includes(s)
                  ? 'border-sky-500 bg-sky-600/30 text-white'
                  : 'border-edge text-slate-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          count
          <input
            type="number"
            className="w-20 rounded-lg border border-edge bg-panel px-2 py-1"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={injectAnomalies}
            onChange={(e) => setInjectAnomalies(e.target.checked)}
          />
          inject anomalies
        </label>
      </div>

      <button
        onClick={run}
        disabled={busy || sinks.length === 0}
        className="mt-6 rounded-xl bg-sky-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Simulating…' : 'Run simulation'}
      </button>

      {result && (
        <pre className="mt-6 overflow-auto rounded-xl border border-edge bg-panel p-4 text-xs text-slate-300">
          {result}
        </pre>
      )}
    </div>
  );
}

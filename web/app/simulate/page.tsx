'use client';

import { useRef, useState } from 'react';
import type { SimulateResult } from '@log/shared';
import { api } from '../../lib/api';

const SOURCES = ['cloudwatch', 'splunk', 'grafana', 'email'] as const;

interface Turn {
  input: string;
  result?: SimulateResult;
  error?: string;
}

export default function SimulatePage() {
  const [samples, setSamples] = useState('');
  const [application, setApplication] = useState('cashMessage');
  const [count, setCount] = useState(1);
  const [sinks, setSinks] = useState<string[]>(['cloudwatch']);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function send() {
    const input = samples.trim();
    if (!input || busy || sinks.length === 0) return;
    setBusy(true);
    setTurns((t) => [...t, { input }]);
    setSamples('');
    try {
      const result = await api.simulate({
        application,
        samples: input,
        sinks,
        count,
        spreadMinutes: 0,
      });
      setTurns((t) => [...t.slice(0, -1), { input, result }]);
    } catch (e) {
      setTurns((t) => [...t.slice(0, -1), { input, error: String(e) }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }));
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col p-6">
      <h1 className="mb-1 text-xl font-semibold text-white">Simulator Agent</h1>
      <p className="mb-4 text-xs text-slate-400">
        Paste one or more sample messages (XML like an FRB cashMessage, plus optional
        ACK/Response) into the box below. The agent replicates the flow{' '}
        <b>{count}</b> time(s), giving each set a unique <code>messageId</code> and
        keeping every ACK/Response <code>initMessageId</code> matched to its request.
      </p>

      {/* Transcript */}
      <div className="flex-1 space-y-4 overflow-auto rounded-xl border border-edge bg-panel p-4">
        {turns.length === 0 && (
          <p className="text-sm text-slate-500">Paste a sample message to get started.</p>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-edge/60 p-3 text-xs text-slate-300">
              {t.input.length > 1200 ? t.input.slice(0, 1200) + '\n…' : t.input}
            </pre>
            {t.result && <ResultCard result={t.result} />}
            {t.error && <div className="text-sm text-red-400">⚠️ {t.error}</div>}
          </div>
        ))}
        {busy && <div className="text-sm text-slate-500">Simulating…</div>}
        <div ref={endRef} />
      </div>

      {/* Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <label className="flex items-center gap-2">
          app
          <input
            className="w-32 rounded-lg border border-edge bg-panel px-2 py-1"
            value={application}
            onChange={(e) => setApplication(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          count
          <input
            type="number"
            min={1}
            className="w-20 rounded-lg border border-edge bg-panel px-2 py-1"
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
          />
        </label>
        <div className="flex gap-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() =>
                setSinks((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
              }
              className={`rounded-lg border px-2 py-1 text-xs ${
                sinks.includes(s)
                  ? 'border-sky-500 bg-sky-600/30 text-white'
                  : 'border-edge text-slate-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Single input area */}
      <div className="mt-2 flex gap-2">
        <textarea
          className="h-28 flex-1 rounded-xl border border-edge bg-panel p-3 font-mono text-xs outline-none focus:border-sky-500"
          placeholder="Paste sample XML message(s) here…"
          value={samples}
          onChange={(e) => setSamples(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="self-end rounded-xl bg-sky-600 px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
          onClick={send}
          disabled={busy || sinks.length === 0}
        >
          {busy ? '…' : 'Simulate'}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">⌘/Ctrl + Enter to simulate</p>
    </div>
  );
}

function ResultCard({ result }: { result: SimulateResult }) {
  const written = Object.entries(result.written)
    .map(([k, v]) => `${v}→${k}`)
    .join(', ');
  return (
    <div className="card text-sm">
      <div className="mb-2 text-slate-300">
        Wrote <b>{written || '0'}</b> log entries · app <code>{result.application}</code>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="pr-4">type</th>
              <th className="pr-4">messageId</th>
              <th>initMessageId</th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-300">
            {result.messages.slice(0, 30).map((m, i) => (
              <tr key={i}>
                <td className="pr-4">{m.messageType}</td>
                <td className="pr-4">{m.messageId}</td>
                <td className={m.initMessageId ? 'text-emerald-400' : 'text-slate-600'}>
                  {m.initMessageId ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.messages.length > 30 && (
          <div className="mt-1 text-slate-500">…and {result.messages.length - 30} more</div>
        )}
      </div>
    </div>
  );
}

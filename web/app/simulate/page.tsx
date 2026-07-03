'use client';

import { useRef, useState } from 'react';
import type { SimulateResult, RouteDecision } from '@log/shared';
import { api } from '../../lib/api';

interface Turn {
  input: string;
  route?: RouteDecision;
  result?: SimulateResult;
  error?: string;
}

const EXAMPLES = [
  'Simulate 4 request/ack/response with message_id=001 to 004',
  'simulate 10 cashMessage request/ack/response to cloudwatch',
  'generate 3 request/ack/response starting messageId FCC-USSS-28090845',
];

export default function SimulatePage() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(text?: string) {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;
    setBusy(true);
    setTurns((t) => [...t, { input: prompt }]);
    setInput('');
    try {
      const { route, result } = await api.simulatePrompt(prompt);
      setTurns((t) => [...t.slice(0, -1), { input: prompt, route, result }]);
    } catch (e) {
      setTurns((t) => [...t.slice(0, -1), { input: prompt, error: String(e) }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }));
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col p-6">
      <h1 className="mb-1 text-xl font-semibold text-white">Simulator Agent</h1>
      <p className="mb-3 text-xs text-slate-400">
        Ask in plain English. The <b>Supervisor Agent (LLM)</b> understands your request —
        how many sets, the starting messageId — and delegates to the Simulator Agent, which
        writes correlated Request/ACK/Response messages (matched <code>initMessageId</code>)
        to the sink. No count field — the number comes from your sentence.
      </p>

      {/* Transcript */}
      <div className="flex-1 space-y-4 overflow-auto rounded-xl border border-edge bg-panel p-4">
        {turns.length === 0 && (
          <div className="text-sm text-slate-500">
            Try one:
            <ul className="mt-2 space-y-1">
              {EXAMPLES.map((ex) => (
                <li key={ex}>
                  <button
                    className="text-left text-sky-400 hover:underline"
                    onClick={() => void send(ex)}
                  >
                    “{ex}”
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="text-right">
              <span className="inline-block rounded-2xl bg-sky-600 px-4 py-2 text-sm text-white">
                {t.input}
              </span>
            </div>
            {t.route && (
              <div className="text-xs text-slate-400">
                🤖 LLM understood → intent <code>{t.route.intent}</code>, agent{' '}
                <code>{t.route.targetAgent}</code>, params{' '}
                <code>{JSON.stringify(t.route.parameters)}</code>
              </div>
            )}
            {t.result && <ResultCard result={t.result} />}
            {t.error && <div className="text-sm text-red-400">⚠️ {t.error}</div>}
          </div>
        ))}
        {busy && <div className="text-sm text-slate-500">Supervisor is routing…</div>}
        <div ref={endRef} />
      </div>

      {/* Single natural-language input */}
      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-xl border border-edge bg-panel px-4 py-3 text-sm outline-none focus:border-sky-500"
          placeholder="e.g. Simulate 4 request/ack/response with message_id=001 to 004"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void send())}
        />
        <button
          className="rounded-xl bg-sky-600 px-5 text-sm font-medium text-white disabled:opacity-50"
          onClick={() => void send()}
          disabled={busy}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: SimulateResult }) {
  const written = Object.entries(result.written)
    .map(([k, v]) => `${v}→${k}`)
    .join(', ');
  const sets = result.messages.filter((m) => m.messageType === 'REQUEST').length;
  return (
    <div className="card text-sm">
      <div className="mb-2 text-slate-300">
        Generated <b>{sets}</b> set(s) · wrote <b>{written || '0'}</b> · app{' '}
        <code>{result.application}</code>
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

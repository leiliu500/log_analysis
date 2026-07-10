'use client';

import { useRef, useState } from 'react';
import type { SimulateResult } from '@log/shared';
import { api } from '../../lib/api';

interface Outcome {
  instruction: string;
  spec: {
    count: number;
    messageTypes: string[];
    ackStatus: 'success' | 'failure';
    startMessageId?: string;
    logGroup?: string;
  };
  result: SimulateResult;
}

interface Turn {
  input: string;
  results?: Outcome[];
  note?: string;
  routedIntent?: string;
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
      const { results, note, route } = await api.simulatePrompt(prompt);
      setTurns((t) => [
        ...t.slice(0, -1),
        { input: prompt, results, note, routedIntent: route?.intent },
      ]);
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
        Ask in plain English. <b>Send</b> flows through the <b>Supervisor Agent</b> → the{' '}
        <b>Simulator Agent</b> only — it writes correlated Request/ACK/Response messages
        (matched <code>initMessageId</code>) to the target CloudWatch log group. No other
        agent runs here. Analysis is <b>not</b> triggered now: the scheduled ingestion poller
        picks up these logs at the next interval, spawns the analysis agents, and updates the
        Dashboard.
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
            {(t.results?.length || t.routedIntent) && (
              <div className="text-xs text-slate-400">
                🧭 Supervisor Agent →{' '}
                {t.routedIntent === 'simulate_logs' || (t.results?.length ?? 0) > 0 ? (
                  <b className="text-sky-400">Simulator Agent</b>
                ) : (
                  <span className="text-orange-300">{t.routedIntent} (no agent run)</span>
                )}
              </div>
            )}
            {t.results?.map((o, j) => (
              <div key={j} className="space-y-1">
                {t.results!.length > 1 && (
                  <div className="text-xs text-slate-500">Command {j + 1}</div>
                )}
                <div className="text-xs text-slate-400">
                  🤖 Simulator understood → <code>{o.spec.count}</code> ×{' '}
                  <code>{o.spec.messageTypes.join('+')}</code>, ack{' '}
                  <code>{o.spec.ackStatus}</code>
                  {o.spec.startMessageId ? (
                    <> , ids from <code>{o.spec.startMessageId}</code></>
                  ) : null}
                  {o.spec.logGroup ? (
                    <> , log group <code>{o.spec.logGroup}</code></>
                  ) : null}
                </div>
                <ResultCard result={o.result} spec={o.spec} />
              </div>
            ))}
            {t.note && (
              <div className="rounded-lg border border-edge bg-panel px-3 py-2 text-xs text-slate-400">
                ⏳ {t.note}
              </div>
            )}
            {t.error && <div className="text-sm text-red-400">⚠️ {t.error}</div>}
          </div>
        ))}
        {busy && <div className="text-sm text-slate-500">Supervisor is routing…</div>}
        <div ref={endRef} />
      </div>

      {/* Single natural-language input (multi-line; paste XML, Shift+Enter for newline) */}
      <div className="mt-3 flex gap-2">
        <textarea
          rows={3}
          className="flex-1 resize-y rounded-xl border border-edge bg-panel px-4 py-3 font-mono text-xs outline-none focus:border-sky-500"
          placeholder="e.g. Simulate 4 request/ack/response with message_id=001 to 004  —  or paste XML"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="self-end rounded-xl bg-sky-600 px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
          onClick={() => void send()}
          disabled={busy}
        >
          Send
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}

function ResultCard({ result, spec }: { result: SimulateResult; spec?: Outcome['spec'] }) {
  const written = Object.entries(result.written)
    .map(([k, v]) => `${v}→${k}`)
    .join(', ');
  // cashMessage (SCP) sets are typed REQUEST/ACK/RESPONSE; verbatim apps (apiflc)
  // report one "SET" per set. Drive the shape from the app's own phases (spec).
  const types = [...new Set(result.messages.map((m) => m.messageType))];
  const isCashMessage = ['REQUEST', 'ACK', 'RESPONSE'].some((t) => types.includes(t));
  const sets = isCashMessage
    ? result.messages.filter((m) => m.messageType === 'REQUEST').length
    : spec?.count ?? result.messages.length;
  const perSet = spec?.messageTypes ?? ['REQUEST', 'ACK', 'RESPONSE'].filter((t) => types.includes(t));
  // "without X" only makes sense for the cashMessage set model.
  const missing = isCashMessage ? ['REQUEST', 'ACK', 'RESPONSE'].filter((t) => !types.includes(t)) : [];
  const failed = result.messages.some((m) => m.ackCode && !/^(OK|SUCCESS|PROCESSED_SUCCESSFULLY|ACCEPTED|COMPLETE)/i.test(m.ackCode));
  return (
    <div className="card text-sm">
      <div className="mb-1 text-slate-300">
        Generated <b>{sets}</b> set(s) · wrote <b>{written || '0'}</b> · app{' '}
        <code>{result.application}</code>
      </div>
      <div className="mb-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-edge px-2 py-0.5">per set: {perSet.join(' + ')}</span>
        {missing.length > 0 && (
          <span className="rounded bg-orange-500/20 px-2 py-0.5 text-orange-300">
            without {missing.join(' & ')}
          </span>
        )}
        <span className={`rounded px-2 py-0.5 ${failed ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
          ack: {failed ? 'FAILURE' : 'success'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="pr-4">type</th>
              <th className="pr-4">messageId</th>
              <th className="pr-4">initMessageId</th>
              <th>ackCode</th>
            </tr>
          </thead>
          <tbody className="font-mono text-slate-300">
            {result.messages.slice(0, 30).map((m, i) => (
              <tr key={i}>
                <td className="pr-4">{m.messageType}</td>
                <td className="pr-4">{m.messageId}</td>
                <td className={`pr-4 ${m.initMessageId ? 'text-emerald-400' : 'text-slate-600'}`}>
                  {m.initMessageId ?? '—'}
                </td>
                <td className={m.ackCode && /fail|reject|error/i.test(m.ackCode) ? 'text-red-400' : 'text-slate-400'}>
                  {m.ackCode ?? '—'}
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

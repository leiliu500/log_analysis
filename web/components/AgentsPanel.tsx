'use client';

import type { Agent } from '@log/shared';

function clock(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const HISTORY_STYLES: Record<string, string> = {
  completed: 'bg-emerald-500/20 text-emerald-300',
  failed: 'bg-red-500/20 text-red-300',
  error: 'bg-amber-500/20 text-amber-300',
};

/** A REQUEST/ACK/RESPONSE progress pip. */
function Pip({ label, state }: { label: string; state: 'done' | 'wait' | 'fail' | 'idle' }) {
  const styles = {
    done: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
    wait: 'border-sky-500 bg-sky-500/10 text-sky-300 animate-pulse',
    fail: 'border-red-500 bg-red-500/20 text-red-300',
    idle: 'border-edge bg-panel text-slate-600',
  }[state];
  const mark = state === 'done' ? '✓' : state === 'fail' ? '✗' : state === 'wait' ? '…' : '·';
  return (
    <div className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1 ${styles}`}>
      <span className="text-sm font-semibold">{mark}</span>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </div>
  );
}

/** One active agent card, showing the protocol's phase progress. */
function AgentCard({ a }: { a: Agent }) {
  return (
    <div className="rounded-xl border border-sky-700/60 bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-sky-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" /> active
        </span>
        <span className="text-[11px] text-slate-500">{ago(a.spawnedAt)}</span>
      </div>
      <div className="mb-2 truncate font-mono text-sm text-white" title={a.messageId}>
        {a.messageId}
      </div>
      <div
        className="mb-2 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, a.phases.length)}, minmax(0, 1fr))` }}
      >
        {a.phases.map((p) => {
          const done = a.phaseTs?.[p] !== undefined;
          const state = done ? 'done' : p === a.waitingFor ? 'wait' : 'idle';
          return <Pip key={p} label={p.toLowerCase()} state={state} />;
        })}
      </div>
      <div className="text-[11px] text-slate-400">
        {a.waitingFor ? `waiting for ${a.waitingFor}` : 'in progress'}
        {a.logGroup ? <span className="text-slate-600"> · {a.logGroup}</span> : null}
      </div>
    </div>
  );
}

export function AgentsPanel({
  active,
  history,
  correlationLabel = 'messageId',
}: {
  active: Agent[];
  history: Agent[];
  /** What this application calls its correlation id (scp: messageId, apiflc: correlationID). */
  correlationLabel?: string;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Active Agents</h2>
        <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">
          {active.length}
        </span>
        <span className="text-xs text-slate-500">
          one agent per in-flight transaction — waits through each protocol phase in order
        </span>
      </div>

      {active.length > 0 ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {active.map((a) => (
            <AgentCard key={a.messageId} a={a} />
          ))}
        </div>
      ) : (
        <p className="mb-6 text-sm text-slate-500">
          No active agents. Simulate an incomplete transaction (e.g. “request only”, or
          “request/ack without response”) so an agent stays active awaiting its ACK/RESPONSE.
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Agent History</h2>
        <span className="text-xs text-slate-500">{history.length} closed</span>
      </div>
      {history.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2">{correlationLabel}</th>
                <th className="px-3 py-2">final status</th>
                <th className="px-3 py-2">phases</th>
                <th className="px-3 py-2">ackCode</th>
                <th className="px-3 py-2">detail</th>
                <th className="px-3 py-2">closed</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {history.slice(0, 60).map((a) => (
                <tr key={a.messageId} className="border-b border-edge/50">
                  <td className="px-3 py-1.5">{a.messageId}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 ${HISTORY_STYLES[a.status] ?? 'bg-slate-500/20 text-slate-300'}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">
                    {a.phases.map((p, i) => (
                      <span key={p}>
                        {i > 0 ? <span className="text-slate-600"> · </span> : null}
                        <span className="text-slate-500">{p}</span> {clock(a.phaseTs?.[p])}
                      </span>
                    ))}
                  </td>
                  <td
                    className={`px-3 py-1.5 ${
                      a.ackCode && /fail|reject|error|nack/i.test(a.ackCode) ? 'text-red-400' : 'text-slate-400'
                    }`}
                  >
                    {a.ackCode ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 font-sans text-slate-400">{a.detail ?? '—'}</td>
                  <td className="px-3 py-1.5 text-slate-500">{ago(a.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > 60 && (
            <div className="px-3 py-2 text-xs text-slate-500">…and {history.length - 60} more</div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No closed agents yet.</p>
      )}
    </section>
  );
}

'use client';

import type { AgentActivity, AgentBatch } from '@log/shared';

const STATUS_STYLES: Record<AgentActivity['status'], string> = {
  finding: 'bg-amber-500/20 text-amber-300',
  clean: 'bg-emerald-500/20 text-emerald-300',
  duplicate: 'bg-slate-500/20 text-slate-300',
  error: 'bg-red-500/20 text-red-300',
};

const KIND_LABEL: Record<AgentActivity['kind'], string> = {
  transaction: 'txn',
  error: 'error',
  correlation: 'corr',
};

function clock(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** ms gap between two message timestamps, e.g. request→ack latency. */
function gap(a?: number, b?: number): string {
  if (a === undefined || b === undefined) return '';
  const d = b - a;
  return d >= 0 ? `+${d}ms` : `${d}ms`;
}

export function AgentActivityPanel({
  activity,
  batches,
}: {
  activity: AgentActivity[];
  batches: AgentBatch[];
}) {
  const latest = batches[0];
  const live = latest ? activity.filter((a) => a.batchId === latest.batchId) : [];
  const fresh = latest ? Date.now() - latest.finishedAt < 90_000 : false;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Agent Dynamics</h2>
        {fresh && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> live
          </span>
        )}
        <span className="text-xs text-slate-500">
          one agent is spawned per ingested request each poll cycle
        </span>
      </div>

      {/* Recent ingest cycles (system activity over time). */}
      {batches.length > 0 ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {batches.map((b, i) => (
            <div
              key={b.batchId}
              className={`min-w-[9rem] shrink-0 rounded-lg border px-3 py-2 text-xs ${
                i === 0 ? 'border-sky-600 bg-sky-500/10' : 'border-edge bg-panel'
              }`}
            >
              <div className="mb-1 flex justify-between text-slate-400">
                <span>{i === 0 ? 'latest cycle' : `cycle −${i}`}</span>
                <span>{ago(b.finishedAt)}</span>
              </div>
              <div className="text-lg font-semibold text-white">{b.total} agents</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {b.finding > 0 && (
                  <span className="rounded bg-amber-500/20 px-1.5 text-amber-300">
                    {b.finding} finding
                  </span>
                )}
                {b.clean > 0 && (
                  <span className="rounded bg-emerald-500/20 px-1.5 text-emerald-300">
                    {b.clean} clean
                  </span>
                )}
                {b.duplicate > 0 && (
                  <span className="rounded bg-slate-500/20 px-1.5 text-slate-300">
                    {b.duplicate} dup
                  </span>
                )}
                {b.error > 0 && (
                  <span className="rounded bg-red-500/20 px-1.5 text-red-300">{b.error} err</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-sm text-slate-500">
          No agent activity yet. Simulate logs, then wait for the ingestion poller (or click
          Analyze now) to spawn agents.
        </p>
      )}

      {/* Active agents from the latest cycle, with the request messageId each handled. */}
      {live.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
            Agents in the latest cycle ({live.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {live.slice(0, 40).map((a) => (
              <span
                key={a.id}
                title={`${a.kind} · ${a.status}${a.detail ? ` · ${a.detail}` : ''}`}
                className={`rounded-lg px-2 py-1 text-xs ${STATUS_STYLES[a.status]}`}
              >
                <span className="opacity-60">#{a.agentNo}</span>{' '}
                <span className="font-mono">{a.messageId ?? KIND_LABEL[a.kind]}</span>{' '}
                <span className="opacity-70">· {a.status}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Agent history: processed request/ack/response with timestamps. */}
      {activity.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2">agent</th>
                <th className="px-3 py-2">messageId</th>
                <th className="px-3 py-2">kind</th>
                <th className="px-3 py-2">status</th>
                <th className="px-3 py-2">REQUEST</th>
                <th className="px-3 py-2">ACK</th>
                <th className="px-3 py-2">RESPONSE</th>
                <th className="px-3 py-2">ackCode</th>
                <th className="px-3 py-2">agent&nbsp;ms</th>
                <th className="px-3 py-2">when</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {activity.slice(0, 60).map((a) => (
                <tr key={a.id} className="border-b border-edge/50">
                  <td className="px-3 py-1.5 text-slate-500">#{a.agentNo}</td>
                  <td className="px-3 py-1.5">{a.messageId ?? '—'}</td>
                  <td className="px-3 py-1.5 text-slate-400">{KIND_LABEL[a.kind]}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLES[a.status]}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">{clock(a.requestTs)}</td>
                  <td className="px-3 py-1.5">
                    {clock(a.ackTs)}
                    {a.ackTs && a.requestTs ? (
                      <span className="ml-1 text-slate-600">{gap(a.requestTs, a.ackTs)}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    {clock(a.responseTs)}
                    {a.responseTs && a.requestTs ? (
                      <span className="ml-1 text-slate-600">{gap(a.requestTs, a.responseTs)}</span>
                    ) : null}
                  </td>
                  <td
                    className={`px-3 py-1.5 ${
                      a.ackCode && /fail|reject|error|nack/i.test(a.ackCode)
                        ? 'text-red-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {a.ackCode ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">{a.durationMs}</td>
                  <td className="px-3 py-1.5 text-slate-500">{ago(a.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {activity.length > 60 && (
            <div className="px-3 py-2 text-xs text-slate-500">
              …and {activity.length - 60} more agent runs
            </div>
          )}
        </div>
      )}
    </section>
  );
}

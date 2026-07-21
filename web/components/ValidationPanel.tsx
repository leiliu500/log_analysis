'use client';

import type { ValidationAgent } from '@log/shared';

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

const RESULT_STYLES: Record<string, string> = {
  success: 'bg-emerald-500/20 text-emerald-300',
  failure: 'bg-red-500/20 text-red-300',
  pending: 'bg-sky-500/20 text-sky-300',
};

/** A protocol phase progress pip (mirrors AgentsPanel so the two views read alike). */
function Pip({ label, state }: { label: string; state: 'done' | 'idle' }) {
  const styles = {
    done: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
    idle: 'border-edge bg-panel text-slate-600',
  }[state];
  const mark = state === 'done' ? '✓' : '·';
  return (
    <div className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1 ${styles}`}>
      <span className="text-sm font-semibold">{mark}</span>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </div>
  );
}

/** One active (pending) validation agent — shadows an in-flight regular agent. */
function ValidationCard({ v }: { v: ValidationAgent }) {
  const overdue = v.slaBreached;
  return (
    <div className={`rounded-xl border bg-panel p-3 ${overdue ? 'border-amber-600/70' : 'border-sky-700/60'}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={`flex items-center gap-1.5 text-xs ${overdue ? 'text-amber-300' : 'text-sky-300'}`}>
          <span className={`h-2 w-2 animate-pulse rounded-full ${overdue ? 'bg-amber-400' : 'bg-sky-400'}`} />
          {overdue ? 'response overdue' : 'validation pending'}
        </span>
        <span className="text-[11px] text-slate-500">{ago(v.spawnedAt)}</span>
      </div>
      <div className="mb-2 truncate font-mono text-sm text-white" title={v.messageId}>
        {v.messageId}
      </div>
      {v.phases.length > 0 && (
        <div
          className="mb-2 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, v.phases.length)}, minmax(0, 1fr))` }}
        >
          {v.phases.map((p) => (
            <Pip key={p} label={p.toLowerCase()} state={v.phaseTs?.[p] !== undefined ? 'done' : 'idle'} />
          ))}
        </div>
      )}
      <div className={`text-[11px] ${overdue ? 'text-amber-300' : 'text-slate-400'}`}>
        {v.detail ?? 'awaiting close to validate'}
        {v.slaBudgetMinutes != null ? (
          <span className="text-slate-600"> · SLA {v.slaBudgetMinutes}m from {v.slaFromPhase}</span>
        ) : null}
      </div>
    </div>
  );
}

export function ValidationPanel({
  active,
  history,
  correlationLabel = 'messageId',
}: {
  active: ValidationAgent[];
  history: ValidationAgent[];
  /** What this application calls its correlation id (scp: messageId, apiflc: correlationID). */
  correlationLabel?: string;
}) {
  const failures = history.filter((v) => v.result === 'failure').length;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Active Validation Agents</h2>
        <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">{active.length}</span>
        <span className="text-xs text-slate-500">
          one validation agent per in-flight transaction — pending until the agent closes
        </span>
      </div>

      {active.length > 0 ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {active.map((v) => (
            <ValidationCard key={v.messageId} v={v} />
          ))}
        </div>
      ) : (
        <p className="mb-6 text-sm text-slate-500">
          No active validation agents. They shadow active ingestion agents — simulate an incomplete
          transaction so an agent stays active and a pending validation agent appears here.
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Validation History</h2>
        <span className="text-xs text-slate-500">{history.length} validated</span>
        {failures > 0 ? (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300">
            {failures} failure{failures === 1 ? '' : 's'}
          </span>
        ) : history.length > 0 ? (
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">all consistent</span>
        ) : null}
      </div>
      {history.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2">{correlationLabel}</th>
                <th className="px-3 py-2">agent status</th>
                <th className="px-3 py-2">result</th>
                <th className="px-3 py-2">phases</th>
                <th className="px-3 py-2">SLA</th>
                <th className="px-3 py-2">expected</th>
                <th className="px-3 py-2">actual</th>
                <th className="px-3 py-2">delta</th>
                <th className="px-3 py-2">validated</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {history.slice(0, 60).map((v) => (
                <tr key={v.messageId} className="border-b border-edge/50">
                  <td className="px-3 py-1.5">{v.messageId}</td>
                  <td className="px-3 py-1.5 text-slate-400">{v.agentStatus}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 ${RESULT_STYLES[v.result] ?? 'bg-slate-500/20 text-slate-300'}`}>
                      {v.result}
                    </span>
                  </td>
                  <td className={`px-3 py-1.5 ${v.missingPhases.length ? 'text-red-400' : 'text-slate-400'}`}>
                    {v.missingPhases.length ? `missing ${v.missingPhases.join(', ')}` : 'complete'}
                  </td>
                  <td className={`px-3 py-1.5 ${v.slaBreached ? 'text-red-400' : 'text-slate-400'}`}>
                    {v.responseLatencyMs != null
                      ? `${Math.round(v.responseLatencyMs / 60_000)}m${v.slaBudgetMinutes != null ? `/${v.slaBudgetMinutes}m` : ''}`
                      : v.slaBudgetMinutes != null
                        ? `≤${v.slaBudgetMinutes}m`
                        : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">
                    {v.expectedFinding ? `finding · ${v.expectedSeverity}` : 'no finding'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">
                    {v.actualFinding ? `finding · ${v.actualSeverity ?? '—'}` : 'no finding'}
                  </td>
                  <td className={`px-3 py-1.5 font-sans ${v.delta.length ? 'text-red-400' : 'text-slate-500'}`}>
                    {v.delta.length ? v.delta.join('; ') : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{v.closedAt ? clock(v.closedAt) : ago(v.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > 60 && (
            <div className="px-3 py-2 text-xs text-slate-500">…and {history.length - 60} more</div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No validated agents yet.</p>
      )}
    </section>
  );
}

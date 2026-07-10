'use client';

import type { PollerRun } from '@log/shared';

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

const TRIGGER_STYLES: Record<string, string> = {
  schedule: 'bg-sky-500/20 text-sky-300',
  manual: 'bg-violet-500/20 text-violet-300',
};

/** Per-source "cloudwatch:3 · splunk:0" breakdown (all-applications view only). */
function sourceBreakdown(r: PollerRun): string {
  const entries = Object.entries(r.bySource);
  if (!entries.length) return '';
  return entries.map(([s, v]) => `${s}:${v.parsed}`).join(' · ');
}

interface Metrics {
  parsed: number;
  findings: number;
  spawned: number;
  advanced: number;
  closed: number;
}

/** The run's metrics for the selected application (or the totals for "all"). */
function metricsFor(r: PollerRun, app: string): Metrics {
  if (app === 'all') {
    const parsed = Object.values(r.bySource).reduce((n, s) => n + s.parsed, 0);
    return {
      parsed,
      findings: r.findings,
      spawned: r.agents.spawned,
      advanced: r.agents.advanced,
      closed: r.agents.closed,
    };
  }
  const b = r.byApplication?.[app];
  return b
    ? { parsed: b.parsed, findings: b.findings, spawned: b.spawned, advanced: b.advanced, closed: b.closed }
    : { parsed: 0, findings: 0, spawned: 0, advanced: 0, closed: 0 };
}

export function ScheduleTab({ runs, appFilter = 'all' }: { runs: PollerRun[]; appFilter?: string }) {
  const rows = runs.map((r) => ({ r, m: metricsFor(r, appFilter) }));
  const lastScheduled = runs.find((r) => r.trigger === 'schedule');
  const totalParsed = rows.reduce((n, { m }) => n + m.parsed, 0);
  const totalFindings = rows.reduce((n, { m }) => n + m.findings, 0);
  const scope = appFilter === 'all' ? 'all applications' : appFilter;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Schedule Activity</h2>
        <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">
          {runs.length} run{runs.length === 1 ? '' : 's'}
        </span>
        <span className="rounded-full bg-edge px-2 py-0.5 text-xs text-slate-300">{scope}</span>
        <span className="text-xs text-slate-500">
          EventBridge triggers the ingestion poller every ~5 min. Numbers below are scoped to the
          selected application; “Analyze now” shows as a{' '}
          <span className="text-violet-300">manual</span> trigger.
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card text-center">
          <div className="text-2xl font-semibold text-white">{runs.length}</div>
          <div className="text-xs uppercase text-slate-400">runs shown</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-semibold text-white">{totalParsed}</div>
          <div className="text-xs uppercase text-slate-400">logs parsed</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-semibold text-white">{totalFindings}</div>
          <div className="text-xs uppercase text-slate-400">findings</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-semibold text-white">
            {lastScheduled ? ago(lastScheduled.ranAt) : '—'}
          </div>
          <div className="text-xs uppercase text-slate-400">last scheduled</div>
        </div>
      </div>

      {runs.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2">time</th>
                <th className="px-3 py-2">trigger</th>
                <th className="px-3 py-2">window</th>
                <th className="px-3 py-2">parsed</th>
                <th className="px-3 py-2">agents (spawn/adv/close)</th>
                <th className="px-3 py-2">findings</th>
                <th className="px-3 py-2">pruned</th>
                <th className="px-3 py-2">duration</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {rows.map(({ r, m }) => (
                <tr key={r.id} className="border-b border-edge/50">
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {clock(r.ranAt)} <span className="text-slate-600">· {ago(r.ranAt)}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 ${TRIGGER_STYLES[r.trigger] ?? 'bg-slate-500/20 text-slate-300'}`}>
                      {r.trigger}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">{r.windowMinutes}m</td>
                  <td className="px-3 py-1.5">
                    {m.parsed}
                    {appFilter === 'all' && sourceBreakdown(r) ? (
                      <span className="ml-1 font-sans text-slate-600">({sourceBreakdown(r)})</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    {m.spawned}/{m.advanced}/{m.closed}
                  </td>
                  <td className={`px-3 py-1.5 ${m.findings ? 'text-amber-300' : ''}`}>{m.findings}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.pruned}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.durationMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          No scheduled runs recorded yet. The poller records a row each cycle (~5 min); use
          “Analyze now” to trigger one immediately.
        </p>
      )}
    </section>
  );
}

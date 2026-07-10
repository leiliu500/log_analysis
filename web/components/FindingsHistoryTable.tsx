'use client';

import type { Finding } from '@log/shared';

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

const SEV: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300',
  high: 'bg-orange-500/20 text-orange-300',
  medium: 'bg-yellow-500/20 text-yellow-300',
  low: 'bg-sky-500/20 text-sky-300',
  info: 'bg-slate-500/20 text-slate-300',
};

/** Findings & anomaly history, rendered as a compact table (vs the recent cards). */
export function FindingsHistoryTable({ findings }: { findings: Finding[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr className="border-b border-edge">
            <th className="px-3 py-2">time</th>
            <th className="px-3 py-2">severity</th>
            <th className="px-3 py-2">app</th>
            <th className="px-3 py-2">kind</th>
            <th className="px-3 py-2">title</th>
            <th className="px-3 py-2">sources</th>
            <th className="px-3 py-2">conf</th>
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {findings.slice(0, 200).map((f) => (
            <tr key={f.id} className="border-b border-edge/50 align-top">
              <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                {clock(f.createdAt)} <span className="text-slate-600">· {ago(f.createdAt)}</span>
              </td>
              <td className="px-3 py-1.5">
                <span className={`rounded px-1.5 py-0.5 uppercase ${SEV[f.severity] ?? SEV.info}`}>
                  {f.severity}
                </span>
              </td>
              <td className="px-3 py-1.5 text-slate-400">{f.application ?? '—'}</td>
              <td className="px-3 py-1.5 text-slate-400">{f.kind}</td>
              <td className="max-w-md px-3 py-1.5" title={f.summary}>
                <div className="truncate text-white">{f.title}</div>
                <div className="truncate text-slate-500">{f.summary}</div>
              </td>
              <td className="px-3 py-1.5 text-slate-400">{f.sources.join(', ') || '—'}</td>
              <td className="px-3 py-1.5 text-slate-500">{(f.confidence * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {findings.length > 200 && (
        <div className="px-3 py-2 text-xs text-slate-500">…and {findings.length - 200} more</div>
      )}
    </div>
  );
}

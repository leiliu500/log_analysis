'use client';

import { useMemo, useState } from 'react';
import type { BacktestSummary, CaseSummary, FailureMode, Metrics } from '@log/shared';

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Colour per failure mode — matches the semantics used across the validation UI. */
const MODE_STYLES: Record<string, string> = {
  clean: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  'false-positive': 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  'false-negative': 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  hallucination: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40',
};

const RESULT_STYLES: Record<string, string> = {
  success: 'text-emerald-300',
  completed_with_issues: 'text-amber-300',
  failure: 'text-red-300',
  pending: 'text-sky-300',
};

function Kpi({ label, value, tone = 'default', hint }: { label: string; value: string; tone?: 'default' | 'good' | 'bad'; hint?: string }) {
  const valueCls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : 'text-white';
  return (
    <div className="rounded-xl border border-edge bg-panel px-4 py-3" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}

/** A metrics table (overall / per-app / per-mode). */
function MetricsTable({ title, rows }: { title: string; rows: Array<{ label: string; m: Metrics }> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
      <div className="border-b border-edge px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">{title}</div>
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr className="border-b border-edge">
            <th className="px-3 py-2">group</th>
            <th className="px-3 py-2 text-right">n</th>
            <th className="px-3 py-2 text-right">FP</th>
            <th className="px-3 py-2 text-right">FN</th>
            <th className="px-3 py-2 text-right">prec</th>
            <th className="px-3 py-2 text-right">recall</th>
            <th className="px-3 py-2 text-right">F1</th>
          </tr>
        </thead>
        <tbody className="font-mono text-slate-300">
          {rows.map(({ label, m }) => (
            <tr key={label} className="border-b border-edge/50">
              <td className="px-3 py-1.5 font-sans">{label}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{m.total}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${m.falsePositives ? 'text-red-400' : 'text-slate-500'}`}>{m.falsePositives}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${m.falseNegatives ? 'text-red-400' : 'text-slate-500'}`}>{m.falseNegatives}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{pct(m.precision)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{pct(m.recall)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{pct(m.f1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModeBadge({ mode }: { mode: FailureMode }) {
  return <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] ${MODE_STYLES[mode] ?? MODE_STYLES.clean}`}>{mode}</span>;
}

function CaseRow({ c }: { c: CaseSummary }) {
  const ok = c.resultMatched && c.deltaMatched !== false;
  return (
    <tr className={`border-b border-edge/50 ${ok ? '' : 'bg-red-500/5'}`}>
      <td className="px-3 py-1.5">
        {ok ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
      </td>
      <td className="px-3 py-1.5"><ModeBadge mode={c.mode} /></td>
      <td className="px-3 py-1.5 text-slate-400">{c.app}</td>
      <td className="px-3 py-1.5 font-sans text-slate-200">{c.name.replace(/^\w+:\s*/, '')}</td>
      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px]">
        <span className={RESULT_STYLES[c.expected]}>{c.expected}</span>
        <span className="text-slate-600"> → </span>
        <span className={`${RESULT_STYLES[c.actual]} ${c.resultMatched ? '' : 'underline decoration-red-500'}`}>{c.actual}</span>
      </td>
      <td className="px-3 py-1.5">
        {c.delta.length ? (
          <div className="flex flex-wrap gap-1">
            {c.delta.map((d, i) => (
              <span key={i} title={d} className="cursor-help whitespace-nowrap rounded border border-slate-600/50 bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                {d.split(':')[0]}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        )}
        {c.deltaMatched === false && (
          <div className="mt-0.5 text-[10px] text-red-400">expected delta {c.expectDelta} not emitted</div>
        )}
      </td>
    </tr>
  );
}

export function BacktestPanel({ summary }: { summary: BacktestSummary }) {
  const [appFilter, setAppFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');
  const [failuresOnly, setFailuresOnly] = useState(false);

  const apps = useMemo(() => [...new Set(summary.cases.map((c) => c.app))].sort(), [summary]);
  const modes = useMemo(() => [...new Set(summary.cases.map((c) => c.mode))].sort(), [summary]);

  const shown = summary.cases.filter(
    (c) =>
      (appFilter === 'all' || c.app === appFilter) &&
      (modeFilter === 'all' || c.mode === modeFilter) &&
      (!failuresOnly || !(c.resultMatched && c.deltaMatched !== false)),
  );

  const m = summary.overall;

  return (
    <div className="space-y-6">
      {/* Verdict banner */}
      <div className={`rounded-xl border p-4 ${summary.passed ? 'border-emerald-600/50 bg-emerald-500/10' : 'border-red-600/50 bg-red-500/10'}`}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">{summary.passed ? '✅' : '❌'}</span>
          <div>
            <div className={`text-lg font-semibold ${summary.passed ? 'text-emerald-300' : 'text-red-300'}`}>
              {summary.passed ? 'PASS — engine reproduced every human label' : 'FAIL — the engine diverged from the gold set'}
            </div>
            <div className="text-sm text-slate-400">
              {m.total} cases · {m.falsePositives} false positive{m.falsePositives === 1 ? '' : 's'} · {m.falseNegatives} false negative
              {m.falseNegatives === 1 ? '' : 's'} · ran {new Date(summary.ranAt).toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Cases" value={String(m.total)} />
        <Kpi label="Correct" value={`${m.correct}/${m.total}`} tone={m.correct === m.total ? 'good' : 'bad'} />
        <Kpi label="False Pos" value={String(m.falsePositives)} tone={m.falsePositives ? 'bad' : 'good'} hint="Engine flagged a clean-labelled transaction" />
        <Kpi label="False Neg" value={String(m.falseNegatives)} tone={m.falseNegatives ? 'bad' : 'good'} hint="Engine passed a problem-labelled transaction" />
        <Kpi label="Precision" value={pct(m.precision)} tone={m.precision === 1 ? 'good' : 'bad'} />
        <Kpi label="Recall" value={pct(m.recall)} tone={m.recall === 1 ? 'good' : 'bad'} />
      </div>

      {/* Metrics breakdowns */}
      <div className="grid gap-4 lg:grid-cols-2">
        <MetricsTable title="By application" rows={Object.entries(summary.byApp).sort().map(([label, mm]) => ({ label, m: mm }))} />
        <MetricsTable title="By failure mode" rows={Object.entries(summary.byMode).sort().map(([label, mm]) => ({ label, m: mm }))} />
      </div>

      {/* Per-case review */}
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-white">Cases</h2>
          <span className="text-xs text-slate-500">{shown.length} shown</span>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} className="accent-red-500" />
              failures only
            </label>
            <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)} className="rounded-md border border-edge bg-panel px-2 py-1 text-slate-200" title="Filter by application">
              <option value="all">All apps</option>
              {apps.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} className="rounded-md border border-edge bg-panel px-2 py-1 text-slate-200" title="Filter by failure mode">
              <option value="all">All modes</option>
              {modes.map((mm) => (
                <option key={mm} value={mm}>{mm}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2"> </th>
                <th className="px-3 py-2">mode</th>
                <th className="px-3 py-2">app</th>
                <th className="px-3 py-2">case</th>
                <th className="px-3 py-2">expected → actual</th>
                <th className="px-3 py-2">deltas</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <CaseRow key={c.name} c={c} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-slate-500">No cases match the filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

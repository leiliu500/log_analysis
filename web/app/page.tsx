'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Finding } from '@log/shared';
import { api } from '../lib/api';
import { FindingCard } from '../components/FindingCard';

const ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

type Analysis = { bySource: Record<string, { parsed: number; findings: number }>; pruned: number };

export default function Dashboard() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  // Each load asks the API to re-run the Analysis Agent over the latest logs
  // from every source, then returns the current findings.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.findings();
      setFindings(r.findings);
      setAnalysis(r.analysis);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function clearAll() {
    if (clearing) return;
    setClearing(true);
    try {
      await api.clearFindings();
      setFindings([]);
      setAnalysis(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [findings]);

  const totalParsed = analysis
    ? Object.values(analysis.bySource).reduce((n, s) => n + s.parsed, 0)
    : undefined;

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Findings & Anomalies</h1>
        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? 'Analyzing…' : 'Re-analyze'}
          </button>
          <button
            onClick={() => void clearAll()}
            disabled={clearing || loading}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-slate-300 hover:bg-edge disabled:opacity-50"
          >
            {clearing ? 'Clearing…' : 'Clear findings'}
          </button>
        </div>
      </div>
      <p className="mb-4 text-sm text-slate-400">
        Every load triggers the Supervisor → Analysis Agent to process the latest logs across all
        sources (parse · detect anomalies · reason · learn) and report current findings.
      </p>

      {analysis && (
        <div className="mb-6 text-xs text-slate-500">
          Analyzed {totalParsed ?? 0} log(s) across{' '}
          {Object.entries(analysis.bySource)
            .map(([s, v]) => `${s}:${v.parsed}`)
            .join(' · ') || 'no sources'}
          {analysis.pruned ? ` · pruned ${analysis.pruned} stale` : ''}
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ORDER.map((s) => (
          <div key={s} className="card text-center">
            <div className="text-2xl font-semibold text-white">{counts[s] ?? 0}</div>
            <div className="text-xs uppercase text-slate-400">{s}</div>
          </div>
        ))}
      </div>

      {loading && <p className="text-slate-400">Running analysis across all sources…</p>}
      {error && (
        <p className="text-red-400">
          Could not reach API ({error}). Is <code>@log/api</code> running on :4000?
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
      </div>
      {!loading && !error && findings.length === 0 && (
        <p className="text-slate-400">
          No findings. Recent logs show no anomalies — trigger the Simulator to generate some.
        </p>
      )}
    </div>
  );
}

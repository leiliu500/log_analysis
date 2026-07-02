'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Finding } from '@log/shared';
import { api } from '../lib/api';
import { FindingCard } from '../components/FindingCard';

const ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export default function Dashboard() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .findings()
      .then((r) => setFindings(r.findings))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [findings]);

  return (
    <div className="p-8">
      <h1 className="mb-1 text-2xl font-semibold text-white">Findings & Anomalies</h1>
      <p className="mb-6 text-sm text-slate-400">
        Cross-source analysis, inference, reasoning & learning results.
      </p>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ORDER.map((s) => (
          <div key={s} className="card text-center">
            <div className="text-2xl font-semibold text-white">{counts[s] ?? 0}</div>
            <div className="text-xs uppercase text-slate-400">{s}</div>
          </div>
        ))}
      </div>

      {loading && <p className="text-slate-400">Loading findings…</p>}
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
          No findings yet. Run <code>npm run db:seed</code> or trigger the Simulator.
        </p>
      )}
    </div>
  );
}

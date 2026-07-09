'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Finding, Agent } from '@log/shared';
import { api } from '../lib/api';
import { FindingCard } from '../components/FindingCard';
import { AgentsPanel } from '../components/AgentsPanel';

const ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

type Analysis = {
  bySource: Record<string, { parsed: number; spawned?: number; findings: number }>;
  pruned: number;
};

const REFRESH_MS = 30_000;

export default function Dashboard() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | undefined>();
  const [activeAgents, setActiveAgents] = useState<Agent[]>([]);
  const [agentHistory, setAgentHistory] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Read current findings + agent activity. Both are produced by the scheduled
  // ingestion poller (agentic analysis) — `analyze=false` just reads them.
  // `analyze=true` is the explicit "Analyze now" override.
  const refresh = useCallback(async (analyze: boolean) => {
    setError(null);
    try {
      const [f, a] = await Promise.all([api.findings(analyze), api.agents()]);
      setFindings(f.findings);
      if (f.analysis) setAnalysis(f.analysis);
      setActiveAgents(a.active);
      setAgentHistory(a.history);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Initial read + silent auto-refresh so the Dashboard reflects each poll cycle.
  useEffect(() => {
    void refresh(false).finally(() => setLoading(false));
    const id = setInterval(() => void refresh(false), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function analyzeNow() {
    if (analyzing) return;
    setAnalyzing(true);
    await refresh(true);
    setAnalyzing(false);
  }

  async function clearAll() {
    if (clearing) return;
    setClearing(true);
    try {
      await api.clearFindings();
      setFindings([]);
      setAnalysis(undefined);
      setActiveAgents([]);
      setAgentHistory([]);
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
  const totalSpawned = analysis
    ? Object.values(analysis.bySource).reduce((n, s) => n + (s.spawned ?? 0), 0)
    : undefined;

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Ingestion & Agent Dashboard</h1>
        <div className="flex gap-2">
          <button
            onClick={() => void analyzeNow()}
            disabled={analyzing || loading}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {analyzing ? 'Analyzing…' : 'Analyze now'}
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
        Findings are produced by the scheduled ingestion poller — agentic analysis spawns one
        agent per ingested request (parse · detect anomalies · reason · learn). This view
        auto-refreshes every {REFRESH_MS / 1000}s. Use <b>Analyze now</b> to run analysis
        immediately instead of waiting for the next poll.
      </p>

      {analysis && (
        <div className="mb-6 text-xs text-slate-500">
          Analyzed {totalParsed ?? 0} log(s)
          {totalSpawned ? ` · spawned ${totalSpawned} agent(s)` : ''} across{' '}
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

      {loading && <p className="text-slate-400">Loading current findings…</p>}
      {error && (
        <p className="text-red-400">
          Could not reach API ({error}). Is <code>@log/api</code> running on :4000?
        </p>
      )}

      {!loading && <AgentsPanel active={activeAgents} history={agentHistory} />}

      <h2 className="mb-3 text-lg font-semibold text-white">Findings & Anomalies</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
      </div>
      {!loading && !error && findings.length === 0 && (
        <p className="text-slate-400">
          No findings yet. Either recent logs show no anomalies, or the next ingestion poll
          hasn’t run — use the Simulator to generate logs, then wait for the poller (or click
          Analyze now).
        </p>
      )}
    </div>
  );
}

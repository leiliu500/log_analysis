'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Finding, Agent, PollerRun } from '@log/shared';
import { api } from '../lib/api';
import { FindingCard } from '../components/FindingCard';
import { AgentsPanel } from '../components/AgentsPanel';
import { ScheduleTab } from '../components/ScheduleTab';

const ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

type Analysis = {
  bySource: Record<string, { parsed: number; findings: number }>;
  agents?: { spawned: number; advanced: number; closed: number; findings: number };
  pruned: number;
};

type TabKey = 'agents' | 'findings' | 'schedule';

const REFRESH_MS = 30_000;

export default function Dashboard() {
  const [tab, setTab] = useState<TabKey>('agents');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | undefined>();
  const [activeAgents, setActiveAgents] = useState<Agent[]>([]);
  const [agentHistory, setAgentHistory] = useState<Agent[]>([]);
  const [schedule, setSchedule] = useState<PollerRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  // Read current findings + agent activity + schedule history. All are produced
  // by the scheduled ingestion poller; `analyze=false` just reads them.
  // `analyze=true` is the explicit "Analyze now" override.
  const refresh = useCallback(async (analyze: boolean) => {
    setError(null);
    try {
      const [f, a, s] = await Promise.all([api.findings(analyze), api.agents(), api.schedule()]);
      setFindings(f.findings);
      if (f.analysis) setAnalysis(f.analysis);
      setActiveAgents(a.active);
      setAgentHistory(a.history);
      setSchedule(s.runs);
    } catch (e) {
      setError(String(e));
    }
  }, []);

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

  // Full database reset: findings + logs + agents + schedule history.
  async function cleanupDb() {
    if (cleaning) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete ALL findings, logs, agents, and schedule history?')) {
      return;
    }
    setCleaning(true);
    try {
      await api.clearAllData();
      setFindings([]);
      setAnalysis(undefined);
      setActiveAgents([]);
      setAgentHistory([]);
      setSchedule([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
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
  const totalSpawned = analysis?.agents?.spawned;

  const tabs: { key: TabKey; label: string; badge: number }[] = [
    { key: 'agents', label: 'Agents', badge: activeAgents.length },
    { key: 'findings', label: 'Findings & Anomalies', badge: findings.length },
    { key: 'schedule', label: 'Schedule', badge: schedule.length },
  ];

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Ingestion &amp; Agent Dashboard</h1>
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
          <button
            onClick={() => void cleanupDb()}
            disabled={cleaning || loading}
            className="rounded-lg border border-red-800/60 bg-red-900/20 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/40 disabled:opacity-50"
            title="Delete all findings, logs, agents, and schedule history"
          >
            {cleaning ? 'Cleaning…' : 'Clean up DB'}
          </button>
        </div>
      </div>
      <p className="mb-4 text-sm text-slate-400">
        The scheduled ingestion poller runs agentic analysis (parse · detect anomalies · reason ·
        learn) plus the request/ack/response agent lifecycle. This view auto-refreshes every{' '}
        {REFRESH_MS / 1000}s. Use <b>Analyze now</b> to run a cycle immediately.
      </p>

      {analysis && (
        <div className="mb-4 text-xs text-slate-500">
          Last analysis: {totalParsed ?? 0} log(s)
          {totalSpawned ? ` · spawned ${totalSpawned} agent(s)` : ''} across{' '}
          {Object.entries(analysis.bySource)
            .map(([s, v]) => `${s}:${v.parsed}`)
            .join(' · ') || 'no sources'}
          {analysis.pruned ? ` · pruned ${analysis.pruned} stale` : ''}
        </div>
      )}

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 border-b border-edge">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-sky-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs ${
                tab === t.key ? 'bg-sky-500/20 text-sky-300' : 'bg-edge text-slate-500'
              }`}
            >
              {t.badge}
            </span>
          </button>
        ))}
      </div>

      {loading && <p className="text-slate-400">Loading dashboard…</p>}
      {error && (
        <p className="mb-4 text-red-400">
          Could not reach API ({error}). Is <code>@log/api</code> running?
        </p>
      )}

      {!loading && tab === 'agents' && (
        <AgentsPanel active={activeAgents} history={agentHistory} />
      )}

      {!loading && tab === 'findings' && (
        <section>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {ORDER.map((s) => (
              <div key={s} className="card text-center">
                <div className="text-2xl font-semibold text-white">{counts[s] ?? 0}</div>
                <div className="text-xs uppercase text-slate-400">{s}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {findings.map((f) => (
              <FindingCard key={f.id} f={f} />
            ))}
          </div>
          {!error && findings.length === 0 && (
            <p className="text-slate-400">
              No findings yet. Either recent logs show no anomalies, or the next ingestion poll
              hasn’t run — use the Simulator to generate logs, then wait for the poller (or click
              Analyze now).
            </p>
          )}
        </section>
      )}

      {!loading && tab === 'schedule' && <ScheduleTab runs={schedule} />}
    </div>
  );
}

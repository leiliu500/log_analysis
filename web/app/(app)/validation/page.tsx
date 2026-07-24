'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ValidationAgent } from '@log/shared';
import { api } from '@/lib/api';
import { ValidationPanel } from '@/components/ValidationPanel';

const REFRESH_MS = 30_000;

/** Applications known to the platform (shown even before they have data). */
const KNOWN_APPS = ['scp', 'apiflc'] as const;

/** What each application calls its correlation id — app-specific column header. */
const CORRELATION_LABELS: Record<string, string> = { scp: 'messageId', apiflc: 'correlationID' };

export default function ValidationPage() {
  const [appFilter, setAppFilter] = useState<string>('all');
  const [active, setActive] = useState<ValidationAgent[]>([]);
  const [history, setHistory] = useState<ValidationAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const v = await api.validationAgents();
      setActive(v.active);
      setHistory(v.history);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function validateNow() {
    if (validating) return;
    setValidating(true);
    try {
      await api.validateNow();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setValidating(false);
    }
  }

  // Application filter. Show known apps + any seen in validation data.
  const apps = useMemo(() => {
    const s = new Set<string>(KNOWN_APPS);
    for (const v of [...active, ...history]) if (v.application) s.add(v.application);
    return [...s].sort();
  }, [active, history]);

  const byApp = <T extends { application?: string }>(items: T[]): T[] =>
    appFilter === 'all' ? items : items.filter((i) => i.application === appFilter);

  const shownActive = byApp(active);
  const shownHistory = byApp(history);

  const failures = shownHistory.filter((v) => v.result === 'failure').length;
  const issues = shownHistory.filter((v) => v.result === 'completed_with_issues').length;
  const suppressed = shownHistory.filter((v) => v.result === 'success' && v.qualityFindings.length > 0).length;

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Validation Agents</h1>
        <button
          onClick={() => void validateNow()}
          disabled={validating || loading}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {validating ? 'Validating…' : 'Validate now'}
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-400">
        Autonomous validation agents shadow the ingestion agents 1:1 and continuously prove, per
        application, that every transaction is consistent — the finding/level invariant (failed →
        high, timeout → medium; completed → none), phase completeness, the response SLA, the terminal
        outcome re-derived from the raw logs (status-vs-reality), evidence completeness, and
        app-specific rules (e.g. SCP REQUEST→ACK→RESPONSE ordering + duplicate-phase integrity). Any
        discrepancy is a colour-coded delta below. Runs in a separate poller from ingestion; this
        view auto-refreshes every {REFRESH_MS / 1000}s.
      </p>

      {/* Result summary + application filter */}
      <div className="mb-6 flex items-center justify-between border-b border-edge pb-3">
        <div className="flex items-center gap-2 text-sm">
          {loading ? (
            <span className="text-slate-500">Loading…</span>
          ) : failures > 0 ? (
            <span className="rounded-md bg-red-500/20 px-2 py-1 text-red-300">
              Validation failure — {failures} inconsistent transaction{failures === 1 ? '' : 's'}
            </span>
          ) : issues > 0 ? (
            <span className="rounded-md bg-amber-500/20 px-2 py-1 text-amber-300">
              Completed with issues — {issues} transaction{issues === 1 ? '' : 's'} have high/critical findings
            </span>
          ) : (
            <span className="rounded-md bg-emerald-500/20 px-2 py-1 text-emerald-300">
              Validation success — no delta
            </span>
          )}
          <span className="text-xs text-slate-500">
            {shownActive.length} pending · {shownHistory.length} validated
          </span>
          {suppressed > 0 && (
            <span
              className="rounded-md bg-slate-500/20 px-2 py-1 text-xs text-slate-300"
              title="Completed cleanly but carried an associated finding below the app's issue threshold — recorded, not flagged."
            >
              {suppressed} suppressed
            </span>
          )}
        </div>
        <label className="mb-1 flex items-center gap-2 text-xs text-slate-400">
          Application
          <select
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
            className="rounded-md border border-edge bg-panel px-2 py-1 text-sm text-slate-200"
            title="Filter validation agents by application"
          >
            <option value="all">All applications</option>
            {apps.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="mb-4 text-red-400">
          Could not reach API ({error}). Is <code>@log/api</code> running?
        </p>
      )}

      {!loading && (
        <ValidationPanel
          active={shownActive}
          history={shownHistory}
          correlationLabel={appFilter === 'all' ? 'id' : CORRELATION_LABELS[appFilter] ?? 'messageId'}
        />
      )}
    </div>
  );
}

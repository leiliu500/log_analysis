'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BacktestSummary } from '@log/shared';
import { api } from '@/lib/api';
import { BacktestPanel } from '@/components/BacktestPanel';

/**
 * Validation Backtest page — trigger the hand-labelled gold-set corpus through the
 * real validation engine and review the false-positive / false-negative /
 * hallucination results. Runs on demand (the same corpus is also a CI gate).
 */
export default function BacktestPage() {
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const s = await api.runBacktest();
      setSummary(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  // Run once on first load so the page isn't empty.
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Validation Backtest</h1>
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run backtest'}
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-400">
        Replays a hand-labelled gold-set corpus through the <em>real</em> validation engine — the exact code the deployed
        validation poller runs — and scores it with a confusion matrix. This is the measurement that turns
        &ldquo;no hallucination / no false positives / no false negatives&rdquo; into a bounded, monitored number.
      </p>

      {/* Run-status line — always reflects the latest run, independent of the panel below. */}
      <div className="mb-4 text-sm">
        {running && <span className="text-sky-300">● Running the corpus…</span>}
        {!running && error && <span className="text-red-300">✗ {error}</span>}
        {!running && !error && summary && (
          <span className={summary.passed ? 'text-emerald-300' : 'text-red-300'}>
            {summary.passed ? '✓ PASS' : '✗ FAIL'} — {summary.overall.total} cases · {summary.overall.falsePositives} FP · {summary.overall.falseNegatives} FN · ran{' '}
            {new Date(summary.ranAt).toLocaleTimeString()}
          </span>
        )}
        {!running && !error && !summary && <span className="text-slate-500">No results yet — click &ldquo;Run backtest&rdquo;.</span>}
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-red-600/40 bg-red-500/10 px-3 py-2 text-red-300">
          Could not run the backtest ({error}). Is <code>@log/api</code> reachable at the configured API base URL?
        </p>
      )}

      {summary && <BacktestPanel summary={summary} />}

      {/* Raw JSON fallback — always available for inspection / if the panel can't render. */}
      {summary && (
        <details className="mt-6">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Raw result (JSON)</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-edge bg-panel p-3 text-[11px] text-slate-300">
            {JSON.stringify(summary, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

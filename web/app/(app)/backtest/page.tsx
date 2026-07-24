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
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setSummary(await api.runBacktest());
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [running]);

  // Run once on first load so the page isn't empty.
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <p className="mb-6 text-sm text-slate-400">
        Replays a hand-labelled gold-set corpus through the <em>real</em> validation engine — the exact code the deployed
        validation poller runs — and scores it with a confusion matrix. This is the measurement that turns
        &ldquo;no hallucination / no false positives / no false negatives&rdquo; into a bounded, monitored number. Each
        case is tagged with the failure mode it guards against; a green run means the engine reproduced every human label.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-600/40 bg-red-500/10 px-3 py-2 text-red-300">
          Could not run the backtest ({error}). Is <code>@log/api</code> reachable?
        </p>
      )}

      {!summary && running && <p className="text-slate-500">Running the corpus…</p>}
      {!summary && !running && !error && <p className="text-slate-500">No results yet — click &ldquo;Run backtest&rdquo;.</p>}
      {summary && <BacktestPanel summary={summary} />}
    </div>
  );
}

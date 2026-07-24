'use client';

import { useState } from 'react';
import { DashboardView } from '@/components/DashboardView';
import { ValidationView } from '@/components/ValidationView';
import { BacktestView } from '@/components/BacktestView';

/**
 * The main workspace — Dashboard, Validation, and Backtest consolidated into three
 * top-level tabs. Each tab's content is its own self-contained view component (also
 * still reachable at /validation and /backtest for deep links). Switching tabs
 * mounts the active view, so its polling/state starts fresh and the others don't run
 * in the background.
 */
const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'validation', label: 'Validation' },
  { key: 'backtest', label: 'Backtest' },
] as const;
type TopTab = (typeof TABS)[number]['key'];

export default function Workspace() {
  const [tab, setTab] = useState<TopTab>('dashboard');

  return (
    <div>
      <div className="flex gap-1 border-b border-edge bg-panel/40 px-8 pt-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              tab === t.key ? 'border-sky-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardView />}
      {tab === 'validation' && <ValidationView />}
      {tab === 'backtest' && <BacktestView />}
    </div>
  );
}

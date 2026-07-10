/**
 * A record of one scheduled-ingestion run (the EventBridge poller invoking
 * analyzeAllSources every ~5 minutes), or an on-demand "Analyze now". Powers the
 * dashboard's Schedule tab — a timeline of what each trigger did.
 */
export type PollerTrigger = 'schedule' | 'manual';

export interface PollerRun {
  id: string;
  /** When the run started (epoch ms). */
  ranAt: number;
  /** 'schedule' = EventBridge cron; 'manual' = dashboard "Analyze now". */
  trigger: PollerTrigger;
  windowMinutes: number;
  durationMs: number;
  /** Per source: logs parsed and findings produced. */
  bySource: Record<string, { parsed: number; findings: number }>;
  /** Request/ack/response agent-lifecycle activity for this run. */
  agents: { spawned: number; advanced: number; closed: number; findings: number };
  /** Total findings produced this run (log/correlation + agent lifecycle). */
  findings: number;
  /** Stale rows pruned this run. */
  pruned: number;
  /**
   * Per-application breakdown of this run, so the dashboard can scope the
   * Schedule tab to a selected application (e.g. scp vs apiflc).
   */
  byApplication?: Record<
    string,
    { parsed: number; findings: number; spawned: number; advanced: number; closed: number }
  >;
}

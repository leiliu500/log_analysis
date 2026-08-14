/**
 * A record of one scheduled-ingestion run (the EventBridge poller invoking
 * analyzeAllSources every ~5 minutes), or an on-demand "Analyze now". Powers the
 * dashboard's Schedule tab — a timeline of what each trigger did.
 */
export type PollerTrigger = 'schedule' | 'manual';

/** One real component invocation in an ingestion execution. */
export interface ExecutionTraceStep {
  id: string;
  sequence: number;
  component: string;
  name: string;
  status: 'completed' | 'skipped' | 'deferred' | 'error';
  startedAt: number;
  completedAt: number;
  durationMs: number;
  source?: string;
  application?: string;
  correlationId?: string;
  /** API agents are highlighted in the dashboard. */
  agent?: {
    kind: 'api' | 'anomaly' | 'lifecycle';
    name: string;
    execution: 'model' | 'deterministic' | 'deferred' | 'timeout';
    /** Exact runtime model id. Absent only when no model was invoked. */
    model?: string;
    /** Agent/model-reported confidence, normalized to 0..1. */
    confidence?: number;
  };
  /** Exact structured facts recorded by the component; raw secrets are never copied. */
  details?: Record<string, unknown>;
  error?: string;
}

export interface ExecutionTraceValidation {
  status: 'passed' | 'failed';
  checkedAt: number;
  checks: number;
  violations: Array<{ code: string; message: string; stepId?: string }>;
}

export interface PollerRun {
  id: string;
  /** When the run started (epoch ms). */
  ranAt: number;
  /** 'schedule' = EventBridge cron; 'manual' = dashboard "Analyze now". */
  trigger: PollerTrigger;
  windowMinutes: number;
  durationMs: number;
  /** Per source: logs parsed and anomalies produced. */
  bySource: Record<string, { parsed: number; anomalies: number }>;
  /** Request/ack/response agent-lifecycle activity for this run. */
  agents: { spawned: number; advanced: number; closed: number; anomalies: number };
  /** Total anomalies produced this run (log/correlation + agent lifecycle). */
  anomalies: number;
  /** Stale rows pruned this run. */
  pruned: number;
  /**
   * Per-stage wall clock for this poll (ingest, lifecycle) plus the lifecycle's
   * fastPathed / reasoned / deferredOverCap split. Lets a slow poll be attributed to a
   * phase, and makes the model's share of ingestion an observable number.
   */
  stages?: Record<string, number>;
  /** Complete ordered component path, including parallel branches and agent calls. */
  trace?: ExecutionTraceStep[];
  /** Defensive integrity verdict computed from the completed trace before persistence. */
  traceValidation?: ExecutionTraceValidation;
  /**
   * Per-application breakdown of this run, so the dashboard can scope the
   * Schedule tab to a selected application (e.g. scp vs apiflc).
   */
  byApplication?: Record<
    string,
    { parsed: number; anomalies: number; spawned: number; advanced: number; closed: number }
  >;
}

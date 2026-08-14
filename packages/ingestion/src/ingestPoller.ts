/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and dispatches AGENTIC processing:
 * one autonomous agent is dynamically spawned per ingested request (correlated
 * transaction) / error signature / correlation, fanned out concurrently.
 * This is the always-on path that keeps anomalies fresh (requirements 2-6).
 */
import { randomUUID } from 'node:crypto';
import { dispatchAgentic, advanceAgents } from '@log/analysis';
import type { ParsedLog, PollerTrigger, Anomaly, PollerRun, ExecutionTraceStep } from '@log/shared';
import { allConnectors } from './source/index.js';
import { pruneAnomaliesOlderThan, insertPollerRun } from '@log/db';
import { applicationRegistry } from '@log/applications';
import { validateExecutionTrace } from './executionTrace.js';

function traceStep(
  trace: ExecutionTraceStep[],
  step: Omit<ExecutionTraceStep, 'id' | 'sequence' | 'completedAt' | 'durationMs'>,
): void {
  const completedAt = Date.now();
  trace.push({ ...step, id: randomUUID(), sequence: 0, completedAt, durationMs: Math.max(0, completedAt - step.startedAt) });
}

export interface AnalyzeOptions {
  windowMinutes?: number;
  /** Anomalies older than this are removed so the dashboard stays current. */
  anomaliesTtlMinutes?: number;
  /** Override the agent inactivity timeout (else INGEST_AGENT_TIMEOUT_MINUTES/30). */
  agentTimeoutMinutes?: number;
  /** What triggered this run — recorded for the Schedule tab. Default 'schedule'. */
  trigger?: PollerTrigger;
}

export interface AnalyzeResult {
  /** Per source: logs parsed and non-transaction anomalies produced. */
  bySource: Record<string, { parsed: number; anomalies: number }>;
  /** The request/ack/response agent lifecycle result for this poll. */
  agents: { spawned: number; advanced: number; closed: number; anomalies: number };
  pruned: number;
}

/**
 * Pull a recent window of logs from every source, run agentic processing per
 * source (parse → persist → non-transaction anomalies), then advance the
 * request/ack/response agent lifecycle ONCE for the whole poll. The lifecycle
 * runs even on an idle poll (no new logs) so stuck agents still time out and
 * report a Anomaly. Shared by the scheduled poller and the dashboard refresh.
 */
export async function analyzeAllSources(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const trace: ExecutionTraceStep[] = [];
  const connectors = allConnectors();
  const windowMinutes = opts.windowMinutes ?? 5;
  const windowMs = windowMinutes * 60_000;
  // Anomalies are RETAINED as history (like the agent history) rather than expired
  // after the short recent-window. Only anomalies older than the history TTL are
  // pruned; the dashboard splits them into "recent (in window)" vs "history".
  const ttlMinutes =
    opts.anomaliesTtlMinutes ?? Number(process.env.FINDINGS_HISTORY_TTL_MINUTES ?? 1440);
  const since = Date.now() - windowMs;
  const bySource: Record<string, { parsed: number; anomalies: number }> = {};
  traceStep(trace, {
    component: 'poller.trigger', name: 'Start ingestion execution', status: 'completed',
    startedAt, details: { runId, trigger: opts.trigger ?? 'schedule', windowMinutes, since, sources: connectors.map((c) => c.source) },
  });

  let pruned = 0;
  const pruneStarted = Date.now();
  try {
    pruned = await pruneAnomaliesOlderThan(Date.now() - ttlMinutes * 60_000);
    traceStep(trace, {
      component: 'retention.anomalies', name: 'Prune expired anomalies', status: 'completed',
      startedAt: pruneStarted, details: { ttlMinutes, pruned },
    });
  } catch (err) {
    traceStep(trace, {
      component: 'retention.anomalies', name: 'Prune expired anomalies', status: 'error',
      startedAt: pruneStarted, error: (err as Error).message, details: { ttlMinutes },
    });
    console.error('prune anomalies failed', err);
  }

  // Per source: parse/persist + non-transaction anomalies. Collect all parsed
  // logs so the lifecycle sees every source's request/ack/response messages.
  const allParsed: ParsedLog[] = [];
  const sourceAnomalies: Anomaly[] = [];
  // Per-stage wall clock. A poll that gets slow otherwise reports only a total, which
  // says nothing about WHICH phase regressed — pull/parse, the agent lifecycle, or the
  // bookkeeping. These are recorded on the run so the Telemetry tab can attribute it.
  const stages: Record<string, number> = {};
  const ingestStart = Date.now();
  await Promise.all(
    connectors.map(async (connector) => {
      const pullStarted = Date.now();
      const sourceTrace: ExecutionTraceStep[] = [];
      try {
        const records = await connector.pull({ since, limit: 5000 });
        traceStep(trace, {
          component: 'connector.pull', name: `Pull ${connector.source} logs`, status: 'completed',
          startedAt: pullStarted, source: connector.source, details: { since, limit: 5000, records: records.length },
        });
        if (!records.length) {
          bySource[connector.source] = { parsed: 0, anomalies: 0 };
          traceStep(trace, {
            component: 'source.complete', name: `Complete ${connector.source} branch`, status: 'completed',
            startedAt: pullStarted, source: connector.source, details: { records: 0, parsed: 0, anomalies: 0 },
          });
          return;
        }
        const result = await dispatchAgentic(records, { windowMs, registry: applicationRegistry, trace: sourceTrace });
        allParsed.push(...result.parsed);
        sourceAnomalies.push(...result.anomalies);
        bySource[connector.source] = { parsed: result.parsed.length, anomalies: result.anomalies.length };
        traceStep(trace, {
          component: 'source.complete', name: `Complete ${connector.source} branch`, status: 'completed',
          startedAt: pullStarted, source: connector.source,
          details: { records: records.length, parsed: result.parsed.length, anomalies: result.anomalies.length, agentOutcomes: result.outcomes.length },
        });
      } catch (err) {
        if (!trace.some((s) => s.component === 'connector.pull' && s.source === connector.source)) {
          traceStep(trace, {
            component: 'connector.pull', name: `Pull ${connector.source} logs`, status: 'error',
            startedAt: pullStarted, source: connector.source, error: (err as Error).message,
            details: { since, limit: 5000 },
          });
        }
        traceStep(trace, {
          component: 'source.complete', name: `Complete ${connector.source} branch`, status: 'error',
          startedAt: pullStarted, source: connector.source, error: (err as Error).message,
          details: { parsed: 0, anomalies: 0 },
        });
        console.error(`ingest ${connector.source} failed`, err);
        bySource[connector.source] = { parsed: 0, anomalies: 0 };
      } finally {
        trace.push(...sourceTrace);
      }
    }),
  );

  stages.ingest = Date.now() - ingestStart;

  // Advance the agent lifecycle exactly once per poll — ALWAYS, even when
  // allParsed is empty, so timeouts fire on idle polls and report Anomalies.
  const lifecycleStart = Date.now();
  let agents = { spawned: 0, advanced: 0, closed: 0, anomalies: 0 };
  let lifecycleSplit = { fastPathed: 0, reasoned: 0, deferredOverCap: 0 };
  let lifeByApp: Record<string, { spawned: number; advanced: number; closed: number; anomalies: number }> = {};
  const lifecycleTrace: ExecutionTraceStep[] = [];
  try {
    const timeoutMs =
      opts.agentTimeoutMinutes != null ? opts.agentTimeoutMinutes * 60_000 : undefined;
    const life = await advanceAgents(allParsed, applicationRegistry, {
      windowMs,
      timeoutMs,
      anomaliesTtlMs: ttlMinutes * 60_000,
      trace: lifecycleTrace,
    });
    agents = {
      spawned: life.spawned,
      advanced: life.advanced,
      closed: life.closed,
      anomalies: life.anomalies.length,
    };
    lifeByApp = life.byApplication;
    // The fast-path vs reasoned split was computed every poll and never persisted, so the
    // one number that says whether the model is back on the ingestion critical path was
    // invisible outside a log line. Recorded now.
    lifecycleSplit = {
      fastPathed: life.fastPathed ?? 0,
      reasoned: life.reasoned ?? 0,
      deferredOverCap: life.deferredOverCap ?? 0,
    };
  } catch (err) {
    traceStep(trace, {
      component: 'lifecycle.advance', name: 'Advance transaction-agent lifecycle', status: 'error',
      startedAt: lifecycleStart, error: (err as Error).message,
      details: { parsedLogs: allParsed.length },
    });
    console.error('agent lifecycle advance failed', err);
  }
  trace.push(...lifecycleTrace);
  stages.lifecycle = Date.now() - lifecycleStart;

  // Per-application breakdown for the Schedule tab (parsed by log group, anomalies
  // + agent lifecycle activity per app).
  const byApplication: NonNullable<PollerRun['byApplication']> = {};
  const bucket = (id: string) =>
    (byApplication[id] ??= { parsed: 0, anomalies: 0, spawned: 0, advanced: 0, closed: 0 });
  for (const l of allParsed) {
    const id = applicationRegistry.forLog(l)?.id;
    if (id) bucket(id).parsed += 1;
  }
  for (const f of sourceAnomalies) if (f.application) bucket(f.application).anomalies += 1;
  for (const [id, c] of Object.entries(lifeByApp)) {
    const b = bucket(id);
    b.spawned += c.spawned;
    b.advanced += c.advanced;
    b.closed += c.closed;
    b.anomalies += c.anomalies;
  }

  // Persist the run and its defensive trace. This is mandatory: silently succeeding
  // without an audit/validation record would defeat the trace's line-of-defense role.
  const anomaliesTotal =
    Object.values(bySource).reduce((n, s) => n + s.anomalies, 0) + agents.anomalies;
  const aggregateStarted = Date.now();
  traceStep(trace, {
    component: 'run.aggregate', name: 'Aggregate and reconcile execution totals',
    status: 'completed', startedAt: aggregateStarted,
    details: { bySource, byApplication, agents, anomalies: anomaliesTotal, pruned, lifecycleSplit },
  });
  trace.sort((a, b) =>
    a.startedAt - b.startedAt || a.completedAt - b.completedAt || a.id.localeCompare(b.id),
  );
  trace.forEach((step, index) => {
    step.sequence = index + 1;
  });
  const traceValidation = validateExecutionTrace(trace, {
    sources: connectors.map((connector) => connector.source),
    bySource,
    agents,
    lifecycleSplit,
  });
  if (traceValidation.status === 'failed') {
    console.error('ingestion execution trace validation failed', { runId, violations: traceValidation.violations });
  }
  try {
    await insertPollerRun({
      id: runId,
      ranAt: startedAt,
      trigger: opts.trigger ?? 'schedule',
      windowMinutes,
      durationMs: Date.now() - startedAt,
      bySource,
      byApplication,
      agents,
      anomalies: anomaliesTotal,
      pruned,
      stages: { ...stages, ...(lifecycleSplit ?? {}) },
      trace,
      traceValidation,
    });
  } catch (err) {
    console.error('record poller run failed', err);
    throw err;
  }

  return { bySource, agents, pruned };
}

/** EventBridge entry point — the always-on scheduled analysis. */
export async function handler(event: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeAllSources(event);
}

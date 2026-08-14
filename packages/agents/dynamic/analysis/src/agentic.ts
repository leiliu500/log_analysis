import { randomUUID } from 'node:crypto';
import type { Anomaly, ParsedLog, RawLogRecord, Severity, ApplicationRegistry, ExecutionTraceStep } from '@log/shared';
import { insertParsedLogs, insertAnomaly, insertAlert, anomalyExistsByFingerprint } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed, modelIds } from './bedrock.js';
import { detectLogAnomalies } from './anomalies.js';

/**
 * Agentic ingestion. Two concerns per poll cycle:
 *
 * Handles the NON-transaction anomalies: one ephemeral agent per error signature
 * and per cross-source correlation reasons about it (LLM) and persists a Anomaly.
 * It also parses + persists the window and returns the parsed logs so the caller
 * can drive the request/ack/response agent lifecycle once per poll (advanceAgents).
 */
export interface AgenticOptions {
  /** Optional live sink so partial component history survives a branch failure. */
  trace?: ExecutionTraceStep[];
  /** Sliding window used for rate/anomaly math + correlation. */
  windowMs?: number;
  /** Embed each parsed log for semantic search (costly at high volume). */
  embedLogs?: boolean;
  /** Max concurrent anomaly-agents — bounds concurrent Bedrock calls. */
  concurrency?: number;
  /** Hard cap on anomaly-agents per run (backstop against a flood). */
  maxAgents?: number;
  /** Application registry; transaction messages are excluded from the anomaly path. */
  registry?: ApplicationRegistry;
}

export type AgentUnitKind = 'error' | 'correlation';
export type AgentStatus = 'anomaly' | 'duplicate' | 'error';

/** What one ephemeral anomaly-agent did with its cluster. */
export interface AgentOutcome {
  kind: AgentUnitKind;
  key: string;
  label: string;
  status: AgentStatus;
  severity?: Severity;
  anomalyId?: string;
  error?: string;
}

export interface AgenticResult {
  /** Parsed logs from this source's window (caller drives the lifecycle). */
  parsed: ParsedLog[];
  outcomes: AgentOutcome[];
  anomalies: Anomaly[];
  /** Every component and anomaly-agent invocation executed for this source branch. */
  trace: ExecutionTraceStep[];
}

/** Alertable severities mirror the bulk pipeline. */
const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];
/** Suppress re-reporting the same fingerprint within this window. */
const DEDUP_WINDOW_MS = 30 * 60_000;

function addTrace(
  trace: ExecutionTraceStep[],
  step: Omit<ExecutionTraceStep, 'id' | 'sequence' | 'completedAt' | 'durationMs'> & {
    completedAt?: number;
  },
): void {
  const completedAt = step.completedAt ?? Date.now();
  trace.push({
    ...step,
    id: randomUUID(),
    sequence: 0,
    completedAt,
    durationMs: Math.max(0, completedAt - step.startedAt),
  });
}

/** A non-transaction anomaly unit: one error signature or one correlation. */
export type AgentUnit = { kind: AgentUnitKind; cluster: Cluster };

/**
 * Non-transaction anomaly units (pure — no DB / model calls, so it is
 * unit-testable): one per error signature and per multi-source correlation.
 * Transactions are NOT here — they flow through the request/ack/response
 * lifecycle (advanceAgents), not the ephemeral anomaly path.
 */
export function planAgentUnits(
  parsed: ParsedLog[],
  opts: { windowMs?: number; registry?: ApplicationRegistry } = {},
): AgentUnit[] {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const units: AgentUnit[] = [];
  for (const cluster of detectLogAnomalies(parsed, opts.registry)) units.push({ kind: 'error', cluster });
  for (const cluster of correlate(parsed, windowMs).filter((c) => c.sources.length >= 2)) {
    units.push({ kind: 'correlation', cluster });
  }
  return units;
}

interface AgentCtx {
  dedupSince: number;
  /** Fingerprints claimed this run (in-memory guard against concurrent dup work). */
  claimed: Set<string>;
  alert: (f: Anomaly) => Promise<boolean>;
  registry?: ApplicationRegistry;
  source: string;
  trace: ExecutionTraceStep[];
}

function unitKey(unit: AgentUnit): { key: string; label: string } {
  const c = unit.cluster;
  return { key: c.logs[0]?.fingerprint ?? c.key, label: `${unit.kind} ${c.key}` };
}

/** One ephemeral anomaly-agent: claim → dedup → reason → persist. Never throws. */
async function runAgent(unit: AgentUnit, ctx: AgentCtx): Promise<{ outcome: AgentOutcome; anomaly?: Anomaly }> {
  const { key, label } = unitKey(unit);
  const application = ctx.registry?.forLog(unit.cluster.logs[0]!)?.id;
  if (ctx.claimed.has(key)) {
    const ts = Date.now();
    addTrace(ctx.trace, {
      component: 'anomaly-agent.deduplicate', name: `Deduplicate ${label}`, status: 'skipped',
      startedAt: ts, source: ctx.source, application,
      details: { key, reason: 'already claimed by a parallel agent in this execution' },
    });
    return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
  }
  ctx.claimed.add(key);
  const agentStarted = Date.now();
  try {
    const dedupStarted = Date.now();
    const duplicate = await anomalyExistsByFingerprint(key, ctx.dedupSince);
    addTrace(ctx.trace, {
      component: 'anomaly-agent.deduplicate', name: `Check anomaly fingerprint ${key}`,
      status: duplicate ? 'skipped' : 'completed', startedAt: dedupStarted,
      source: ctx.source, application, details: { key, dedupSince: ctx.dedupSince, duplicate },
    });
    if (duplicate) {
      return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
    }
    const reasonStarted = Date.now();
    const anomaly = await reasonAboutCluster(unit.cluster);
    anomaly.application = application;
    addTrace(ctx.trace, {
      component: 'api-agent.reason', name: `${application ?? 'platform'} API agent: ${label}`,
      status: 'completed', startedAt: reasonStarted, source: ctx.source, application,
      agent: {
        kind: 'api', name: `${application ?? 'platform'} anomaly API agent`, execution: 'model',
        model: modelIds.MODEL_ID, confidence: anomaly.confidence,
      },
      details: {
        unitKind: unit.kind, key, clusterLogs: unit.cluster.logs.length,
        sources: unit.cluster.sources, anomalyId: anomaly.id, severity: anomaly.severity,
        evidenceLogIds: anomaly.evidence.map((e) => e.logId), embeddingGenerated: !!anomaly.embedding,
      },
    });
    const persistStarted = Date.now();
    await insertAnomaly(anomaly);
    addTrace(ctx.trace, {
      component: 'persistence.anomaly', name: `Persist anomaly ${anomaly.id}`,
      status: 'completed', startedAt: persistStarted, source: ctx.source, application,
      details: { anomalyId: anomaly.id, fingerprint: anomaly.fingerprint },
    });
    const alertStarted = Date.now();
    const alerted = await ctx.alert(anomaly);
    addTrace(ctx.trace, {
      component: 'alert.dispatch', name: alerted ? 'Create dashboard alert' : 'Alert threshold check',
      status: alerted ? 'completed' : 'skipped', startedAt: alertStarted,
      source: ctx.source, application,
      details: { anomalyId: anomaly.id, severity: anomaly.severity, alerted },
    });
    return {
      outcome: { kind: unit.kind, key, label, status: 'anomaly', severity: anomaly.severity, anomalyId: anomaly.id },
      anomaly,
    };
  } catch (err) {
    addTrace(ctx.trace, {
      component: 'anomaly-agent.execute', name: `Execute ${label}`,
      status: 'error', startedAt: agentStarted, source: ctx.source, application,
      error: (err as Error).message, details: { key, unitKind: unit.kind },
    });
    return { outcome: { kind: unit.kind, key, label, status: 'error', error: (err as Error).message } };
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parse + persist a source's window and fan out anomaly-agents over its
 * non-transaction anomalies. Returns the parsed logs so the caller can drive the
 * request/ack/response agent lifecycle exactly once per poll.
 */
export async function dispatchAgentic(records: RawLogRecord[], opts: AgenticOptions = {}): Promise<AgenticResult> {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const concurrency = Math.max(1, opts.concurrency ?? Number(process.env.INGEST_AGENT_CONCURRENCY ?? 6));
  const maxAgents = Math.max(1, opts.maxAgents ?? Number(process.env.INGEST_MAX_AGENTS ?? 200));
  const now = Date.now();
  const source = records[0]?.source ?? 'unknown';
  const trace = opts.trace ?? [];

  // --- shared prep: parse → (optional embed) → persist → learn baselines.
  const parseStarted = Date.now();
  const parsed = parseBatch(records);
  addTrace(trace, {
    component: 'parser.batch', name: 'Parse raw log batch', status: 'completed',
    startedAt: parseStarted, source, details: { records: records.length, parsed: parsed.length },
  });
  if (opts.embedLogs) {
    const embedStarted = Date.now();
    await Promise.all(
      parsed.map(async (l) => {
        try {
          l.embedding = await embed(`${l.level} ${l.message}`);
        } catch {
          /* best effort */
        }
      }),
    );
    addTrace(trace, {
      component: 'embedding.logs', name: 'Embed parsed logs', status: 'completed',
      startedAt: embedStarted, source,
      details: { requested: parsed.length, embedded: parsed.filter((l) => !!l.embedding).length, model: modelIds.EMBED_MODEL_ID },
    });
  } else {
    addTrace(trace, {
      component: 'embedding.logs', name: 'Embed parsed logs', status: 'skipped',
      startedAt: Date.now(), source, details: { reason: 'embedLogs disabled' },
    });
  }
  const persistStarted = Date.now();
  await insertParsedLogs(parsed);
  addTrace(trace, {
    component: 'persistence.logs', name: 'Persist parsed logs', status: 'completed',
    startedAt: persistStarted, source, details: { logs: parsed.length },
  });
  const learnStarted = Date.now();
  await scoreAndLearn(parsed, windowMs);
  addTrace(trace, {
    component: 'analysis.learn', name: 'Score and learn baselines', status: 'completed',
    startedAt: learnStarted, source, details: { logs: parsed.length, windowMs },
  });

  const ctx: AgentCtx = {
    dedupSince: now - DEDUP_WINDOW_MS,
    claimed: new Set<string>(),
    alert: async (f) => {
      if (ALERT_SEVERITIES.includes(f.severity)) {
        await insertAlert({
          id: randomUUID(),
          anomalyId: f.id,
          severity: f.severity,
          channel: 'dashboard',
          status: 'pending',
          createdAt: now,
        });
        return true;
      }
      return false;
    },
    registry: opts.registry,
    source,
    trace,
  };

  // Non-transaction anomalies → one anomaly-agent each, bounded fan-out.
  const planStarted = Date.now();
  const planned = planAgentUnits(parsed, { windowMs, registry: opts.registry });
  const units = planned.slice(0, maxAgents);
  addTrace(trace, {
    component: 'analysis.detect', name: 'Detect non-transaction anomalies', status: 'completed',
    startedAt: planStarted, source,
    details: { candidates: planned.filter((u) => u.kind === 'error').length, logs: parsed.length },
  });
  addTrace(trace, {
    component: 'analysis.correlate', name: 'Correlate logs across sources', status: 'completed',
    startedAt: planStarted, source,
    details: { candidates: planned.filter((u) => u.kind === 'correlation').length, windowMs },
  });
  addTrace(trace, {
    component: 'anomaly-agent.fanout', name: 'Plan bounded anomaly-agent fan-out', status: 'completed',
    startedAt: planStarted, source,
    details: { planned: planned.length, dispatched: units.length, deferredByCap: planned.length - units.length, concurrency, maxAgents },
  });
  const settled = await runPool(units, concurrency, (u) => runAgent(u, ctx));
  const outcomes = settled.map((s) => s.outcome);
  const anomalies = settled.map((s) => s.anomaly).filter((f): f is Anomaly => !!f);

  return { parsed, outcomes, anomalies, trace };
}

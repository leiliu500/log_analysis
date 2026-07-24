import { randomUUID } from 'node:crypto';
import type { Anomaly, ParsedLog, RawLogRecord, Severity, ApplicationRegistry } from '@log/shared';
import { insertParsedLogs, insertAnomaly, insertAlert, anomalyExistsByFingerprint } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';
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
}

/** Alertable severities mirror the bulk pipeline. */
const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];
/** Suppress re-reporting the same fingerprint within this window. */
const DEDUP_WINDOW_MS = 30 * 60_000;

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
  alert: (f: Anomaly) => Promise<void>;
  registry?: ApplicationRegistry;
}

function unitKey(unit: AgentUnit): { key: string; label: string } {
  const c = unit.cluster;
  return { key: c.logs[0]?.fingerprint ?? c.key, label: `${unit.kind} ${c.key}` };
}

/** One ephemeral anomaly-agent: claim → dedup → reason → persist. Never throws. */
async function runAgent(unit: AgentUnit, ctx: AgentCtx): Promise<{ outcome: AgentOutcome; anomaly?: Anomaly }> {
  const { key, label } = unitKey(unit);
  if (ctx.claimed.has(key)) {
    return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
  }
  ctx.claimed.add(key);
  try {
    if (await anomalyExistsByFingerprint(key, ctx.dedupSince)) {
      return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
    }
    const anomaly = await reasonAboutCluster(unit.cluster);
    anomaly.application = ctx.registry?.forLog(unit.cluster.logs[0]!)?.id;
    await insertAnomaly(anomaly);
    await ctx.alert(anomaly);
    return {
      outcome: { kind: unit.kind, key, label, status: 'anomaly', severity: anomaly.severity, anomalyId: anomaly.id },
      anomaly,
    };
  } catch (err) {
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

  // --- shared prep: parse → (optional embed) → persist → learn baselines.
  const parsed = parseBatch(records);
  if (opts.embedLogs) {
    await Promise.all(
      parsed.map(async (l) => {
        try {
          l.embedding = await embed(`${l.level} ${l.message}`);
        } catch {
          /* best effort */
        }
      }),
    );
  }
  await insertParsedLogs(parsed);
  await scoreAndLearn(parsed, windowMs);

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
      }
    },
    registry: opts.registry,
  };

  // Non-transaction anomalies → one anomaly-agent each, bounded fan-out.
  const units = planAgentUnits(parsed, { windowMs, registry: opts.registry }).slice(0, maxAgents);
  const settled = await runPool(units, concurrency, (u) => runAgent(u, ctx));
  const outcomes = settled.map((s) => s.outcome);
  const anomalies = settled.map((s) => s.anomaly).filter((f): f is Anomaly => !!f);

  return { parsed, outcomes, anomalies };
}

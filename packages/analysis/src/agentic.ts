import { randomUUID } from 'node:crypto';
import type { Agent, Finding, LogSourceType, ParsedLog, RawLogRecord, Severity } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert, findingExistsByFingerprint } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';
import { detectLogAnomalies } from './anomalies.js';
import { advanceAgents } from './agentLifecycle.js';

/**
 * Agentic ingestion. Two concerns per poll cycle:
 *
 *  1) The request/ack/response LIFECYCLE — advanceAgents() spawns a stateful
 *     agent per REQUEST and advances/closes it as its ACK/RESPONSE arrive (over
 *     one or more cycles). These are the Dashboard's active-agent cards + agent
 *     history.
 *
 *  2) Non-transaction anomalies — one ephemeral agent per error signature and
 *     per cross-source correlation reasons about it (LLM) and persists a Finding.
 */
export interface AgenticOptions {
  /** Sliding window used for rate/anomaly math + correlation. */
  windowMs?: number;
  /** Embed each parsed log for semantic search (costly at high volume). */
  embedLogs?: boolean;
  /** Max concurrent finding-agents — bounds concurrent Bedrock calls. */
  concurrency?: number;
  /** Hard cap on finding-agents per run (backstop against a flood). */
  maxAgents?: number;
  /** Close a still-active lifecycle agent this long after its last activity. */
  agentTimeoutMs?: number;
}

export type AgentUnitKind = 'error' | 'correlation';
export type AgentStatus = 'finding' | 'duplicate' | 'error';

/** What one ephemeral finding-agent did with its cluster. */
export interface AgentOutcome {
  kind: AgentUnitKind;
  key: string;
  label: string;
  status: AgentStatus;
  severity?: Severity;
  findingId?: string;
  error?: string;
}

export interface AgenticResult {
  parsed: number;
  /** Lifecycle agents spawned this cycle (dashboard "spawned"). */
  spawned: number;
  /** Lifecycle agents advanced (ACK ok) this cycle. */
  advanced: number;
  /** Lifecycle agents closed (completed/failed/error) this cycle. */
  closed: number;
  outcomes: AgentOutcome[];
  findings: Finding[];
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
 * lifecycle (advanceAgents), not the ephemeral finding path.
 */
export function planAgentUnits(parsed: ParsedLog[], opts: { windowMs?: number } = {}): AgentUnit[] {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const units: AgentUnit[] = [];
  for (const cluster of detectLogAnomalies(parsed)) units.push({ kind: 'error', cluster });
  for (const cluster of correlate(parsed, windowMs).filter((c) => c.sources.length >= 2)) {
    units.push({ kind: 'correlation', cluster });
  }
  return units;
}

interface AgentCtx {
  dedupSince: number;
  /** Fingerprints claimed this run (in-memory guard against concurrent dup work). */
  claimed: Set<string>;
  alert: (f: Finding) => Promise<void>;
}

function unitKey(unit: AgentUnit): { key: string; label: string } {
  const c = unit.cluster;
  return { key: c.logs[0]?.fingerprint ?? c.key, label: `${unit.kind} ${c.key}` };
}

/** One ephemeral finding-agent: claim → dedup → reason → persist. Never throws. */
async function runAgent(unit: AgentUnit, ctx: AgentCtx): Promise<{ outcome: AgentOutcome; finding?: Finding }> {
  const { key, label } = unitKey(unit);
  if (ctx.claimed.has(key)) {
    return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
  }
  ctx.claimed.add(key);
  try {
    if (await findingExistsByFingerprint(key, ctx.dedupSince)) {
      return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
    }
    const finding = await reasonAboutCluster(unit.cluster);
    await insertFinding(finding);
    await ctx.alert(finding);
    return {
      outcome: { kind: unit.kind, key, label, status: 'finding', severity: finding.severity, findingId: finding.id },
      finding,
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
 * Agentic ingestion entry point: parse + persist the window, advance the
 * request/ack/response agent lifecycle, then fan out finding-agents over the
 * non-transaction anomalies.
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
          findingId: f.id,
          severity: f.severity,
          channel: 'dashboard',
          status: 'pending',
          createdAt: now,
        });
      }
    },
  };

  // --- 1) request/ack/response lifecycle (stateful, persistent across cycles).
  //     Resilient: a missing `agents` table (pre-migration) must not break the
  //     findings path below.
  let life = { spawned: 0, advanced: 0, closed: 0, failures: [] as Agent[] };
  try {
    life = await advanceAgents(parsed, { now, timeoutMs: opts.agentTimeoutMs });
  } catch (err) {
    console.error('agentic: lifecycle advance skipped', (err as Error).message);
  }

  // A terminally failed/errored agent is also an anomaly Finding, so the
  // dashboard severity tiles + Findings list reconcile with Agent History.
  const findings: Finding[] = [];
  for (const agent of life.failures) {
    try {
      const fp = `tx:${agent.messageId}`;
      if (await findingExistsByFingerprint(fp, ctx.dedupSince)) continue;
      const f = agentFailureFinding(agent, now, windowMs);
      await insertFinding(f);
      await ctx.alert(f);
      findings.push(f);
    } catch (err) {
      console.error('agentic: failure finding skipped', (err as Error).message);
    }
  }

  // --- 2) non-transaction anomalies → one finding-agent each, bounded fan-out.
  const units = planAgentUnits(parsed, { windowMs }).slice(0, maxAgents);
  const settled = await runPool(units, concurrency, (u) => runAgent(u, ctx));
  const outcomes = settled.map((s) => s.outcome);
  for (const s of settled) if (s.finding) findings.push(s.finding);

  return {
    parsed: parsed.length,
    spawned: life.spawned,
    advanced: life.advanced,
    closed: life.closed,
    outcomes,
    findings,
  };
}

/** A deterministic Finding for a terminally failed/errored lifecycle agent. */
function agentFailureFinding(a: Agent, now: number, windowMs: number): Finding {
  const failed = a.status === 'failed';
  return {
    id: randomUUID(),
    kind: 'anomaly',
    severity: failed ? 'high' : 'medium',
    title: `Transaction ${a.messageId} ${failed ? 'failed' : 'did not complete'}`,
    summary:
      a.detail ??
      (failed ? `Transaction ${a.messageId} failed.` : `Transaction ${a.messageId} timed out.`),
    confidence: 0.9,
    sources: a.source ? [a.source as LogSourceType] : [],
    fingerprint: `tx:${a.messageId}`,
    evidence: [],
    reasoning: [a.detail ?? (failed ? 'ACK/RESPONSE carried a failure ackCode.' : 'No ACK/RESPONSE received in time.')],
    recommendations: [
      failed
        ? 'Investigate the failed ACK/RESPONSE for this messageId.'
        : 'Check why the ACK/RESPONSE was not received for this messageId.',
    ],
    metadata: {
      messageId: a.messageId,
      agentStatus: a.status,
      ackCode: a.ackCode,
      requestTs: a.requestTs,
      ackTs: a.ackTs,
      responseTs: a.responseTs,
    },
    windowStart: now - windowMs,
    windowEnd: now,
    createdAt: now,
  };
}

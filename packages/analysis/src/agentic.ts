import { randomUUID } from 'node:crypto';
import type { AgentActivity, Finding, ParsedLog, RawLogRecord, Severity } from '@log/shared';
import {
  insertParsedLogs,
  insertFinding,
  insertAlert,
  findingExistsByFingerprint,
  insertAgentActivity,
  pruneAgentActivityOlderThan,
} from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';
import { detectLogAnomalies } from './anomalies.js';
import {
  buildTransactions,
  transactionAnomalies,
  reasonAboutTransaction,
  txMetaOf,
  type Transaction,
} from './transactions.js';

/**
 * Agentic ingestion (replaces the bulk pipeline on the ingest path).
 *
 * Instead of running one monolithic pipeline over the whole batch, this
 * dispatcher splits a freshly-ingested window into independent UNITS OF WORK —
 * one per correlated cashMessage transaction (an ingested "request"), plus one
 * per error signature and per cross-source correlation — and dynamically spawns
 * an autonomous agent for each, running them concurrently under a bounded pool.
 *
 * Each agent owns exactly one request: it triages it, and only when it looks
 * anomalous does it escalate to LLM reasoning + persist a Finding. Healthy
 * requests cost no model call. The number of agents spawned scales with the
 * ingested volume (that is the "dynamic spawn"); `concurrency` bounds how many
 * run at once so Bedrock isn't overrun.
 */
export interface AgenticOptions {
  /** Sliding window used for rate/anomaly math + finding window bounds. */
  windowMs?: number;
  /** Embed each parsed log for semantic search (costly at high volume). */
  embedLogs?: boolean;
  /** Grace period before a request lacking ACK/RESPONSE is flagged (ms). */
  txGraceMs?: number;
  /** Max agents running at once — bounds concurrent Bedrock calls. */
  concurrency?: number;
  /** Hard cap on agents spawned per run (backstop against a flood). */
  maxAgents?: number;
}

export type AgentUnitKind = 'transaction' | 'error' | 'correlation';
export type AgentStatus = 'finding' | 'clean' | 'duplicate' | 'error';

/** What one spawned agent did with its single request/cluster. */
export interface AgentOutcome {
  kind: AgentUnitKind;
  /** Dedup key / request id the agent processed. */
  key: string;
  label: string;
  status: AgentStatus;
  severity?: Severity;
  findingId?: string;
  error?: string;
}

export interface AgenticResult {
  /** The dispatch cycle id — groups the agents spawned this run. */
  batchId: string;
  parsed: number;
  /** Number of per-request agents spawned this run. */
  spawned: number;
  outcomes: AgentOutcome[];
  findings: Finding[];
  /** Per-agent activity records persisted for the dashboard. */
  activity: AgentActivity[];
  counts: Record<AgentStatus, number>;
}

/** Alertable severities mirror the bulk pipeline. */
const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];
/** Suppress re-reporting the same fingerprint within this window. */
const DEDUP_WINDOW_MS = 30 * 60_000;

/**
 * One unit of work = one ingested request (correlated transaction), one error
 * signature, or one cross-source correlation. Each gets its own agent.
 */
export type AgentUnit =
  | { kind: 'transaction'; tx: Transaction; reason?: string }
  | { kind: 'error' | 'correlation'; cluster: Cluster };

export interface PlanOptions {
  windowMs?: number;
  txGraceMs?: number;
  now?: number;
}

/**
 * Split a parsed window into per-request units (pure — no DB / model calls, so
 * it is unit-testable). One transaction unit per ingested REQUEST (with its
 * anomaly reason attached when flagged), plus one unit per error signature and
 * per multi-source correlation. Orphan ACK/RESPONSE with no REQUEST in-window
 * are skipped — they belonged to an earlier request's agent.
 */
export function planAgentUnits(parsed: ParsedLog[], opts: PlanOptions = {}): AgentUnit[] {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const txGraceMs = opts.txGraceMs ?? 60_000;
  const now = opts.now ?? Date.now();

  const units: AgentUnit[] = [];
  const txs = buildTransactions(parsed);
  const reasonById = new Map(transactionAnomalies(txs, txGraceMs, now).map((a) => [a.tx.id, a.reason]));
  for (const tx of txs) {
    if (!tx.types.has('REQUEST')) continue;
    units.push({ kind: 'transaction', tx, reason: reasonById.get(tx.id) });
  }
  for (const cluster of detectLogAnomalies(parsed)) units.push({ kind: 'error', cluster });
  for (const cluster of correlate(parsed, windowMs).filter((c) => c.sources.length >= 2)) {
    units.push({ kind: 'correlation', cluster });
  }
  return units;
}

interface AgentCtx {
  now: number;
  windowMs: number;
  dedupSince: number;
  /** Fingerprints claimed this run (in-memory guard against concurrent dup work). */
  claimed: Set<string>;
  alert: (f: Finding) => Promise<void>;
}

/** Stable dedup key + display label for a unit. */
function unitKey(unit: AgentUnit): { key: string; label: string } {
  if (unit.kind === 'transaction') return { key: `tx:${unit.tx.id}`, label: `tx ${unit.tx.id}` };
  const c = unit.cluster;
  return { key: c.logs[0]?.fingerprint ?? c.key, label: `${unit.kind} ${c.key}` };
}

/**
 * One autonomous agent handling one ingested request/cluster: claim → dedup →
 * reason → persist. Never throws; failures come back as an 'error' outcome so
 * one bad request can't sink the batch.
 */
async function runAgent(
  unit: AgentUnit,
  ctx: AgentCtx,
): Promise<{ outcome: AgentOutcome; finding?: Finding }> {
  const { key, label } = unitKey(unit);
  // Healthy transaction (no anomaly reason) → nothing to persist, no model call.
  if (unit.kind === 'transaction' && !unit.reason) {
    return { outcome: { kind: 'transaction', key, label, status: 'clean' } };
  }
  // Synchronous claim BEFORE any await: two concurrent agents can't both process
  // the same fingerprint (e.g. a log in both an error and a correlation cluster).
  if (ctx.claimed.has(key)) {
    return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
  }
  ctx.claimed.add(key);

  try {
    if (await findingExistsByFingerprint(key, ctx.dedupSince)) {
      return { outcome: { kind: unit.kind, key, label, status: 'duplicate' } };
    }
    const finding =
      unit.kind === 'transaction'
        ? await reasonAboutTransaction(unit.tx, unit.reason!, ctx.now, ctx.windowMs)
        : await reasonAboutCluster(unit.cluster);
    await insertFinding(finding);
    await ctx.alert(finding);
    return {
      outcome: {
        kind: unit.kind,
        key,
        label,
        status: 'finding',
        severity: finding.severity,
        findingId: finding.id,
      },
      finding,
    };
  } catch (err) {
    return {
      outcome: { kind: unit.kind, key, label, status: 'error', error: (err as Error).message },
    };
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight — the bounded pool that
 * caps how many agents (and thus Bedrock calls) execute at once while still
 * spawning one logical agent per item.
 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Agentic ingestion entry point. Parses + persists the window (shared prep),
 * builds the per-request units, then dynamically spawns a bounded fan-out of
 * agents — one per request/cluster — and aggregates their outcomes.
 */
export async function dispatchAgentic(
  records: RawLogRecord[],
  opts: AgenticOptions = {},
): Promise<AgenticResult> {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const txGraceMs = opts.txGraceMs ?? 60_000;
  const concurrency = Math.max(1, opts.concurrency ?? Number(process.env.INGEST_AGENT_CONCURRENCY ?? 6));
  const maxAgents = Math.max(1, opts.maxAgents ?? Number(process.env.INGEST_MAX_AGENTS ?? 200));
  const now = Date.now();

  // --- shared, cheap prep: parse → (optional embed) → persist → learn baselines.
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
  await scoreAndLearn(parsed, windowMs); // keep rate baselines fresh

  // --- build one unit of work per ingested request / error signature / correlation.
  const units = planAgentUnits(parsed, { windowMs, txGraceMs, now });

  const spawnUnits = units.slice(0, maxAgents);
  if (spawnUnits.length < units.length) {
    console.warn(`agentic: capping ${units.length} units -> ${maxAgents} agents this run`);
  }

  const ctx: AgentCtx = {
    now,
    windowMs,
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

  // --- dynamically spawn one agent per unit, bounded by `concurrency`. Each
  //     agent is timed so the dashboard can show its runtime.
  const batchId = randomUUID();
  const settled = await runPool(spawnUnits, concurrency, async (u) => {
    const startedAt = Date.now();
    const r = await runAgent(u, ctx);
    return { ...r, startedAt, finishedAt: Date.now() };
  });

  const outcomes = settled.map((s) => s.outcome);
  const findings = settled.map((s) => s.finding).filter((f): f is Finding => !!f);
  const counts: Record<AgentStatus, number> = { finding: 0, clean: 0, duplicate: 0, error: 0 };
  for (const o of outcomes) counts[o.status] += 1;

  // --- record per-agent activity (dashboard "dynamics"). Resilient: a missing
  //     table (pre-migration) or write error must never break ingestion.
  const activity = spawnUnits.map((u, i) => buildActivity(u, settled[i]!, batchId, i));
  try {
    await insertAgentActivity(activity);
    const ttlMin = Number(process.env.INGEST_ACTIVITY_TTL_MINUTES ?? 1440);
    await pruneAgentActivityOlderThan(now - ttlMin * 60_000);
  } catch (err) {
    console.error('agentic: agent_activity persist skipped', (err as Error).message);
  }

  return { batchId, parsed: parsed.length, spawned: spawnUnits.length, outcomes, findings, activity, counts };
}

interface Settled {
  outcome: AgentOutcome;
  finding?: Finding;
  startedAt: number;
  finishedAt: number;
}

/** First-seen REQUEST/ACK/RESPONSE timestamps + ackCode for a transaction. */
function txTimestamps(tx: Transaction): {
  requestTs?: number;
  ackTs?: number;
  responseTs?: number;
  ackCode?: string;
} {
  const out: { requestTs?: number; ackTs?: number; responseTs?: number; ackCode?: string } = {};
  for (const l of tx.logs) {
    const m = txMetaOf(l);
    if (m.type === 'REQUEST' && out.requestTs === undefined) out.requestTs = l.timestamp;
    else if (m.type === 'ACK' && out.ackTs === undefined) {
      out.ackTs = l.timestamp;
      if (m.ackCode) out.ackCode = m.ackCode;
    } else if (m.type === 'RESPONSE' && out.responseTs === undefined) {
      out.responseTs = l.timestamp;
      if (!out.ackCode && m.ackCode) out.ackCode = m.ackCode;
    }
  }
  if (!out.ackCode && tx.ackCodes.length) out.ackCode = tx.ackCodes[0];
  return out;
}

/** Assemble one persisted activity record for a spawned agent. */
function buildActivity(unit: AgentUnit, s: Settled, batchId: string, agentNo: number): AgentActivity {
  const o = s.outcome;
  const base = {
    id: randomUUID(),
    batchId,
    agentNo,
    kind: o.kind,
    status: o.status,
    severity: o.severity,
    findingId: o.findingId,
    presentTypes: [] as string[],
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    durationMs: Math.max(0, s.finishedAt - s.startedAt),
  };
  if (unit.kind === 'transaction') {
    const t = txTimestamps(unit.tx);
    return {
      ...base,
      messageId: unit.tx.id,
      source: unit.tx.logs[0]?.source,
      logGroup: unit.tx.logs[0]?.stream,
      presentTypes: [...unit.tx.types],
      requestTs: t.requestTs,
      ackTs: t.ackTs,
      responseTs: t.responseTs,
      ackCode: t.ackCode,
      detail: unit.reason ?? o.error,
    };
  }
  return {
    ...base,
    source: unit.cluster.sources[0],
    logGroup: unit.cluster.logs[0]?.stream,
    detail: o.error ?? unit.cluster.reason,
  };
}

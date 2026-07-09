import { randomUUID } from 'node:crypto';
import type { Agent, Finding, LogSourceType, ParsedLog, Severity } from '@log/shared';
import {
  getActiveAgents,
  getAgentsByMessageIds,
  upsertAgents,
  pruneClosedAgentsOlderThan,
  insertFinding,
  insertAlert,
  findingExistsByFingerprint,
} from '@log/db';
import { txMetaOf } from './transactions.js';

/**
 * The stateful ingestion-agent lifecycle. Unlike the ephemeral per-batch model,
 * an agent persists across poll cycles: it is spawned on a REQUEST and stays
 * ACTIVE until it receives a terminal signal, then it closes and moves to
 * history. Driven by the request/ack/response messages ingested each cycle.
 */

const OK_CODES = /^(OK|SUCCESS|PROCESSED_SUCCESSFULLY|ACCEPTED|COMPLETE|COMPLETED)$/i;

/** One correlated message extracted from a parsed log. */
export interface AgentEvent {
  type: 'REQUEST' | 'ACK' | 'RESPONSE';
  corrId: string;
  ts: number;
  ackCode?: string;
  source?: string;
  logGroup?: string;
}

/** Pull the ordered request/ack/response events out of a parsed window. */
export function agentEvents(parsed: ParsedLog[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const l of parsed) {
    const m = txMetaOf(l);
    if (m.type !== 'REQUEST' && m.type !== 'ACK' && m.type !== 'RESPONSE') continue;
    const corrId = m.type === 'REQUEST' ? m.messageId : m.initMessageId;
    if (!corrId) continue;
    out.push({ type: m.type, corrId, ts: l.timestamp, ackCode: m.ackCode, source: l.source, logGroup: l.stream });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface StepOptions {
  now: number;
  /** Close a still-active agent this long after its last activity. */
  timeoutMs: number;
}

export interface StepResult {
  agents: Map<string, Agent>;
  /** messageIds whose agent changed this step (need persisting). */
  changed: Set<string>;
  spawned: number;
  advanced: number;
  closed: number;
}

/**
 * Advance the agent state machine over a batch of events (pure — no DB). Given
 * the currently-known agents (active ones + any matching this window's ids),
 * apply each event and time out stuck agents. Terminal agents are immutable
 * (idempotent across overlapping poll windows).
 */
export function stepAgents(
  events: AgentEvent[],
  known: Agent[],
  opts: StepOptions,
): StepResult {
  const { now, timeoutMs } = opts;
  const agents = new Map<string, Agent>();
  for (const a of known) agents.set(a.messageId, { ...a });
  const changed = new Set<string>();
  let spawned = 0;
  let advanced = 0;
  let closed = 0;

  const close = (a: Agent, status: Agent['status'], detail: string, severity?: string): void => {
    a.status = status;
    a.active = false;
    a.closedAt = now;
    a.detail = detail;
    if (severity) a.severity = severity;
    closed += 1;
  };

  for (const e of events) {
    let a = agents.get(e.corrId);
    if (!a) {
      // Spawn — on a REQUEST, or lazily if an ACK/RESPONSE arrives first (its
      // request was in an earlier, already-aged-out window).
      a = {
        messageId: e.corrId,
        status: 'awaiting_ack',
        active: true,
        source: e.source,
        logGroup: e.logGroup,
        spawnedAt: e.ts,
        updatedAt: now,
      };
      agents.set(e.corrId, a);
      spawned += 1;
      changed.add(e.corrId);
    }
    if (!a.active) continue; // terminal — ignore further events

    if (e.type === 'REQUEST') {
      if (a.requestTs === undefined) a.requestTs = e.ts;
    } else if (e.type === 'ACK') {
      if (a.ackTs === undefined) {
        a.ackTs = e.ts;
        a.ackCode = e.ackCode;
      }
      if (e.ackCode && !OK_CODES.test(e.ackCode)) {
        close(a, 'failed', `ACK failed — ackCode ${e.ackCode}`, 'high');
      } else if (a.status === 'awaiting_ack') {
        a.status = 'awaiting_response';
        a.detail = 'ACK ok — awaiting RESPONSE';
        advanced += 1;
      }
    } else if (e.type === 'RESPONSE') {
      if (a.responseTs === undefined) a.responseTs = e.ts;
      if (e.ackCode && !OK_CODES.test(e.ackCode)) {
        close(a, 'failed', `RESPONSE failed — ackCode ${e.ackCode}`, 'high');
      } else {
        close(a, 'completed', 'RESPONSE received');
      }
    }
    a.updatedAt = now;
    changed.add(e.corrId);
  }

  // Time out agents that have been waiting too long (covers the "or error" path).
  for (const a of agents.values()) {
    if (!a.active) continue;
    const last = a.ackTs ?? a.requestTs ?? a.spawnedAt;
    if (now - last > timeoutMs) {
      const waitingFor = a.status === 'awaiting_response' ? 'RESPONSE' : 'ACK';
      close(a, 'error', `Timed out awaiting ${waitingFor}`, 'medium');
      a.updatedAt = now;
      changed.add(a.messageId);
    }
  }

  return { agents, changed, spawned, advanced, closed };
}

export interface AdvanceResult {
  spawned: number;
  advanced: number;
  closed: number;
  /** Findings minted for agents that closed failed/error this cycle. */
  findings: Finding[];
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];
const FINDING_DEDUP_MS = 30 * 60_000;

/**
 * DB-backed driver — the complete per-poll lifecycle step. Loads the relevant
 * agents (all active + any matching this window's ids), advances the state
 * machine, persists changes, and reports a Finding for every agent that newly
 * closes as failed or errored (timeout). Runs even with no new logs so idle
 * polls still fire timeouts + their Findings.
 */
export async function advanceAgents(
  parsed: ParsedLog[],
  opts: { now?: number; timeoutMs?: number; windowMs?: number } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.INGEST_AGENT_TIMEOUT_MINUTES ?? 30) * 60_000;

  const events = agentEvents(parsed);
  const ids = [...new Set(events.map((e) => e.corrId))];
  const [active, matching] = await Promise.all([
    getActiveAgents(2000),
    ids.length ? getAgentsByMessageIds(ids) : Promise.resolve([] as Agent[]),
  ]);
  const known = new Map<string, Agent>();
  for (const a of [...active, ...matching]) known.set(a.messageId, a);

  const step = stepAgents(events, [...known.values()], { now, timeoutMs });

  const toPersist = [...step.changed].map((id) => step.agents.get(id)!).filter(Boolean);
  await upsertAgents(toPersist);

  // Agents that newly closed as failed/error this cycle → one Finding each.
  const findings: Finding[] = [];
  for (const id of step.changed) {
    const post = step.agents.get(id)!;
    const pre = known.get(id);
    if ((post.status !== 'failed' && post.status !== 'error') || (pre && !pre.active)) continue;
    try {
      const fp = `tx:${post.messageId}`;
      if (await findingExistsByFingerprint(fp, now - FINDING_DEDUP_MS)) continue;
      const f = agentFinding(post, now, windowMs);
      await insertFinding(f);
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
      findings.push(f);
    } catch (err) {
      console.error('agentLifecycle: failure finding skipped', (err as Error).message);
    }
  }

  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  await pruneClosedAgentsOlderThan(now - historyTtlMin * 60_000);

  return { spawned: step.spawned, advanced: step.advanced, closed: step.closed, findings };
}

/** A deterministic Finding for a terminally failed/errored (timed-out) agent. */
function agentFinding(a: Agent, now: number, windowMs: number): Finding {
  const failed = a.status === 'failed';
  return {
    id: randomUUID(),
    kind: 'anomaly',
    severity: failed ? 'high' : 'medium',
    title: `Transaction ${a.messageId} ${failed ? 'failed' : 'did not complete (timeout)'}`,
    summary:
      a.detail ??
      (failed ? `Transaction ${a.messageId} failed.` : `Transaction ${a.messageId} timed out.`),
    confidence: 0.9,
    sources: a.source ? [a.source as LogSourceType] : [],
    fingerprint: `tx:${a.messageId}`,
    evidence: [],
    reasoning: [a.detail ?? (failed ? 'ACK/RESPONSE carried a failure ackCode.' : 'No ACK/RESPONSE received before the timeout.')],
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

import type { Agent, ParsedLog } from '@log/shared';
import { getActiveAgents, getAgentsByMessageIds, upsertAgents, pruneClosedAgentsOlderThan } from '@log/db';
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
}

/**
 * DB-backed driver: load the relevant agents (all active + any matching this
 * window's ids), step the state machine, and persist the changes. Also prunes
 * closed agents older than the history TTL.
 */
export async function advanceAgents(
  parsed: ParsedLog[],
  opts: { now?: number; timeoutMs?: number } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? Date.now();
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

  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  await pruneClosedAgentsOlderThan(now - historyTtlMin * 60_000);

  return { spawned: step.spawned, advanced: step.advanced, closed: step.closed };
}

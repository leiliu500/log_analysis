import { randomUUID } from 'node:crypto';
import type { Agent, Finding, LogSourceType, ParsedLog, Severity, ApplicationRegistry } from '@log/shared';
import {
  getActiveAgents,
  getAgentsByMessageIds,
  upsertAgents,
  pruneClosedAgentsOlderThan,
  insertFinding,
  insertAlert,
  getUnreportedClosedAgents,
} from '@log/db';

/**
 * The stateful ingestion-agent lifecycle. Unlike the ephemeral per-batch model,
 * an agent persists across poll cycles: it is spawned on the initiating message
 * and stays ACTIVE until it receives a terminal signal, then closes and moves to
 * history. The transaction shape (which phases, in what order, and what counts as
 * a success) is supplied by a {@link TransactionProtocol}, so the engine is
 * generic — SCP is REQUEST → ACK → RESPONSE, another app may be REQUEST → RESPONSE.
 */

/** One correlated message extracted from a parsed log. */
export interface AgentEvent {
  /** Protocol phase name (e.g. 'REQUEST' | 'ACK' | 'RESPONSE'). */
  type: string;
  corrId: string;
  ts: number;
  ackCode?: string;
  source?: string;
  logGroup?: string;
  /** Owning application id (which protocol produced this event). */
  application: string;
}

/** Pull the ordered transaction events out of a parsed window, across all apps. */
export function agentEvents(parsed: ParsedLog[], registry: ApplicationRegistry): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const l of parsed) {
    const app = registry.forLog(l);
    if (!app) continue;
    const e = app.protocol.eventOf(l);
    if (!e) continue;
    out.push({
      type: e.type,
      corrId: e.corrId,
      ts: l.timestamp,
      ackCode: e.ackCode,
      source: l.source,
      logGroup: l.stream,
      application: app.id,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface StepOptions {
  now: number;
  /** Close a still-active agent this long after its last activity. */
  timeoutMs: number;
  registry: ApplicationRegistry;
}

export interface AgentCounts {
  spawned: number;
  advanced: number;
  closed: number;
}

export interface StepResult {
  agents: Map<string, Agent>;
  /** messageIds whose agent changed this step (need persisting). */
  changed: Set<string>;
  spawned: number;
  advanced: number;
  closed: number;
  /** Per-application agent counts (application id → counts). */
  byApp: Record<string, AgentCounts>;
}

/**
 * Advance the agent state machine over a batch of events (pure — no DB). Given
 * the currently-known agents (active ones + any matching this window's ids),
 * apply each event per the protocol and time out stuck agents. Terminal agents
 * are immutable (idempotent across overlapping poll windows).
 */
export function stepAgents(events: AgentEvent[], known: Agent[], opts: StepOptions): StepResult {
  const { now, timeoutMs, registry } = opts;
  const protoFor = (appId?: string) => registry.byId(appId)?.protocol;
  const agents = new Map<string, Agent>();
  for (const a of known) {
    agents.set(a.messageId, {
      ...a,
      phaseTs: { ...(a.phaseTs ?? {}) },
      phases: a.phases ?? protoFor(a.application)?.allPhases ?? [],
    });
  }
  const changed = new Set<string>();
  let spawned = 0;
  let advanced = 0;
  let closed = 0;
  const byApp: Record<string, AgentCounts> = {};
  const bump = (app: string | undefined, k: keyof AgentCounts): void => {
    (byApp[app ?? 'unknown'] ??= { spawned: 0, advanced: 0, closed: 0 })[k] += 1;
  };

  const close = (a: Agent, status: Agent['status'], detail: string, severity?: string): void => {
    a.status = status;
    a.active = false;
    a.waitingFor = undefined;
    a.closedAt = now;
    a.detail = detail;
    if (severity) a.severity = severity;
    closed += 1;
    bump(a.application, 'closed');
  };

  for (const e of events) {
    let a = agents.get(e.corrId);
    if (!a) {
      // Spawn — on the initiating message, or lazily if a later phase arrives
      // first (its initiating message was in an earlier, already-aged-out window).
      const sp = protoFor(e.application);
      a = {
        messageId: e.corrId,
        application: e.application,
        status: 'awaiting',
        active: true,
        waitingFor: sp?.phases[0],
        phases: sp?.allPhases ?? [],
        phaseTs: {},
        source: e.source,
        logGroup: e.logGroup,
        spawnedAt: e.ts,
        updatedAt: now,
      };
      agents.set(e.corrId, a);
      spawned += 1;
      bump(a.application, 'spawned');
      changed.add(e.corrId);
    }
    if (!a.active) continue; // terminal — ignore further events

    if (a.phaseTs[e.type] === undefined) a.phaseTs[e.type] = e.ts;
    if (e.ackCode) a.ackCode = e.ackCode;

    // The initiating phase only records its timestamp; the follow-up phases drive
    // the state machine (resolved via the agent's owning application protocol).
    const proto = protoFor(a.application ?? e.application);
    if (proto && e.type !== proto.initial && proto.phases.includes(e.type)) {
      if (e.ackCode && !proto.isSuccess(e.ackCode)) {
        close(a, 'failed', `${e.type} failed — ackCode ${e.ackCode}`, 'high');
      } else {
        const remaining = proto.phases.filter((p) => a!.phaseTs[p] === undefined);
        if (remaining.length === 0) {
          close(a, 'completed', `${e.type} received`);
        } else {
          a.waitingFor = remaining[0];
          a.detail = `${e.type} ok — awaiting ${remaining[0]}`;
          advanced += 1;
          bump(a.application, 'advanced');
        }
      }
    }
    a.updatedAt = now;
    changed.add(e.corrId);
  }

  // Time out agents that have been waiting too long (covers the "or error" path).
  for (const a of agents.values()) {
    if (!a.active) continue;
    const tsVals = Object.values(a.phaseTs);
    const last = tsVals.length ? Math.max(...tsVals) : a.spawnedAt;
    if (now - last > timeoutMs) {
      close(a, 'error', `Timed out awaiting ${a.waitingFor ?? 'next phase'}`, 'medium');
      a.updatedAt = now;
      changed.add(a.messageId);
    }
  }

  return { agents, changed, spawned, advanced, closed, byApp };
}

export interface AdvanceResult {
  spawned: number;
  advanced: number;
  closed: number;
  /** Findings minted for agents that closed failed/error this cycle. */
  findings: Finding[];
  /** Per-application agent counts + minted findings (application id → counts). */
  byApplication: Record<string, AgentCounts & { findings: number }>;
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];

/** The finding's stable identity: one per closed-agent OCCURRENCE. */
export const agentFindingFingerprint = (a: Agent): string => `tx:${a.messageId}:${a.closedAt ?? a.updatedAt}`;

/**
 * DB-backed driver — the complete per-poll lifecycle step. Loads the relevant
 * agents (all active + any matching this window's ids), advances the state
 * machine against the protocol, persists changes, and reports a Finding for every
 * agent in history that closed NOT-completed (failed / error) and has none yet.
 * Runs even with no new logs so idle polls still fire timeouts + their Findings.
 */
export async function advanceAgents(
  parsed: ParsedLog[],
  registry: ApplicationRegistry,
  opts: { now?: number; timeoutMs?: number; windowMs?: number; findingsTtlMs?: number } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.INGEST_AGENT_TIMEOUT_MINUTES ?? 30) * 60_000;
  // Reconcile only within findings retention, so an agent whose finding was pruned
  // isn't recreated (it would churn back every poll). Defaults match the poller.
  const findingsTtlMs =
    opts.findingsTtlMs ?? Number(process.env.FINDINGS_HISTORY_TTL_MINUTES ?? 1440) * 60_000;

  const events = agentEvents(parsed, registry);
  const ids = [...new Set(events.map((e) => e.corrId))];
  const [active, matching] = await Promise.all([
    getActiveAgents(2000),
    ids.length ? getAgentsByMessageIds(ids) : Promise.resolve([] as Agent[]),
  ]);
  const known = new Map<string, Agent>();
  for (const a of [...active, ...matching]) known.set(a.messageId, a);

  const step = stepAgents(events, [...known.values()], { now, timeoutMs, registry });

  const toPersist = [...step.changed].map((id) => step.agents.get(id)!).filter(Boolean);
  await upsertAgents(toPersist);

  // Report every non-completed closed agent lacking a finding — those that closed
  // this poll AND any that slipped through earlier (a fingerprint collision on a
  // reused messageId, a restart, a DB blip). Driven off persisted history rather
  // than only this poll's transitions, so the "not completed ⇒ a finding" property
  // is self-healing. The per-occurrence fingerprint makes each mint idempotent.
  const findings: Finding[] = [];
  const findingsByApp: Record<string, number> = {};
  const unreported = await getUnreportedClosedAgents(now - findingsTtlMs);
  for (const a of unreported) {
    try {
      const f = agentFinding(a, now, windowMs);
      await insertFinding(f);
      findingsByApp[a.application ?? 'unknown'] = (findingsByApp[a.application ?? 'unknown'] ?? 0) + 1;
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

  const byApplication: AdvanceResult['byApplication'] = {};
  const appIds = new Set([...Object.keys(step.byApp), ...Object.keys(findingsByApp)]);
  for (const id of appIds) {
    const c = step.byApp[id] ?? { spawned: 0, advanced: 0, closed: 0 };
    byApplication[id] = { ...c, findings: findingsByApp[id] ?? 0 };
  }

  return { spawned: step.spawned, advanced: step.advanced, closed: step.closed, findings, byApplication };
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
    application: a.application,
    fingerprint: agentFindingFingerprint(a),
    evidence: [],
    reasoning: [
      a.detail ?? (failed ? 'A phase carried a failure ackCode.' : 'A phase was not received before the timeout.'),
    ],
    recommendations: [
      failed
        ? 'Investigate the failed phase for this messageId.'
        : `Check why the ${a.waitingFor ?? 'next phase'} was not received for this messageId.`,
    ],
    metadata: {
      messageId: a.messageId,
      agentStatus: a.status,
      ackCode: a.ackCode,
      waitingFor: a.waitingFor,
      phases: a.phases,
      phaseTs: a.phaseTs,
    },
    windowStart: now - windowMs,
    windowEnd: now,
    createdAt: now,
  };
}

import { randomUUID } from 'node:crypto';
import type { Agent, Anomaly, ApplicationDef, LogSourceType, ParsedLog, Severity, ApplicationRegistry } from '@log/shared';
import { reasonTransition, deterministicDecision, type TransitionDecision } from './reasonTransition.js';
import {
  getActiveAgents,
  getAgentsByMessageIds,
  upsertAgents,
  pruneClosedAgentsOlderThan,
  insertAnomaly,
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
  /** The raw log line — passed to the dynamic (LLM-reasoned) lifecycle so it reasons over actual log text. */
  raw?: string;
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
      raw: l.raw ?? l.message,
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

/** Bounded-concurrency map — runs `fn` over `items`, at most `limit` in flight. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

/** Sum two per-application count maps. */
function mergeByApp(a: Record<string, AgentCounts>, b: Record<string, AgentCounts>): Record<string, AgentCounts> {
  const out: Record<string, AgentCounts> = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src)) {
      const c = (out[k] ??= { spawned: 0, advanced: 0, closed: 0 });
      c.spawned += v.spawned;
      c.advanced += v.advanced;
      c.closed += v.closed;
    }
  }
  return out;
}

/**
 * The DYNAMIC lifecycle step — the LLM-reasoned counterpart of {@link stepAgents} for
 * apps that opt in via `dynamicLifecycle`. Extraction/correlation + phaseTs bookkeeping
 * stay deterministic (the events come from `eventOf`); only the per-transaction state
 * TRANSITION is reasoned from the app's `transaction.md` ({@link reasonTransition}).
 * Timeouts stay a deterministic wall-clock check. Bounded concurrency + a per-poll cap
 * protect the Lambda; beyond the cap (or on any model error) it uses the deterministic
 * decision, so this can never block or corrupt ingestion.
 */
export async function stepAgentsDynamic(
  events: AgentEvent[],
  known: Agent[],
  opts: StepOptions & { reasoner?: Parameters<typeof reasonTransition>[2]; maxLlm?: number; windowLogs?: ParsedLog[] },
): Promise<StepResult> {
  const { now, timeoutMs, registry } = opts;
  const windowLogs = opts.windowLogs ?? [];

  /**
   * The RAW lines of the WHOLE correlated call for a transaction — resolved by the app's
   * cross-log-group join (apiflc's handler + authorizer + gateway) so the LLM can read
   * signals no protocol event carries (the HTTP status lives only in the gateway log).
   * Falls back to the eventOf-correlated lines when the app declares no join.
   */
  const relatedLinesFor = (app: ApplicationDef, id: string): string[] => {
    if (!windowLogs.length) return [];
    const related = app.relatedLogs
      ? app.relatedLogs(id, windowLogs)
      : windowLogs.filter((l) => app.protocol.eventOf(l)?.corrId === id);
    return related.map((l) => l.raw ?? l.message).filter(Boolean);
  };
  const agents = new Map<string, Agent>();
  for (const a of known) {
    agents.set(a.messageId, {
      ...a,
      phaseTs: { ...(a.phaseTs ?? {}) },
      phases: a.phases ?? registry.byId(a.application)?.protocol.allPhases ?? [],
    });
  }
  const changed = new Set<string>();
  const justSpawned = new Set<string>();
  let spawned = 0;
  let advanced = 0;
  let closed = 0;
  const byApp: Record<string, AgentCounts> = {};
  const bump = (app: string | undefined, k: keyof AgentCounts): void => {
    (byApp[app ?? 'unknown'] ??= { spawned: 0, advanced: 0, closed: 0 })[k] += 1;
  };

  // Group new events per transaction; spawn shells + record phaseTs deterministically.
  const byTx = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const arr = byTx.get(e.corrId) ?? [];
    arr.push(e);
    byTx.set(e.corrId, arr);
  }
  const decisions: Array<{ id: string; a: Agent; app: ApplicationDef; evs: AgentEvent[] }> = [];
  for (const [id, evs] of byTx) {
    evs.sort((x, y) => x.ts - y.ts);
    let a = agents.get(id);
    const appId = a?.application ?? evs[0]!.application;
    const app = registry.byId(appId);
    if (!a) {
      const sp = app?.protocol;
      a = {
        messageId: id,
        application: appId,
        status: 'awaiting',
        active: true,
        waitingFor: sp?.phases[0],
        phases: sp?.allPhases ?? [],
        phaseTs: {},
        source: evs[0]!.source,
        logGroup: evs[0]!.logGroup,
        spawnedAt: evs[0]!.ts,
        updatedAt: now,
      };
      agents.set(id, a);
      spawned += 1;
      justSpawned.add(id);
      bump(appId, 'spawned');
      changed.add(id);
    }
    if (!a.active) continue; // terminal — immutable
    for (const e of evs) {
      if (a.phaseTs[e.type] === undefined) a.phaseTs[e.type] = e.ts;
      if (e.ackCode) a.ackCode = e.ackCode;
    }
    a.updatedAt = now;
    changed.add(id);
    if (app) decisions.push({ id, a, app, evs });
  }

  // Reason each transition from transaction.md (bounded concurrency); cap protects the
  // Lambda timeout — overflow uses the deterministic decision.
  const maxLlm = opts.maxLlm ?? Number(process.env.INGEST_DYNAMIC_MAX ?? 40);
  await mapPool(decisions, 6, async (dec, idx) => {
    const d: TransitionDecision =
      idx < maxLlm
        ? await reasonTransition(
            dec.app,
            {
              messageId: dec.id,
              currentStatus: dec.a.status,
              phaseTs: dec.a.phaseTs,
              ackCode: dec.a.ackCode,
              events: dec.evs,
              relatedLogs: relatedLinesFor(dec.app, dec.id),
              now,
            },
            opts.reasoner,
          )
        : deterministicDecision(dec.app, dec.a.phaseTs, dec.a.ackCode);
    const a = dec.a;
    if (d.status === 'awaiting') {
      a.status = 'awaiting';
      a.active = true;
      a.waitingFor = d.waitingFor ?? a.waitingFor;
      a.detail = d.detail;
      if (!justSpawned.has(dec.id)) {
        advanced += 1;
        bump(dec.app.id, 'advanced');
      }
    } else {
      a.status = d.status;
      a.active = false;
      a.waitingFor = undefined;
      a.closedAt = now;
      a.detail = d.detail;
      if (d.severity) a.severity = d.severity;
      closed += 1;
      bump(dec.app.id, 'closed');
    }
  });

  // Deterministic timeout pass (a clock check, not reasoning).
  for (const a of agents.values()) {
    if (!a.active) continue;
    const tsVals = Object.values(a.phaseTs);
    const last = tsVals.length ? Math.max(...tsVals) : a.spawnedAt;
    if (now - last > timeoutMs) {
      const wf = a.waitingFor;
      a.status = 'error';
      a.active = false;
      a.waitingFor = undefined;
      a.closedAt = now;
      a.detail = `Timed out awaiting ${wf ?? 'next phase'}`;
      a.severity = 'medium';
      a.updatedAt = now;
      closed += 1;
      bump(a.application, 'closed');
      changed.add(a.messageId);
    }
  }

  return { agents, changed, spawned, advanced, closed, byApp };
}

export interface AdvanceResult {
  spawned: number;
  advanced: number;
  closed: number;
  /** Anomalies minted for agents that closed failed/error this cycle. */
  anomalies: Anomaly[];
  /** Per-application agent counts + minted anomalies (application id → counts). */
  byApplication: Record<string, AgentCounts & { anomalies: number }>;
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];

/**
 * The anomaly's stable identity. `message_id` is the agents PRIMARY KEY, so there
 * is exactly ONE agent per id and, once terminal, it is immutable — the id alone
 * uniquely identifies the closed transaction, and a second anomaly for it is always
 * a duplicate. (Do NOT fold in closedAt: it does not disambiguate anything here, and
 * it stops this from matching anomalies written under the same scheme.)
 */
export const agentAnomalyFingerprint = (a: Agent): string => `tx:${a.messageId}`;

/**
 * DB-backed driver — the complete per-poll lifecycle step. Loads the relevant
 * agents (all active + any matching this window's ids), advances the state
 * machine against the protocol, persists changes, and reports a Anomaly for every
 * agent in history that closed NOT-completed (failed / error) and has none yet.
 * Runs even with no new logs so idle polls still fire timeouts + their Anomalies.
 */
export async function advanceAgents(
  parsed: ParsedLog[],
  registry: ApplicationRegistry,
  opts: { now?: number; timeoutMs?: number; windowMs?: number; anomaliesTtlMs?: number } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.INGEST_AGENT_TIMEOUT_MINUTES ?? 30) * 60_000;
  // Reconcile only within anomalies retention, so an agent whose anomaly was pruned
  // isn't recreated (it would churn back every poll). Defaults match the poller.
  const anomaliesTtlMs =
    opts.anomaliesTtlMs ?? Number(process.env.FINDINGS_HISTORY_TTL_MINUTES ?? 1440) * 60_000;

  const events = agentEvents(parsed, registry);
  const ids = [...new Set(events.map((e) => e.corrId))];
  const [active, matching] = await Promise.all([
    getActiveAgents(2000),
    ids.length ? getAgentsByMessageIds(ids) : Promise.resolve([] as Agent[]),
  ]);
  const known = new Map<string, Agent>();
  for (const a of [...active, ...matching]) known.set(a.messageId, a);

  // Route each app's transactions to its lifecycle: the deterministic state machine,
  // or — for apps that opt into `dynamicLifecycle` — the LLM-reasoned dynamic lifecycle
  // (prompted by transaction.md), which falls back to deterministic on any model error.
  const isDynamic = (appId?: string): boolean => !!registry.byId(appId)?.dynamicLifecycle;
  const knownList = [...known.values()];
  const detStep = stepAgents(
    events.filter((e) => !isDynamic(e.application)),
    knownList.filter((a) => !isDynamic(a.application)),
    { now, timeoutMs, registry },
  );
  const dynEvents = events.filter((e) => isDynamic(e.application));
  const dynKnown = knownList.filter((a) => isDynamic(a.application));
  const dynStep: StepResult =
    dynEvents.length || dynKnown.length
      ? await stepAgentsDynamic(dynEvents, dynKnown, { now, timeoutMs, registry, windowLogs: parsed })
      : { agents: new Map(), changed: new Set(), spawned: 0, advanced: 0, closed: 0, byApp: {} };

  const step: StepResult = {
    agents: new Map([...detStep.agents, ...dynStep.agents]),
    changed: new Set([...detStep.changed, ...dynStep.changed]),
    spawned: detStep.spawned + dynStep.spawned,
    advanced: detStep.advanced + dynStep.advanced,
    closed: detStep.closed + dynStep.closed,
    byApp: mergeByApp(detStep.byApp, dynStep.byApp),
  };

  const toPersist = [...step.changed].map((id) => step.agents.get(id)!).filter(Boolean);
  await upsertAgents(toPersist);

  // Report every non-completed closed agent lacking a anomaly — those that closed
  // this poll AND any that slipped through earlier (a fingerprint collision on a
  // reused messageId, a restart, a DB blip). Driven off persisted history rather
  // than only this poll's transitions, so the "not completed ⇒ a anomaly" property
  // is self-healing. The per-occurrence fingerprint makes each mint idempotent.
  const anomalies: Anomaly[] = [];
  const anomaliesByApp: Record<string, number> = {};
  const unreported = await getUnreportedClosedAgents(now - anomaliesTtlMs);
  for (const a of unreported) {
    try {
      const f = agentAnomaly(a, now, windowMs);
      await insertAnomaly(f);
      anomaliesByApp[a.application ?? 'unknown'] = (anomaliesByApp[a.application ?? 'unknown'] ?? 0) + 1;
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
      anomalies.push(f);
    } catch (err) {
      console.error('agentLifecycle: failure anomaly skipped', (err as Error).message);
    }
  }

  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  await pruneClosedAgentsOlderThan(now - historyTtlMin * 60_000);

  const byApplication: AdvanceResult['byApplication'] = {};
  const appIds = new Set([...Object.keys(step.byApp), ...Object.keys(anomaliesByApp)]);
  for (const id of appIds) {
    const c = step.byApp[id] ?? { spawned: 0, advanced: 0, closed: 0 };
    byApplication[id] = { ...c, anomalies: anomaliesByApp[id] ?? 0 };
  }

  return { spawned: step.spawned, advanced: step.advanced, closed: step.closed, anomalies, byApplication };
}

/** A deterministic Anomaly for a terminally failed/errored (timed-out) agent. */
function agentAnomaly(a: Agent, now: number, windowMs: number): Anomaly {
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
    fingerprint: agentAnomalyFingerprint(a),
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

import { randomUUID } from 'node:crypto';
import type { Agent, Anomaly, ApplicationDef, AgentPromptContext, LogSourceType, ParsedLog, Severity, ApplicationRegistry, TransitionDecision, TransitionReasoner } from '@log/shared';
import { lifecycleTimeoutMs } from '@log/shared';
import { converseJson } from './bedrock.js';
import {
  getActiveAgents,
  getAgentsByMessageIds,
  upsertAgents,
  pruneClosedAgentsOlderThan,
  insertAnomaly,
  insertAlert,
  getUnreportedClosedAgents,
  queryLogs,
} from '@log/db';

/**
 * The stateful ingestion-agent lifecycle. Every application's ingestion is dispatched to
 * the DYNAMIC agent: an agent persists across poll cycles — spawned on the initiating
 * message, ACTIVE until a terminal signal, then closed and moved to history — and each
 * per-transaction state TRANSITION is reasoned by the owning app's own ingestion agent
 * ({@link ApplicationDef.ingestionAgent}) from its `transaction.md`, never a hardcoded
 * state machine, and never with any app-specific logic in this engine.
 *
 * The only deterministic pieces left are (1) app-owned EXTRACTION — `protocol.eventOf`
 * turns a raw log into a phase event (parsing, not lifecycle logic; it lives in the app
 * package) — and (2) the wall-clock inactivity timeout, an app-configured SLA backstop.
 * On a model error the transition is simply deferred to the next poll.
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
  /** The raw log line — handed to the dynamic agent so it reasons over actual log text. */
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
  /**
   * Fallback inactivity timeout for an app whose `transaction.md` states none. The
   * effective timeout is per-app — {@link lifecycleTimeoutMs} reads each app's own
   * spec (SCP 30 min, apiflc 2 min) — so this is only used when an app declares no
   * directive (or no prompt).
   */
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
  /**
   * Transitions decided DETERMINISTICALLY by an app's fastPath, costing no model call.
   * Reported next to `reasoned` so the model's share of ingestion is an observable
   * number: if this collapses toward zero the throughput ceiling is back.
   */
  fastPathed: number;
  /** Transitions that required a model call (these consume INGEST_DYNAMIC_MAX). */
  reasoned: number;
  /** Transitions left undecided this poll because the reasoning cap was hit. */
  deferredOverCap: number;
  /** Per-application agent counts (application id → counts). */
  byApp: Record<string, AgentCounts>;
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

/** The default transition reasoner — a Bedrock structured-output call, injected into each
 *  app's {@link IngestionAgent} so the app packages never depend on Bedrock or this engine.
 *
 *  maxTokens must be GENEROUS: the configured foundation model (GPT-OSS) is a REASONING
 *  model whose hidden reasoning tokens count against maxTokens. A tight budget (e.g. 400)
 *  gets consumed by reasoning on large prompts, leaving NO final text — the reply comes back
 *  empty, decideFromSpec returns null, and every transaction times out instead of
 *  transitioning. The JSON answer itself is tiny; the budget is headroom for reasoning.
 *  So it inherits the platform-wide ceiling (`BEDROCK_MAX_TOKENS`, see bedrock.ts) rather
 *  than carrying its own number; INGEST_DYNAMIC_MAXTOKENS still overrides it per-site. */
const REASONER_MAX_TOKENS = process.env.INGEST_DYNAMIC_MAXTOKENS
  ? Number(process.env.INGEST_DYNAMIC_MAXTOKENS)
  : undefined;
const defaultReasoner: TransitionReasoner = (system, user) =>
  converseJson<Partial<TransitionDecision>>(user, { system, temperature: 0, maxTokens: REASONER_MAX_TOKENS });

/**
 * The dynamic lifecycle step (pure — no DB). Extraction/correlation + phaseTs bookkeeping
 * are deterministic (the events come from the app's `eventOf`); the per-transaction state
 * TRANSITION is delegated to the owning app's {@link ApplicationDef.ingestionAgent}, which
 * assembles its own evidence and reasons it against its `transaction.md`. This engine holds
 * no app-specific logic — it only dispatches and injects the model. Bounded concurrency + a
 * per-poll cap protect the Lambda; beyond the cap, or on any model error (a null decision),
 * no transition is applied and the agent is retried next poll. Timeouts are a deterministic
 * wall-clock check.
 */
export async function stepAgentsDynamic(
  events: AgentEvent[],
  known: Agent[],
  opts: StepOptions & { reasoner?: TransitionReasoner; maxLlm?: number; windowLogs?: ParsedLog[] },
): Promise<StepResult> {
  const { now, timeoutMs, registry } = opts;
  const windowLogs = opts.windowLogs ?? [];
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
  let fastPathed = 0;
  let reasoned = 0;
  let deferredOverCap = 0;
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
        spawnedAt: evs[0]!.ts, // DATA time — the initiating log line's timestamp
        firstSeenAt: now, // WALL-CLOCK — when we first saw it; never moved again
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

  // Some apps' decisive signal is NOT a protocol event, so no eventOf fired to schedule
  // the transaction above (apiflc's outcome is the API-Gateway HTTP status, logged under
  // the gateway requestId — it never becomes an event). Ask each app, via its own
  // `pendingSignals` hook, which of its ACTIVE transactions have such a signal in THIS
  // window; the engine re-reasons those. The criterion is entirely app-owned — no
  // application's out-of-band signal is known here.
  const scheduled = new Set(decisions.map((d) => d.id));
  const activeIdsByApp = new Map<string, string[]>();
  for (const a of agents.values()) {
    if (!a.active || scheduled.has(a.messageId)) continue;
    const list = activeIdsByApp.get(a.application ?? '') ?? [];
    list.push(a.messageId);
    activeIdsByApp.set(a.application ?? '', list);
  }
  for (const [appId, ids] of activeIdsByApp) {
    const app = registry.byId(appId);
    if (!app?.pendingSignals || !app.ingestionAgent) continue;
    for (const id of app.pendingSignals(windowLogs, ids)) {
      const a = agents.get(id);
      if (a?.active && !scheduled.has(id)) {
        decisions.push({ id, a, app, evs: [] });
        scheduled.add(id);
      }
    }
  }

  // Reason each transition from transaction.md (bounded concurrency); cap protects the
  // Lambda timeout — beyond it (or on a null/no-transition result) the agent is left
  // unchanged and retried next poll.
  const maxLlm = opts.maxLlm ?? Number(process.env.INGEST_DYNAMIC_MAX ?? 40);

  // DETERMINISTIC FAST PATH first. Each app decides the transitions its own evidence makes
  // unambiguous (SCP: the ackCode on the protocol event; apiflc: the gateway HTTP status),
  // and defers the rest. Those transitions cost no model call and do not consume the
  // reasoning budget, which is what actually bounds ingestion throughput — see
  // IngestionAgent.fastPath. Anything an app does not claim still goes to the model, so
  // this narrows the model's role without removing it.
  const fastPathEnabled = (process.env.INGEST_FASTPATH_ENABLED ?? 'true').toLowerCase() !== 'false';

  /** Apply one decided transition. Identical for a fast-path and a reasoned decision. */
  const applyDecision = (dec: (typeof decisions)[number], d: TransitionDecision): void => {
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
    changed.add(dec.id);
  };

  const ctxOf = (dec: (typeof decisions)[number]): AgentPromptContext => ({
    messageId: dec.id,
    currentStatus: dec.a.status,
    phaseTs: dec.a.phaseTs,
    ackCode: dec.a.ackCode,
    phasesThisCycle: dec.evs.map((e) => e.type),
    eventLines: dec.evs.map((e) => e.raw ?? '').filter(Boolean),
    window: windowLogs,
    now,
  });

  const deferred: typeof decisions = [];
  for (const dec of decisions) {
    let d: TransitionDecision | null = null;
    if (fastPathEnabled && dec.app.ingestionAgent?.fastPath) {
      try {
        d = dec.app.ingestionAgent.fastPath(ctxOf(dec));
      } catch (err) {
        // A broken fast path must never drop a transaction — fall back to reasoning.
        console.error(`ingest: fastPath threw for ${dec.id}, deferring to the model`, (err as Error).message);
        d = null;
      }
    }
    if (d) {
      applyDecision(dec, d);
      fastPathed += 1;
    } else {
      deferred.push(dec);
    }
  }

  await mapPool(deferred, 6, async (dec, idx) => {
    if (idx >= maxLlm) {
      deferredOverCap += 1;
      return; // over the per-poll cap — defer to next poll
    }
    const agent = dec.app.ingestionAgent;
    if (!agent) return; // app declares no dynamic agent — only its timeouts fire
    const d = await agent.decide(ctxOf(dec), opts.reasoner ?? defaultReasoner);
    if (!d) return; // no transition this poll (model error / no spec) — leave unchanged
    reasoned += 1;
    applyDecision(dec, d);
  });

  if (deferredOverCap > 0) {
    // Never silent: this is the back-pressure that, left unchecked, turns into agents
    // tripping their inactivity timeout and being recorded as legitimate timeouts.
    console.warn(
      `ingest: ${deferredOverCap} transition(s) over the ${maxLlm}-per-poll reasoning cap; deferred to the next poll`,
    );
  }

  // Deterministic timeout pass (a clock check, not reasoning) — the SLA backstop. The
  // timeout is per-app, sourced from each app's transaction.md (SCP 30 min, apiflc
  // 2 min); `timeoutMs` is only the fallback for an app that states none.
  for (const a of agents.values()) {
    if (!a.active) continue;
    const tsVals = Object.values(a.phaseTs);
    const last = tsVals.length ? Math.max(...tsVals) : a.spawnedAt;
    const appTimeoutMs = lifecycleTimeoutMs(registry.byId(a.application), timeoutMs);
    // TWO clocks, and both must agree before a transaction is called timed out:
    //   (1) DATA time — nothing new has arrived for this transaction in `appTimeoutMs`.
    //   (2) WALL-CLOCK — we have actually WATCHED it that long (`firstSeenAt`).
    // (1) alone was the bug: `last` comes from log timestamps while `now` is wall-clock,
    // so a transaction ingested from logs already older than its timeout — a simulation,
    // a back-fill, a catch-up after the poller was down, or simply delivery latency —
    // was closed as "timed out" by the first poll that ever saw it. It never got to be
    // an active agent, so nothing could observe it in flight and no validation worker
    // could shadow it as pending. Requiring (2) guarantees every transaction gets a full
    // timeout window of real observation, which is what "inactivity" always meant.
    // `firstSeenAt` is used rather than `updatedAt` deliberately: `updatedAt` is bumped
    // whenever a poll re-matches this agent's events, and the poll window overlaps, so a
    // still-visible log line would keep pushing it forward and the agent would never
    // time out at all.
    const observedMs = now - (a.firstSeenAt ?? a.spawnedAt);
    if (now - last > appTimeoutMs && observedMs > appTimeoutMs) {
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

  return { agents, changed, spawned, advanced, closed, fastPathed, reasoned, deferredOverCap, byApp };
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
 * agents (all active + any matching this window's ids), advances every application's
 * transactions through the dynamic (LLM-reasoned) agent, persists changes, and reports a
 * Anomaly for every agent in history that closed NOT-completed (failed / error) and has
 * none yet. Runs even with no new logs so idle polls still fire timeouts + their Anomalies.
 */
export async function advanceAgents(
  parsed: ParsedLog[],
  registry: ApplicationRegistry,
  opts: { now?: number; timeoutMs?: number; windowMs?: number; anomaliesTtlMs?: number } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 5 * 60_000;
  // FALLBACK inactivity timeout only — the effective timeout is per-app, read from each
  // app's transaction.md by lifecycleTimeoutMs. Used when an app states no directive.
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.INGEST_AGENT_TIMEOUT_MINUTES ?? 30) * 60_000;
  // Reconcile only within anomalies retention, so an agent whose anomaly was pruned
  // isn't recreated (it would churn back every poll). Defaults match the poller.
  const anomaliesTtlMs =
    opts.anomaliesTtlMs ?? Number(process.env.FINDINGS_HISTORY_TTL_MINUTES ?? 1440) * 60_000;

  const events = agentEvents(parsed, registry);
  const ids = [...new Set(events.map((e) => e.corrId))];
  // The active-agent load is CAPPED, and hitting the cap is the sharpest scaling cliff in
  // the poller: agents beyond it are never loaded, so they are never advanced, so they sit
  // until their inactivity timeout closes them as `error` — and the validation worker then
  // passes that as consistent, because a timeout carrying its medium anomaly satisfies the
  // invariant. Thousands of transactions can be silently mis-recorded that way. Raise it
  // with INGEST_ACTIVE_AGENT_LIMIT, and never let reaching it pass unreported.
  const activeLimit = Number(process.env.INGEST_ACTIVE_AGENT_LIMIT ?? 5000);
  const [active, matching] = await Promise.all([
    getActiveAgents(activeLimit),
    ids.length ? getAgentsByMessageIds(ids) : Promise.resolve([] as Agent[]),
  ]);
  if (active.length >= activeLimit) {
    console.error(
      `ingest: active-agent load hit the ${activeLimit} cap — agents beyond it are NOT being advanced and will time out spuriously. Raise INGEST_ACTIVE_AGENT_LIMIT.`,
    );
  }
  const known = new Map<string, Agent>();
  for (const a of [...active, ...matching]) known.set(a.messageId, a);

  // Cross-poll correlation window. The connector pulls INCREMENTALLY — each log lands in
  // exactly one poll — so a transaction's later-arriving cross-group signal (apiflc's
  // gateway HTTP status is ingested in a different poll than the handler logs, and is not
  // a protocol event) would otherwise never share a window with its call. Correlate over
  // recent STORED logs spanning an agent's active lifetime, merged with this poll's logs
  // (which may not be persisted yet), so app joins (`relatedLogs`) see the whole call.
  // Span the LARGEST per-app inactivity timeout so no app's active lifetime is
  // under-covered (SCP's 30-min window must still load even while apiflc's is 2 min).
  const windowSpanMs = Math.max(
    timeoutMs,
    ...registry.all().map((app) => lifecycleTimeoutMs(app, timeoutMs)),
  );
  let windowLogs = parsed;
  try {
    const stored = await queryLogs({ from: now - windowSpanMs, to: now, limit: 10000 });
    const byId = new Map<string, ParsedLog>();
    for (const l of [...stored, ...parsed]) byId.set(l.id, l);
    windowLogs = [...byId.values()];
  } catch (err) {
    console.error('advanceAgents: correlation-window query failed, using this poll only', (err as Error).message);
  }

  const step = await stepAgentsDynamic(events, [...known.values()], { now, timeoutMs, registry, windowLogs });

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

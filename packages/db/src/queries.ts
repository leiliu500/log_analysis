import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type {
  Anomaly,
  ParsedLog,
  ChatMessage,
  LogSourceType,
  Agent,
  PollerRun,
  ValidationAgent,
} from '@log/shared';
import { getDb, getSql, type Sql } from './client.js';
import {
  parsedLogs,
  anomalies,
  alerts,
  chatSessions,
  chatMessages,
  learnedPatterns,
} from './schema.js';

const toVector = (v?: number[]): string | null =>
  v && v.length ? `[${v.join(',')}]` : null;

/**
 * Read a JSONB column defensively. postgres.js normally returns jsonb as a
 * parsed object, but a value bound as a JSON string + `::jsonb` cast can
 * round-trip as a string; parse it so callers always get the object/array.
 */
function jsonbField<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

// postgres.js `json()` has a strict JSONValue signature; our records use
// `unknown`-valued maps, so wrap with a permissive cast in one place.
const json = (v: unknown) => getSql().json(v as Parameters<Sql['json']>[0]);

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
export async function insertParsedLogs(logs: ParsedLog[]): Promise<void> {
  if (!logs.length) return;
  const sqlc = getSql();
  // Per-row inserts in one transaction. sql.json() is used directly in the
  // template (its supported form); the bulk sql(rows) helper does not serialize
  // json()-wrapped values correctly.
  await sqlc.begin(async (tx) => {
    for (const l of logs) {
      await tx`INSERT INTO parsed_logs
        (id, source, stream, ts, level, message, fields, entities, fingerprint, raw, ingested_at, embedding)
        VALUES (${l.id}, ${l.source}, ${l.stream}, ${l.timestamp}, ${l.level}, ${l.message},
                ${JSON.stringify(l.fields ?? {})}::jsonb, ${JSON.stringify(l.entities ?? {})}::jsonb,
                ${l.fingerprint}, ${l.raw}, ${l.ingestedAt}, ${toVector(l.embedding)}::vector)`;
    }
  });
}

export interface LogQuery {
  sources?: LogSourceType[];
  from?: number;
  to?: number;
  limit?: number;
}

export async function queryLogs(q: LogQuery): Promise<ParsedLog[]> {
  const db = getDb();
  const conds = [];
  if (q.sources?.length) conds.push(inArray(parsedLogs.source, q.sources));
  if (q.from) conds.push(gte(parsedLogs.ts, q.from));
  if (q.to) conds.push(lte(parsedLogs.ts, q.to));
  const rows = await db
    .select()
    .from(parsedLogs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(parsedLogs.ts))
    .limit(q.limit ?? 200);
  return rows.map(rowToParsedLog);
}

/** Semantic search over logs relevant to a query embedding (scoped chat). */
export async function searchLogsByEmbedding(
  embedding: number[],
  limit = 20,
  sources?: LogSourceType[],
): Promise<ParsedLog[]> {
  const sqlc = getSql();
  const vec = toVector(embedding);
  if (!vec) return [];
  const rows = sources?.length
    ? await sqlc`SELECT * FROM parsed_logs WHERE source = ANY(${sqlc.array(sources)})
                 ORDER BY embedding <=> ${vec}::vector LIMIT ${limit}`
    : await sqlc`SELECT * FROM parsed_logs
                 ORDER BY embedding <=> ${vec}::vector LIMIT ${limit}`;
  return rows.map(rawRowToParsedLog);
}

// ---------------------------------------------------------------------------
// Anomalies & alerts
// ---------------------------------------------------------------------------
export async function insertAnomaly(f: Anomaly): Promise<void> {
  const sqlc = getSql();
  await sqlc`INSERT INTO anomalies
    (id, kind, severity, title, summary, confidence, sources, application, fingerprint,
     evidence, reasoning, recommendations, metadata, window_start, window_end, created_at, embedding)
    VALUES (${f.id}, ${f.kind}, ${f.severity}, ${f.title}, ${f.summary}, ${f.confidence},
            ${f.sources}, ${f.application ?? null}, ${f.fingerprint},
            ${JSON.stringify(f.evidence ?? [])}::jsonb, ${JSON.stringify(f.reasoning ?? [])}::jsonb,
            ${JSON.stringify(f.recommendations ?? [])}::jsonb, ${JSON.stringify(f.metadata ?? {})}::jsonb,
            ${f.windowStart}, ${f.windowEnd}, ${f.createdAt}, ${toVector(f.embedding)}::vector)`;
}

/**
 * Delete anomalies (and their alerts, via cascade) created before `cutoff` (ms).
 * Keeps the Anomalies dashboard reflecting only recent analysis so it
 * doesn't show anomalies whose logs have aged out. Returns the count removed.
 */
export async function pruneAnomaliesOlderThan(cutoff: number): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM anomalies WHERE created_at < ${cutoff} RETURNING id`;
  return rows.length;
}

/** Delete every anomaly (and cascade their alerts). Returns the count removed. */
export async function deleteAllAnomalies(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM anomalies RETURNING id`;
  return rows.length;
}

/** Delete every parsed log row. Returns the count removed. */
export async function deleteAllLogs(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM parsed_logs RETURNING id`;
  return rows.length;
}

/** True if a anomaly with this fingerprint was created at/after `since` (ms). */
export async function anomalyExistsByFingerprint(
  fingerprint: string,
  since: number,
): Promise<boolean> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT 1 FROM anomalies
    WHERE fingerprint = ${fingerprint} AND created_at >= ${since} LIMIT 1`;
  return rows.length > 0;
}

export async function recentAnomalies(limit = 50): Promise<Anomaly[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(anomalies)
    .orderBy(desc(anomalies.createdAt))
    .limit(limit);
  return rows.map(rowToAnomaly);
}

/** Semantic search over anomalies — the core of the scoped chatbot. */
export async function searchAnomaliesByEmbedding(
  embedding: number[],
  limit = 10,
): Promise<Anomaly[]> {
  const sqlc = getSql();
  const vec = toVector(embedding);
  if (!vec) return [];
  const rows = await sqlc`SELECT * FROM anomalies
    ORDER BY embedding <=> ${vec}::vector LIMIT ${limit}`;
  return rows.map(rawRowToAnomaly);
}

export async function insertAlert(a: {
  id: string;
  anomalyId: string;
  severity: string;
  channel: string;
  status: string;
  createdAt: number;
}): Promise<void> {
  await getDb().insert(alerts).values(a);
}

// ---------------------------------------------------------------------------
// Agents (stateful ingestion-agent lifecycle)
// ---------------------------------------------------------------------------
export async function upsertAgents(agents: Agent[]): Promise<void> {
  if (!agents.length) return;
  const sqlc = getSql();
  await sqlc.begin(async (tx) => {
    for (const a of agents) {
      await tx`INSERT INTO agents
        (message_id, application, status, active, waiting_for, phases, phase_ts, source, log_group,
         ack_code, severity, detail, spawned_at, updated_at, closed_at)
        VALUES (${a.messageId}, ${a.application ?? null}, ${a.status}, ${a.active}, ${a.waitingFor ?? null},
                ${JSON.stringify(a.phases)}::jsonb, ${JSON.stringify(a.phaseTs)}::jsonb, ${a.source ?? null}, ${a.logGroup ?? null},
                ${a.ackCode ?? null}, ${a.severity ?? null}, ${a.detail ?? null},
                ${a.spawnedAt}, ${a.updatedAt}, ${a.closedAt ?? null})
        ON CONFLICT (message_id) DO UPDATE SET
          application = COALESCE(agents.application, EXCLUDED.application),
          status = EXCLUDED.status, active = EXCLUDED.active,
          waiting_for = EXCLUDED.waiting_for,
          phases = EXCLUDED.phases, phase_ts = EXCLUDED.phase_ts,
          source = COALESCE(agents.source, EXCLUDED.source),
          log_group = COALESCE(agents.log_group, EXCLUDED.log_group),
          ack_code = COALESCE(EXCLUDED.ack_code, agents.ack_code),
          severity = EXCLUDED.severity, detail = EXCLUDED.detail,
          updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at`;
    }
  });
}

export async function getAgentsByMessageIds(ids: string[]): Promise<Agent[]> {
  if (!ids.length) return [];
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM agents WHERE message_id = ANY(${sqlc.array(ids)})`;
  return rows.map(rawRowToAgent);
}

/** Active agents (cards) — those still awaiting an ACK or RESPONSE. */
export async function getActiveAgents(limit = 500): Promise<Agent[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM agents WHERE active = TRUE ORDER BY spawned_at DESC LIMIT ${limit}`;
  return rows.map(rawRowToAgent);
}

/** Closed agents (history) — completed / failed / errored, newest first. */
export async function getAgentHistory(limit = 200): Promise<Agent[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM agents WHERE active = FALSE ORDER BY closed_at DESC NULLS LAST LIMIT ${limit}`;
  return rows.map(rawRowToAgent);
}

/**
 * Closed non-completed agents (failed / errored) that closed on/after `since` and
 * have NO anomaly yet — the backlog the lifecycle must report on. This is what makes
 * "every non-completed agent in history is a anomaly" self-healing: an agent whose
 * anomaly was missed at close time (a restart, a DB blip) is picked up here on a
 * later poll. The anomaly identity is `tx:<messageId>` — one agent per id (message_id
 * is the PK), so this NOT EXISTS is exactly "no anomaly for this agent yet" and never
 * mints a duplicate for one already reported.
 */
export async function getUnreportedClosedAgents(since: number, limit = 500): Promise<Agent[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT a.* FROM agents a
    WHERE a.active = FALSE
      AND a.status IN ('failed', 'error')
      AND a.closed_at >= ${since}
      AND NOT EXISTS (
        SELECT 1 FROM anomalies f
        WHERE f.fingerprint = 'tx:' || a.message_id
      )
    ORDER BY a.closed_at DESC
    LIMIT ${limit}`;
  return rows.map(rawRowToAgent);
}

export async function pruneClosedAgentsOlderThan(cutoff: number): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM agents WHERE active = FALSE AND closed_at < ${cutoff} RETURNING message_id`;
  return rows.length;
}

export async function deleteAllAgents(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM agents RETURNING message_id`;
  return rows.length;
}

function rawRowToAgent(r: Record<string, unknown>): Agent {
  const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
  return {
    messageId: r.message_id as string,
    application: (r.application ?? undefined) as string | undefined,
    status: r.status as Agent['status'],
    active: r.active as boolean,
    waitingFor: (r.waiting_for ?? undefined) as string | undefined,
    phases: jsonbField<string[]>(r.phases, []),
    phaseTs: jsonbField<Record<string, number>>(r.phase_ts, {}),
    source: (r.source ?? undefined) as string | undefined,
    logGroup: (r.log_group ?? undefined) as string | undefined,
    ackCode: (r.ack_code ?? undefined) as string | undefined,
    severity: (r.severity ?? undefined) as string | undefined,
    detail: (r.detail ?? undefined) as string | undefined,
    spawnedAt: Number(r.spawned_at),
    updatedAt: Number(r.updated_at),
    closedAt: num(r.closed_at),
  };
}

// ---------------------------------------------------------------------------
// Validation agents (autonomous 1:1 shadow of the agent lifecycle)
// ---------------------------------------------------------------------------

/**
 * The severity of the agent-lifecycle anomaly for each messageId, keyed by the
 * anomaly fingerprint scheme `tx:<messageId>`. The validation engine's only read
 * against `anomalies`: it returns messageId → severity for every id that has a
 * `tx:` anomaly, so a missing key means "no anomaly exists for that agent".
 */
export async function getAgentAnomalySeverities(messageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!messageIds.length) return out;
  const sqlc = getSql();
  const fps = messageIds.map((id) => `tx:${id}`);
  const rows = await sqlc<{ fingerprint: string; severity: string }[]>`
    SELECT fingerprint, severity FROM anomalies WHERE fingerprint = ANY(${sqlc.array(fps)})`;
  for (const r of rows) {
    if (typeof r.fingerprint === 'string' && r.fingerprint.startsWith('tx:')) {
      out.set(r.fingerprint.slice(3), r.severity);
    }
  }
  return out;
}

/**
 * Analysis anomalies (anomaly / correlation / …) created at/after `since` — i.e.
 * every anomaly EXCEPT the `tx:<messageId>` lifecycle anomalies. These are the
 * anomalies the validator associates with completed transactions (by shared log
 * identity) to distinguish a clean completion from one with quality issues.
 */
export async function getNonTransactionAnomaliesSince(since: number, limit = 2000): Promise<Anomaly[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM anomalies
    WHERE created_at >= ${since} AND fingerprint NOT LIKE 'tx:%'
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(rawRowToAnomaly);
}

export async function upsertValidationAgents(vas: ValidationAgent[]): Promise<void> {
  if (!vas.length) return;
  const sqlc = getSql();
  await sqlc.begin(async (tx) => {
    for (const v of vas) {
      await tx`INSERT INTO validation_agents
        (message_id, application, agent_status, active, result, expected_anomaly, expected_severity,
         actual_anomaly, actual_severity, delta, missing_phases, sla_breached, sla_budget_minutes,
         sla_from_phase, response_latency_ms, quality_anomalies, max_quality_severity,
         ai_findings, ai_rejected, ai_reviewed_at, ai_error,
         phases, phase_ts, detail, spawned_at, updated_at, closed_at)
        VALUES (${v.messageId}, ${v.application ?? null}, ${v.agentStatus}, ${v.active}, ${v.result},
                ${v.expectedAnomaly}, ${v.expectedSeverity ?? null}, ${v.actualAnomaly}, ${v.actualSeverity ?? null},
                ${JSON.stringify(v.delta)}::jsonb, ${JSON.stringify(v.missingPhases)}::jsonb, ${v.slaBreached},
                ${v.slaBudgetMinutes ?? null}, ${v.slaFromPhase ?? null}, ${v.responseLatencyMs ?? null},
                ${JSON.stringify(v.qualityAnomalies)}::jsonb, ${v.maxQualitySeverity ?? null},
                ${JSON.stringify(v.aiFindings ?? [])}::jsonb, ${v.aiRejected ?? null}, ${v.aiReviewedAt ?? null},
                ${v.aiError ?? null},
                ${JSON.stringify(v.phases)}::jsonb, ${JSON.stringify(v.phaseTs)}::jsonb,
                ${v.detail ?? null}, ${v.spawnedAt}, ${v.updatedAt}, ${v.closedAt ?? null})
        ON CONFLICT (message_id) DO UPDATE SET
          application = COALESCE(validation_agents.application, EXCLUDED.application),
          agent_status = EXCLUDED.agent_status, active = EXCLUDED.active,
          expected_anomaly = EXCLUDED.expected_anomaly, expected_severity = EXCLUDED.expected_severity,
          actual_anomaly = EXCLUDED.actual_anomaly, actual_severity = EXCLUDED.actual_severity,
          delta = EXCLUDED.delta, missing_phases = EXCLUDED.missing_phases, sla_breached = EXCLUDED.sla_breached,
          sla_budget_minutes = EXCLUDED.sla_budget_minutes, sla_from_phase = EXCLUDED.sla_from_phase,
          response_latency_ms = EXCLUDED.response_latency_ms,
          quality_anomalies = EXCLUDED.quality_anomalies, max_quality_severity = EXCLUDED.max_quality_severity,
          -- The AI review is one-shot: it runs only while a closed transaction is inside
          -- the log-backed window, so later polls re-validate it deterministically and
          -- carry no review (ai_reviewed_at NULL). Treat that as "no new information" and
          -- keep the stored review rather than wiping a result that cost a model call.
          ai_findings = CASE WHEN EXCLUDED.ai_reviewed_at IS NULL THEN validation_agents.ai_findings ELSE EXCLUDED.ai_findings END,
          ai_rejected = COALESCE(EXCLUDED.ai_rejected, validation_agents.ai_rejected),
          ai_reviewed_at = COALESCE(EXCLUDED.ai_reviewed_at, validation_agents.ai_reviewed_at),
          -- Always take the latest: a retry that succeeds must CLEAR the stored error,
          -- and a retry that fails again must keep it visible.
          ai_error = EXCLUDED.ai_error,
          -- Same reason for the verdict: a stored 'ai_suspected' survives a later
          -- deterministic re-pass, but ONLY while that re-pass is still a clean success —
          -- if the deterministic engine now has something to say (failure, issues), its
          -- verdict wins, exactly as it does everywhere else.
          result = CASE
            WHEN EXCLUDED.ai_reviewed_at IS NULL AND EXCLUDED.result = 'success'
                 AND jsonb_array_length(validation_agents.ai_findings) > 0 THEN 'ai_suspected'
            ELSE EXCLUDED.result END,
          phases = EXCLUDED.phases, phase_ts = EXCLUDED.phase_ts,
          detail = CASE
            WHEN EXCLUDED.ai_reviewed_at IS NULL AND EXCLUDED.result = 'success'
                 AND jsonb_array_length(validation_agents.ai_findings) > 0 THEN validation_agents.detail
            ELSE EXCLUDED.detail END,
          updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at`;
    }
  });
}

/** Active validation agents (cards) — those shadowing a still-active agent (pending). */
export async function getActiveValidationAgents(limit = 500): Promise<ValidationAgent[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM validation_agents WHERE active = TRUE ORDER BY spawned_at DESC LIMIT ${limit}`;
  return rows.map(rawRowToValidationAgent);
}

/** Closed validation agents (history) — evaluated success/failure, newest first. */
export async function getValidationHistory(limit = 200): Promise<ValidationAgent[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM validation_agents WHERE active = FALSE ORDER BY closed_at DESC NULLS LAST LIMIT ${limit}`;
  return rows.map(rawRowToValidationAgent);
}

/**
 * Of `messageIds`, those whose validation agent has ALREADY been reviewed by the app's
 * validation AI agent. A residual transaction stays inside the log-backed window for
 * several polls, so without this the same transaction would be re-sent to the model on
 * every one of them — the review is one-shot by design, and its stored result is sticky
 * (see the ON CONFLICT clause in {@link upsertValidationAgents}).
 */
export async function getAiReviewedMessageIds(messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  const sqlc = getSql();
  const rows = await sqlc`SELECT message_id FROM validation_agents
    WHERE message_id = ANY(${messageIds}) AND ai_reviewed_at IS NOT NULL`;
  return new Set(rows.map((r) => r.message_id as string));
}

export async function pruneClosedValidationAgentsOlderThan(cutoff: number): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM validation_agents WHERE active = FALSE AND closed_at < ${cutoff} RETURNING message_id`;
  return rows.length;
}

export async function deleteAllValidationAgents(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM validation_agents RETURNING message_id`;
  return rows.length;
}

function rawRowToValidationAgent(r: Record<string, unknown>): ValidationAgent {
  const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
  return {
    messageId: r.message_id as string,
    application: (r.application ?? undefined) as string | undefined,
    agentStatus: r.agent_status as ValidationAgent['agentStatus'],
    active: r.active as boolean,
    result: r.result as ValidationAgent['result'],
    expectedAnomaly: r.expected_anomaly as boolean,
    expectedSeverity: (r.expected_severity ?? undefined) as ValidationAgent['expectedSeverity'],
    actualAnomaly: r.actual_anomaly as boolean,
    actualSeverity: (r.actual_severity ?? undefined) as string | undefined,
    delta: jsonbField<string[]>(r.delta, []),
    missingPhases: jsonbField<string[]>(r.missing_phases, []),
    slaBreached: (r.sla_breached ?? false) as boolean,
    slaBudgetMinutes: num(r.sla_budget_minutes),
    slaFromPhase: (r.sla_from_phase ?? undefined) as string | undefined,
    responseLatencyMs: num(r.response_latency_ms),
    qualityAnomalies: jsonbField<ValidationAgent['qualityAnomalies']>(r.quality_anomalies, []),
    maxQualitySeverity: (r.max_quality_severity ?? undefined) as ValidationAgent['maxQualitySeverity'],
    aiFindings: jsonbField<ValidationAgent['aiFindings']>(r.ai_findings, []),
    aiRejected: num(r.ai_rejected),
    aiError: (r.ai_error ?? undefined) as string | undefined,
    aiReviewedAt: num(r.ai_reviewed_at),
    phases: jsonbField<string[]>(r.phases, []),
    phaseTs: jsonbField<Record<string, number>>(r.phase_ts, {}),
    detail: (r.detail ?? undefined) as string | undefined,
    spawnedAt: Number(r.spawned_at),
    updatedAt: Number(r.updated_at),
    closedAt: num(r.closed_at),
  };
}

// ---------------------------------------------------------------------------
// Scheduled-ingestion run history (Schedule tab)
// ---------------------------------------------------------------------------

/** Keep the poller_runs table bounded to the most recent N rows. */
const POLLER_RUNS_KEEP = 500;

export async function insertPollerRun(run: PollerRun): Promise<void> {
  const sqlc = getSql();
  await sqlc`INSERT INTO poller_runs
    (id, ran_at, trigger, window_minutes, duration_ms, by_source, agents, anomalies, pruned, by_application)
    VALUES (${run.id}, ${run.ranAt}, ${run.trigger}, ${run.windowMinutes}, ${run.durationMs},
            ${JSON.stringify(run.bySource)}::jsonb, ${JSON.stringify(run.agents)}::jsonb, ${run.anomalies}, ${run.pruned},
            ${JSON.stringify(run.byApplication ?? {})}::jsonb)
    ON CONFLICT (id) DO NOTHING`;
  // Bound growth (a run lands every ~5 min) — drop everything past the newest N.
  await sqlc`DELETE FROM poller_runs WHERE id IN (
    SELECT id FROM poller_runs ORDER BY ran_at DESC OFFSET ${POLLER_RUNS_KEEP}
  )`;
}

export async function recentPollerRuns(limit = 50): Promise<PollerRun[]> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT * FROM poller_runs ORDER BY ran_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    ranAt: Number(r.ran_at),
    trigger: r.trigger as PollerRun['trigger'],
    windowMinutes: Number(r.window_minutes),
    durationMs: Number(r.duration_ms),
    bySource: jsonbField<PollerRun['bySource']>(r.by_source, {}),
    agents: jsonbField<PollerRun['agents']>(r.agents, { spawned: 0, advanced: 0, closed: 0, anomalies: 0 }),
    anomalies: Number(r.anomalies),
    pruned: Number(r.pruned),
    byApplication: jsonbField<NonNullable<PollerRun['byApplication']>>(r.by_application, {}),
  }));
}

export async function deleteAllPollerRuns(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM poller_runs RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
export async function ensureSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(chatSessions)
    .values({ id: sessionId, createdAt: Date.now() })
    .onConflictDoNothing();
}

export async function appendMessage(m: ChatMessage): Promise<void> {
  await getDb().insert(chatMessages).values({
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  });
}

export async function sessionHistory(sessionId: string, limit = 20): Promise<ChatMessage[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as ChatMessage['role'],
      content: r.content,
      createdAt: r.createdAt,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// Learned patterns (learning / baselines)
// ---------------------------------------------------------------------------
export interface PatternBaseline {
  fingerprint: string;
  source: string;
  sample: string;
  occurrences: number;
  ewmaRate: number;
  ewmaVariance: number;
  lastSeen: number;
  firstSeen: number;
  isKnownGood: boolean;
}

export async function getBaseline(fingerprint: string): Promise<PatternBaseline | undefined> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(learnedPatterns)
    .where(eq(learnedPatterns.fingerprint, fingerprint))
    .limit(1);
  return row as PatternBaseline | undefined;
}

export async function upsertBaseline(b: PatternBaseline): Promise<void> {
  const db = getDb();
  await db
    .insert(learnedPatterns)
    .values(b)
    .onConflictDoUpdate({
      target: learnedPatterns.fingerprint,
      set: {
        occurrences: b.occurrences,
        ewmaRate: b.ewmaRate,
        ewmaVariance: b.ewmaVariance,
        lastSeen: b.lastSeen,
        sample: b.sample,
      },
    });
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------
function rowToParsedLog(r: typeof parsedLogs.$inferSelect): ParsedLog {
  return {
    id: r.id,
    source: r.source as LogSourceType,
    stream: r.stream,
    timestamp: r.ts,
    level: r.level as ParsedLog['level'],
    message: r.message,
    fields: (r.fields ?? {}) as Record<string, unknown>,
    entities: (r.entities ?? {}) as Record<string, string[]>,
    fingerprint: r.fingerprint,
    raw: r.raw,
    ingestedAt: r.ingestedAt,
  };
}

function rawRowToParsedLog(r: Record<string, unknown>): ParsedLog {
  return {
    id: r.id as string,
    source: r.source as LogSourceType,
    stream: r.stream as string,
    timestamp: Number(r.ts),
    level: (r.level ?? 'unknown') as ParsedLog['level'],
    message: r.message as string,
    fields: (r.fields ?? {}) as Record<string, unknown>,
    entities: (r.entities ?? {}) as Record<string, string[]>,
    fingerprint: r.fingerprint as string,
    raw: r.raw as string,
    ingestedAt: Number(r.ingested_at),
  };
}

function rowToAnomaly(r: typeof anomalies.$inferSelect): Anomaly {
  return {
    id: r.id,
    kind: r.kind as Anomaly['kind'],
    severity: r.severity as Anomaly['severity'],
    title: r.title,
    summary: r.summary,
    confidence: r.confidence,
    sources: r.sources as LogSourceType[],
    application: (r.application ?? undefined) as string | undefined,
    fingerprint: r.fingerprint,
    evidence: (r.evidence ?? []) as Anomaly['evidence'],
    reasoning: (r.reasoning ?? []) as string[],
    recommendations: (r.recommendations ?? []) as string[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    createdAt: r.createdAt,
  };
}

function rawRowToAnomaly(r: Record<string, unknown>): Anomaly {
  return {
    id: r.id as string,
    kind: r.kind as Anomaly['kind'],
    severity: r.severity as Anomaly['severity'],
    title: r.title as string,
    summary: r.summary as string,
    confidence: Number(r.confidence),
    sources: (r.sources ?? []) as LogSourceType[],
    application: (r.application ?? undefined) as string | undefined,
    fingerprint: r.fingerprint as string,
    evidence: (r.evidence ?? []) as Anomaly['evidence'],
    reasoning: (r.reasoning ?? []) as string[],
    recommendations: (r.recommendations ?? []) as string[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    windowStart: Number(r.window_start),
    windowEnd: Number(r.window_end),
    createdAt: Number(r.created_at),
  };
}

export { sql };

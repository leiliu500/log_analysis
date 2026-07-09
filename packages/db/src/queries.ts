import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Finding, ParsedLog, ChatMessage, LogSourceType, Agent } from '@log/shared';
import { getDb, getSql, type Sql } from './client.js';
import {
  parsedLogs,
  findings,
  alerts,
  chatSessions,
  chatMessages,
  learnedPatterns,
} from './schema.js';

const toVector = (v?: number[]): string | null =>
  v && v.length ? `[${v.join(',')}]` : null;

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
// Findings & alerts
// ---------------------------------------------------------------------------
export async function insertFinding(f: Finding): Promise<void> {
  const sqlc = getSql();
  await sqlc`INSERT INTO findings
    (id, kind, severity, title, summary, confidence, sources, fingerprint,
     evidence, reasoning, recommendations, metadata, window_start, window_end, created_at, embedding)
    VALUES (${f.id}, ${f.kind}, ${f.severity}, ${f.title}, ${f.summary}, ${f.confidence},
            ${f.sources}, ${f.fingerprint},
            ${JSON.stringify(f.evidence ?? [])}::jsonb, ${JSON.stringify(f.reasoning ?? [])}::jsonb,
            ${JSON.stringify(f.recommendations ?? [])}::jsonb, ${JSON.stringify(f.metadata ?? {})}::jsonb,
            ${f.windowStart}, ${f.windowEnd}, ${f.createdAt}, ${toVector(f.embedding)}::vector)`;
}

/**
 * Delete findings (and their alerts, via cascade) created before `cutoff` (ms).
 * Keeps the Findings & Anomalies dashboard reflecting only recent analysis so it
 * doesn't show anomalies whose logs have aged out. Returns the count removed.
 */
export async function pruneFindingsOlderThan(cutoff: number): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM findings WHERE created_at < ${cutoff} RETURNING id`;
  return rows.length;
}

/** Delete every finding (and cascade their alerts). Returns the count removed. */
export async function deleteAllFindings(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM findings RETURNING id`;
  return rows.length;
}

/** Delete every parsed log row. Returns the count removed. */
export async function deleteAllLogs(): Promise<number> {
  const sqlc = getSql();
  const rows = await sqlc`DELETE FROM parsed_logs RETURNING id`;
  return rows.length;
}

/** True if a finding with this fingerprint was created at/after `since` (ms). */
export async function findingExistsByFingerprint(
  fingerprint: string,
  since: number,
): Promise<boolean> {
  const sqlc = getSql();
  const rows = await sqlc`SELECT 1 FROM findings
    WHERE fingerprint = ${fingerprint} AND created_at >= ${since} LIMIT 1`;
  return rows.length > 0;
}

export async function recentFindings(limit = 50): Promise<Finding[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(findings)
    .orderBy(desc(findings.createdAt))
    .limit(limit);
  return rows.map(rowToFinding);
}

/** Semantic search over findings — the core of the scoped chatbot. */
export async function searchFindingsByEmbedding(
  embedding: number[],
  limit = 10,
): Promise<Finding[]> {
  const sqlc = getSql();
  const vec = toVector(embedding);
  if (!vec) return [];
  const rows = await sqlc`SELECT * FROM findings
    ORDER BY embedding <=> ${vec}::vector LIMIT ${limit}`;
  return rows.map(rawRowToFinding);
}

export async function insertAlert(a: {
  id: string;
  findingId: string;
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
        (message_id, status, active, source, log_group, request_ts, ack_ts, response_ts,
         ack_code, severity, detail, spawned_at, updated_at, closed_at)
        VALUES (${a.messageId}, ${a.status}, ${a.active}, ${a.source ?? null}, ${a.logGroup ?? null},
                ${a.requestTs ?? null}, ${a.ackTs ?? null}, ${a.responseTs ?? null}, ${a.ackCode ?? null},
                ${a.severity ?? null}, ${a.detail ?? null}, ${a.spawnedAt}, ${a.updatedAt}, ${a.closedAt ?? null})
        ON CONFLICT (message_id) DO UPDATE SET
          status = EXCLUDED.status, active = EXCLUDED.active,
          source = COALESCE(agents.source, EXCLUDED.source),
          log_group = COALESCE(agents.log_group, EXCLUDED.log_group),
          request_ts = COALESCE(agents.request_ts, EXCLUDED.request_ts),
          ack_ts = COALESCE(agents.ack_ts, EXCLUDED.ack_ts),
          response_ts = COALESCE(agents.response_ts, EXCLUDED.response_ts),
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
    status: r.status as Agent['status'],
    active: r.active as boolean,
    source: (r.source ?? undefined) as string | undefined,
    logGroup: (r.log_group ?? undefined) as string | undefined,
    requestTs: num(r.request_ts),
    ackTs: num(r.ack_ts),
    responseTs: num(r.response_ts),
    ackCode: (r.ack_code ?? undefined) as string | undefined,
    severity: (r.severity ?? undefined) as string | undefined,
    detail: (r.detail ?? undefined) as string | undefined,
    spawnedAt: Number(r.spawned_at),
    updatedAt: Number(r.updated_at),
    closedAt: num(r.closed_at),
  };
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

function rowToFinding(r: typeof findings.$inferSelect): Finding {
  return {
    id: r.id,
    kind: r.kind as Finding['kind'],
    severity: r.severity as Finding['severity'],
    title: r.title,
    summary: r.summary,
    confidence: r.confidence,
    sources: r.sources as LogSourceType[],
    fingerprint: r.fingerprint,
    evidence: (r.evidence ?? []) as Finding['evidence'],
    reasoning: (r.reasoning ?? []) as string[],
    recommendations: (r.recommendations ?? []) as string[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    createdAt: r.createdAt,
  };
}

function rawRowToFinding(r: Record<string, unknown>): Finding {
  return {
    id: r.id as string,
    kind: r.kind as Finding['kind'],
    severity: r.severity as Finding['severity'],
    title: r.title as string,
    summary: r.summary as string,
    confidence: Number(r.confidence),
    sources: (r.sources ?? []) as LogSourceType[],
    fingerprint: r.fingerprint as string,
    evidence: (r.evidence ?? []) as Finding['evidence'],
    reasoning: (r.reasoning ?? []) as string[],
    recommendations: (r.recommendations ?? []) as string[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    windowStart: Number(r.window_start),
    windowEnd: Number(r.window_end),
    createdAt: Number(r.created_at),
  };
}

export { sql };

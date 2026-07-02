import {
  pgTable,
  uuid,
  text,
  bigint,
  doublePrecision,
  jsonb,
  boolean,
} from 'drizzle-orm/pg-core';

// Note: pgvector `embedding` columns exist in SQL but are handled via raw SQL
// in queries.ts (drizzle's vector type support is kept out of the typed schema
// to avoid pinning a specific extension helper version).

export const parsedLogs = pgTable('parsed_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  stream: text('stream').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  level: text('level').notNull().default('unknown'),
  message: text('message').notNull(),
  fields: jsonb('fields').notNull().default({}),
  entities: jsonb('entities').notNull().default({}),
  fingerprint: text('fingerprint').notNull(),
  raw: text('raw').notNull(),
  ingestedAt: bigint('ingested_at', { mode: 'number' }).notNull(),
});

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  confidence: doublePrecision('confidence').notNull().default(0),
  sources: text('sources').array().notNull().default([]),
  fingerprint: text('fingerprint').notNull(),
  evidence: jsonb('evidence').notNull().default([]),
  reasoning: jsonb('reasoning').notNull().default([]),
  recommendations: jsonb('recommendations').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  windowEnd: bigint('window_end', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  findingId: uuid('finding_id').notNull(),
  severity: text('severity').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const learnedPatterns = pgTable('learned_patterns', {
  fingerprint: text('fingerprint').primaryKey(),
  source: text('source').notNull(),
  sample: text('sample').notNull(),
  occurrences: bigint('occurrences', { mode: 'number' }).notNull().default(0),
  ewmaRate: doublePrecision('ewma_rate').notNull().default(0),
  ewmaVariance: doublePrecision('ewma_variance').notNull().default(0),
  lastSeen: bigint('last_seen', { mode: 'number' }).notNull(),
  firstSeen: bigint('first_seen', { mode: 'number' }).notNull(),
  isKnownGood: boolean('is_known_good').notNull().default(false),
});

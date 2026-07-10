import { z } from 'zod';
import { LogSourceType } from './logs.js';

export const Severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const FindingKind = z.enum([
  'anomaly', // statistical / behavioural outlier
  'correlation', // related events across sources
  'inference', // derived conclusion (root cause candidate)
  'reasoning', // multi-step reasoned explanation
  'pattern', // recurring learned pattern
]);
export type FindingKind = z.infer<typeof FindingKind>;

/** A citation back to the concrete logs that support a finding. */
export const Evidence = z.object({
  logId: z.string().uuid(),
  source: LogSourceType,
  stream: z.string(),
  timestamp: z.number().int(),
  excerpt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Finding = z.object({
  id: z.string().uuid(),
  kind: FindingKind,
  severity: Severity,
  title: z.string(),
  summary: z.string(),
  /** Model/heuristic confidence 0..1. */
  confidence: z.number().min(0).max(1),
  sources: z.array(LogSourceType),
  /** Owning application id (e.g. 'scp', 'apiflc'), when the finding is app-scoped. */
  application: z.string().optional(),
  fingerprint: z.string(),
  evidence: z.array(Evidence).default([]),
  /** Structured reasoning trace (steps the agent took). */
  reasoning: z.array(z.string()).default([]),
  /** Suggested remediation / next actions. */
  recommendations: z.array(z.string()).default([]),
  /** Free-form metadata (metrics, thresholds, correlation keys...). */
  metadata: z.record(z.string(), z.unknown()).default({}),
  windowStart: z.number().int(),
  windowEnd: z.number().int(),
  createdAt: z.number().int(),
  /** Vector embedding of title+summary for semantic retrieval (optional). */
  embedding: z.array(z.number()).optional(),
});
export type Finding = z.infer<typeof Finding>;

/** Alert emitted when a finding crosses notification thresholds. */
export const Alert = z.object({
  id: z.string().uuid(),
  findingId: z.string().uuid(),
  severity: Severity,
  channel: z.enum(['email', 'sns', 'webhook', 'dashboard']),
  status: z.enum(['pending', 'sent', 'acknowledged', 'suppressed']),
  createdAt: z.number().int(),
});
export type Alert = z.infer<typeof Alert>;

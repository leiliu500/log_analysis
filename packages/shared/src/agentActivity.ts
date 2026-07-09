import { z } from 'zod';

/**
 * A record of one agent spawned during agentic ingestion — what it processed and
 * how. Persisted per run so the Dashboard can show the dynamics of agents and
 * system activity (which request/ack/response each agent handled, the outcome,
 * and timing).
 */
export const AgentActivity = z.object({
  id: z.string(),
  /** The ingest/dispatch cycle that spawned this agent. */
  batchId: z.string(),
  /** Sequence number within the cycle. */
  agentNo: z.number().int(),
  kind: z.enum(['transaction', 'error', 'correlation']),
  /** Correlation id (the request messageId) for transaction agents. */
  messageId: z.string().optional(),
  status: z.enum(['finding', 'clean', 'duplicate', 'error']),
  severity: z.string().optional(),
  findingId: z.string().optional(),
  source: z.string().optional(),
  logGroup: z.string().optional(),
  /** Which message types were present (REQUEST/ACK/RESPONSE). */
  presentTypes: z.array(z.string()).default([]),
  requestTs: z.number().optional(),
  ackTs: z.number().optional(),
  responseTs: z.number().optional(),
  ackCode: z.string().optional(),
  /** Reason / error message / label. */
  detail: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number(),
  durationMs: z.number().int(),
});
export type AgentActivity = z.infer<typeof AgentActivity>;

/** Roll-up of one ingest cycle (a batch of agents). */
export interface AgentBatch {
  batchId: string;
  startedAt: number;
  finishedAt: number;
  total: number;
  finding: number;
  clean: number;
  duplicate: number;
  error: number;
  sources: string[];
}

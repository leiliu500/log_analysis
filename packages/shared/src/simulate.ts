import { z } from 'zod';
import { LogSourceType } from './logs.js';

/**
 * Instruction to the simulator agent (requirements 8 & 9). The user pastes one
 * or more sample messages into a single input area — typically XML like an FRB
 * cashMessage, and optionally its ACK/Response. The simulator reads them,
 * replicates the flow `count` times with a fresh unique messageId per set, and
 * keeps each ACK/Response's <initMessageId> matched to its Request's
 * <messageId>. Messages are written verbatim (aside from the id/time rewrites)
 * to the chosen sinks.
 */
export const SimulateRequest = z.object({
  /** Application being simulated (e.g. "scp", "cashMessage"). */
  application: z.string().default('cashMessage'),
  /** Raw pasted sample message(s): one or more XML docs (Request/ACK/Response). */
  samples: z.string().min(1),
  /** Which sinks to write simulated logs into. */
  sinks: z.array(LogSourceType).min(1).default(['cloudwatch']),
  /** How many correlated Request/ACK/Response sets to generate. */
  count: z.number().int().min(1).max(10000).default(1),
  /**
   * Which message types to emit per set. Default is a complete transaction;
   * e.g. ['REQUEST','ACK'] simulates a request/ack WITHOUT a response.
   */
  messageTypes: z
    .array(z.enum(['REQUEST', 'ACK', 'RESPONSE']))
    .min(1)
    .default(['REQUEST', 'ACK', 'RESPONSE']),
  /** ackCode written on ACK/RESPONSE — 'failure' produces a failed transaction. */
  ackStatus: z.enum(['success', 'failure']).default('success'),
  /**
   * Optional starting messageId for the first Request (e.g. "001"). Overrides
   * the sample's messageId; subsequent sets increment it (001, 002, 003…).
   */
  startMessageId: z.string().optional(),
  /** Spread the generated messages across this many minutes (0 = all "now"). */
  spreadMinutes: z.number().int().min(0).max(1440).default(0),
});
export type SimulateRequest = z.infer<typeof SimulateRequest>;

/** Per-message summary of what the simulator generated. */
export const SimulatedMessage = z.object({
  messageType: z.string(),
  messageId: z.string(),
  initMessageId: z.string().optional(),
});
export type SimulatedMessage = z.infer<typeof SimulatedMessage>;

export const SimulateResult = z.object({
  application: z.string(),
  written: z.record(LogSourceType, z.number().int()),
  batchId: z.string().uuid(),
  /** The generated messages (type + ids) so the UI can show correlation. */
  messages: z.array(SimulatedMessage).default([]),
});
export type SimulateResult = z.infer<typeof SimulateResult>;

/** Instruction to invoke a REAL application endpoint. Per requirement (10). */
export const InvokeAppRequest = z.object({
  application: z.string(),
  request: z.record(z.string(), z.unknown()),
});
export type InvokeAppRequest = z.infer<typeof InvokeAppRequest>;

export const InvokeAppResult = z.object({
  application: z.string(),
  status: z.number().int(),
  response: z.unknown(),
  latencyMs: z.number(),
});
export type InvokeAppResult = z.infer<typeof InvokeAppResult>;

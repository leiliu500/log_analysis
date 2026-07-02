import { z } from 'zod';
import { LogSourceType } from './logs.js';

/**
 * Instruction to the simulator agent: given a sample request and a sample
 * application response, synthesize realistic logs and write them to the chosen
 * sinks (CloudWatch/Splunk/Grafana/Email). Per requirements (8) and (9).
 */
export const SimulateRequest = z.object({
  /** Application being simulated (e.g. "scp", "checkout-service"). */
  application: z.string(),
  /** Sample inbound request the app would receive. */
  sampleRequest: z.record(z.string(), z.unknown()),
  /** Sample response the app would return. */
  sampleResponse: z.record(z.string(), z.unknown()),
  /** Which sinks to write simulated logs into. */
  sinks: z.array(LogSourceType).min(1),
  /** How many log lines to generate. */
  count: z.number().int().min(1).max(10000).default(25),
  /** Optionally inject anomalies (error bursts, latency spikes). */
  injectAnomalies: z.boolean().default(false),
  /** Spread logs across this many minutes (0 = all "now"). */
  spreadMinutes: z.number().int().min(0).max(1440).default(5),
});
export type SimulateRequest = z.infer<typeof SimulateRequest>;

export const SimulateResult = z.object({
  application: z.string(),
  written: z.record(LogSourceType, z.number().int()),
  batchId: z.string().uuid(),
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

import { z } from 'zod';
import { LogSourceType } from './logs.js';

/** Names of collaborator agents the supervisor can route to. */
export const CollaboratorAgent = z.enum([
  'cloudwatch-log-agent',
  'splunk-log-agent',
  'grafana-log-agent',
  'email-log-agent',
  'analysis-agent',
  'simulator-agent',
  'scp-agent',
]);
export type CollaboratorAgent = z.infer<typeof CollaboratorAgent>;

/** Supervisor's routing decision for an inbound user request. */
export const RouteDecision = z.object({
  intent: z.enum([
    'query_findings', // answer questions from stored logs/findings
    'analyze_logs', // run analysis over a source/window
    'simulate_logs', // trigger simulator agent
    'invoke_application', // hit a real app endpoint (e.g. scp)
    'unknown',
  ]),
  targetAgent: CollaboratorAgent.optional(),
  /** Concrete downstream application name (e.g. "scp"). */
  targetApplication: z.string().optional(),
  sources: z.array(LogSourceType).default([]),
  /** Extracted parameters for the collaborator (time range, filters, payload). */
  parameters: z.record(z.string(), z.unknown()).default({}),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

/** Standard action-group event contract (Bedrock Agent -> Lambda). */
export const ActionGroupEvent = z.object({
  actionGroup: z.string(),
  apiPath: z.string(),
  httpMethod: z.string(),
  parameters: z
    .array(z.object({ name: z.string(), type: z.string(), value: z.string() }))
    .default([]),
  requestBody: z.unknown().optional(),
  sessionAttributes: z.record(z.string(), z.string()).default({}),
});
export type ActionGroupEvent = z.infer<typeof ActionGroupEvent>;

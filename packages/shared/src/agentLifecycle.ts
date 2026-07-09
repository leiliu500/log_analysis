/**
 * A stateful ingestion agent. One agent tracks one request through its lifecycle,
 * correlated by messageId:
 *   awaiting_ack      → spawned on REQUEST, waiting for its ACK          (active)
 *   awaiting_response → ACK succeeded, waiting for its RESPONSE          (active)
 *   completed         → RESPONSE received                               (inactive)
 *   failed            → ACK/RESPONSE carried a failure ackCode          (inactive)
 *   error             → timed out waiting                               (inactive)
 */
export const AGENT_ACTIVE_STATUSES = ['awaiting_ack', 'awaiting_response'] as const;
export const AGENT_TERMINAL_STATUSES = ['completed', 'failed', 'error'] as const;
export type AgentLifecycleStatus =
  | (typeof AGENT_ACTIVE_STATUSES)[number]
  | (typeof AGENT_TERMINAL_STATUSES)[number];

export interface Agent {
  /** Correlation id — the request's messageId. */
  messageId: string;
  status: AgentLifecycleStatus;
  active: boolean;
  source?: string;
  logGroup?: string;
  requestTs?: number;
  ackTs?: number;
  responseTs?: number;
  ackCode?: string;
  severity?: string;
  /** Human note on why it closed (or what it's waiting for). */
  detail?: string;
  spawnedAt: number;
  updatedAt: number;
  closedAt?: number;
}

export const isAgentActive = (s: AgentLifecycleStatus): boolean =>
  s === 'awaiting_ack' || s === 'awaiting_response';

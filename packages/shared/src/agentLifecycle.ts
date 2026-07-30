/**
 * A stateful ingestion agent. One agent tracks one transaction through its
 * lifecycle, correlated by messageId. The set of phases it moves through is
 * defined by the application's TransactionProtocol (not hardcoded), so the shape
 * generalizes across apps — e.g. SCP is REQUEST → ACK → RESPONSE, while another
 * app may be REQUEST → RESPONSE only.
 *
 *   awaiting   → spawned on the initial message; waiting for the next phase (active)
 *   completed  → all phases received                                        (inactive)
 *   failed     → a phase carried a failure ackCode                          (inactive)
 *   error      → timed out waiting for a phase                              (inactive)
 */
export const AGENT_ACTIVE_STATUSES = ['awaiting'] as const;
export const AGENT_TERMINAL_STATUSES = ['completed', 'failed', 'error'] as const;
export type AgentLifecycleStatus =
  | (typeof AGENT_ACTIVE_STATUSES)[number]
  | (typeof AGENT_TERMINAL_STATUSES)[number];

export interface Agent {
  /** Correlation id — the transaction's messageId. */
  messageId: string;
  /** Owning application id (e.g. 'scp', 'apiflc'). */
  application?: string;
  status: AgentLifecycleStatus;
  active: boolean;
  /** The phase this agent is currently awaiting (protocol phase name), while active. */
  waitingFor?: string;
  /** The protocol's ordered phases (initial first), for progress rendering. */
  phases: string[];
  /** Phase name → timestamp of the message that satisfied it. */
  phaseTs: Record<string, number>;
  source?: string;
  logGroup?: string;
  /** The decisive ackCode (the one that failed, or the latest seen). */
  ackCode?: string;
  severity?: string;
  /** Human note on why it closed (or what it's waiting for). */
  detail?: string;
  /**
   * When the transaction STARTED, read from its initiating log line — i.e. DATA time,
   * not wall-clock. For live traffic the two are close; for replayed, back-filled, or
   * late-delivered logs they can be hours apart. See {@link firstSeenAt}.
   */
  spawnedAt: number;
  updatedAt: number;
  /**
   * WALL-CLOCK time at which the engine first observed this transaction, set once on
   * spawn and never moved. It exists because the inactivity timeout previously compared
   * wall-clock `now` against {@link spawnedAt}/`phaseTs`, which are LOG timestamps — so
   * any transaction whose logs were already older than the timeout when ingested was
   * closed as "timed out" by the very first poll that saw it, and could never exist as
   * an active agent. That silently killed every incomplete transaction in a simulated,
   * back-filled, or catch-up ingest. The timeout now additionally requires that the
   * engine has actually WATCHED the transaction for a full timeout window, which is what
   * "inactivity" was always meant to mean.
   */
  firstSeenAt?: number;
  closedAt?: number;
}

export const isAgentActive = (s: AgentLifecycleStatus): boolean => s === 'awaiting';

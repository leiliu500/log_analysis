import type { ParsedLog } from './logs.js';
import type { TransactionProtocol } from './transactionProtocol.js';

/**
 * An application onboarded to the platform (e.g. SCP, apiflc). It declares which
 * CloudWatch log groups it owns and the {@link TransactionProtocol} that shapes
 * its transactions. The concrete definition lives in the application's own
 * package (`@log/app-scp`, `@log/app-apiflc`); the platform engine is generic and
 * resolves the right application/protocol per log via an {@link ApplicationRegistry}.
 */
export interface ApplicationDef {
  /** Stable id, e.g. 'scp', 'apiflc'. */
  id: string;
  displayName: string;
  /** CloudWatch log groups this application owns (matched exact or by prefix). */
  logGroups: readonly string[];
  protocol: TransactionProtocol;
  /**
   * Path (relative to the `prompts/` root) of THIS application's regular-agent
   * transaction prompt (e.g. 'apps/scp/transaction.md') — the human-readable spec
   * of how its ingestion agent tracks a transaction through the protocol phases
   * (spawn, advance, close on failure/complete/timeout). Owned by the app package
   * and shipped with the runtime, kept fully separate from every other app's. The
   * generic engine still runs off {@link TransactionProtocol}; this documents the
   * per-app lifecycle beside the {@link ApplicationValidation} spec.
   */
  transactionPromptPath?: string;

  // ---- Simulator support (each application supplies its own) ----
  /** Detect this application's target log group named in a message (names/keywords). */
  matchLogGroup?(message: string): string | undefined;
  /**
   * Split a multi-group paste into per-log-group segments — for apps whose input
   * can name several target groups at once (e.g. apiflc's handler / authorizer /
   * API-Gateway-execution logs). Returns [] / undefined when the input is a
   * single-group request.
   */
  splitByLogGroup?(message: string): Array<{ group: string; samples: string }>;

  /**
   * Every log record belonging to the same call as `id`, resolved across this
   * application's log groups by their shared identifiers. For apps whose groups key
   * the same call by DIFFERENT ids, a question about one id ("the authorizer result
   * for correlationID 1234") cannot be answered from records carrying that id —
   * apiflc's authorizer log, for one, never mentions the correlationID. This hook
   * follows the app's own id chain so the Log Assistant is handed the whole call.
   * Returns [] when the id resolves to nothing; apps whose groups share one id need
   * not implement it.
   */
  relatedLogs?(id: string, logs: readonly ParsedLog[]): ParsedLog[];
  /** Sample log content the simulator writes when the user pastes none. */
  defaultSamples?: string;
  /**
   * What this application calls its correlation id — for display. SCP uses
   * 'messageId'; apiflc correlates by 'correlationID'. Defaults to 'messageId'.
   */
  correlationLabel?: string;
  /**
   * How the simulator treats this app: 'cashMessage' = the correlated
   * REQUEST/ACK/RESPONSE set model (SCP XML); 'verbatim' = write the pasted
   * samples (or defaultSamples) to the log group as-is (e.g. apiflc's raw
   * Lambda / API-Gateway logs). Defaults to 'cashMessage'.
   */
  simulationMode?: 'cashMessage' | 'verbatim';
  /**
   * Path (relative to the `prompts/` root) of THIS application's own Simulator
   * understanding-agent prompt. The prompt is application-specific — it knows
   * this app's log shape and correlation field, and extracts the correlation
   * id(s) from a pasted sample. Each app owns its own prompt (e.g. apiflc reads
   * its `correlationID`); apps whose correlation needs no LLM extraction (e.g.
   * scp reads `messageId` straight from the cashMessage XML) leave it unset.
   */
  simulateUnderstandingPromptPath?: string;

  // ---- Log Assistant support (each application supplies its own) ----
  /**
   * Path (relative to the `prompts/` root) of this application's Log Assistant
   * prompt — the grounded-Q&A system prompt used when a user's question is
   * routed to this application. Falls back to a generic prompt when absent.
   */
  assistantPromptPath?: string;
  /**
   * Per-application extraction of the Log Assistant's view of one log: the
   * message phase, its own id (for display), the transaction's correlation id
   * (groups a request with its follow-ups), and any ackCode. When absent, the
   * assistant derives this from {@link TransactionProtocol.eventOf} (id = corrId).
   * SCP supplies its own so the assistant keeps the richer messageId vs
   * initMessageId distinction.
   */
  assistantMeta?(log: ParsedLog): AssistantMeta | undefined;

  // ---- Validation agent support (each application supplies its own) ----
  /**
   * This application's validation spec. The autonomous validation poller uses it
   * to check, per app and with no human interaction, that every regular agent's
   * transaction is consistent: all protocol phases accounted for AND the final
   * response received within this app's SLA. Absent ⇒ the validator only checks
   * the finding/level invariant (no phase/SLA checks).
   */
  validation?: ApplicationValidation;
}

/** An application's validation rules — its own `validation.md` spec, made executable. */
export interface ApplicationValidation {
  /**
   * Path (relative to the `prompts/` root) of THIS application's validation prompt
   * (e.g. 'apps/scp/validation.md') — the human-readable spec of what its
   * validation agent checks (phases + timeout). Shipped with the runtime like the
   * other app prompts and shown/loaded by name.
   */
  promptPath: string;
  /**
   * Minutes allowed to receive the final RESPONSE that completes the transaction,
   * measured from {@link responseTimeoutFrom}. An active transaction past this
   * budget is overdue; a completed one whose RESPONSE arrived later than this
   * breached its SLA. (SCP: 30 min after ACK; apiflc: 2 min after REQUEST.)
   */
  responseTimeoutMinutes: number;
  /**
   * The protocol phase the response-timeout clock starts from — SCP measures the
   * 30-minute budget from 'ACK', apiflc measures its 2-minute budget from 'REQUEST'.
   */
  responseTimeoutFrom: string;
}

/** What the Log Assistant reads from one log for an application. */
export interface AssistantMeta {
  /** Phase name — e.g. REQUEST | ACK | RESPONSE — if this is a transaction message. */
  type?: string;
  /** This message's own id (for display / listing). */
  id?: string;
  /** The transaction's correlation id — groups a request with its follow-ups. */
  corrId?: string;
  ackCode?: string;
}

/**
 * The set of installed applications. Built at the composition root from the app
 * packages, then passed into the analysis engine so a single ingest pass can
 * handle many applications — each log is routed to its owning application's
 * protocol (SCP: REQUEST→ACK→RESPONSE, apiflc: REQUEST→RESPONSE, …).
 */
export class ApplicationRegistry {
  private readonly apps: ApplicationDef[] = [];

  register(app: ApplicationDef): this {
    if (!this.apps.some((a) => a.id === app.id)) this.apps.push(app);
    return this;
  }

  all(): ApplicationDef[] {
    return [...this.apps];
  }

  ids(): string[] {
    return this.apps.map((a) => a.id);
  }

  byId(id?: string | null): ApplicationDef | undefined {
    return id ? this.apps.find((a) => a.id === id) : undefined;
  }

  /**
   * The application that owns a log group — exact match first, then prefix (API
   * Gateway execution-log groups carry a trailing "/<stage>" path).
   */
  forLogGroup(group?: string | null): ApplicationDef | undefined {
    if (!group) return undefined;
    return this.apps.find((a) => a.logGroups.some((g) => group === g || group.startsWith(g)));
  }

  /**
   * The application for a parsed log: by its log group (stream), else by whichever
   * application's protocol recognizes the log content.
   */
  forLog(log: ParsedLog): ApplicationDef | undefined {
    return this.forLogGroup(log.stream) ?? this.apps.find((a) => a.protocol.eventOf(log));
  }

  /** True if any application's protocol recognizes this log as a transaction message. */
  isTransactionLog(log: ParsedLog): boolean {
    return this.apps.some((a) => a.protocol.eventOf(log) !== undefined);
  }

  /** Every log group across all applications (for connector configuration). */
  allLogGroups(): string[] {
    return this.apps.flatMap((a) => [...a.logGroups]);
  }

  /**
   * Resolve the target log group + owning application from a message (used by the
   * simulator to route to the right app). Tries each app's own matcher first,
   * then a literal log-group-name match across all apps.
   */
  matchLogGroup(message: string): { group: string; app: ApplicationDef } | undefined {
    for (const app of this.apps) {
      const g = app.matchLogGroup?.(message);
      if (g) return { group: g, app };
    }
    for (const app of this.apps) {
      for (const g of app.logGroups) {
        if (message.includes(g)) return { group: g, app };
      }
    }
    return undefined;
  }
}

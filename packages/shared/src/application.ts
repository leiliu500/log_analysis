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
}

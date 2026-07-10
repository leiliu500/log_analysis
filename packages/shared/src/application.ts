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

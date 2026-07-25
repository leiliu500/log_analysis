import type { ApplicationDef } from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converseJson } from './bedrock.js';
import type { AgentEvent } from './agentLifecycle.js';

/**
 * The DYNAMIC ingestion lifecycle: reason a transaction's next state from the app's
 * `transaction.md` spec over its correlated raw logs, instead of the deterministic
 * state machine. Dispatched per application (each app's own spec is the prompt).
 *
 * Extraction/correlation stay deterministic (`protocol.eventOf` produces the events +
 * phaseTs), so the validation worker keeps an INDEPENDENT non-LLM view that catches a
 * bad transition. Every model failure falls back to {@link deterministicDecision}, so
 * ingestion can never be blocked or corrupted by the LLM.
 */

export interface TransitionDecision {
  status: 'awaiting' | 'completed' | 'failed' | 'error';
  /** The next phase awaited (only when status is 'awaiting'). */
  waitingFor?: string;
  /** Severity for a non-completed close (failed ⇒ high, timeout/error ⇒ medium). */
  severity?: 'high' | 'medium';
  detail: string;
  /** True when the decision came from the deterministic fallback (model unavailable/errored). */
  fallback?: boolean;
}

export interface TransitionInput {
  messageId: string;
  /** Current persisted status ('new' when the transaction has not been spawned yet). */
  currentStatus: string;
  /** Phase → first-seen timestamp, accumulated deterministically from eventOf. */
  phaseTs: Record<string, number>;
  /** The decisive ackCode seen so far, if any. */
  ackCode?: string;
  /** The new correlated events this cycle (deterministic extraction), oldest first. */
  events: AgentEvent[];
  now: number;
}

// Load + cache each app's transaction.md spec (the LLM system prompt).
const specCache = new Map<string, string | null>();
function specFor(app: ApplicationDef): string | null {
  if (!specCache.has(app.id)) {
    let spec: string | null = null;
    try {
      spec = app.transactionPromptPath ? loadPrompt(app.transactionPromptPath) : null;
    } catch {
      spec = null; // missing spec ⇒ deterministic decision, never crash ingestion
    }
    specCache.set(app.id, spec);
  }
  return specCache.get(app.id) ?? null;
}

/** The deterministic transition decision — mirrors `stepAgents`, used as the fallback. */
export function deterministicDecision(app: ApplicationDef, phaseTs: Record<string, number>, ackCode?: string): TransitionDecision {
  const proto = app.protocol;
  if (ackCode && !proto.isSuccess(ackCode)) {
    return { status: 'failed', severity: 'high', detail: `failure ackCode ${ackCode}`, fallback: true };
  }
  const remaining = proto.phases.filter((p) => phaseTs[p] === undefined);
  if (remaining.length === 0) return { status: 'completed', detail: 'all phases received', fallback: true };
  return { status: 'awaiting', waitingFor: remaining[0], detail: `awaiting ${remaining[0]}`, fallback: true };
}

const VALID = new Set(['awaiting', 'completed', 'failed', 'error']);

/**
 * Reason the transaction's new lifecycle state from `transaction.md`. `reasoner` is
 * injectable for tests; it defaults to a Bedrock structured-output call. On ANY error
 * (or an app with no spec) it returns the deterministic decision, so the caller always
 * gets a valid transition.
 */
export async function reasonTransition(
  app: ApplicationDef,
  input: TransitionInput,
  reasoner: (system: string, user: string) => Promise<Partial<TransitionDecision>> = defaultReasoner,
): Promise<TransitionDecision> {
  const spec = specFor(app);
  if (!spec) return deterministicDecision(app, input.phaseTs, input.ackCode);

  const user = [
    `Transaction: ${input.messageId} (application ${app.id})`,
    `Protocol phases, in order: ${app.protocol.allPhases.join(' -> ')}`,
    `Current status: ${input.currentStatus}`,
    `Phases received so far: ${Object.keys(input.phaseTs).join(', ') || '(none)'}`,
    '',
    'New log events this cycle (oldest first) — reason over these per the spec above:',
    ...input.events.map(
      (e) => `  - phase=${e.type}${e.ackCode ? ` ackCode=${e.ackCode}` : ''} @ ${new Date(e.ts).toISOString()}\n    log: ${(e.raw ?? '').slice(0, 500)}`,
    ),
    '',
    'Decide this transaction\'s NEW lifecycle state. Respond ONLY with JSON:',
    '{ "status": "awaiting" | "completed" | "failed" | "error", "waitingFor": "<next phase or null>", "severity": "high" | "medium" | null, "detail": "<short reason>" }',
  ].join('\n');

  try {
    const out = await reasoner(spec, user);
    const status = VALID.has(out.status as string) ? (out.status as TransitionDecision['status']) : undefined;
    if (!status) return deterministicDecision(app, input.phaseTs, input.ackCode);
    return {
      status,
      waitingFor: status === 'awaiting' ? out.waitingFor ?? undefined : undefined,
      severity: out.severity === 'high' || out.severity === 'medium' ? out.severity : status === 'failed' ? 'high' : status === 'error' ? 'medium' : undefined,
      detail: out.detail ?? `reasoned ${status}`,
    };
  } catch (err) {
    console.error(`reasonTransition: model failed for ${input.messageId}, falling back`, (err as Error).message);
    return deterministicDecision(app, input.phaseTs, input.ackCode);
  }
}

const defaultReasoner = (system: string, user: string): Promise<Partial<TransitionDecision>> =>
  converseJson<Partial<TransitionDecision>>(user, { system, temperature: 0, maxTokens: 400 });

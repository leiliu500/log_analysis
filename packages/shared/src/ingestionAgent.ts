import type { AgentPromptContext } from './application.js';
import { loadPrompt } from './prompts.js';

/**
 * The dynamic ingestion agent contract. Each application OWNS its agent: given a
 * transaction's context it assembles its own evidence (correlating its own logs) and
 * reasons the next lifecycle state from its `transaction.md`. The platform engine only
 * dispatches — it holds no per-application logic. The model call is INJECTED as
 * {@link TransitionReasoner} so an app agent never depends on Bedrock (or on the engine
 * package), keeping the dependency arrow app → shared only.
 */

export interface TransitionDecision {
  status: 'awaiting' | 'completed' | 'failed' | 'error';
  /** The next phase awaited (only when status is 'awaiting'). */
  waitingFor?: string;
  /** Severity for a non-completed close (failed ⇒ high, timeout/error ⇒ medium). */
  severity?: 'high' | 'medium';
  detail: string;
}

/** The structured-output model call, injected by the engine (defaults to Bedrock there). */
export type TransitionReasoner = (system: string, user: string) => Promise<Partial<TransitionDecision>>;

/** An application's dynamic ingestion agent — it decides one transaction's transition. */
export interface IngestionAgent {
  /**
   * Reason this transaction's NEW lifecycle state. Return `null` to make NO transition
   * this poll (model error, or evidence insufficient) — the engine then leaves the agent
   * unchanged and retries next poll; a genuinely stuck agent is still closed by the
   * wall-clock timeout. So a model failure only defers a transition, never forces a wrong one.
   */
  decide(ctx: AgentPromptContext, reason: TransitionReasoner): Promise<TransitionDecision | null>;
  /**
   * The DETERMINISTIC fast path: decide this transition without a model when — and only
   * when — the evidence makes it unambiguous. Return `null` to defer to {@link decide},
   * which is what genuinely ambiguous evidence must do.
   *
   * This exists because one model call per transition is what bounds ingestion
   * throughput: the poll is capped at `INGEST_DYNAMIC_MAX` reasoned transitions, so at a
   * 5-minute cadence the ceiling is ~480/hour no matter how much hardware is behind it.
   * Worse, overload does not surface as an error — deferred agents eventually trip their
   * inactivity timeout and are closed as `error`, which the validation worker then passes
   * as consistent (a timeout carrying its medium anomaly satisfies the invariant). A
   * capacity problem silently becomes thousands of "legitimately timed out" transactions.
   *
   * It is per-APPLICATION, not generic, because "the completing phase arrived" means
   * different things per app: for SCP the deciding ackCode rides on the protocol event,
   * while for apiflc the decisive HTTP status lives only in the gateway execution log and
   * a bare RESPONSE line proves nothing. A generic rule would mark an apiflc 500 as
   * completed — exactly the mis-recorded outcome the validation engine exists to catch.
   *
   * MUST be pure and synchronous: it runs for every transaction in the poll, before any
   * concurrency limit, so it may not do I/O. Anything requiring a lookup belongs in
   * {@link decide}. A fast-path transition does NOT consume the reasoning budget.
   */
  fastPath?(ctx: AgentPromptContext): TransitionDecision | null;
}

const VALID = new Set(['awaiting', 'completed', 'failed', 'error']);
const specCache = new Map<string, string | null>();

/** The JSON response contract every app's agent shares (appended to its evidence). */
const RESPONSE_CONTRACT = [
  "Decide this transaction's NEW lifecycle state. Respond ONLY with JSON:",
  '{ "status": "awaiting" | "completed" | "failed" | "error", "waitingFor": "<next phase or null>", "severity": "high" | "medium" | null, "detail": "<short reason>" }',
].join('\n');

/**
 * The generic engine an app agent calls: load the app's `transaction.md` (the system
 * prompt), prompt the injected reasoner with the app-built `evidence`, and normalize the
 * reply to a {@link TransitionDecision}. This holds NOTHING app-specific — the evidence
 * (which logs, how correlated, what to read) is the app's; this only runs the model and
 * validates the shape. Returns `null` on any error or a missing spec.
 */
export async function decideFromSpec(
  transactionPromptPath: string | undefined,
  evidence: string,
  reason: TransitionReasoner,
): Promise<TransitionDecision | null> {
  const key = transactionPromptPath ?? '';
  if (!specCache.has(key)) {
    let spec: string | null = null;
    try {
      spec = transactionPromptPath ? loadPrompt(transactionPromptPath) : null;
    } catch {
      spec = null; // missing spec ⇒ no transition this poll, never crash ingestion
    }
    specCache.set(key, spec);
  }
  const spec = specCache.get(key) ?? null;
  if (!spec) return null;

  const user = `${evidence}\n\n${RESPONSE_CONTRACT}`;
  try {
    const out = await reason(spec, user);
    const status = VALID.has(out.status as string) ? (out.status as TransitionDecision['status']) : undefined;
    if (!status) return null;
    return {
      status,
      waitingFor: status === 'awaiting' ? out.waitingFor ?? undefined : undefined,
      severity:
        out.severity === 'high' || out.severity === 'medium'
          ? out.severity
          : status === 'failed'
            ? 'high'
            : status === 'error'
              ? 'medium'
              : undefined,
      detail: out.detail ?? `reasoned ${status}`,
    };
  } catch (err) {
    console.error('decideFromSpec: model failed, no transition this poll', (err as Error).message);
    return null;
  }
}

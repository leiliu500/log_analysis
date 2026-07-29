import type { ParsedLog } from './logs.js';
import { Severity } from './anomalies.js';
import { loadPrompt } from './prompts.js';

/**
 * The per-application VALIDATION AI agent contract — an LLM reviewer bolted onto the
 * deterministic validation engine WITHOUT giving it authority over any verdict.
 *
 * Three rules make an LLM safe here, and all three are enforced by code in this file
 * (and by the driver in `validationLifecycle`), never by the prompt:
 *
 *  1. IT PROPOSES, IT DOES NOT DECIDE. The agent may only emit {@link ValidationClaim}s.
 *     A claim is never a validation verdict: it cannot turn a deterministic `success`
 *     into a `failure`, and it cannot silence a deterministic `failure`. Its output is
 *     surfaced as its own result (`ai_suspected`) and its own counters, so the two
 *     populations — proven and suspected — are never mixed.
 *
 *  2. IT ONLY SEES THE RESIDUAL. The driver invokes it exclusively for transactions the
 *     deterministic engine could NOT decide from positive evidence (it emitted no delta
 *     AND could not re-derive the outcome from the logs). It is never asked about a
 *     transaction that already has a proven verdict, so its error rate applies only to
 *     the set nobody was checking before — it can reduce false negatives, and it is
 *     structurally incapable of adding a false positive to the passing set.
 *
 *  3. EVERY CLAIM IS RE-EXECUTED BEFORE IT IS ADMITTED. A claim must cite real
 *     `parsed_logs` ids from THIS transaction and carry {@link ClaimPredicate}s — a
 *     machine-checkable witness. {@link admitClaim} re-runs every predicate against the
 *     actual log rows and DISCARDS the whole claim if any citation or predicate fails.
 *     A hallucinated log id, a fabricated field value, or an invented quote therefore
 *     cannot survive admission: the failure mode collapses from "false positive" to
 *     "dropped finding", which is the cheaper error. Discards are counted, so the
 *     hallucination rate is observable in production rather than assumed.
 *
 * Like {@link IngestionAgent}, the model call is INJECTED ({@link ValidationReasoner}) so
 * an app package never depends on Bedrock or on the engine package.
 */

/** The log field a predicate reads. `raw` falls back to `message` when absent. */
export type ClaimField = 'raw' | 'message' | 'level' | 'stream' | 'source' | 'timestamp';

/** The comparison a predicate applies. `lt`/`gt` are numeric (timestamp only). */
export type ClaimOp = 'contains' | 'not_contains' | 'equals' | 'matches' | 'lt' | 'gt';

/**
 * One machine-checkable assertion about one log line — the WITNESS that makes a claim
 * admissible. The engine re-executes it against the real `parsed_logs` row; a claim
 * whose witness does not hold is discarded rather than repaired.
 */
export interface ClaimPredicate {
  /** A `parsed_logs` id that MUST also appear in the claim's `evidenceLogIds`. */
  logId: string;
  field: ClaimField;
  op: ClaimOp;
  /** Compared as a string, except `lt`/`gt` which parse it as a number. */
  value: string;
}

/** What the validation AI agent is allowed to emit. Never a verdict — only a claim. */
export interface ValidationClaim {
  /** Short kebab-case class of problem, e.g. 'response-without-request'. */
  kind: string;
  /** One-sentence statement of the suspected problem. */
  title: string;
  severity: Severity;
  /** `parsed_logs` ids from THIS transaction that evidence the claim. */
  evidenceLogIds: string[];
  /** The re-executable witness. A claim with none is inadmissible. */
  predicates: ClaimPredicate[];
  detail?: string;
  /**
   * The generalizable rule this claim is an instance of — the agent's proposal for a
   * DETERMINISTIC check that would catch the whole class without an LLM. Recurring
   * proposals are the promotion queue: a human turns a frequent one into an app's
   * `ApplicationValidation.checks` and the model is out of that loop for good.
   */
  proposedRule?: { id: string; title: string; rationale: string };
}

/** A claim that survived {@link admitClaim} — every citation and predicate re-verified. */
export interface AiValidationFinding {
  kind: string;
  title: string;
  severity: Severity;
  detail?: string;
  evidenceLogIds: string[];
  /** How many predicates were re-executed and held (all of them — a partial fails). */
  verifiedPredicates: number;
  proposedRule?: { id: string; title: string; rationale: string };
}

/** The outcome of one transaction's AI review — admitted findings plus what was discarded. */
export interface AiReviewOutcome {
  findings: AiValidationFinding[];
  /** Claims the admission gate discarded, with the reason (hallucination observability). */
  rejected: Array<{ title: string; reason: string }>;
}

/** The structured-output model call, injected by the engine (Bedrock there). */
export type ValidationReasoner = (system: string, user: string) => Promise<{ claims?: ValidationClaim[] }>;

/**
 * Everything an app's validation agent is given about ONE residual transaction. The
 * deterministic conclusion is included so the agent knows what has already been proven
 * and must not restate — it is here to be respected, not revisited.
 */
export interface ValidationAgentInput {
  messageId: string;
  application?: string;
  /** The lifecycle status the ingestion agent recorded. */
  agentStatus: string;
  /** The transaction's logs, resolved by the app's own cross-log-group join. */
  relatedLogs: readonly ParsedLog[];
  /** The deterministic engine's result for this transaction (always a passing one). */
  deterministicResult: string;
  deterministicDetail?: string;
  /** Why the deterministic engine could not decide from positive evidence. */
  residualReason: string;
  phases: string[];
  phaseTs: Record<string, number>;
}

/** An application's validation AI agent — it reviews ONE residual transaction. */
export interface ValidationAgentDef {
  /**
   * Review a residual transaction and return only ADMITTED findings. Never throws and
   * never returns a verdict: on a model error, an unparseable reply, or a claim that
   * fails re-verification, the transaction is simply left as the deterministic engine
   * decided it.
   */
  review(input: ValidationAgentInput, reason: ValidationReasoner): Promise<AiReviewOutcome>;
}

// ---------------------------------------------------------------------------
// The admission gate — the deterministic half of the design.
// ---------------------------------------------------------------------------

/** Cap the work a single reply can create (a runaway reply must not stall the poller). */
const MAX_CLAIMS = 8;
const MAX_PREDICATES = 10;
/** Bound regex work: model-supplied patterns run against bounded strings only. */
const MAX_PATTERN_LEN = 200;
const MAX_SUBJECT_LEN = 4000;

const EMPTY: AiReviewOutcome = { findings: [], rejected: [] };

function fieldValue(log: ParsedLog, field: ClaimField): string | number | undefined {
  switch (field) {
    case 'raw':
      return log.raw ?? log.message;
    case 'message':
      return log.message;
    case 'level':
      return log.level;
    case 'stream':
      return log.stream;
    case 'source':
      return log.source;
    case 'timestamp':
      return log.timestamp;
    default:
      return undefined;
  }
}

/**
 * Re-execute ONE predicate against the real log row. Anything ambiguous — an unknown
 * field, a bad regex, a non-numeric comparison — is FALSE, never true: the gate must
 * only ever admit on positive proof, mirroring `deriveOutcome`'s "absence never speaks".
 */
export function evaluatePredicate(p: ClaimPredicate, log: ParsedLog): boolean {
  const raw = fieldValue(log, p.field);
  if (raw === undefined || raw === null) return false;

  if (p.op === 'lt' || p.op === 'gt') {
    const lhs = typeof raw === 'number' ? raw : Number(raw);
    const rhs = Number(p.value);
    if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return false;
    return p.op === 'lt' ? lhs < rhs : lhs > rhs;
  }

  const subject = String(raw).slice(0, MAX_SUBJECT_LEN);
  const value = typeof p.value === 'string' ? p.value : String(p.value ?? '');
  if (!value) return false;

  switch (p.op) {
    case 'contains':
      return subject.toLowerCase().includes(value.toLowerCase());
    case 'not_contains':
      return !subject.toLowerCase().includes(value.toLowerCase());
    case 'equals':
      return subject === value;
    case 'matches': {
      if (value.length > MAX_PATTERN_LEN) return false;
      try {
        return new RegExp(value, 'i').test(subject);
      } catch {
        return false; // an uncompilable pattern proves nothing
      }
    }
    default:
      return false;
  }
}

const KIND_RE = /[^a-z0-9-]+/g;

/**
 * The gate: admit a claim ONLY if every citation resolves to a real log of THIS
 * transaction and every predicate re-executes true. Returns the reason on rejection so
 * the discard rate is reportable instead of silent.
 */
export function admitClaim(
  claim: ValidationClaim,
  byId: ReadonlyMap<string, ParsedLog>,
): { ok: true; finding: AiValidationFinding } | { ok: false; reason: string } {
  const title = typeof claim?.title === 'string' ? claim.title.trim() : '';
  if (!title) return { ok: false, reason: 'no title' };

  const ids = Array.isArray(claim.evidenceLogIds) ? claim.evidenceLogIds.filter((i) => typeof i === 'string') : [];
  if (!ids.length) return { ok: false, reason: 'cites no evidence log' };
  // A cited id that is not part of this transaction's logs is a fabrication — the
  // single most likely hallucination, and the cheapest one to catch.
  const unknown = ids.find((id) => !byId.has(id));
  if (unknown) return { ok: false, reason: `cites unknown logId ${unknown}` };

  const preds = Array.isArray(claim.predicates) ? claim.predicates : [];
  if (!preds.length) return { ok: false, reason: 'no verifiable predicate' };
  if (preds.length > MAX_PREDICATES) return { ok: false, reason: `too many predicates (${preds.length})` };

  const cited = new Set(ids);
  for (const p of preds) {
    if (!p || typeof p.logId !== 'string') return { ok: false, reason: 'predicate has no logId' };
    // A predicate must test a log the claim actually cites, so the witness and the
    // evidence trail can never diverge.
    if (!cited.has(p.logId)) return { ok: false, reason: `predicate logId ${p.logId} is not cited as evidence` };
    const log = byId.get(p.logId);
    if (!log) return { ok: false, reason: `predicate cites unknown logId ${p.logId}` };
    if (!evaluatePredicate(p, log)) {
      return { ok: false, reason: `predicate failed: ${p.field} ${p.op} "${String(p.value).slice(0, 60)}" on ${p.logId}` };
    }
  }

  // Severity and kind are labels, not factual assertions — normalize rather than reject.
  const severity = Severity.options.includes(claim.severity as Severity) ? (claim.severity as Severity) : 'medium';
  const kind = (typeof claim.kind === 'string' ? claim.kind : '').toLowerCase().replace(KIND_RE, '-').replace(/^-|-$/g, '');

  const rule = claim.proposedRule;
  return {
    ok: true,
    finding: {
      kind: kind || 'ai-claim',
      title: title.slice(0, 300),
      severity,
      detail: typeof claim.detail === 'string' ? claim.detail.slice(0, 1000) : undefined,
      evidenceLogIds: [...new Set(ids)],
      verifiedPredicates: preds.length,
      proposedRule:
        rule && typeof rule.title === 'string' && rule.title.trim()
          ? {
              id: (typeof rule.id === 'string' ? rule.id : '').toLowerCase().replace(KIND_RE, '-').replace(/^-|-$/g, '') || kind || 'ai-rule',
              title: rule.title.slice(0, 200),
              rationale: (typeof rule.rationale === 'string' ? rule.rationale : '').slice(0, 500),
            }
          : undefined,
    },
  };
}

/** Run the gate over a whole reply. Nothing that fails is repaired, retried, or partially kept. */
export function admitClaims(
  claims: readonly ValidationClaim[] | undefined,
  relatedLogs: readonly ParsedLog[],
): AiReviewOutcome {
  if (!Array.isArray(claims) || !claims.length) return EMPTY;
  const byId = new Map(relatedLogs.map((l) => [l.id, l]));
  const findings: AiValidationFinding[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  for (const c of claims.slice(0, MAX_CLAIMS)) {
    const verdict = admitClaim(c, byId);
    if (verdict.ok) findings.push(verdict.finding);
    else rejected.push({ title: (c?.title ?? '(untitled)').toString().slice(0, 120), reason: verdict.reason });
  }
  return { findings, rejected };
}

// ---------------------------------------------------------------------------
// The generic driver an app agent calls.
// ---------------------------------------------------------------------------

/** The JSON response contract every app's validation agent shares. */
const RESPONSE_CONTRACT = [
  'Respond ONLY with JSON of this exact shape (an empty list is the correct and expected',
  'answer whenever the logs do not PROVE a problem):',
  '{ "claims": [ {',
  '    "kind": "<short-kebab-case-class>",',
  '    "title": "<one sentence stating the suspected problem>",',
  '    "severity": "info" | "low" | "medium" | "high" | "critical",',
  '    "detail": "<why the cited logs show this>",',
  '    "evidenceLogIds": ["<logId from the LOGS list above>", ...],',
  '    "predicates": [ { "logId": "<one of evidenceLogIds>", "field": "raw" | "message" | "level" | "stream" | "source" | "timestamp",',
  '                      "op": "contains" | "not_contains" | "equals" | "matches" | "lt" | "gt", "value": "<literal>" } ],',
  '    "proposedRule": { "id": "<kebab-case-rule-id>", "title": "<the general rule>", "rationale": "<why it generalizes>" }',
  '} ] }',
  '',
  'Every claim is RE-EXECUTED against the real log rows before it is recorded: each',
  'evidenceLogId must be one of the ids listed above, every predicate must reference one',
  'of your own evidenceLogIds, and every predicate must actually hold. A claim with an',
  'invented id, an inexact quoted value, or a predicate that does not hold is discarded',
  'in full — you cannot argue it back. Quote values EXACTLY as they appear in the log',
  'line. Prefer no claim over an unproven one.',
].join('\n');

/**
 * The generic engine an app's validation agent calls: load the app's validation-agent
 * spec (the system prompt), prompt the injected reasoner with the app-built `evidence`,
 * and admit only the claims that re-verify against the transaction's real logs. Holds
 * NOTHING app-specific — which logs, how correlated, and what matters is the app's.
 * Returns an empty outcome (never throws) on a missing spec or any model error.
 */
export async function reviewFromSpec(
  promptPath: string | undefined,
  evidence: string,
  input: ValidationAgentInput,
  reason: ValidationReasoner,
): Promise<AiReviewOutcome> {
  if (!promptPath) return EMPTY;
  let spec: string;
  try {
    spec = loadPrompt(promptPath);
  } catch {
    return EMPTY; // a missing spec means no review, never a crash in the poller
  }
  if (!spec) return EMPTY;

  const user = `${evidence}\n\n${RESPONSE_CONTRACT}`;
  try {
    const out = await reason(spec, user);
    return admitClaims(out?.claims, input.relatedLogs);
  } catch (err) {
    console.error(
      `validation AI agent: model failed for ${input.messageId}, no review this poll`,
      (err as Error).message,
    );
    return EMPTY;
  }
}

/**
 * Render a transaction's logs with their ids — the shared preamble every app's evidence
 * builder needs, since a claim is only admissible if it cites these exact ids.
 */
export function renderEvidenceLogs(logs: readonly ParsedLog[], max = 40, maxLen = 300): string[] {
  return logs
    .slice(0, max)
    .map((l) => `  [${l.id}] ${new Date(l.timestamp).toISOString()} (${l.stream}) ${(l.raw ?? l.message ?? '').slice(0, maxLen)}`);
}

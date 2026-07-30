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
  /**
   * The predicates themselves, as re-executed. Persisted because a claim's WORDING is
   * not enough to judge it: two prod false positives ("lacks a terminal status line",
   * "sendTime missing seconds") read as findings about the data but were actually
   * assertions about absence, and that was only diagnosable by seeing the operators.
   */
  predicates: ClaimPredicate[];
  proposedRule?: { id: string; title: string; rationale: string };
}

/** The outcome of one transaction's AI review — admitted findings plus what was discarded. */
export interface AiReviewOutcome {
  findings: AiValidationFinding[];
  /** Claims the admission gate discarded, with the reason (hallucination observability). */
  rejected: Array<{ title: string; reason: string }>;
  /**
   * Set when the review could not be completed at all — the model errored, was throttled,
   * or returned a reply too mangled to recover claims from. CRITICALLY DIFFERENT from an
   * empty `findings`: "the agent looked and found nothing" and "the agent never answered"
   * must never render the same way, or a broken model reads as a clean bill of health.
   * A transaction whose review errored is NOT marked reviewed, so the next poll retries it.
   */
  error?: string;
}

/**
 * The model call, injected by the engine (Bedrock there). It returns the reply as RAW
 * TEXT rather than parsed JSON on purpose: the reasoning model's replies can arrive
 * truncated, and parsing them here — beside the admission gate — lets a truncated reply
 * be salvaged for its complete claims ({@link salvageClaims}) instead of being thrown
 * away wholesale by a strict parse in the transport layer.
 */
export type ValidationReasoner = (system: string, user: string) => Promise<string>;

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

/**
 * Cap the work a single reply can create. Kept SMALL on purpose: the configured
 * foundation model is a reasoning model whose hidden tokens share the output budget, and
 * a long claim list is what pushes the JSON past it and gets the whole reply truncated.
 * Three well-evidenced claims are worth more than eight truncated ones.
 */
const MAX_CLAIMS = 3;
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
  /** The transaction's correlation id, so membership-only witnesses can be rejected. */
  correlationId?: string,
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

  // ONLY POSITIVE EVIDENCE SPEAKS — the same rule `deriveOutcome` follows, enforced here
  // rather than left to the prompt. `not_contains` can only establish that ONE cited line
  // does not say something, which proves nothing about the transaction: the lines are an
  // excerpted, windowed subset, so anything absent may simply not have been shown. Left
  // unchecked it lets an absence claim ("no terminal status line", "timestamp missing its
  // seconds") arrive dressed as a verified predicate — both observed in prod. A claim must
  // rest on at least one thing a log line positively SAYS.
  if (preds.every((p) => p?.op === 'not_contains')) {
    return { ok: false, reason: 'no positive evidence — supported only by what a line does not say' };
  }

  // A VACUOUS witness: every predicate only asserts that the line carries this
  // transaction's own correlation id, i.e. that it belongs to the transaction — which
  // the join already established before the agent ever saw it. Such predicates verify
  // perfectly and support nothing. Observed in prod: "Same correlationID used for
  // multiple distinct requests", witnessed by three predicates all checking
  // `contains "correlationID: 5678"`. A witness has to say something the join did not.
  if (correlationId) {
    const id = correlationId.toLowerCase();
    const saysOnlyMembership = (p: ClaimPredicate): boolean => {
      const v = String(p?.value ?? '').toLowerCase();
      // The value carries the id and nothing else of substance (a label like
      // "correlationID: 5678" or "messageId=001" still only asserts membership).
      return v.includes(id) && v.replace(id, '').replace(/[^a-z0-9]/g, '').length <= 14;
    };
    if (preds.every(saysOnlyMembership)) {
      return { ok: false, reason: 'vacuous witness — every predicate only asserts the line belongs to this transaction' };
    }
  }

  // CO-OCCURRENCE IS NOT A DEFECT. If every predicate is the same field/op/value and
  // differs only in which line it runs against, the claim proves exactly one thing: that
  // N lines share a value. That is what a correlation id, a request id, or a trace id is
  // FOR — one call is logged across many lines under one identifier — so it can never be
  // evidence on its own. Observed in prod as "Duplicate API Gateway requestId across
  // invocations", witnessed by the same `contains <requestId>` on two lines of a single
  // call. A real claim needs at least one predicate that says something DIFFERENT.
  if (preds.length > 1) {
    const shape = (p: ClaimPredicate): string => `${p?.field}|${p?.op}|${String(p?.value ?? '').toLowerCase()}`;
    const first = shape(preds[0]!);
    if (preds.every((p) => shape(p) === first)) {
      return { ok: false, reason: 'co-occurrence only — every predicate asserts the same value on a different line' };
    }
  }

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
      predicates: preds.map((p) => ({ logId: p.logId, field: p.field, op: p.op, value: String(p.value).slice(0, 200) })),
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

/**
 * Recover the complete claim objects from a TRUNCATED reply. The reasoning model shares
 * its output budget with hidden reasoning tokens, so a long reply can be cut mid-string —
 * and one unterminated claim would otherwise throw away the complete claims in front of
 * it. This scans the raw text for balanced `{...}` objects (string- and escape-aware) and
 * keeps the ones that parse, dropping any incomplete tail.
 *
 * Salvaging is safe here for the same reason the whole design is: a recovered claim is
 * still just a proposal, and it must still pass {@link admitClaim} against the real log
 * rows. A half-written claim loses its predicates and is discarded by the gate. This can
 * only recover evidence that was fully stated, never invent it.
 */
export function salvageClaims(text: string): ValidationClaim[] {
  const out: ValidationClaim[] = [];
  // A STACK of open-brace positions, not a single depth counter: the object that gets
  // truncated is the OUTER one, so waiting for depth to return to zero recovers nothing.
  // Every balanced object is parsed at whatever depth it closes, and the incomplete
  // ancestors are simply never closed and never parsed.
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') starts.push(i);
    else if (ch === '}') {
      const start = starts.pop();
      if (start === undefined) continue;
      try {
        const obj = JSON.parse(text.slice(start, i + 1)) as ValidationClaim & { claims?: ValidationClaim[] };
        if (Array.isArray(obj?.claims)) out.push(...obj.claims);
        // Only claim-SHAPED objects. Nested objects (predicates, and proposedRule — which
        // also has a `title`) close first and would otherwise be mistaken for claims, so
        // require the evidence array that only a claim carries.
        else if (obj && typeof obj === 'object' && typeof obj.title === 'string' && Array.isArray(obj.evidenceLogIds)) {
          out.push(obj);
        }
      } catch {
        // not parseable at this level; keep scanning
      }
    }
  }
  return out;
}

/** Run the gate over a whole reply. Nothing that fails is repaired, retried, or partially kept. */
export function admitClaims(
  claims: readonly ValidationClaim[] | undefined,
  relatedLogs: readonly ParsedLog[],
  correlationId?: string,
): AiReviewOutcome {
  if (!Array.isArray(claims) || !claims.length) return EMPTY;
  const byId = new Map(relatedLogs.map((l) => [l.id, l]));
  const findings: AiValidationFinding[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  for (const c of claims.slice(0, MAX_CLAIMS)) {
    const verdict = admitClaim(c, byId, correlationId);
    if (verdict.ok) findings.push(verdict.finding);
    else rejected.push({ title: (c?.title ?? '(untitled)').toString().slice(0, 120), reason: verdict.reason });
  }
  return { findings, rejected };
}

// ---------------------------------------------------------------------------
// The generic driver an app agent calls.
// ---------------------------------------------------------------------------

/**
 * The JSON response contract every app's validation agent shares. Kept DELIBERATELY
 * terse: the reply shares its token budget with the model's hidden reasoning, and a
 * verbose schema is what pushes the JSON past the budget and gets it truncated mid-claim.
 * Short fields, at most three claims, no prose outside the JSON.
 */
const RESPONSE_CONTRACT = [
  'Answer with JSON ONLY — no prose, no explanation, no markdown fence around it.',
  'Emit AT MOST 3 claims. An empty list is the correct and expected answer whenever the',
  'logs do not PROVE a problem, and costs you nothing.',
  '',
  '{"claims":[{',
  '  "kind":"<short-kebab-case>",',
  '  "title":"<one sentence, max 20 words>",',
  '  "severity":"info|low|medium|high|critical",',
  '  "detail":"<max 25 words>",',
  '  "evidenceLogIds":["<logId from the LOGS list>"],',
  '  "predicates":[{"logId":"<one of evidenceLogIds>","field":"raw|message|level|stream|source|timestamp",',
  '                 "op":"contains|not_contains|equals|matches|lt|gt","value":"<literal>"}],',
  '  "proposedRule":{"id":"<kebab-case>","title":"<the general rule, max 15 words>","rationale":"<max 20 words>"}',
  '}]}',
  '',
  'Keep every string short. Do not restate the log lines; cite them by id.',
  '',
  'Every claim is RE-EXECUTED against the real log rows before it is recorded: each',
  'evidenceLogId must be one of the ids listed above, every predicate must reference one',
  'of your own evidenceLogIds, and every predicate must actually hold. A claim with an',
  'invented id, an inexact quoted value, or a predicate that does not hold is discarded',
  'in full — you cannot argue it back. Quote values EXACTLY as they appear in the log',
  'line. Prefer no claim over an unproven one.',
  '',
  'Writing a predicate that survives:',
  '- Pick a SHORT, distinctive substring as the value — a status code, an id, an error',
  '  token, a single field value. Long values (whole timestamps, whole payloads) get',
  '  copied imprecisely and the claim dies on re-execution.',
  '- NEVER claim that a value is truncated, malformed, or missing characters. The lines',
  '  you were shown are EXCERPTS, cut for length. A short-looking timestamp or a cut-off',
  '  payload is an artifact of how you were shown the line, not a defect in the data.',
  '- A difference between two lines is only a defect if the protocol says those two',
  '  values must match. If nothing above says they must match, they may differ.',
  '- At least one predicate must be POSITIVE (contains/equals/matches/lt/gt). A claim',
  '  supported only by `not_contains` is rejected outright: the lines you were shown are',
  '  an excerpt of a time window, so something not appearing in them proves nothing. You',
  '  cannot claim anything is "missing", "absent", "never logged", or "not found".',
  '- Reserve high/critical for evidence of money, data, or state being lost or wrong.',
  '  A cosmetic or formatting observation is at most low.',
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
  let text: string;
  try {
    text = await reason(spec, user);
  } catch (err) {
    const error = `model call failed: ${(err as Error).message}`;
    console.error(`validation AI agent: ${error} for ${input.messageId}`);
    return { findings: [], rejected: [], error };
  }

  if (!text.trim()) {
    // An empty reply is the reasoning model spending its whole budget on hidden
    // reasoning. It is a FAILED review, not a clean one — say so.
    const error = 'model returned an empty reply (output budget likely exhausted)';
    console.error(`validation AI agent: ${error} for ${input.messageId}`);
    return { findings: [], rejected: [], error };
  }

  let claims: ValidationClaim[] | undefined;
  let truncated = false;
  try {
    claims = (JSON.parse(stripFence(text)) as { claims?: ValidationClaim[] }).claims;
  } catch {
    claims = salvageClaims(text);
    truncated = true;
  }

  if (!Array.isArray(claims)) {
    const error = 'model reply contained no recoverable claims';
    console.error(`validation AI agent: ${error} for ${input.messageId}`);
    return { findings: [], rejected: [], error };
  }

  const outcome = admitClaims(claims, input.relatedLogs, input.messageId);
  if (truncated) {
    // Salvage succeeded, but the reply WAS cut off — so "no claims" cannot be trusted as
    // a clean result. Flag it as partial rather than let it pass for a completed review.
    const note = `model reply was truncated; recovered ${claims.length} complete claim(s)`;
    console.warn(`validation AI agent: ${note} for ${input.messageId}`);
    if (!outcome.findings.length) return { ...outcome, error: note };
  }
  return outcome;
}

/** Unwrap a ```json fenced reply, if the model wrapped one. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const from = body.indexOf('{');
  return from === -1 ? body : body.slice(from);
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

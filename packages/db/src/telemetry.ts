import type { ModelCallTelemetry, PlatformTelemetry } from '@log/shared';
import { getSql } from './client.js';

/**
 * Platform telemetry, computed ENTIRELY IN SQL from the live tables.
 *
 * Every number here is an aggregate over real rows — `parsed_logs`, `anomalies`,
 * `agents`, `validation_agents`, `validation_agent_runs`, `poller_runs`. Nothing is
 * sampled, synthesised, or defaulted to a placeholder: a metric with no underlying rows
 * reports zero and the UI says so, because a dashboard that invents a plausible number is
 * worse than one that admits it has none.
 *
 * The aggregation is deliberately server-side. Pulling rows to count them in the browser
 * would put the row caps (`getActiveAgents`, `queryLogs`) between the data and the metric,
 * so a count would silently become "count of the first N" — the same silent-truncation
 * class that has bitten the ingestion path twice.
 */

/** `n` bucketed by a text column, as `{ value: count }`. */
type Buckets = Record<string, number>;

const toBuckets = (rows: readonly Record<string, unknown>[], key = 'k'): Buckets => {
  const out: Buckets = {};
  for (const r of rows) out[String(r[key] ?? 'unknown')] = Number(r.n ?? 0);
  return out;
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function getPlatformTelemetry(windowMs = 24 * 60 * 60_000): Promise<PlatformTelemetry> {
  const sql = getSql();
  const now = Date.now();
  const since = now - windowMs;

  const [
    logTotals,
    logsBySource,
    logsByLevel,
    anomalyTotals,
    anomaliesBySeverity,
    anomaliesByApp,
    agentTotals,
    agentsByStatus,
    agentDurations,
    validationByResult,
    validationTotals,
    aiTotals,
    aiRuns,
    pollerTotals,
    pollerByTrigger,
    ruleCandidates,
  ] = await Promise.all([
    sql`SELECT count(*)::int AS n, min(ts) AS oldest, max(ts) AS newest, max(ingested_at) AS last_ingest
        FROM parsed_logs`,
    sql`SELECT source AS k, count(*)::int AS n FROM parsed_logs GROUP BY source ORDER BY n DESC`,
    sql`SELECT level AS k, count(*)::int AS n FROM parsed_logs GROUP BY level ORDER BY n DESC`,
    sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at >= ${since})::int AS recent
        FROM anomalies`,
    sql`SELECT severity AS k, count(*)::int AS n FROM anomalies GROUP BY severity`,
    sql`SELECT coalesce(application,'unassigned') AS k, count(*)::int AS n FROM anomalies GROUP BY 1`,
    sql`SELECT count(*) FILTER (WHERE active)::int AS active,
               count(*) FILTER (WHERE NOT active)::int AS closed,
               count(*)::int AS total
        FROM agents`,
    sql`SELECT coalesce(application,'unknown') || '|' || status AS k, count(*)::int AS n
        FROM agents WHERE NOT active GROUP BY 1`,
    // Lifetime percentiles over CLOSED transactions only — an active one has no duration.
    sql`SELECT coalesce(application,'unknown') AS app,
               count(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY (closed_at - spawned_at)::float8) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (closed_at - spawned_at)::float8) AS p95,
               max(closed_at - spawned_at) AS max
        FROM agents WHERE NOT active AND closed_at IS NOT NULL GROUP BY 1`,
    sql`SELECT result AS k, count(*)::int AS n FROM validation_agents GROUP BY result`,
    sql`SELECT count(*)::int AS n,
               count(*) FILTER (WHERE sla_breached)::int AS sla_breached,
               count(*) FILTER (WHERE jsonb_array_length(delta) > 0)::int AS with_delta,
               avg(response_latency_ms) FILTER (WHERE response_latency_ms IS NOT NULL) AS avg_latency
        FROM validation_agents`,
    // The AI stage's own scorecard. `discarded` is the observed hallucination rate: every
    // one would have been a false positive had the claim been trusted.
    sql`SELECT count(*) FILTER (WHERE ai_reviewed_at IS NOT NULL)::int AS reviewed,
               count(*) FILTER (WHERE jsonb_array_length(ai_findings) > 0)::int AS suspected,
               coalesce(sum(ai_rejected),0)::int AS discarded,
               count(*) FILTER (WHERE ai_error IS NOT NULL)::int AS failed,
               coalesce(sum(jsonb_array_length(ai_findings)),0)::int AS admitted_claims
        FROM validation_agents`,
    sql`SELECT count(*)::int AS runs,
               count(*) FILTER (WHERE finished_at IS NULL)::int AS running,
               coalesce(sum(queued),0)::int AS queued,
               avg(finished_at - started_at) FILTER (WHERE finished_at IS NOT NULL) AS avg_ms
        FROM validation_agent_runs`,
    sql`SELECT count(*)::int AS n,
               count(*) FILTER (WHERE ran_at >= ${since})::int AS recent,
               max(ran_at) AS last_run,
               avg(duration_ms) AS avg_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms::float8) AS p95_ms,
               coalesce(sum(anomalies),0)::int AS anomalies_produced
        FROM poller_runs`,
    sql`SELECT trigger AS k, count(*)::int AS n FROM poller_runs GROUP BY trigger`,
    // Deterministic checks the AI agents proposed, ranked by recurrence — the promotion
    // queue that takes the model out of the loop for a class it keeps re-finding.
    sql`SELECT f->'proposedRule'->>'id' AS k, count(*)::int AS n
        FROM validation_agents, jsonb_array_elements(ai_findings) f
        WHERE f->'proposedRule'->>'id' IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  ]);

  const lt = logTotals[0] ?? {};
  const at = agentTotals[0] ?? {};
  const vt = validationTotals[0] ?? {};
  const ai = aiTotals[0] ?? {};
  const ar = aiRuns[0] ?? {};
  const pt = pollerTotals[0] ?? {};
  const an = anomalyTotals[0] ?? {};

  // Outcome mix per application, from the "app|status" bucket key.
  const byApp: PlatformTelemetry['transactions']['byApplication'] = {};
  for (const [k, n] of Object.entries(toBuckets(agentsByStatus))) {
    const [app = 'unknown', status = 'unknown'] = k.split('|');
    (byApp[app] ??= { completed: 0, failed: 0, error: 0, other: 0, total: 0 });
    if (status === 'completed' || status === 'failed' || status === 'error') byApp[app]![status] += n;
    else byApp[app]!.other += n;
    byApp[app]!.total += n;
  }
  for (const r of agentDurations) {
    const app = String(r.app ?? 'unknown');
    (byApp[app] ??= { completed: 0, failed: 0, error: 0, other: 0, total: 0 });
    byApp[app]!.p50Ms = num(r.p50);
    byApp[app]!.p95Ms = num(r.p95);
    byApp[app]!.maxMs = num(r.max);
  }

  const discarded = num(ai.discarded);
  const admitted = num(ai.admitted_claims);
  const claims = discarded + admitted;

  return {
    generatedAt: now,
    windowMs,
    logs: {
      total: num(lt.n),
      oldestTs: num(lt.oldest) || undefined,
      newestTs: num(lt.newest) || undefined,
      lastIngestAt: num(lt.last_ingest) || undefined,
      bySource: toBuckets(logsBySource),
      byLevel: toBuckets(logsByLevel),
    },
    anomalies: {
      total: num(an.n),
      inWindow: num(an.recent),
      bySeverity: toBuckets(anomaliesBySeverity),
      byApplication: toBuckets(anomaliesByApp),
    },
    transactions: {
      active: num(at.active),
      closed: num(at.closed),
      total: num(at.total),
      byApplication: byApp,
    },
    validation: {
      total: num(vt.n),
      byResult: toBuckets(validationByResult),
      slaBreached: num(vt.sla_breached),
      withDelta: num(vt.with_delta),
      avgResponseLatencyMs: num(vt.avg_latency) || undefined,
    },
    validationAi: {
      reviewed: num(ai.reviewed),
      suspected: num(ai.suspected),
      admittedClaims: admitted,
      discardedClaims: discarded,
      failedReviews: num(ai.failed),
      // Share of claims the gate threw out. Undefined rather than 0 when no claim has
      // ever been made — an unmeasured rate is not a rate of zero.
      discardRate: claims > 0 ? discarded / claims : undefined,
      runs: num(ar.runs),
      running: num(ar.running),
      queued: num(ar.queued),
      avgRunMs: num(ar.avg_ms) || undefined,
      ruleCandidates: toBuckets(ruleCandidates),
    },
    models: await getModelCallTelemetry(windowMs).catch(() => undefined),
    poller: {
      runs: num(pt.n),
      inWindow: num(pt.recent),
      lastRunAt: num(pt.last_run) || undefined,
      avgDurationMs: num(pt.avg_ms) || undefined,
      p95DurationMs: num(pt.p95_ms) || undefined,
      anomaliesProduced: num(pt.anomalies_produced),
      byTrigger: toBuckets(pollerByTrigger),
    },
  };
}

// ---------------------------------------------------------------------------
// Model-call instrumentation. Written by the Bedrock wrapper on EVERY call.
// ---------------------------------------------------------------------------

export interface ModelCallRow {
  ts: number;
  stage: string;
  model: string;
  application?: string;
  ok: boolean;
  /** Provider-reported latency (Bedrock `metrics.latencyMs`); absent on failure. */
  latencyMs?: number;
  /** Our own wall clock around the call — always present, includes transport. */
  wallMs: number;
  inputTokens?: number;
  outputTokens?: number;
  replyChars?: number;
  stopReason?: string;
  error?: string;
  /**
   * Bedrock Guardrail policies that fired, as `policy:name` (`content:PROMPT_ATTACK`,
   * `pii:AWS_SECRET_KEY`). Empty on the overwhelming majority of calls. Non-empty with a
   * `guardrail_intervened` stop reason means the call was BLOCKED; non-empty without one
   * means the reply was MASKED — which nothing else records, so the answer a user saw
   * would otherwise differ from anything we can reconstruct.
   */
  guardrailPolicies?: string[];
}

/** Keep a bounded recent history: this is an operational stream, not an audit log. */
const MODEL_CALLS_KEEP = Number(process.env.MODEL_CALLS_KEEP ?? 20000);

/**
 * Record one model call. Best-effort by contract — the caller fire-and-forgets, because
 * telemetry must never be able to fail or slow the call it is measuring.
 */
export async function insertModelCall(r: ModelCallRow): Promise<void> {
  const sql = getSql();
  await sql`INSERT INTO model_calls
    (id, ts, stage, model, application, ok, latency_ms, wall_ms, input_tokens, output_tokens, reply_chars, stop_reason, error, guardrail_policies)
    VALUES (${`${r.ts}-${Math.random().toString(36).slice(2, 10)}`}, ${r.ts}, ${r.stage}, ${r.model},
            ${r.application ?? null}, ${r.ok}, ${r.latencyMs ?? null}, ${Math.round(r.wallMs)},
            ${r.inputTokens ?? null}, ${r.outputTokens ?? null}, ${r.replyChars ?? null},
            ${r.stopReason ?? null}, ${r.error ?? null},
            ${r.guardrailPolicies?.length ? r.guardrailPolicies : null})`;
  // Trim opportunistically rather than on a schedule — no extra moving part to fail.
  if (Math.random() < 0.02) {
    await sql`DELETE FROM model_calls WHERE id IN (
      SELECT id FROM model_calls ORDER BY ts DESC OFFSET ${MODEL_CALLS_KEEP})`;
  }
}

/** Aggregate model-call metrics, per stage and per model, over a window. */
export async function getModelCallTelemetry(windowMs: number): Promise<ModelCallTelemetry> {
  const sql = getSql();
  const since = Date.now() - windowMs;

  const [totals, byStage, byModel, byStop, recentErrors, guardrail, guardrailByPolicy] = await Promise.all([
    sql`SELECT count(*)::int AS n,
               count(*) FILTER (WHERE NOT ok)::int AS failed,
               coalesce(sum(input_tokens),0)::bigint AS in_tok,
               coalesce(sum(output_tokens),0)::bigint AS out_tok,
               avg(latency_ms) AS avg_latency,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms::float8) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms::float8) AS p95,
               max(latency_ms) AS max_latency,
               avg(wall_ms) AS avg_wall
        FROM model_calls WHERE ts >= ${since}`,
    sql`SELECT stage AS k, count(*)::int AS n,
               count(*) FILTER (WHERE NOT ok)::int AS failed,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms::float8) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms::float8) AS p95,
               coalesce(sum(input_tokens),0)::bigint AS in_tok,
               coalesce(sum(output_tokens),0)::bigint AS out_tok,
               avg(reply_chars) AS avg_chars
        FROM model_calls WHERE ts >= ${since} GROUP BY stage ORDER BY n DESC`,
    sql`SELECT model AS k, count(*)::int AS n FROM model_calls WHERE ts >= ${since} GROUP BY model`,
    // A reply that keeps stopping on the token ceiling is the truncation signature.
    sql`SELECT coalesce(stop_reason,'unknown') AS k, count(*)::int AS n
        FROM model_calls WHERE ts >= ${since} AND ok GROUP BY 1`,
    sql`SELECT stage, error, ts FROM model_calls
        WHERE ts >= ${since} AND NOT ok ORDER BY ts DESC LIMIT 5`,
    // Blocked vs masked, split on the stop reason. Both are guardrail activity, but they
    // mean opposite things operationally: a block is a request that got NO answer (and is
    // a false positive until proven otherwise), a mask is an answer that was delivered
    // with a secret removed — which is the guardrail working exactly as intended.
    sql`SELECT count(*) FILTER (WHERE stop_reason = 'guardrail_intervened')::int AS blocked,
               count(*) FILTER (WHERE stop_reason IS DISTINCT FROM 'guardrail_intervened')::int AS masked
        FROM model_calls
        WHERE ts >= ${since} AND guardrail_policies IS NOT NULL`,
    sql`SELECT p AS k, count(*)::int AS n
        FROM model_calls, unnest(guardrail_policies) p
        WHERE ts >= ${since} GROUP BY 1 ORDER BY n DESC`,
  ]);

  const t = totals[0] ?? {};
  const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

  return {
    total: n(t.n),
    failed: n(t.failed),
    errorRate: n(t.n) > 0 ? n(t.failed) / n(t.n) : undefined,
    inputTokens: n(t.in_tok),
    outputTokens: n(t.out_tok),
    avgLatencyMs: n(t.avg_latency) || undefined,
    p50LatencyMs: n(t.p50) || undefined,
    p95LatencyMs: n(t.p95) || undefined,
    maxLatencyMs: n(t.max_latency) || undefined,
    avgWallMs: n(t.avg_wall) || undefined,
    byStage: byStage.map((r) => ({
      stage: String(r.k),
      calls: n(r.n),
      failed: n(r.failed),
      p50LatencyMs: n(r.p50) || undefined,
      p95LatencyMs: n(r.p95) || undefined,
      inputTokens: n(r.in_tok),
      outputTokens: n(r.out_tok),
      avgReplyChars: n(r.avg_chars) || undefined,
    })),
    byModel: Object.fromEntries(byModel.map((r) => [String(r.k), n(r.n)])),
    byStopReason: Object.fromEntries(byStop.map((r) => [String(r.k), n(r.n)])),
    guardrail: {
      blocked: n(guardrail[0]?.blocked),
      masked: n(guardrail[0]?.masked),
      byPolicy: toBuckets(guardrailByPolicy),
    },
    recentErrors: recentErrors.map((r) => ({
      stage: String(r.stage),
      error: String(r.error ?? ''),
      ts: n(r.ts),
    })),
  };
}

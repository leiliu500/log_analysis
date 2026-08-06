import type { PlatformTelemetry } from '@log/shared';
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
               percentile_cont(0.5) WITHIN GROUP (ORDER BY (closed_at - spawned_at)) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (closed_at - spawned_at)) AS p95,
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
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
               coalesce(sum(findings),0)::int AS findings
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
    poller: {
      runs: num(pt.n),
      inWindow: num(pt.recent),
      lastRunAt: num(pt.last_run) || undefined,
      avgDurationMs: num(pt.avg_ms) || undefined,
      p95DurationMs: num(pt.p95_ms) || undefined,
      anomaliesProduced: num(pt.findings),
      byTrigger: toBuckets(pollerByTrigger),
    },
  };
}

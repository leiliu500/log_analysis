import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, RawLogRecord, Severity, LogSourceType } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn, isAnomalous, type AnomalyScore } from './learn.js';
import { correlate } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';

/** Deterministic anomaly finding (no LLM) from a scored fingerprint burst. */
function anomalyFinding(
  score: AnomalyScore,
  evidence: ParsedLog[],
  windowMs: number,
  now: number,
): Finding {
  const severity: Severity =
    score.zScore >= 5 || score.count >= 25 ? 'high' : score.isNew || score.zScore >= 3 ? 'medium' : 'low';
  const reason = score.isNew
    ? `New log pattern appeared ${score.count} time(s) in this window.`
    : `Volume rose to ${score.observedRate.toFixed(1)}/min vs baseline ${score.baselineRate.toFixed(1)}/min (z=${score.zScore.toFixed(1)}).`;
  return {
    id: randomUUID(),
    kind: 'anomaly',
    severity,
    title: `Unusual activity: ${score.sample.slice(0, 70)}`,
    summary: `${reason} ${score.count} occurrence(s) on ${score.source}.`,
    confidence: Math.min(0.95, 0.5 + Math.min(score.zScore, 5) / 10 + (score.isNew ? 0.2 : 0)),
    sources: [score.source as LogSourceType],
    fingerprint: score.fingerprint,
    evidence: evidence.slice(0, 10).map((l) => ({
      logId: l.id,
      source: l.source,
      stream: l.stream,
      timestamp: l.timestamp,
      excerpt: l.message.slice(0, 200),
    })),
    reasoning: [reason, `Log signature: ${score.fingerprint}.`],
    recommendations: score.isNew
      ? ['Confirm whether this new log pattern is expected.']
      : ['Investigate the cause of the volume change.'],
    metadata: { anomaly: score },
    windowStart: now - windowMs,
    windowEnd: now,
    createdAt: now,
  };
}

export interface PipelineOptions {
  /** Sliding window used for rate/anomaly math. */
  windowMs?: number;
  /** Embed each parsed log for semantic search (costly at high volume). */
  embedLogs?: boolean;
  /** Max clusters to send to the reasoning model per run. */
  maxReasoned?: number;
}

export interface PipelineResult {
  parsed: number;
  anomalies: AnomalyScore[];
  findings: Finding[];
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];

/**
 * End-to-end log processing for one batch:
 *   parse → (embed) → persist → learn/score → correlate → reason → persist findings/alerts.
 * Designed to run per source, per window, and to scale by batching.
 */
export async function runPipeline(
  records: RawLogRecord[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const maxReasoned = opts.maxReasoned ?? 8;

  const parsed = parseBatch(records);

  if (opts.embedLogs) {
    // Best-effort; failures shouldn't drop the batch.
    await Promise.all(
      parsed.map(async (l) => {
        try {
          l.embedding = await embed(`${l.level} ${l.message}`);
        } catch {
          /* ignore */
        }
      }),
    );
  }

  await insertParsedLogs(parsed);

  const scores = await scoreAndLearn(parsed, windowMs);
  const anomalous = scores.filter(isAnomalous);

  const findings: Finding[] = [];
  const now = Date.now();

  const alert = async (f: Finding): Promise<void> => {
    if (ALERT_SEVERITIES.includes(f.severity)) {
      await insertAlert({
        id: randomUUID(),
        findingId: f.id,
        severity: f.severity,
        channel: 'dashboard',
        status: 'pending',
        createdAt: now,
      });
    }
  };

  // 1) Deterministic anomaly findings — guarantees the dashboard surfaces every
  //    detected burst / new pattern, even for single-source traffic.
  const byFp = new Map<string, ParsedLog[]>();
  for (const l of parsed) {
    const arr = byFp.get(l.fingerprint);
    if (arr) arr.push(l);
    else byFp.set(l.fingerprint, [l]);
  }
  for (const score of anomalous) {
    const finding = anomalyFinding(score, byFp.get(score.fingerprint) ?? [], windowMs, now);
    try {
      finding.embedding = await embed(`${finding.title}\n${finding.summary}`);
    } catch {
      /* embeddings best-effort */
    }
    await insertFinding(finding);
    await alert(finding);
    findings.push(finding);
  }

  // 2) Cross-source correlation clusters -> LLM reasoning (richer findings).
  const clusters = correlate(parsed, windowMs)
    .filter((c) => c.sources.length >= 2)
    .slice(0, maxReasoned);
  for (const cluster of clusters) {
    try {
      const finding = await reasonAboutCluster(cluster);
      await insertFinding(finding);
      await alert(finding);
      findings.push(finding);
    } catch (err) {
      console.error('reasoning failed for cluster', cluster.key, err);
    }
  }

  return { parsed: parsed.length, anomalies: anomalous, findings };
}

export type { ParsedLog };

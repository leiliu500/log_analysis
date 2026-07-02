import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, RawLogRecord, Severity } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn, isAnomalous, type AnomalyScore } from './learn.js';
import { correlate } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';

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
  const anomalyByFp = new Map(anomalous.map((a) => [a.fingerprint, a]));

  // Correlate all parsed logs, then keep clusters that either contain an
  // anomalous fingerprint or are cross-source (interesting on their own).
  const clusters = correlate(parsed, windowMs)
    .filter(
      (c) =>
        c.sources.length >= 2 ||
        c.logs.some((l) => anomalyByFp.has(l.fingerprint)),
    )
    .slice(0, maxReasoned);

  const findings: Finding[] = [];
  for (const cluster of clusters) {
    const anomaly = cluster.logs
      .map((l) => anomalyByFp.get(l.fingerprint))
      .find(Boolean);
    try {
      const finding = await reasonAboutCluster(cluster, { anomaly });
      await insertFinding(finding);
      findings.push(finding);
      if (ALERT_SEVERITIES.includes(finding.severity)) {
        await insertAlert({
          id: randomUUID(),
          findingId: finding.id,
          severity: finding.severity,
          channel: 'dashboard',
          status: 'pending',
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      console.error('reasoning failed for cluster', cluster.key, err);
    }
  }

  return { parsed: parsed.length, anomalies: anomalous, findings };
}

export type { ParsedLog };

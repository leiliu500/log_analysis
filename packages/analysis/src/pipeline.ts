import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, RawLogRecord, Severity } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn, isAnomalous, type AnomalyScore } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';
import { detectLogAnomalies } from './anomalies.js';
import { buildTransactions, transactionAnomalies, reasonAboutTransaction } from './transactions.js';

export interface PipelineOptions {
  /** Sliding window used for rate/anomaly math. */
  windowMs?: number;
  /** Embed each parsed log for semantic search (costly at high volume). */
  embedLogs?: boolean;
  /** Max clusters/transactions to send to the reasoning model per run. */
  maxReasoned?: number;
  /** Grace period before a request lacking ACK/RESPONSE is flagged (ms). */
  txGraceMs?: number;
}

export interface PipelineResult {
  parsed: number;
  anomalies: AnomalyScore[];
  findings: Finding[];
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];

/**
 * End-to-end log processing for one batch. Findings are produced only for real
 * production anomalies — all LLM-reasoned:
 *   A. error / exception / timeout / 5xx logs (grouped by signature)
 *   B. incomplete cashMessage transactions (a REQUEST missing its ACK/RESPONSE)
 *   C. cross-source correlated clusters
 * Normal request volume and idle windows produce no findings.
 */
export async function runPipeline(
  records: RawLogRecord[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const maxReasoned = opts.maxReasoned ?? 8;
  const txGraceMs = opts.txGraceMs ?? 60_000;

  const parsed = parseBatch(records);

  if (opts.embedLogs) {
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

  // Keep learning baselines (used for error-rate context); volume alone is not
  // treated as an anomaly.
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

  const reasonCluster = async (cluster: Cluster): Promise<void> => {
    try {
      const finding = await reasonAboutCluster(cluster);
      await insertFinding(finding);
      await alert(finding);
      findings.push(finding);
    } catch (err) {
      console.error('reasoning failed for cluster', cluster.key, err);
    }
  };

  // A) Production log anomalies (errors, exceptions, timeouts, 5xx/4xx, auth,
  //    rate-limit, resource exhaustion, crashes, data-integrity, latency).
  for (const cluster of detectLogAnomalies(parsed).slice(0, maxReasoned)) {
    await reasonCluster(cluster);
  }

  // B) Transaction anomalies (incomplete / duplicate / rejected cashMessages).
  for (const { tx, reason } of transactionAnomalies(buildTransactions(parsed), txGraceMs, now).slice(
    0,
    maxReasoned,
  )) {
    try {
      const finding = await reasonAboutTransaction(tx, reason, now, windowMs);
      await insertFinding(finding);
      await alert(finding);
      findings.push(finding);
    } catch (err) {
      console.error('transaction reasoning failed', tx.id, err);
    }
  }

  // C) Cross-source correlated clusters.
  for (const cluster of correlate(parsed, windowMs)
    .filter((c) => c.sources.length >= 2)
    .slice(0, maxReasoned)) {
    await reasonCluster(cluster);
  }

  return { parsed: parsed.length, anomalies: anomalous, findings };
}

export type { ParsedLog };

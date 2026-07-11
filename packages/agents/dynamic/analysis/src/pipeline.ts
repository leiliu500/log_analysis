import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, RawLogRecord, Severity, ApplicationRegistry } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert, findingExistsByFingerprint } from '@log/db';
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
  /** Grace period before an incomplete transaction is flagged (ms). */
  txGraceMs?: number;
  /**
   * Application registry for the transaction-analysis stage (B). When omitted,
   * transaction detection is skipped and only log/correlation anomalies run.
   */
  registry?: ApplicationRegistry;
}

export interface PipelineResult {
  parsed: number;
  anomalies: AnomalyScore[];
  findings: Finding[];
}

const ALERT_SEVERITIES: Severity[] = ['high', 'critical'];

/** Suppress re-reporting the same fingerprint within this window (poller runs every 5 min). */
const DEDUP_WINDOW_MS = 30 * 60_000;

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

  // Skip anomalies already reported recently so the 5-minute poller does not
  // pile up duplicate findings for the same signature/transaction.
  const dedupSince = now - DEDUP_WINDOW_MS;
  const isDuplicate = (fingerprint: string): Promise<boolean> =>
    findingExistsByFingerprint(fingerprint, dedupSince);

  const reasonCluster = async (cluster: Cluster): Promise<void> => {
    const fp = cluster.logs[0]?.fingerprint ?? cluster.key;
    if (await isDuplicate(fp)) return;
    try {
      const finding = await reasonAboutCluster(cluster);
      finding.application = opts.registry?.forLog(cluster.logs[0]!)?.id;
      await insertFinding(finding);
      await alert(finding);
      findings.push(finding);
    } catch (err) {
      console.error('reasoning failed for cluster', cluster.key, err);
    }
  };

  // A) Production log anomalies (errors, exceptions, timeouts, 5xx/4xx, auth,
  //    rate-limit, resource exhaustion, crashes, data-integrity, latency).
  for (const cluster of detectLogAnomalies(parsed, opts.registry).slice(0, maxReasoned)) {
    await reasonCluster(cluster);
  }

  // B) Transaction anomalies (incomplete / duplicate / rejected), per each
  //    application's protocol. Skipped when no registry is supplied.
  if (opts.registry) {
    for (const { tx, reason } of transactionAnomalies(
      buildTransactions(parsed, opts.registry),
      opts.registry,
      txGraceMs,
      now,
    ).slice(0, maxReasoned)) {
      if (await isDuplicate(`tx:${tx.id}`)) continue;
      try {
        const finding = await reasonAboutTransaction(tx, reason, now, windowMs);
        await insertFinding(finding);
        await alert(finding);
        findings.push(finding);
      } catch (err) {
        console.error('transaction reasoning failed', tx.id, err);
      }
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

import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, RawLogRecord, Severity } from '@log/shared';
import { insertParsedLogs, insertFinding, insertAlert } from '@log/db';
import { parseBatch } from './parser.js';
import { scoreAndLearn, isAnomalous, type AnomalyScore } from './learn.js';
import { correlate, type Cluster } from './correlate.js';
import { reasonAboutCluster } from './reason.js';
import { embed } from './bedrock.js';
import {
  buildTransactions,
  incompleteTransactions,
  reasonAboutTransaction,
} from './transactions.js';

// Production error/exception signals. Normal request traffic and idle windows
// are NOT anomalies; errors, exceptions, timeouts, failures and 5xx are.
const ERROR_RE =
  /\b(exception|errno|error|failed|failure|timeout|timed out|refused|unavailable|unauthorized|denied|rejected|panic|fatal|traceback|stack ?trace|unhandled)\b/i;

/** Is this a production error/exception log worth flagging? */
export function isErrorLog(l: ParsedLog): boolean {
  if (l.level === 'error' || l.level === 'fatal') return true;
  const status = Number((l.fields as Record<string, unknown> | undefined)?.statusCode);
  if (status >= 500 && status < 600) return true;
  return ERROR_RE.test(l.message);
}

/** Group error logs by fingerprint into synthetic clusters for LLM reasoning. */
function errorClusters(logs: ParsedLog[]): Cluster[] {
  const byFp = new Map<string, ParsedLog[]>();
  for (const l of logs) {
    const arr = byFp.get(l.fingerprint);
    if (arr) arr.push(l);
    else byFp.set(l.fingerprint, [l]);
  }
  return [...byFp.values()].map((group) => {
    const sorted = group.sort((a, b) => a.timestamp - b.timestamp);
    return {
      key: `error:${sorted[0]!.fingerprint}`,
      reason: `${sorted.length} error/exception log(s)`,
      logs: sorted,
      sources: [...new Set(sorted.map((l) => l.source))],
      windowStart: sorted[0]!.timestamp,
      windowEnd: sorted[sorted.length - 1]!.timestamp,
    };
  });
}

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

  // A) Error / exception anomalies.
  for (const cluster of errorClusters(parsed.filter(isErrorLog)).slice(0, maxReasoned)) {
    await reasonCluster(cluster);
  }

  // B) Incomplete cashMessage transactions.
  const incomplete = incompleteTransactions(buildTransactions(parsed), txGraceMs, now).slice(
    0,
    maxReasoned,
  );
  for (const tx of incomplete) {
    try {
      const finding = await reasonAboutTransaction(tx, now, windowMs);
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

import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, LogSourceType, Severity, TransactionProtocol } from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converseJson, embed } from './bedrock.js';

export interface Transaction {
  id: string; // REQUEST.messageId == ACK/RESPONSE.initMessageId
  logs: ParsedLog[];
  types: Set<string>;
  requestTs?: number;
  requestCount: number;
  ackCodes: string[];
  sources: Set<LogSourceType>;
}

/** Group logs into transactions keyed by their correlation id, per the protocol. */
export function buildTransactions(logs: ParsedLog[], protocol: TransactionProtocol): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const log of logs) {
    const e = protocol.eventOf(log);
    if (!e) continue;
    let tx = byId.get(e.corrId);
    if (!tx) {
      tx = { id: e.corrId, logs: [], types: new Set(), requestCount: 0, ackCodes: [], sources: new Set() };
      byId.set(e.corrId, tx);
    }
    tx.logs.push(log);
    tx.types.add(e.type);
    tx.sources.add(log.source);
    if (e.type === protocol.initial) {
      tx.requestTs = log.timestamp;
      tx.requestCount += 1;
    }
    if (e.ackCode) tx.ackCodes.push(e.ackCode);
  }
  return [...byId.values()];
}

export interface TransactionAnomaly {
  tx: Transaction;
  reason: string;
}

/**
 * Detect anomalous transactions against a {@link TransactionProtocol}:
 *  - rejected: a phase carries a non-success ackCode
 *  - duplicate: the same initiating messageId occurs more than once (replay/resend)
 *  - incomplete: the initiating message (past the grace window) is missing a phase
 * A complete, successful transaction (all phases present, ackCodes OK) is normal
 * and produces nothing.
 */
export function transactionAnomalies(
  txs: Transaction[],
  protocol: TransactionProtocol,
  graceMs: number,
  now: number,
): TransactionAnomaly[] {
  const out: TransactionAnomaly[] = [];
  for (const tx of txs) {
    if (!tx.types.has(protocol.initial)) continue; // orphan follow-up — initial likely in an earlier window

    const bad = tx.ackCodes.filter((c) => !protocol.isSuccess(c));
    if (bad.length) {
      out.push({ tx, reason: `Transaction rejected/failed — ackCode ${[...new Set(bad)].join(', ')}.` });
      continue;
    }
    if (tx.requestCount > 1) {
      out.push({ tx, reason: `Duplicate ${protocol.initial} — ${tx.requestCount} requests share messageId ${tx.id} (possible replay/resend).` });
      continue;
    }
    if (tx.requestTs && now - tx.requestTs < graceMs) continue; // too recent to judge
    const missing = protocol.phases.filter((p) => !tx.types.has(p));
    if (missing.length) {
      out.push({ tx, reason: `Request incomplete — missing ${missing.join(' and ')}.` });
    }
  }
  return out;
}

interface ModelTxFinding {
  severity: Severity;
  title: string;
  summary: string;
  confidence: number;
  reasoning: string[];
  recommendations: string[];
}

const TX_SYSTEM = loadPrompt('analysis/transactions.md');

/** LLM-reason a flagged transaction into a Finding. */
export async function reasonAboutTransaction(
  tx: Transaction,
  reason: string,
  now: number,
  windowMs: number,
): Promise<Finding> {
  const prompt = `Anomaly reason: ${reason}
Transaction messageId=${tx.id}
Present message types: ${[...tx.types].join(', ')}
ackCodes: ${tx.ackCodes.join(', ') || '(none)'}
Request time: ${tx.requestTs ? new Date(tx.requestTs).toISOString() : 'unknown'}
Now: ${new Date(now).toISOString()}
Sources: ${[...tx.sources].join(', ')}`;

  const mf = await converseJson<ModelTxFinding>(prompt, { system: TX_SYSTEM, temperature: 0 });
  let embedding: number[] | undefined;
  try {
    embedding = await embed(`${mf.title}\n${mf.summary}`);
  } catch {
    embedding = undefined;
  }

  return {
    id: randomUUID(),
    kind: 'anomaly',
    severity: mf.severity ?? 'medium',
    title: mf.title,
    summary: mf.summary,
    confidence: Math.max(0, Math.min(1, mf.confidence ?? 0.7)),
    sources: [...tx.sources],
    fingerprint: `tx:${tx.id}`,
    evidence: tx.logs.slice(0, 10).map((l) => ({
      logId: l.id,
      source: l.source,
      stream: l.stream,
      timestamp: l.timestamp,
      excerpt: l.message.slice(0, 800),
    })),
    reasoning: mf.reasoning ?? [reason],
    recommendations: mf.recommendations ?? [],
    metadata: { transactionId: tx.id, reason, present: [...tx.types], ackCodes: tx.ackCodes },
    windowStart: now - windowMs,
    windowEnd: now,
    createdAt: now,
    embedding,
  };
}

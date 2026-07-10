import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, LogSourceType, Severity } from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converseJson, embed } from './bedrock.js';

/** Message metadata pulled from FRB cashMessage XML logs. */
export interface TxMeta {
  type?: string; // REQUEST | ACK | RESPONSE
  messageId?: string;
  initMessageId?: string;
  ackCode?: string;
}

function xmlTag(raw: string, tag: string): string | undefined {
  const m = raw.match(new RegExp(`<(?:[\\w.-]+:)?${tag}>\\s*([^<]+?)\\s*</(?:[\\w.-]+:)?${tag}>`, 'i'));
  return m ? m[1] : undefined;
}

export function txMetaOf(log: ParsedLog): TxMeta {
  return {
    type: xmlTag(log.raw, 'messageType')?.toUpperCase(),
    messageId: xmlTag(log.raw, 'messageId'),
    initMessageId: xmlTag(log.raw, 'initMessageId'),
    ackCode: xmlTag(log.raw, 'ackCode'),
  };
}

export interface Transaction {
  id: string; // REQUEST.messageId == ACK/RESPONSE.initMessageId
  logs: ParsedLog[];
  types: Set<string>;
  requestTs?: number;
  requestCount: number;
  ackCodes: string[];
  sources: Set<LogSourceType>;
}

/** Group logs into transactions keyed by their correlation id. */
export function buildTransactions(logs: ParsedLog[]): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const log of logs) {
    const m = txMetaOf(log);
    if (!m.type) continue;
    const id = m.type === 'REQUEST' ? m.messageId : m.initMessageId;
    if (!id) continue;
    let tx = byId.get(id);
    if (!tx) {
      tx = { id, logs: [], types: new Set(), requestCount: 0, ackCodes: [], sources: new Set() };
      byId.set(id, tx);
    }
    tx.logs.push(log);
    tx.types.add(m.type);
    tx.sources.add(log.source);
    if (m.type === 'REQUEST') {
      tx.requestTs = log.timestamp;
      tx.requestCount += 1;
    }
    if (m.ackCode) tx.ackCodes.push(m.ackCode);
  }
  return [...byId.values()];
}

const OK_CODES = new Set(['OK', 'SUCCESS', 'PROCESSED_SUCCESSFULLY', 'ACCEPTED', 'COMPLETE', 'COMPLETED']);

export interface TransactionAnomaly {
  tx: Transaction;
  reason: string;
}

/**
 * Detect anomalous transactions:
 *  - rejected: an ACK/RESPONSE carries a non-success ackCode
 *  - duplicate: the same REQUEST messageId occurs more than once (replay/resend)
 *  - incomplete: a REQUEST (past the grace window) is missing its ACK/RESPONSE
 * A complete, successful transaction (REQUEST + ACK + RESPONSE, ackCode OK) is
 * normal and produces nothing.
 */
export function transactionAnomalies(
  txs: Transaction[],
  graceMs: number,
  now: number,
): TransactionAnomaly[] {
  const out: TransactionAnomaly[] = [];
  for (const tx of txs) {
    if (!tx.types.has('REQUEST')) continue; // orphan ACK/RESPONSE — request likely in an earlier window

    const bad = tx.ackCodes.filter((c) => !OK_CODES.has(c.toUpperCase()));
    if (bad.length) {
      out.push({ tx, reason: `Transaction rejected/failed — ackCode ${[...new Set(bad)].join(', ')}.` });
      continue;
    }
    if (tx.requestCount > 1) {
      out.push({ tx, reason: `Duplicate REQUEST — ${tx.requestCount} requests share messageId ${tx.id} (possible replay/resend).` });
      continue;
    }
    if (tx.requestTs && now - tx.requestTs < graceMs) continue; // too recent to judge
    const missing = ['ACK', 'RESPONSE'].filter((t) => !tx.types.has(t));
    if (missing.length) {
      const what = missing.map((m) => (m === 'ACK' ? 'acknowledged' : 'processed')).join(' or ');
      out.push({ tx, reason: `Request not ${what} — missing ${missing.join(' and ')}.` });
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

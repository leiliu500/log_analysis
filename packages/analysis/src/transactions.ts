import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog, LogSourceType, Severity } from '@log/shared';
import { converseJson, embed } from './bedrock.js';

/** Message metadata pulled from FRB cashMessage XML logs. */
export interface TxMeta {
  type?: string; // REQUEST | ACK | RESPONSE
  messageId?: string;
  initMessageId?: string;
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
  };
}

export interface Transaction {
  id: string; // correlation id = REQUEST.messageId == ACK/RESPONSE.initMessageId
  logs: ParsedLog[];
  types: Set<string>;
  requestTs?: number;
  sources: Set<LogSourceType>;
}

/**
 * Group logs into transactions keyed by the correlation id: a REQUEST's
 * messageId, and an ACK/RESPONSE's initMessageId. A well-formed transaction
 * contains a REQUEST, an ACK and a RESPONSE that all share that id.
 */
export function buildTransactions(logs: ParsedLog[]): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const log of logs) {
    const m = txMetaOf(log);
    if (!m.type) continue;
    const id = m.type === 'REQUEST' ? m.messageId : m.initMessageId;
    if (!id) continue;
    let tx = byId.get(id);
    if (!tx) {
      tx = { id, logs: [], types: new Set(), sources: new Set() };
      byId.set(id, tx);
    }
    tx.logs.push(log);
    tx.types.add(m.type);
    tx.sources.add(log.source);
    if (m.type === 'REQUEST') tx.requestTs = log.timestamp;
  }
  return [...byId.values()];
}

const EXPECTED = ['REQUEST', 'ACK', 'RESPONSE'];

/**
 * A transaction is anomalous when it has a REQUEST but is missing its ACK and/or
 * RESPONSE — the request was not acknowledged / not processed. A `graceMs`
 * window avoids flagging very recent requests whose ACK/RESPONSE may not have
 * been written/pulled yet. Orphan ACK/RESPONSE (no REQUEST in this window) are
 * skipped, since the REQUEST may simply be in an earlier window.
 */
export function incompleteTransactions(
  txs: Transaction[],
  graceMs: number,
  now: number,
): Transaction[] {
  return txs.filter((tx) => {
    if (!tx.types.has('REQUEST')) return false;
    if (tx.requestTs && now - tx.requestTs < graceMs) return false;
    return !tx.types.has('ACK') || !tx.types.has('RESPONSE');
  });
}

interface ModelTxFinding {
  severity: Severity;
  title: string;
  summary: string;
  confidence: number;
  reasoning: string[];
  recommendations: string[];
}

const TX_SYSTEM = `You are an SRE analyzing FRB cashMessage transactions. A
transaction is identified by a messageId. A NORMAL transaction has three
messages sharing that id: a REQUEST, an ACK, and a RESPONSE (the ACK/RESPONSE
carry it as initMessageId). Sending a REQUEST is normal; an idle window with no
logs is normal. Report an ANOMALY only for a broken transaction: a REQUEST that
is missing its ACK and/or RESPONSE (not acknowledged / not processed).

Respond ONLY with JSON:
{"severity":"info|low|medium|high|critical","title":string,"summary":string,
 "confidence":0..1,"reasoning":string[],"recommendations":string[]}`;

/** LLM-reason a single incomplete transaction into a Finding. */
export async function reasonAboutTransaction(
  tx: Transaction,
  now: number,
  windowMs: number,
): Promise<Finding> {
  const missing = EXPECTED.filter((t) => !tx.types.has(t));
  const prompt = `Transaction messageId=${tx.id}
Present message types: ${[...tx.types].join(', ')}
Missing message types: ${missing.join(', ') || 'none'}
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
    fingerprint: `tx-incomplete-${missing.join('-')}`,
    evidence: tx.logs.slice(0, 10).map((l) => ({
      logId: l.id,
      source: l.source,
      stream: l.stream,
      timestamp: l.timestamp,
      excerpt: l.message.slice(0, 300),
    })),
    reasoning: mf.reasoning ?? [],
    recommendations: mf.recommendations ?? [],
    metadata: { transactionId: tx.id, present: [...tx.types], missing },
    windowStart: now - windowMs,
    windowEnd: now,
    createdAt: now,
    embedding,
  };
}

import type { ParsedLog, ApplicationRegistry } from '@log/shared';
import type { Cluster } from './correlate.js';

/**
 * Production-anomaly taxonomy. Each log is classified into at most one category;
 * normal traffic (a request being sent, an idle window) classifies as none.
 * Matched logs are grouped per (category, signature) and LLM-reasoned into
 * findings by the pipeline.
 */
export interface AnomalyCategory {
  category: string;
  label: string;
}

interface Rule extends AnomalyCategory {
  re: RegExp;
}

/** Message-pattern rules, ordered specific → generic (first match wins). */
const RULES: Rule[] = [
  {
    category: 'timeout',
    label: 'Timeouts',
    re: /\b(timeout|timed[\s-]?out|deadline exceeded|context deadline|etimedout|read timed out|request timeout|gateway timeout|504)\b/i,
  },
  {
    category: 'connection',
    label: 'Connection failures',
    re: /\b(connection (refused|reset|closed|failed|error|aborted)|econnrefused|econnreset|epipe|broken pipe|no route to host|network (error|unreachable)|socket hang up)\b/i,
  },
  {
    category: 'dependency',
    label: 'Dependency / service unavailable',
    re: /\b(service unavailable|circuit breaker|upstream (error|failed|unavailable)|downstream (error|failed|unavailable)|dependency (failed|unavailable)|host unreachable|backend (error|unavailable)|503)\b/i,
  },
  {
    category: 'auth',
    label: 'Auth / access denied',
    re: /\b(unauthorized|forbidden|access denied|permission denied|authentication failed|auth failure|invalid (token|credentials|api[\s-]?key|signature)|expired token|401|403)\b/i,
  },
  {
    category: 'rate_limit',
    label: 'Rate limiting / throttling',
    re: /\b(rate[\s-]?limit(ed|ing)?|too many requests|throttl(e|ed|ing)|quota exceeded|429)\b/i,
  },
  {
    category: 'resource',
    label: 'Resource exhaustion',
    // No strict \b anchors — catches compound tokens like OutOfMemoryError.
    re: /(out\s?of\s?memory|oomkilled|\boom\b|heap (space|dump)|gc overhead|disk (full|space)|no space left|too many open files|connection pool (exhausted|timeout)|cannot allocate|memory (exhausted|leak)|thread pool (exhausted|full))/i,
  },
  {
    category: 'crash',
    label: 'Crash / restart',
    re: /\b(crash(ed|es)?|segfault|segmentation fault|core dump(ed)?|sig(kill|segv|abrt)|\bkilled\b|exited with (code|status)|non[\s-]?zero exit|panic|restart(ing|ed)?|unhealthy|liveness probe failed)\b/i,
  },
  {
    category: 'data_integrity',
    label: 'Data integrity / validation',
    re: /\b(malformed|invalid (xml|json|message|format|request|payload|schema|field)|parse (error|failure)|parsing (failed|error)|deserializ\w+|unmarshal\w*|schema (validation|error)|validation (failed|error)|corrupt(ed|ion)?|checksum (mismatch|failed))\b/i,
  },
  {
    category: 'exception',
    label: 'Exceptions / errors',
    // Match exception/error as substrings to catch NullPointerException etc.
    re: /(exception|errno|error|\bfailed\b|\bfailure\b|\bfail\b|traceback|stack ?trace|unhandled|uncaught|\bfatal\b|\bpanic\b)/i,
  },
];

const num = (l: ParsedLog, field: string): number =>
  Number((l.fields as Record<string, unknown> | undefined)?.[field]) || 0;

export const LATENCY_THRESHOLD_MS = 3000;

/** Classify a log into a production-anomaly category, or undefined if normal. */
export function classifyAnomaly(l: ParsedLog): AnomalyCategory | undefined {
  const sc = num(l, 'statusCode');
  if (sc >= 500 && sc < 600) return { category: 'http_5xx', label: 'HTTP 5xx server errors' };
  if (sc === 401 || sc === 403) return { category: 'auth', label: 'Auth failures (401/403)' };
  if (sc === 429) return { category: 'rate_limit', label: 'Rate limiting (429)' };
  if (sc >= 400 && sc < 500) return { category: 'http_4xx', label: 'HTTP 4xx client errors' };
  if (num(l, 'latencyMs') >= LATENCY_THRESHOLD_MS) return { category: 'latency', label: 'High latency' };
  // Specific message rules take precedence over the generic error-level fallback
  // (e.g. "parse error" -> data_integrity, not just "error").
  for (const r of RULES) if (r.re.test(l.message)) return { category: r.category, label: r.label };
  if (l.level === 'error' || l.level === 'fatal') return { category: 'exception', label: 'Errors / exceptions' };
  return undefined;
}

/**
 * Group anomalous logs into per-(category, signature) clusters for reasoning.
 * The cluster `reason` carries the category label so the reasoner has context.
 */
export function detectLogAnomalies(logs: ParsedLog[], registry?: ApplicationRegistry): Cluster[] {
  const groups = new Map<string, { cat: AnomalyCategory; logs: ParsedLog[] }>();
  for (const l of logs) {
    // Transaction messages (any installed application's REQUEST/ACK/RESPONSE) are
    // analyzed by the transaction analyzer (which understands ackCode); don't also
    // flag them here on naive text — that double-counts and mis-reads domain
    // fields like ackCode=FAILED.
    if (registry?.isTransactionLog(l)) continue;
    const cat = classifyAnomaly(l);
    if (!cat) continue;
    const key = `${cat.category}:${l.fingerprint}`;
    const g = groups.get(key);
    if (g) g.logs.push(l);
    else groups.set(key, { cat, logs: [l] });
  }
  return [...groups.values()].map(({ cat, logs: g }) => {
    const sorted = g.sort((a, b) => a.timestamp - b.timestamp);
    return {
      key: `${cat.category}:${sorted[0]!.fingerprint}`,
      reason: `${cat.label}: ${sorted.length} log(s)`,
      logs: sorted,
      sources: [...new Set(sorted.map((l) => l.source))],
      windowStart: sorted[0]!.timestamp,
      windowEnd: sorted[sorted.length - 1]!.timestamp,
    };
  });
}

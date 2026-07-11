import type { ParsedLog, LogSourceType } from '@log/shared';

export interface Cluster {
  key: string;
  /** Entity or fingerprint that ties these logs together. */
  reason: string;
  logs: ParsedLog[];
  sources: LogSourceType[];
  windowStart: number;
  windowEnd: number;
}

/** Entities considered strong correlation keys (shared identity across logs). */
const CORRELATION_ENTITIES = ['requestId', 'uuid', 'ip', 'host', 'service'];

/**
 * Correlate logs into clusters by shared entities within a sliding time
 * window. Produces cross-source clusters that the reasoning agent turns into
 * findings.
 */
export function correlate(logs: ParsedLog[], windowMs = 5 * 60_000): Cluster[] {
  const byKey = new Map<string, ParsedLog[]>();

  for (const log of logs) {
    for (const entity of CORRELATION_ENTITIES) {
      for (const value of log.entities[entity] ?? []) {
        const key = `${entity}:${value}`;
        const arr = byKey.get(key) ?? [];
        arr.push(log);
        byKey.set(key, arr);
      }
    }
  }

  const clusters: Cluster[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue; // need at least a pair to correlate
    const sources = [...new Set(group.map((l) => l.source))];
    // Only keep clusters that are cross-source OR span a meaningful window.
    const sorted = group.sort((a, b) => a.timestamp - b.timestamp);
    const windowStart = sorted[0]!.timestamp;
    const windowEnd = sorted[sorted.length - 1]!.timestamp;
    const spans = windowEnd - windowStart <= windowMs;
    if (!spans && sources.length < 2) continue;
    clusters.push({
      key,
      reason: `Shared ${key.split(':')[0]} across ${group.length} events`,
      logs: sorted,
      sources,
      windowStart,
      windowEnd,
    });
  }

  // Largest / most cross-source clusters first.
  return clusters.sort(
    (a, b) => b.sources.length - a.sources.length || b.logs.length - a.logs.length,
  );
}

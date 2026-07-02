import type { ParsedLog } from '@log/shared';
import { getBaseline, upsertBaseline, type PatternBaseline } from '@log/db';

const ALPHA = 0.3; // EWMA smoothing factor

export interface AnomalyScore {
  fingerprint: string;
  sample: string;
  source: string;
  observedRate: number; // events/min in the window
  baselineRate: number;
  zScore: number;
  isNew: boolean;
  count: number;
}

/**
 * Update per-fingerprint baselines from a window of logs and return anomaly
 * scores. This is the "learning" capability: baselines (EWMA rate + variance)
 * are persisted so the system adapts to normal behaviour over time.
 */
export async function scoreAndLearn(
  logs: ParsedLog[],
  windowMs: number,
): Promise<AnomalyScore[]> {
  const windowMin = Math.max(windowMs / 60_000, 1 / 60);

  // Group window by fingerprint.
  const groups = new Map<string, ParsedLog[]>();
  for (const l of logs) {
    const g = groups.get(l.fingerprint) ?? [];
    g.push(l);
    groups.set(l.fingerprint, g);
  }

  const scores: AnomalyScore[] = [];
  const now = Date.now();

  for (const [fp, group] of groups) {
    const count = group.length;
    const observedRate = count / windowMin;
    const first = group[0]!;
    const prior = await getBaseline(fp);

    let zScore = 0;
    let isNew = false;
    let next: PatternBaseline;

    if (!prior) {
      isNew = true;
      next = {
        fingerprint: fp,
        source: first.source,
        sample: first.message.slice(0, 500),
        occurrences: count,
        ewmaRate: observedRate,
        ewmaVariance: 0,
        lastSeen: now,
        firstSeen: now,
        isKnownGood: false,
      };
    } else {
      const std = Math.sqrt(prior.ewmaVariance) || observedRate * 0.25 + 1;
      zScore = (observedRate - prior.ewmaRate) / std;
      const newRate = ALPHA * observedRate + (1 - ALPHA) * prior.ewmaRate;
      const diff = observedRate - prior.ewmaRate;
      const newVar = (1 - ALPHA) * (prior.ewmaVariance + ALPHA * diff * diff);
      next = {
        ...prior,
        occurrences: prior.occurrences + count,
        ewmaRate: newRate,
        ewmaVariance: newVar,
        lastSeen: now,
        sample: first.message.slice(0, 500),
      };
    }

    await upsertBaseline(next);
    scores.push({
      fingerprint: fp,
      sample: first.message,
      source: first.source,
      observedRate,
      baselineRate: prior?.ewmaRate ?? 0,
      zScore,
      isNew,
      count,
    });
  }

  return scores;
}

/** Heuristic gate: is this score worth escalating to the reasoning agent? */
export function isAnomalous(s: AnomalyScore): boolean {
  if (s.isNew && s.count >= 3) return true; // new burst
  if (s.zScore >= 3) return true; // statistical spike
  return false;
}

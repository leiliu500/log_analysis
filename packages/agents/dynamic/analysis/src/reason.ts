import { randomUUID } from 'node:crypto';
import type { Anomaly, ParsedLog } from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converseJson, embed } from './bedrock.js';
import type { AnomalyScore } from './learn.js';
import type { Cluster } from './correlate.js';

const REASONING_SYSTEM = loadPrompt('analysis/reason.md');

interface ModelAnomaly {
  kind: Anomaly['kind'];
  severity: Anomaly['severity'];
  title: string;
  summary: string;
  confidence: number;
  sourceLogGroups?: string[];
  reasoning: string[];
  recommendations: string[];
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function renderLogs(logs: ParsedLog[], max = 40): string {
  return logs
    .slice(0, max)
    .map(
      (l) =>
        `[${new Date(l.timestamp).toISOString()}] source=${l.source} sourceLogGroup=${l.stream} level=${l.level.toUpperCase()} message=${l.message}`,
    )
    .join('\n');
}

/**
 * Ask the reasoning model to explain a correlated cluster and emit a Anomaly.
 * The result is embedded for later semantic retrieval by the chatbot.
 */
export async function reasonAboutCluster(
  cluster: Cluster,
  context: { anomaly?: AnomalyScore } = {},
): Promise<Anomaly> {
  const stat = context.anomaly
    ? `Observed rate ${context.anomaly.observedRate.toFixed(2)}/min vs baseline ${context.anomaly.baselineRate.toFixed(2)}/min (z=${context.anomaly.zScore.toFixed(1)}, new=${context.anomaly.isNew}).`
    : 'No statistical baseline available.';

  const prompt = `Correlation key: ${cluster.key}
Reason: ${cluster.reason}
Sources: ${cluster.sources.join(', ')}
Statistical context: ${stat}

Logs:
${renderLogs(cluster.logs)}`;

  const mf = await converseJson<ModelAnomaly>(prompt, {
    system: REASONING_SYSTEM,
    temperature: 0.1,
    stage: 'analysis-reason',
    // Correlated log evidence is data, not a human-authored instruction. Exempt it from
    // input prompt-attack filtering while preserving guardrail checks on the finding.
    trustedInput: true,
  });
  const observedSourceLogGroups = uniqueStrings(cluster.logs.map((log) => log.stream));
  const reportedSourceLogGroups = uniqueStrings(mf.sourceLogGroups ?? []);
  const sourceLogGroups = observedSourceLogGroups.length > 0
    ? observedSourceLogGroups
    : reportedSourceLogGroups;

  const summaryText = `${mf.title}\n${mf.summary}`;
  let embedding: number[] | undefined;
  try {
    embedding = await embed(summaryText);
  } catch {
    embedding = undefined; // embeddings are best-effort
  }

  return {
    id: randomUUID(),
    kind: mf.kind ?? 'reasoning',
    severity: mf.severity ?? 'medium',
    title: mf.title,
    summary: mf.summary,
    confidence: Math.max(0, Math.min(1, mf.confidence ?? 0.5)),
    sources: cluster.sources,
    sourceLogGroups,
    fingerprint: cluster.logs[0]?.fingerprint ?? cluster.key,
    evidence: cluster.logs.slice(0, 10).map((l) => ({
      logId: l.id,
      source: l.source,
      stream: l.stream,
      timestamp: l.timestamp,
      excerpt: l.message.slice(0, 800),
    })),
    reasoning: mf.reasoning ?? [],
    recommendations: mf.recommendations ?? [],
    metadata: {
      ...(context.anomaly ? { anomaly: context.anomaly } : {}),
      sourceLogGroups,
    },
    windowStart: cluster.windowStart,
    windowEnd: cluster.windowEnd,
    createdAt: Date.now(),
    embedding,
  };
}

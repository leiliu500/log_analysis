import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog } from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converseJson, embed } from './bedrock.js';
import type { AnomalyScore } from './learn.js';
import type { Cluster } from './correlate.js';

const REASONING_SYSTEM = loadPrompt('analysis/reason.md');

interface ModelFinding {
  kind: Finding['kind'];
  severity: Finding['severity'];
  title: string;
  summary: string;
  confidence: number;
  reasoning: string[];
  recommendations: string[];
}

function renderLogs(logs: ParsedLog[], max = 40): string {
  return logs
    .slice(0, max)
    .map(
      (l) =>
        `[${new Date(l.timestamp).toISOString()}] (${l.source}/${l.stream}) ${l.level.toUpperCase()} ${l.message}`,
    )
    .join('\n');
}

/**
 * Ask the reasoning model to explain a correlated cluster and emit a Finding.
 * The result is embedded for later semantic retrieval by the chatbot.
 */
export async function reasonAboutCluster(
  cluster: Cluster,
  context: { anomaly?: AnomalyScore } = {},
): Promise<Finding> {
  const stat = context.anomaly
    ? `Observed rate ${context.anomaly.observedRate.toFixed(2)}/min vs baseline ${context.anomaly.baselineRate.toFixed(2)}/min (z=${context.anomaly.zScore.toFixed(1)}, new=${context.anomaly.isNew}).`
    : 'No statistical baseline available.';

  const prompt = `Correlation key: ${cluster.key}
Reason: ${cluster.reason}
Sources: ${cluster.sources.join(', ')}
Statistical context: ${stat}

Logs:
${renderLogs(cluster.logs)}`;

  const mf = await converseJson<ModelFinding>(prompt, {
    system: REASONING_SYSTEM,
    temperature: 0.1,
  });

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
    metadata: context.anomaly ? { anomaly: context.anomaly } : {},
    windowStart: cluster.windowStart,
    windowEnd: cluster.windowEnd,
    createdAt: Date.now(),
    embedding,
  };
}

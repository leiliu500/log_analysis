import { randomUUID } from 'node:crypto';
import type { Finding, ParsedLog } from '@log/shared';
import { converseJson, embed } from './bedrock.js';
import type { AnomalyScore } from './learn.js';
import type { Cluster } from './correlate.js';

const REASONING_SYSTEM = `You are a log-analysis agent. You are given actual log
lines. Describe a finding based STRICTLY and ONLY on the literal content of those
log lines.

HARD RULES — follow exactly:
- Use ONLY facts that literally appear in the provided log lines.
- Quote the exact log text you are referring to (verbatim) in the summary.
- Do NOT invent, infer, guess, or assume anything not written in the logs:
  no root causes, no cause-and-effect ("caused by"), no error types, no
  technologies/languages/frameworks, no stack traces, no business impact.
- Do NOT assume the application is Java or any specific stack.
- reasoning[] must contain only restatements/quotes of the log content, not
  hypotheses.
- recommendations[] must be a single generic step like "Investigate the logged
  message." Do not invent remediation for causes not in the logs.
- If the log lines do not clearly show an error/problem, set severity "info" and
  say the logs show no explicit error.
- The title must paraphrase the actual logged message, not a narrative.

Respond ONLY with JSON matching:
{
  "kind": "anomaly|correlation|inference|reasoning|pattern",
  "severity": "info|low|medium|high|critical",
  "title": string,
  "summary": string,
  "confidence": number,
  "reasoning": string[],
  "recommendations": string[]
}`;

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

import { randomUUID } from 'node:crypto';
import {
  ChatRequest,
  type ChatResponse,
  type ChatContext,
  type RouteDecision,
  SimulateRequest,
  InvokeAppRequest,
} from '@log/shared';
import { converse, embed, runPipeline } from '@log/analysis';
import {
  ensureSession,
  appendMessage,
  searchFindingsByEmbedding,
  searchLogsByEmbedding,
  recentFindings,
} from '@log/db';
import { routeRequest, invokeApplication } from '@log/agents';
import { simulate } from '@log/simulator';
import { connectorFor } from '@log/ingestion';

const ANSWER_SYSTEM = `You are the log-analysis assistant. Answer the user's
question using ONLY the retrieved findings and logs provided as CONTEXT below.
These are scoped to the user's question — do NOT invent global statistics or
reference data not in the context. If the context is insufficient, say what is
missing and suggest a narrower query or an analysis run. Cite findings by their
title and logs by timestamp/source. Be concise and technical.`;

function renderContext(ctx: ChatContext): string {
  const findings = ctx.findings
    .map(
      (f, i) =>
        `#${i + 1} [${f.severity}] ${f.title}\n  ${f.summary}\n  reasoning: ${f.reasoning.join(' | ')}`,
    )
    .join('\n');
  const logs = ctx.logs
    .slice(0, 25)
    .map(
      (l) =>
        `[${new Date(l.timestamp).toISOString()}] (${l.source}) ${l.level} ${l.message}`,
    )
    .join('\n');
  return `FINDINGS:\n${findings || '(none)'}\n\nRELATED LOGS:\n${logs || '(none)'}`;
}

/**
 * Scoped conversational answer (requirement 7): route the request, retrieve
 * ONLY the findings/logs relevant to this question, and answer grounded in them.
 * Also handles simulate/invoke-app/analyze intents (requirements 9-11).
 */
export async function handleChat(input: unknown): Promise<ChatResponse> {
  const req = ChatRequest.parse(input);
  await ensureSession(req.sessionId);
  await appendMessage({
    id: randomUUID(),
    sessionId: req.sessionId,
    role: 'user',
    content: req.message,
    createdAt: Date.now(),
  });

  const route = await routeRequest(req.message);
  const { answer, context } = await dispatch(req.message, route);

  await appendMessage({
    id: randomUUID(),
    sessionId: req.sessionId,
    role: 'assistant',
    content: answer,
    createdAt: Date.now(),
  });

  return { sessionId: req.sessionId, answer, context, route };
}

async function dispatch(
  message: string,
  route: RouteDecision,
): Promise<{ answer: string; context: ChatContext }> {
  switch (route.intent) {
    case 'simulate_logs': {
      const p = route.parameters;
      const req = SimulateRequest.parse({
        application: route.targetApplication ?? p.application ?? 'cashMessage',
        // Prefer an extracted samples param; otherwise treat the whole message
        // (e.g. a pasted XML payload) as the sample.
        samples: (typeof p.samples === 'string' && p.samples) || message,
        sinks: (Array.isArray(p.sinks) ? p.sinks : undefined) ?? (route.sources.length ? route.sources : ['cloudwatch']),
        count: Number(p.count ?? 1),
        spreadMinutes: Number(p.spreadMinutes ?? 0),
      });
      const result = await simulate(req);
      const written = Object.entries(result.written)
        .map(([k, v]) => `${v} to ${k}`)
        .join(', ');
      const ids = result.messages
        .filter((m) => m.messageType === 'REQUEST')
        .map((m) => m.messageId)
        .join(', ');
      return {
        answer: `Simulated ${req.count} set(s) for "${req.application}" (${written} log entries). Request messageIds: ${ids || '(none parsed)'}. They will appear in findings after the next analysis cycle.`,
        context: { findings: [], logs: [], route },
      };
    }

    case 'invoke_application': {
      const req = InvokeAppRequest.parse({
        application: route.targetApplication ?? route.parameters.application,
        request: route.parameters.request ?? route.parameters ?? {},
      });
      const result = await invokeApplication(req);
      return {
        answer: `Invoked "${req.application}" → HTTP ${result.status} in ${result.latencyMs}ms.\n\n\`\`\`json\n${JSON.stringify(result.response, null, 2).slice(0, 2000)}\n\`\`\``,
        context: { findings: [], logs: [], route },
      };
    }

    case 'analyze_logs': {
      const source = route.sources[0] ?? 'cloudwatch';
      const since = Date.now() - 15 * 60_000;
      const records = await connectorFor(source).pull({ since, limit: 2000 });
      const result = await runPipeline(records, { windowMs: 15 * 60_000 });
      return {
        answer: `Analyzed ${result.parsed} ${source} logs; found ${result.findings.length} findings and ${result.anomalies.length} anomalies. Ask me about any of them.`,
        context: { findings: result.findings, logs: [], route },
      };
    }

    case 'query_findings':
    default: {
      const context = await retrieveScoped(message);
      const answer = await converse(
        `CONTEXT:\n${renderContext(context)}\n\nQUESTION: ${message}`,
        { system: ANSWER_SYSTEM, temperature: 0.2 },
      );
      return { answer, context: { ...context, route } };
    }
  }
}

/** Retrieve findings + logs semantically scoped to the question. */
async function retrieveScoped(message: string): Promise<ChatContext> {
  let embedding: number[] = [];
  try {
    embedding = await embed(message);
  } catch {
    /* embeddings unavailable — fall back to recency below */
  }
  const findings = embedding.length
    ? await searchFindingsByEmbedding(embedding, 8)
    : await recentFindings(8);
  const logs = embedding.length ? await searchLogsByEmbedding(embedding, 20) : [];
  return { findings, logs };
}

import { randomUUID } from 'node:crypto';
import {
  ChatRequest,
  type ChatResponse,
  type ChatContext,
  type RouteDecision,
  InvokeAppRequest,
  loadPrompt,
} from '@log/shared';
import { converse, embed } from '@log/analysis';
import {
  ensureSession,
  appendMessage,
  searchFindingsByEmbedding,
  searchLogsByEmbedding,
  recentFindings,
} from '@log/db';
import { routeRequest, invokeApplication } from '@log/agents';
import { simulate } from '@log/simulator';
import { buildSimulateRequest } from './simulate.js';
import { answerLogQuestion } from './analyze.js';

const ANSWER_SYSTEM = loadPrompt('api/chat.md');

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
      const req = buildSimulateRequest(message, route);
      const result = await simulate(req);
      const written = Object.entries(result.written)
        .map(([k, v]) => `${v} to ${k}`)
        .join(', ');
      const ids = result.messages
        .filter((m) => m.messageType === 'REQUEST')
        .map((m) => m.messageId)
        .join(', ');
      return {
        answer: `Simulated ${req.count} request/ack/response set(s) for "${req.application}" (${written} log entries). Request messageIds: ${ids}. Each ACK/Response initMessageId matches its request. They will appear in findings after the next analysis cycle.`,
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
      // Pull raw logs over the requested window and answer the question.
      const { answer, logs } = await answerLogQuestion(message, route);
      return { answer, context: { findings: [], logs, route } };
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

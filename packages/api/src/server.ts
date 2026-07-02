import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  recentFindings,
  queryLogs,
  ensureSession,
  sessionHistory,
} from '@log/db';
import { runPipeline } from '@log/analysis';
import { connectorFor } from '@log/ingestion';
import { simulate } from '@log/simulator';
import { invokeApplication } from '@log/agents';
import { SimulateRequest, InvokeAppRequest, LogSourceType } from '@log/shared';
import { handleChat } from './chat.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

// Root health check (target-group health check hits this directly, bypassing
// the /api ALB listener rule).
app.get('/health', async () => ({ ok: true, ts: Date.now() }));

/**
 * All application routes live under `/api/*` so they don't collide with the
 * Next.js UI routes (`/chat`, `/simulate`) behind the shared ALB. The web app
 * is configured with NEXT_PUBLIC_API_BASE_URL=<alb>/api.
 */
async function apiRoutes(api: FastifyInstance): Promise<void> {
  api.get('/health', async () => ({ ok: true, ts: Date.now() }));

  // -------- Dashboard: findings, logs --------
  api.get('/findings', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return { findings: await recentFindings(limit) };
  });

  const LogsQuery = z.object({
    sources: z.string().optional(),
    from: z.coerce.number().optional(),
    to: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  });
  api.get('/logs', async (req) => {
    const q = LogsQuery.parse(req.query);
    const sources = q.sources
      ? (q.sources.split(',').filter(Boolean) as z.infer<typeof LogSourceType>[])
      : undefined;
    return { logs: await queryLogs({ sources, from: q.from, to: q.to, limit: q.limit }) };
  });

  // -------- Chatbot (scoped RAG + agent routing) --------
  api.post('/chat', async (req, reply) => {
    try {
      return await handleChat(req.body);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  api.get('/chat/:sessionId/history', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    await ensureSession(sessionId);
    return { messages: await sessionHistory(sessionId, 100) };
  });

  // -------- Simulator (requirements 8 & 9) --------
  api.post('/simulate', async (req, reply) => {
    try {
      const parsed = SimulateRequest.parse(req.body);
      return await simulate(parsed);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // -------- Real application trigger (requirement 10) --------
  api.post('/invoke-app', async (req, reply) => {
    try {
      const parsed = InvokeAppRequest.parse(req.body);
      return await invokeApplication(parsed);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // -------- On-demand analysis run --------
  const AnalyzeBody = z.object({
    source: LogSourceType.default('cloudwatch'),
    since: z.coerce.number().optional(),
    limit: z.coerce.number().default(2000),
    embedLogs: z.boolean().default(false),
  });
  api.post('/analyze', async (req, reply) => {
    try {
      const b = AnalyzeBody.parse(req.body);
      const since = b.since ?? Date.now() - 15 * 60_000;
      const records = await connectorFor(b.source).pull({ since, limit: b.limit });
      const result = await runPipeline(records, { embedLogs: b.embedLogs });
      return {
        parsed: result.parsed,
        anomalies: result.anomalies.length,
        findings: result.findings,
      };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}

await app.register(apiRoutes, { prefix: '/api' });

const port = Number(process.env.API_PORT ?? 4000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`API listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

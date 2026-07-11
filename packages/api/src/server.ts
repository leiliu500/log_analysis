import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  recentFindings,
  deleteAllFindings,
  deleteAllLogs,
  queryLogs,
  ensureSession,
  sessionHistory,
  runMigrations,
  getActiveAgents,
  getAgentHistory,
  deleteAllAgents,
  recentPollerRuns,
  deleteAllPollerRuns,
} from '@log/db';
import { runPipeline } from '@log/analysis';
import { connectorFor } from '@log/ingestion';
import { simulate, handleSimulatePrompt } from '@log/simulator';
import { analyzeAllSources, applicationRegistry, routeRequest } from '@log/agents';
import { invokeApplication } from '@log/app-scp';
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
  // Every dashboard load re-runs the analysis: pull the latest logs from all
  // sources and run the pipeline (Analysis Agent) so the returned findings
  // reflect current logs, not a stale snapshot. `?analyze=false` skips the run
  // (used by internal/polling callers). `?window=<minutes>` sets the log window.
  api.get('/findings', async (req) => {
    const q = req.query as { limit?: string; analyze?: string; window?: string };
    const limit = Number(q.limit ?? 50);
    let analysis: Awaited<ReturnType<typeof analyzeAllSources>> | undefined;
    if (q.analyze !== 'false') {
      try {
        analysis = await analyzeAllSources({ windowMinutes: Number(q.window ?? 5), trigger: 'manual' });
      } catch (err) {
        req.log.error(err, 'live findings analysis failed');
      }
    }
    return { findings: await recentFindings(limit), analysis };
  });

  // -------- Agents (request/ack/response lifecycle) --------
  // Active agents (cards, still awaiting ACK/RESPONSE) + closed agents (history).
  api.get('/agents', async (req) => {
    const q = req.query as { active?: string; history?: string };
    const [active, history] = await Promise.all([
      getActiveAgents(Math.min(Number(q.active ?? 500), 2000)),
      getAgentHistory(Math.min(Number(q.history ?? 200), 1000)),
    ]);
    return { active, history };
  });

  // -------- Schedule: scheduled-ingestion run history --------
  // Timeline of poller runs (EventBridge cron every ~5 min + on-demand "Analyze
  // now"), so the dashboard's Schedule tab can show what each trigger did.
  api.get('/schedule', async (req) => {
    const q = req.query as { limit?: string };
    return { runs: await recentPollerRuns(Math.min(Number(q.limit ?? 50), 200)) };
  });

  // Clear the scheduled-ingestion run history (Schedule tab).
  api.delete('/schedule', async () => ({ deleted: await deleteAllPollerRuns() }));

  // Clear the findings table (and cascade alerts), plus the agent lifecycle —
  // the dashboard's "Clear" control resets the whole view.
  api.delete('/findings', async () => {
    const [deleted, agentsDeleted] = await Promise.all([deleteAllFindings(), deleteAllAgents()]);
    return { deleted, agentsDeleted };
  });

  // Reset stored data: findings + parsed logs. Removes stale/seeded rows so the
  // chatbot and dashboard reflect only live logs.
  api.delete('/data', async () => {
    const [findingsDeleted, logsDeleted, , scheduleDeleted] = await Promise.all([
      deleteAllFindings(),
      deleteAllLogs(),
      deleteAllAgents(),
      deleteAllPollerRuns(),
    ]);
    return { findingsDeleted, logsDeleted, scheduleDeleted };
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

  // -------- Simulator: natural-language (LLM/supervisor-driven) --------
  // The Simulator UI posts a plain sentence here; the supervisor LLM understands
  // it (count, startMessageId, ...) and the Simulator Agent runs. Returns the
  // routing decision + result so the UI can show what the LLM understood.
  api.post('/simulate/prompt', async (req, reply) => {
    try {
      return await handleSimulatePrompt(req.body, routeRequest);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // -------- Simulator: structured (direct SimulateRequest) --------
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
      const result = await runPipeline(records, { embedLogs: b.embedLogs, registry: applicationRegistry });
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

// Self-migrate on boot so a deploy applies pending schema (e.g. the agents table)
// without out-of-band access to the private RDS. Advisory-locked so the two API
// tasks don't race; never block startup on a migration hiccup.
try {
  const applied = await runMigrations();
  if (applied.length) app.log.info(`applied migrations: ${applied.join(', ')}`);
} catch (err) {
  app.log.error(err, 'boot migrations failed (continuing)');
}

const port = Number(process.env.API_PORT ?? 4000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`API listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

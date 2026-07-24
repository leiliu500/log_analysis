/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and dispatches AGENTIC processing:
 * one autonomous agent is dynamically spawned per ingested request (correlated
 * transaction) / error signature / correlation, fanned out concurrently.
 * This is the always-on path that keeps anomalies fresh (requirements 2-6).
 */
import { randomUUID } from 'node:crypto';
import { dispatchAgentic, advanceAgents } from '@log/analysis';
import type { ParsedLog, PollerTrigger, Anomaly, PollerRun } from '@log/shared';
import { allConnectors } from './source/index.js';
import { pruneAnomaliesOlderThan, insertPollerRun } from '@log/db';
import { applicationRegistry } from '@log/applications';

export interface AnalyzeOptions {
  windowMinutes?: number;
  /** Anomalies older than this are removed so the dashboard stays current. */
  anomaliesTtlMinutes?: number;
  /** Override the agent inactivity timeout (else INGEST_AGENT_TIMEOUT_MINUTES/30). */
  agentTimeoutMinutes?: number;
  /** What triggered this run — recorded for the Schedule tab. Default 'schedule'. */
  trigger?: PollerTrigger;
}

export interface AnalyzeResult {
  /** Per source: logs parsed and non-transaction anomalies produced. */
  bySource: Record<string, { parsed: number; anomalies: number }>;
  /** The request/ack/response agent lifecycle result for this poll. */
  agents: { spawned: number; advanced: number; closed: number; anomalies: number };
  pruned: number;
}

/**
 * Pull a recent window of logs from every source, run agentic processing per
 * source (parse → persist → non-transaction anomalies), then advance the
 * request/ack/response agent lifecycle ONCE for the whole poll. The lifecycle
 * runs even on an idle poll (no new logs) so stuck agents still time out and
 * report a Anomaly. Shared by the scheduled poller and the dashboard refresh.
 */
export async function analyzeAllSources(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const windowMinutes = opts.windowMinutes ?? 5;
  const windowMs = windowMinutes * 60_000;
  // Anomalies are RETAINED as history (like the agent history) rather than expired
  // after the short recent-window. Only anomalies older than the history TTL are
  // pruned; the dashboard splits them into "recent (in window)" vs "history".
  const ttlMinutes =
    opts.anomaliesTtlMinutes ?? Number(process.env.FINDINGS_HISTORY_TTL_MINUTES ?? 1440);
  const since = Date.now() - windowMs;
  const bySource: Record<string, { parsed: number; anomalies: number }> = {};

  let pruned = 0;
  try {
    pruned = await pruneAnomaliesOlderThan(Date.now() - ttlMinutes * 60_000);
  } catch (err) {
    console.error('prune anomalies failed', err);
  }

  // Per source: parse/persist + non-transaction anomalies. Collect all parsed
  // logs so the lifecycle sees every source's request/ack/response messages.
  const allParsed: ParsedLog[] = [];
  const sourceAnomalies: Anomaly[] = [];
  await Promise.all(
    allConnectors().map(async (connector) => {
      try {
        const records = await connector.pull({ since, limit: 5000 });
        if (!records.length) {
          bySource[connector.source] = { parsed: 0, anomalies: 0 };
          return;
        }
        const result = await dispatchAgentic(records, { windowMs, registry: applicationRegistry });
        allParsed.push(...result.parsed);
        sourceAnomalies.push(...result.anomalies);
        bySource[connector.source] = { parsed: result.parsed.length, anomalies: result.anomalies.length };
      } catch (err) {
        console.error(`ingest ${connector.source} failed`, err);
        bySource[connector.source] = { parsed: 0, anomalies: 0 };
      }
    }),
  );

  // Advance the agent lifecycle exactly once per poll — ALWAYS, even when
  // allParsed is empty, so timeouts fire on idle polls and report Anomalies.
  let agents = { spawned: 0, advanced: 0, closed: 0, anomalies: 0 };
  let lifeByApp: Record<string, { spawned: number; advanced: number; closed: number; anomalies: number }> = {};
  try {
    const timeoutMs =
      opts.agentTimeoutMinutes != null ? opts.agentTimeoutMinutes * 60_000 : undefined;
    const life = await advanceAgents(allParsed, applicationRegistry, {
      windowMs,
      timeoutMs,
      anomaliesTtlMs: ttlMinutes * 60_000,
    });
    agents = {
      spawned: life.spawned,
      advanced: life.advanced,
      closed: life.closed,
      anomalies: life.anomalies.length,
    };
    lifeByApp = life.byApplication;
  } catch (err) {
    console.error('agent lifecycle advance failed', err);
  }

  // Per-application breakdown for the Schedule tab (parsed by log group, anomalies
  // + agent lifecycle activity per app).
  const byApplication: NonNullable<PollerRun['byApplication']> = {};
  const bucket = (id: string) =>
    (byApplication[id] ??= { parsed: 0, anomalies: 0, spawned: 0, advanced: 0, closed: 0 });
  for (const l of allParsed) {
    const id = applicationRegistry.forLog(l)?.id;
    if (id) bucket(id).parsed += 1;
  }
  for (const f of sourceAnomalies) if (f.application) bucket(f.application).anomalies += 1;
  for (const [id, c] of Object.entries(lifeByApp)) {
    const b = bucket(id);
    b.spawned += c.spawned;
    b.advanced += c.advanced;
    b.closed += c.closed;
    b.anomalies += c.anomalies;
  }

  // Record this run for the dashboard's Schedule tab (best-effort — never fail
  // the poll on a bookkeeping error).
  const anomaliesTotal =
    Object.values(bySource).reduce((n, s) => n + s.anomalies, 0) + agents.anomalies;
  try {
    await insertPollerRun({
      id: randomUUID(),
      ranAt: startedAt,
      trigger: opts.trigger ?? 'schedule',
      windowMinutes,
      durationMs: Date.now() - startedAt,
      bySource,
      byApplication,
      agents,
      anomalies: anomaliesTotal,
      pruned,
    });
  } catch (err) {
    console.error('record poller run failed', err);
  }

  return { bySource, agents, pruned };
}

/** EventBridge entry point — the always-on scheduled analysis. */
export async function handler(event: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeAllSources(event);
}

/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and dispatches AGENTIC processing:
 * one autonomous agent is dynamically spawned per ingested request (correlated
 * transaction) / error signature / correlation, fanned out concurrently.
 * This is the always-on path that keeps findings fresh (requirements 2-6).
 */
import { dispatchAgentic, advanceAgents } from '@log/analysis';
import type { ParsedLog } from '@log/shared';
import { allConnectors } from '@log/ingestion';
import { pruneFindingsOlderThan } from '@log/db';

export interface AnalyzeOptions {
  windowMinutes?: number;
  /** Findings older than this are removed so the dashboard stays current. */
  findingsTtlMinutes?: number;
  /** Override the agent inactivity timeout (else INGEST_AGENT_TIMEOUT_MINUTES/30). */
  agentTimeoutMinutes?: number;
}

export interface AnalyzeResult {
  /** Per source: logs parsed and non-transaction findings produced. */
  bySource: Record<string, { parsed: number; findings: number }>;
  /** The request/ack/response agent lifecycle result for this poll. */
  agents: { spawned: number; advanced: number; closed: number; findings: number };
  pruned: number;
}

/**
 * Pull a recent window of logs from every source, run agentic processing per
 * source (parse → persist → non-transaction findings), then advance the
 * request/ack/response agent lifecycle ONCE for the whole poll. The lifecycle
 * runs even on an idle poll (no new logs) so stuck agents still time out and
 * report a Finding. Shared by the scheduled poller and the dashboard refresh.
 */
export async function analyzeAllSources(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const windowMinutes = opts.windowMinutes ?? 5;
  const windowMs = windowMinutes * 60_000;
  const ttlMinutes = opts.findingsTtlMinutes ?? Number(process.env.FINDINGS_TTL_MINUTES ?? 30);
  const since = Date.now() - windowMs;
  const bySource: Record<string, { parsed: number; findings: number }> = {};

  // Expire findings whose logs have aged out, so the dashboard reflects only
  // recent analysis (a finding only shows while its logs are recent).
  let pruned = 0;
  try {
    pruned = await pruneFindingsOlderThan(Date.now() - ttlMinutes * 60_000);
  } catch (err) {
    console.error('prune findings failed', err);
  }

  // Per source: parse/persist + non-transaction findings. Collect all parsed
  // logs so the lifecycle sees every source's request/ack/response messages.
  const allParsed: ParsedLog[] = [];
  await Promise.all(
    allConnectors().map(async (connector) => {
      try {
        const records = await connector.pull({ since, limit: 5000 });
        if (!records.length) {
          bySource[connector.source] = { parsed: 0, findings: 0 };
          return;
        }
        const result = await dispatchAgentic(records, { windowMs });
        allParsed.push(...result.parsed);
        bySource[connector.source] = { parsed: result.parsed.length, findings: result.findings.length };
      } catch (err) {
        console.error(`ingest ${connector.source} failed`, err);
        bySource[connector.source] = { parsed: 0, findings: 0 };
      }
    }),
  );

  // Advance the agent lifecycle exactly once per poll — ALWAYS, even when
  // allParsed is empty, so timeouts fire on idle polls and report Findings.
  let agents = { spawned: 0, advanced: 0, closed: 0, findings: 0 };
  try {
    const timeoutMs =
      opts.agentTimeoutMinutes != null ? opts.agentTimeoutMinutes * 60_000 : undefined;
    const life = await advanceAgents(allParsed, { windowMs, timeoutMs });
    agents = {
      spawned: life.spawned,
      advanced: life.advanced,
      closed: life.closed,
      findings: life.findings.length,
    };
  } catch (err) {
    console.error('agent lifecycle advance failed', err);
  }

  return { bySource, agents, pruned };
}

/** EventBridge entry point — the always-on scheduled analysis. */
export async function handler(event: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeAllSources(event);
}

/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and dispatches AGENTIC processing:
 * one autonomous agent is dynamically spawned per ingested request (correlated
 * transaction) / error signature / correlation, fanned out concurrently.
 * This is the always-on path that keeps findings fresh (requirements 2-6).
 */
import { dispatchAgentic } from '@log/analysis';
import { allConnectors } from '@log/ingestion';
import { pruneFindingsOlderThan } from '@log/db';

export interface AnalyzeOptions {
  windowMinutes?: number;
  /** Findings older than this are removed so the dashboard stays current. */
  findingsTtlMinutes?: number;
}

export interface AnalyzeResult {
  /** Per source: logs parsed, agents spawned, and findings produced. */
  bySource: Record<string, { parsed: number; spawned: number; findings: number }>;
  pruned: number;
}

/**
 * Pull a recent window of logs from every source and dispatch agentic
 * processing (parse → spawn one agent per ingested request → each triages,
 * LLM-reasons if anomalous, and persists a finding). Shared by the scheduled
 * poller and the on-demand dashboard refresh so both report current findings.
 */
export async function analyzeAllSources(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const windowMinutes = opts.windowMinutes ?? 5;
  const ttlMinutes = opts.findingsTtlMinutes ?? Number(process.env.FINDINGS_TTL_MINUTES ?? 30);
  const since = Date.now() - windowMinutes * 60_000;
  const bySource: Record<string, { parsed: number; spawned: number; findings: number }> = {};

  // Expire findings whose logs have aged out, so the dashboard reflects only
  // recent analysis (a finding only shows while its logs are recent).
  let pruned = 0;
  try {
    pruned = await pruneFindingsOlderThan(Date.now() - ttlMinutes * 60_000);
  } catch (err) {
    console.error('prune findings failed', err);
  }

  await Promise.all(
    allConnectors().map(async (connector) => {
      try {
        const records = await connector.pull({ since, limit: 5000 });
        if (!records.length) {
          bySource[connector.source] = { parsed: 0, spawned: 0, findings: 0 };
          return;
        }
        const result = await dispatchAgentic(records, { windowMs: windowMinutes * 60_000 });
        bySource[connector.source] = {
          parsed: result.parsed,
          spawned: result.spawned,
          findings: result.findings.length,
        };
      } catch (err) {
        console.error(`ingest ${connector.source} failed`, err);
        bySource[connector.source] = { parsed: 0, spawned: 0, findings: 0 };
      }
    }),
  );

  return { bySource, pruned };
}

/** EventBridge entry point — the always-on scheduled analysis. */
export async function handler(event: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeAllSources(event);
}

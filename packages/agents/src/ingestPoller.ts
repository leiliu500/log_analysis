/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and runs the analysis pipeline.
 * This is the always-on path that keeps findings fresh (requirements 2-6).
 */
import { runPipeline } from '@log/analysis';
import { allConnectors } from '@log/ingestion';
import { pruneFindingsOlderThan } from '@log/db';

export interface AnalyzeOptions {
  windowMinutes?: number;
  /** Findings older than this are removed so the dashboard stays current. */
  findingsTtlMinutes?: number;
}

export interface AnalyzeResult {
  bySource: Record<string, { parsed: number; findings: number }>;
  pruned: number;
}

/**
 * Pull a recent window of logs from every source and run the analysis pipeline
 * (the Analysis Agent's log processing: parse → detect anomalies → LLM reason →
 * persist findings). Shared by the scheduled poller and the on-demand dashboard
 * refresh so both report the same, current findings.
 */
export async function analyzeAllSources(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const windowMinutes = opts.windowMinutes ?? 5;
  const ttlMinutes = opts.findingsTtlMinutes ?? Number(process.env.FINDINGS_TTL_MINUTES ?? 30);
  const since = Date.now() - windowMinutes * 60_000;
  const bySource: Record<string, { parsed: number; findings: number }> = {};

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
          bySource[connector.source] = { parsed: 0, findings: 0 };
          return;
        }
        const result = await runPipeline(records, { windowMs: windowMinutes * 60_000 });
        bySource[connector.source] = {
          parsed: result.parsed,
          findings: result.findings.length,
        };
      } catch (err) {
        console.error(`ingest ${connector.source} failed`, err);
        bySource[connector.source] = { parsed: 0, findings: 0 };
      }
    }),
  );

  return { bySource, pruned };
}

/** EventBridge entry point — the always-on scheduled analysis. */
export async function handler(event: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  return analyzeAllSources(event);
}

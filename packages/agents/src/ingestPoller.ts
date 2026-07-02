/**
 * Scheduled ingestion Lambda. EventBridge invokes this every N minutes; it
 * pulls a window of logs from every source and runs the analysis pipeline.
 * This is the always-on path that keeps findings fresh (requirements 2-6).
 */
import { runPipeline } from '@log/analysis';
import { allConnectors } from '@log/ingestion';

interface ScheduleEvent {
  windowMinutes?: number;
}

export async function handler(event: ScheduleEvent = {}): Promise<{
  bySource: Record<string, { parsed: number; findings: number }>;
}> {
  const windowMinutes = event.windowMinutes ?? 5;
  const since = Date.now() - windowMinutes * 60_000;
  const bySource: Record<string, { parsed: number; findings: number }> = {};

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

  return { bySource };
}

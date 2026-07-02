import type { RawLogRecord } from '@log/shared';
import type { LogConnector, PullOptions } from './connector.js';

/**
 * Grafana Loki connector. Reads via query_range and writes via the Loki push
 * API. (Grafana dashboards front Loki for log storage.)
 */
export class GrafanaLokiConnector implements LogConnector {
  readonly source = 'grafana' as const;

  constructor(
    private url = process.env.GRAFANA_LOKI_URL ?? '',
    private token = process.env.GRAFANA_API_TOKEN ?? '',
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async pull(opts: PullOptions): Promise<RawLogRecord[]> {
    if (!this.url) return [];
    const query = opts.query ?? '{job=~".+"}';
    const params = new URLSearchParams({
      query,
      start: String(opts.since * 1_000_000), // Loki wants nanoseconds
      end: String((opts.until ?? Date.now()) * 1_000_000),
      limit: String(opts.limit ?? 1000),
      direction: 'backward',
    });
    const res = await fetch(`${this.url}/loki/api/v1/query_range?${params}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Loki query failed: ${res.status}`);
    const body = (await res.json()) as {
      data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
    };
    const out: RawLogRecord[] = [];
    for (const streamObj of body.data?.result ?? []) {
      const label = JSON.stringify(streamObj.stream ?? {});
      for (const [ns, line] of streamObj.values ?? []) {
        out.push({
          source: 'grafana',
          stream: label,
          timestamp: Math.floor(Number(ns) / 1_000_000),
          raw: line,
          attributes: streamObj.stream ?? {},
        });
      }
    }
    return out;
  }

  /** Push logs to Loki (used by the simulator). */
  async write(records: RawLogRecord[]): Promise<number> {
    if (!this.url || !records.length) return 0;
    const streams = [
      {
        stream: { job: records[0]!.stream || 'simulator', source: 'simulator' },
        values: records
          .sort((a, b) => a.timestamp - b.timestamp)
          .map((r) => [String(r.timestamp * 1_000_000), r.raw] as [string, string]),
      },
    ];
    const res = await fetch(`${this.url}/loki/api/v1/push`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ streams }),
    });
    if (!res.ok) throw new Error(`Loki push failed: ${res.status}`);
    return records.length;
  }
}

import type { RawLogRecord } from '@log/shared';
import type { LogConnector, PullOptions } from './connector.js';

/**
 * Splunk connector. Reads via the REST search API (oneshot export) and writes
 * via the HTTP Event Collector (HEC). Auth is a bearer token.
 */
export class SplunkConnector implements LogConnector {
  readonly source = 'splunk' as const;

  constructor(
    private host = process.env.SPLUNK_HOST ?? '',
    private token = process.env.SPLUNK_TOKEN ?? '',
    private hecHost = process.env.SPLUNK_HEC_HOST ?? process.env.SPLUNK_HOST ?? '',
    private hecToken = process.env.SPLUNK_HEC_TOKEN ?? '',
  ) {}

  async pull(opts: PullOptions): Promise<RawLogRecord[]> {
    if (!this.host || !this.token) return [];
    const search = opts.query ?? 'search index=* | head 1000';
    const params = new URLSearchParams({
      search: search.startsWith('search') ? search : `search ${search}`,
      output_mode: 'json',
      earliest_time: new Date(opts.since).toISOString(),
      latest_time: new Date(opts.until ?? Date.now()).toISOString(),
      count: String(opts.limit ?? 1000),
    });
    const res = await fetch(`${this.host}/services/search/jobs/export`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) throw new Error(`Splunk export failed: ${res.status}`);
    const text = await res.text();
    // Export API returns newline-delimited JSON.
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const obj = JSON.parse(line) as { result?: { _raw?: string; _time?: string } };
          const raw = obj.result?._raw ?? line;
          const ts = obj.result?._time ? Date.parse(obj.result._time) : Date.now();
          return { source: 'splunk' as const, stream: 'splunk', timestamp: ts, raw, attributes: {} };
        } catch {
          return { source: 'splunk' as const, stream: 'splunk', timestamp: Date.now(), raw: line, attributes: {} };
        }
      });
  }

  /** Write via HEC (used by the simulator). */
  async write(records: RawLogRecord[]): Promise<number> {
    if (!this.hecHost || !this.hecToken) return 0;
    const body = records
      .map((r) =>
        JSON.stringify({ time: r.timestamp / 1000, event: r.raw, source: r.stream }),
      )
      .join('\n');
    const res = await fetch(`${this.hecHost}/services/collector/event`, {
      method: 'POST',
      headers: {
        Authorization: `Splunk ${this.hecToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!res.ok) throw new Error(`Splunk HEC write failed: ${res.status}`);
    return records.length;
  }
}

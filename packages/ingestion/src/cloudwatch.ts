import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  PutLogEventsCommand,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DescribeLogStreamsCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { RawLogRecord } from '@log/shared';
import type { LogConnector, PullOptions } from './connector.js';

export class CloudWatchConnector implements LogConnector {
  readonly source = 'cloudwatch' as const;
  private client: CloudWatchLogsClient;

  constructor(
    private logGroups: string[] = (process.env.CLOUDWATCH_LOG_GROUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    region = process.env.AWS_REGION ?? 'us-east-1',
  ) {
    this.client = new CloudWatchLogsClient({ region });
  }

  /**
   * Resolve configured entries to concrete log-group names. An entry containing
   * "*" (e.g. "/sim/*") is expanded via DescribeLogGroups so simulated app
   * groups like "/sim/cashMessage" are discovered automatically.
   */
  private async resolveGroups(): Promise<string[]> {
    const out: string[] = [];
    for (const entry of this.logGroups) {
      if (!entry.includes('*')) {
        out.push(entry);
        continue;
      }
      const prefix = entry.slice(0, entry.indexOf('*'));
      let token: string | undefined;
      do {
        const res = await this.client.send(
          new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken: token }),
        );
        for (const lg of res.logGroups ?? []) if (lg.logGroupName) out.push(lg.logGroupName);
        token = res.nextToken;
      } while (token);
    }
    return [...new Set(out)];
  }

  async pull(opts: PullOptions): Promise<RawLogRecord[]> {
    const out: RawLogRecord[] = [];
    const groups = await this.resolveGroups();
    for (const group of groups) {
      let token: string | undefined;
      do {
        const res = await this.client.send(
          new FilterLogEventsCommand({
            logGroupName: group,
            startTime: opts.since,
            endTime: opts.until,
            filterPattern: opts.query,
            nextToken: token,
            limit: Math.min(opts.limit ?? 1000, 10000),
          }),
        );
        for (const e of res.events ?? []) {
          out.push({
            source: 'cloudwatch',
            stream: group,
            timestamp: e.timestamp ?? Date.now(),
            raw: e.message ?? '',
            attributes: { logStreamName: e.logStreamName },
          });
        }
        token = res.nextToken;
        if (out.length >= (opts.limit ?? 1000)) break;
      } while (token);
    }
    return out;
  }

  /** Writes records to CloudWatch (used by the simulator). */
  async write(records: RawLogRecord[]): Promise<number> {
    if (!records.length) return 0;
    const group = records[0]!.stream || this.logGroups[0] || '/sim/default';
    const stream = `sim-${new Date().toISOString().slice(0, 10)}`;
    await this.ensureStream(group, stream);
    const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
    await this.client.send(
      new PutLogEventsCommand({
        logGroupName: group,
        logStreamName: stream,
        logEvents: sorted.map((r) => ({ timestamp: r.timestamp, message: r.raw })),
      }),
    );
    return records.length;
  }

  private async ensureStream(group: string, stream: string): Promise<void> {
    try {
      await this.client.send(new CreateLogGroupCommand({ logGroupName: group }));
    } catch {
      /* already exists */
    }
    try {
      const existing = await this.client.send(
        new DescribeLogStreamsCommand({
          logGroupName: group,
          logStreamNamePrefix: stream,
        }),
      );
      if (!existing.logStreams?.some((s) => s.logStreamName === stream)) {
        await this.client.send(
          new CreateLogStreamCommand({ logGroupName: group, logStreamName: stream }),
        );
      }
    } catch {
      /* best effort */
    }
  }
}

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { RawLogRecord } from '@log/shared';
import type { LogConnector, PullOptions } from './connector.js';

/**
 * Email-alert connector. Reads inbound alert emails that SES delivers to an S3
 * bucket, and (for the simulator) sends alert emails via SES. Each email is
 * treated as a single log record whose `raw` is the message text.
 */
export class EmailConnector implements LogConnector {
  readonly source = 'email' as const;
  private s3: S3Client;
  private ses: SESv2Client;

  constructor(
    private bucket = process.env.EMAIL_S3_BUCKET ?? '',
    private prefix = process.env.EMAIL_S3_PREFIX ?? 'inbound/',
    private fromAddress = process.env.EMAIL_FROM ?? 'alerts@example.com',
    private toAddress = process.env.EMAIL_TO ?? 'oncall@example.com',
    region = process.env.AWS_REGION ?? 'us-east-1',
  ) {
    this.s3 = new S3Client({ region });
    this.ses = new SESv2Client({ region });
  }

  async pull(opts: PullOptions): Promise<RawLogRecord[]> {
    if (!this.bucket) return [];
    const list = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        MaxKeys: opts.limit ?? 200,
      }),
    );
    const out: RawLogRecord[] = [];
    for (const obj of list.Contents ?? []) {
      const modified = obj.LastModified?.getTime() ?? Date.now();
      if (modified < opts.since) continue;
      const body = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key! }),
      );
      const raw = (await body.Body?.transformToString()) ?? '';
      out.push({
        source: 'email',
        stream: this.prefix,
        timestamp: modified,
        raw: extractEmailText(raw),
        attributes: { key: obj.Key },
      });
    }
    return out;
  }

  /** Send an alert email per record (used by the simulator). */
  async write(records: RawLogRecord[]): Promise<number> {
    if (!this.bucket && !this.fromAddress) return 0;
    let sent = 0;
    for (const r of records) {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromAddress,
          Destination: { ToAddresses: [this.toAddress] },
          Content: {
            Simple: {
              Subject: { Data: `[Alert] ${r.raw.slice(0, 80)}` },
              Body: { Text: { Data: r.raw } },
            },
          },
        }),
      );
      sent++;
    }
    return sent;
  }
}

/** Strips MIME headers to the plain-text body (best effort). */
function extractEmailText(raw: string): string {
  const idx = raw.indexOf('\r\n\r\n');
  const body = idx >= 0 ? raw.slice(idx + 4) : raw;
  return body.replace(/=\r?\n/g, '').trim().slice(0, 4000);
}

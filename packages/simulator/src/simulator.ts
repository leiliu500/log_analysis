import { randomUUID } from 'node:crypto';
import type {
  RawLogRecord,
  SimulateRequest,
  SimulateResult,
  LogSourceType,
} from '@log/shared';
import { connectorFor } from '@log/ingestion';
import { generateTemplates, type LogTemplate } from './generator.js';

// Seedable PRNG so simulation is reproducible within a run (no Math.random,
// which is unavailable in some sandboxed contexts and non-deterministic).
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function expand(tpl: string, rng: () => number, base: number): string {
  return tpl
    .replace(/\{reqId\}/g, () => `req-${Math.floor(rng() * 1e9).toString(36)}`)
    .replace(/\{userId\}/g, () => `user-${Math.floor(rng() * 1e6)}`)
    .replace(/\{latencyMs\}/g, () => String(Math.floor(20 + rng() * 480)))
    .replace(/\{status\}/g, () => (rng() < 0.9 ? '200' : '500'));
}

function toRecord(
  tpl: LogTemplate,
  stream: string,
  ts: number,
  rng: () => number,
): RawLogRecord {
  const payload = {
    level: tpl.level,
    message: expand(tpl.message, rng, ts),
    ...tpl.fields,
    ts: new Date(ts).toISOString(),
  };
  return { source: 'cloudwatch', stream, timestamp: ts, raw: JSON.stringify(payload), attributes: {} };
}

/**
 * The Simulator Agent. Generates realistic logs for `application` from a sample
 * request/response and writes them into the requested sinks. Backs requirements
 * (8) and (9). `seed` keeps a run reproducible.
 */
export async function simulate(req: SimulateRequest, seed = 12345): Promise<SimulateResult> {
  const rng = makeRng(seed);
  const templates = await generateTemplates(req);
  const now = Date.now();
  const spreadMs = req.spreadMinutes * 60_000;
  const batchId = randomUUID();

  // Build `count` records by cycling templates with varied tokens + timestamps.
  const records: RawLogRecord[] = [];
  for (let i = 0; i < req.count; i++) {
    let tpl = templates[i % templates.length]!;
    // Anomaly injection: bias a tail of the run toward error templates.
    if (req.injectAnomalies && i > req.count * 0.75) {
      const errs = templates.filter((t) => t.level === 'error');
      if (errs.length) tpl = errs[i % errs.length]!;
    }
    const ts = spreadMs ? now - spreadMs + Math.floor((i / req.count) * spreadMs) : now;
    records.push(toRecord(tpl, `/sim/${req.application}`, ts, rng));
  }

  // Fan out to each requested sink's connector.
  const written = {} as Record<LogSourceType, number>;
  for (const sink of req.sinks) {
    const connector = connectorFor(sink);
    if (!connector.write) {
      written[sink] = 0;
      continue;
    }
    const stamped = records.map((r) => ({ ...r, source: sink }));
    try {
      written[sink] = await connector.write(stamped);
    } catch (err) {
      console.error(`simulator: write to ${sink} failed`, err);
      written[sink] = 0;
    }
  }

  return { application: req.application, written, batchId };
}

import { randomUUID } from 'node:crypto';
import type {
  RawLogRecord,
  SimulateRequest,
  SimulateResult,
  SimulatedMessage,
  LogSourceType,
} from '@log/shared';
import { connectorFor } from '@log/ingestion';
import { splitMessages, messageType, getTag, setTag, bumpId } from './xml.js';

/**
 * The Simulator Agent. Reads the pasted sample message(s) (XML like an FRB
 * cashMessage, and optionally its ACK/Response), then generates `count`
 * correlated sets and writes them verbatim to the requested sinks.
 *
 * Correlation rule (requirement 2): within each generated set the Request's
 * <messageId> is a fresh unique id, and every ACK/Response's <initMessageId> is
 * set to that same id. Each set gets a distinct id (requirement 3): count=1 →
 * one set reusing the sample id; count=N → N sets with incremented ids.
 */
export async function simulate(req: SimulateRequest): Promise<SimulateResult> {
  const samples = splitMessages(req.samples);
  if (samples.length === 0) {
    return { application: req.application, written: {} as Record<LogSourceType, number>, batchId: randomUUID(), messages: [] };
  }

  // The Request drives correlation; if none is typed, treat the first message as it.
  const requestSample = samples.find((m) => messageType(m) === 'REQUEST') ?? samples[0]!;
  // startMessageId (from the NL prompt) overrides the sample's id when provided.
  const baseRequestId =
    req.startMessageId ?? getTag(requestSample, 'messageId') ?? `SIM-${req.application}-1`;

  const now = Date.now();
  const spreadMs = req.spreadMinutes * 60_000;
  const batchId = randomUUID();
  // Write into the requested target log group (explicit name or content type)
  // when given; otherwise the default per-application simulated stream.
  const stream = req.logGroup?.trim() || `/sim/${req.application}`;

  const records: RawLogRecord[] = [];
  const summary: SimulatedMessage[] = [];

  for (let i = 0; i < req.count; i++) {
    const requestId = bumpId(baseRequestId, i);
    const baseTs = spreadMs ? now - spreadMs + Math.floor((i / req.count) * spreadMs) : now;
    let offset = 0;

    for (const sample of samples) {
      const type = messageType(sample) || (sample === requestSample ? 'REQUEST' : 'MESSAGE');
      // Only emit the requested message types (e.g. omit RESPONSE for a
      // "request/ack without response" simulation).
      if ((type === 'REQUEST' || type === 'ACK' || type === 'RESPONSE') && !req.messageTypes.includes(type)) {
        continue;
      }
      let out = sample;
      let ownId: string;

      if (sample === requestSample || type === 'REQUEST') {
        // Request: its messageId becomes the correlation id for this set.
        ownId = requestId;
        out = setTag(out, 'messageId', requestId);
      } else {
        // ACK / Response: point initMessageId at the request, keep a unique own id.
        out = setTag(out, 'initMessageId', requestId);
        const sampleOwnId = getTag(sample, 'messageId');
        ownId = sampleOwnId ? bumpId(sampleOwnId, i) : `${requestId}-${type}`;
        if (sampleOwnId) out = setTag(out, 'messageId', ownId);
        // Apply the requested ack status (failure -> FAILED ackCode).
        if (req.ackStatus === 'failure') out = setTag(out, 'ackCode', 'FAILED');
      }

      // Freshen sendTime if present so log timestamps look current.
      out = setTag(out, 'sendTime', new Date(baseTs + offset).toISOString());

      records.push({
        source: 'cloudwatch',
        stream,
        timestamp: baseTs + offset,
        raw: out,
        attributes: {
          application: req.application,
          messageType: type,
          messageId: ownId,
          initMessageId: type === 'REQUEST' ? undefined : requestId,
          batchId,
          set: i,
        },
      });
      summary.push({
        messageType: type,
        messageId: ownId,
        initMessageId: type === 'REQUEST' ? undefined : requestId,
        ackCode: type === 'REQUEST' ? undefined : getTag(out, 'ackCode'),
      });
      offset += 1;
    }
  }

  // Fan out to each requested sink's connector, writing the records verbatim.
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

  return { application: req.application, written, batchId, messages: summary };
}

/**
 * Verbatim simulation for line-based logs (e.g. apiflc's raw Lambda / API-Gateway
 * output): write each non-empty line of the sample as its own CloudWatch event,
 * `count` sets, freshening uuid / correlationID tokens per set so each set is a
 * distinct transaction. No XML rewriting — the content is written as pasted.
 */
export async function simulateVerbatim(req: SimulateRequest): Promise<SimulateResult> {
  const lines = req.samples
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
  const stream = req.logGroup?.trim() || `/sim/${req.application}`;
  const now = Date.now();
  const spreadMs = req.spreadMinutes * 60_000;
  const batchId = randomUUID();
  const records: RawLogRecord[] = [];
  const summary: SimulatedMessage[] = [];
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  // Preserve the pasted transaction's own correlationID (e.g. 1234) instead of
  // inventing one — the first set writes it verbatim; extra sets (count>1) are
  // bumped off it so they stay distinct. Only fall back to a synthetic base when
  // the paste carries no correlationID and the caller gave no startMessageId.
  const pastedCorr = req.samples.match(/correlationID:\s*([A-Za-z0-9._-]+)/i)?.[1];
  const corrBase = req.startMessageId ?? pastedCorr;

  for (let i = 0; i < req.count; i++) {
    const freshUuid = randomUUID();
    const freshCorr = corrBase ? bumpId(corrBase, i) : String(1000 + i);
    const baseTs = spreadMs ? now - spreadMs + Math.floor((i / req.count) * spreadMs) : now;
    lines.forEach((line, k) => {
      // The first set is written exactly as pasted (keep its real uuid/requestId);
      // only additional sets get a fresh uuid so they don't collide.
      let out = i > 0 ? line.replace(uuidRe, freshUuid) : line;
      out = out.replace(/(correlationID:\s*)[A-Za-z0-9._-]+/gi, `$1${freshCorr}`);
      records.push({
        source: 'cloudwatch',
        stream,
        timestamp: baseTs + k,
        raw: out,
        attributes: { application: req.application, batchId, set: i },
      });
    });
    // Report the transaction by its correlationID (what apiflc correlates on).
    summary.push({ messageType: 'SET', messageId: freshCorr });
  }

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
      console.error(`simulator: verbatim write to ${sink} failed`, err);
      written[sink] = 0;
    }
  }
  return { application: req.application, written, batchId, messages: summary };
}

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
  const stream = `/sim/${req.application}`;

  const records: RawLogRecord[] = [];
  const summary: SimulatedMessage[] = [];

  for (let i = 0; i < req.count; i++) {
    const requestId = bumpId(baseRequestId, i);
    const baseTs = spreadMs ? now - spreadMs + Math.floor((i / req.count) * spreadMs) : now;
    let offset = 0;

    for (const sample of samples) {
      const type = messageType(sample) || (sample === requestSample ? 'REQUEST' : 'MESSAGE');
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

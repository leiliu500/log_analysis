import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPromptContext, ParsedLog, TransitionDecision } from '@log/shared';
import { apiflcIngestionAgent, apiflcPendingSignals } from './agent.js';

const log = (raw: string, stream = 'x'): ParsedLog =>
  ({ raw, source: 'cloudwatch', stream, timestamp: 0 } as unknown as ParsedLog);

const ctx = (window: ParsedLog[], over: Partial<AgentPromptContext> = {}): AgentPromptContext => ({
  messageId: '1234',
  currentStatus: 'awaiting',
  phaseTs: { REQUEST: 0 },
  phasesThisCycle: ['REQUEST'],
  eventLines: ['correlationID: 1234; FedLine Request'],
  window,
  now: 0,
  ...over,
});

test('apiflc agent joins the gateway execution log so the model reasons over the HTTP status', async () => {
  const gw = '68f54c61-3e54-4e02-8ccf-2fbc14576104';
  const lambda = '45e5ece0-7dbe-490a-880b-38670acab559';
  const trace = '1-6a45ea62-54e4e5dd10e9b6af71959157';
  const window = [
    log(`2026-07-02T04:34:43.329Z ${lambda} INFO correlationID: 1234; FedLine Request: {...}`),
    log(`2026-07-02T04:34:48.381Z ${lambda} INFO correlationID: 1234; Response from Data Services:`),
    log(`(${gw}) Method request headers: {X-Correlation-ID=1234, User-Agent=x}`),
    log(`(${gw}) Endpoint response headers: {x-amzn-RequestId=${lambda}, X-Amzn-Trace-Id=Root=${trace}}`),
    log(`(${gw}) Method completed with status: 200`),
  ];

  // Capture the evidence the model is asked to reason over, and only complete on the 200.
  let seenUser = '';
  const httpAware = async (_system: string, user: string): Promise<Partial<TransitionDecision>> => {
    seenUser = user;
    return /status:\s*200/i.test(user) ? { status: 'completed', detail: 'gateway HTTP 200' } : { status: 'awaiting', waitingFor: 'RESPONSE', detail: 'no status' };
  };

  const d = await apiflcIngestionAgent.decide(ctx(window), httpAware);
  assert.equal(d?.status, 'completed');
  // The gateway status — which no protocol event carries — reached the prompt.
  assert.match(seenUser, /Method completed with status: 200/);
  assert.match(seenUser, /Full correlated call logs/);
});

test('apiflc agent defers (awaiting) when the correlated logs carry no HTTP status yet', async () => {
  const window = [log('2026-07-02T04:34:48.381Z abc INFO correlationID: 1234; Response from Data Services:')];
  const httpAware = async (_s: string, user: string): Promise<Partial<TransitionDecision>> =>
    /status:\s*\d{3}/i.test(user) ? { status: 'completed', detail: 'has status' } : { status: 'awaiting', waitingFor: 'RESPONSE', detail: 'no status yet' };
  const d = await apiflcIngestionAgent.decide(ctx(window), httpAware);
  assert.equal(d?.status, 'awaiting');
});

test('apiflcPendingSignals re-schedules an awaiting agent once the gateway HTTP status is in the window', () => {
  const gw = '68f54c61-3e54-4e02-8ccf-2fbc14576104';
  const lambda = '45e5ece0-7dbe-490a-880b-38670acab559';
  // The gateway execution logs (all together) arrive in a LATER poll than the handler.
  // They carry X-Correlation-ID=1234 and the decisive status, but NO protocol event.
  const gatewayWindow = [
    log(`(${gw}) Method request headers: {X-Correlation-ID=1234, User-Agent=x}`),
    log(`(${gw}) Endpoint response headers: {x-amzn-RequestId=${lambda}}`),
    log(`(${gw}) Received response. Status: 200, Integration latency: 5639 ms`),
    log(`(${gw}) Method completed with status: 200`),
  ];
  assert.deepEqual(apiflcPendingSignals(gatewayWindow, ['1234']), ['1234']); // re-reason 1234

  // No status line yet ⇒ do NOT re-schedule (it would just say "still awaiting").
  const noStatus = [log(`(${gw}) Method request headers: {X-Correlation-ID=1234}`)];
  assert.deepEqual(apiflcPendingSignals(noStatus, ['1234']), []);

  // An id that doesn't correlate to anything in the window is not scheduled.
  assert.deepEqual(apiflcPendingSignals(gatewayWindow, ['9999']), []);
});

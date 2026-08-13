import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPromptContext } from '@log/shared';
import { edgeFastPath } from './agent.js';

const FILE = 'RSReel_End_2100_33_38_20260813-151338_CP_000.zip';
const ctx = (over: Partial<AgentPromptContext> = {}): AgentPromptContext => ({
  messageId: FILE,
  currentStatus: 'new',
  phaseTs: {},
  phasesThisCycle: [],
  eventLines: [],
  window: [],
  now: 0,
  ...over,
});

test('SFTP embedded ZIP value starts one edge agent awaiting BPS', () => {
  const result = edgeFastPath(ctx({ phaseTs: { SFTP: 1 }, phasesThisCycle: ['SFTP'] }));
  assert.equal(result?.status, 'awaiting');
  assert.equal(result?.waitingFor, 'BPS');
});

test('SFTP and BPS for the same embedded ZIP value await CloudWatch', () => {
  const result = edgeFastPath(ctx({ phaseTs: { SFTP: 1, BPS: 2 }, ackCode: 'SUCCESS' }));
  assert.equal(result?.status, 'awaiting');
  assert.equal(result?.waitingFor, 'CLOUDWATCH');
});

test('all filename-correlated phases complete the edge agent', () => {
  const result = edgeFastPath(ctx({ phaseTs: { SFTP: 1, BPS: 2, CLOUDWATCH: 3 }, ackCode: 'SUCCESS' }));
  assert.equal(result?.status, 'completed');
});

test('a concrete non-success status fails the edge agent', () => {
  const result = edgeFastPath(
    ctx({
      phaseTs: { SFTP: 1, BPS: 2 },
      eventLines: [`now | ${FILE} | D20260813T151053713.${FILE} | /tmp/${FILE} | FAILED`],
    }),
  );
  assert.equal(result?.status, 'failed');
  assert.equal(result?.severity, 'high');
});

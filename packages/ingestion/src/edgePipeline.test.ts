import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicationRegistry } from '@log/applications';
import { makeParsedLog } from '@log/shared';
import {
  agentEvents,
  appContextFor,
  deriveOutcome,
  relatedLogsFor,
  residualReason,
  stepAgentsDynamic,
  validateAgent,
  validationAgentInfo,
} from '@log/analysis';

const COMPLETE = 'RSReel_End_2100_33_38_20260813-151338_CP_000.zip';
const INCOMPLETE = 'RSReel_End_2100_33_38_20260813-151338_CP_001.zip';
const renamed = (file: string) => `D20260813T151053713.${file}`;

function edgeLogs() {
  return [
    makeParsedLog('edge-sftp-log-group', 1, `status=SUCCESS service=sftp operation=put arguments=/opt/in/${COMPLETE}`),
    makeParsedLog('edge-bps-log-group', 2, `now | ${COMPLETE} | ${renamed(COMPLETE)} | /opt/out/${renamed(COMPLETE)} | SUCCESS`),
    makeParsedLog('edge-cloudwatch-log-group', 3, `BPS-AUDIT-EVENT : ZIP_FILE_NM :${renamed(COMPLETE)} XML_FILE_NM :Reject_Report_${COMPLETE.replace(/\.zip$/, '.xml')}`),
    makeParsedLog('edge-sftp-log-group', 4, `status=SUCCESS service=sftp operation=put arguments=/opt/in/${INCOMPLETE}`),
    makeParsedLog('edge-bps-log-group', 5, `now | ${INCOMPLETE} | ${renamed(INCOMPLETE)} | /opt/out/${renamed(INCOMPLETE)} | SUCCESS`),
  ];
}

test('ingestion registry owns all edge log groups and declares its validation agent', () => {
  const edge = applicationRegistry.byId('edge');
  assert.ok(edge);
  assert.deepEqual(edge.logGroups, [
    'edge-sftp-log-group',
    'edge-bps-log-group',
    'edge-cloudwatch-log-group',
  ]);
  assert.equal(edge.correlationLabel, 'fileName');
  assert.equal(edge.validation?.agentPromptPath, 'apps/edge/validation.agent.md');
  assert.ok(edge.validation?.validationAgent);
  assert.equal(validationAgentInfo(applicationRegistry).find((info) => info.application === 'edge')?.enabled, true);
});

test('ingestion lifecycle correlates embedded ZIP values into complete and incomplete edge agents', async () => {
  const logs = edgeLogs();
  // No raw line contains a fileName label; ownership/correlation comes from native fields.
  assert.ok(logs.every((log) => !/\bfileName\s*[=:]/i.test(log.raw)));
  const events = agentEvents(logs, applicationRegistry);
  assert.equal(events.length, 5);
  assert.deepEqual(new Set(events.map((event) => event.corrId)), new Set([COMPLETE, INCOMPLETE]));

  const step = await stepAgentsDynamic(events, [], {
    now: 100,
    timeoutMs: 30 * 60_000,
    registry: applicationRegistry,
    windowLogs: logs,
    maxLlm: 0,
  });

  const complete = step.agents.get(COMPLETE);
  assert.equal(complete?.status, 'completed');
  assert.equal(complete?.active, false);
  assert.deepEqual(complete?.phaseTs, { SFTP: 1, BPS: 2, CLOUDWATCH: 3 });

  const incomplete = step.agents.get(INCOMPLETE);
  assert.equal(incomplete?.status, 'awaiting');
  assert.equal(incomplete?.active, true);
  assert.equal(incomplete?.waitingFor, 'CLOUDWATCH');
  assert.deepEqual(incomplete?.phaseTs, { SFTP: 4, BPS: 5 });
  assert.equal(step.spawned, 2);
  assert.equal(step.closed, 1);
  assert.equal(step.fastPathed, 2);
  assert.equal(step.reasoned, 0);
});

test('validation worker re-derives edge completion from filename-correlated logs', () => {
  const edge = applicationRegistry.byId('edge');
  assert.ok(edge);
  const logs = edgeLogs();
  const related = relatedLogsFor(edge, COMPLETE, logs);
  const ctx = appContextFor({ application: 'edge' }, applicationRegistry);
  const derived = deriveOutcome(edge, COMPLETE, related, ctx);
  derived.windowComplete = true;
  assert.equal(derived.status, 'completed');
  assert.deepEqual(derived.phasesSeen, ['SFTP', 'BPS', 'CLOUDWATCH']);

  const result = validateAgent(
    {
      messageId: COMPLETE,
      application: 'edge',
      status: 'completed',
      active: false,
      phases: ['SFTP', 'BPS', 'CLOUDWATCH'],
      phaseTs: { SFTP: 1, BPS: 2, CLOUDWATCH: 3 },
      spawnedAt: 1,
      closedAt: 3,
    },
    undefined,
    100,
    ctx,
    [],
    derived,
  );
  assert.equal(result.result, 'success');
  assert.deepEqual(result.delta, []);
  assert.match(
    residualReason(result, derived, 'clean') ?? '',
    /outcome was derived as completed/,
    'the completed Edge transaction must remain eligible for its non-blocking AI review',
  );
});

test('validation worker stays pending for an in-flight edge file without blocking the AI stage', () => {
  const ctx = appContextFor({ application: 'edge' }, applicationRegistry);
  const result = validateAgent(
    {
      messageId: INCOMPLETE,
      application: 'edge',
      status: 'awaiting',
      active: true,
      waitingFor: 'CLOUDWATCH',
      phases: ['SFTP', 'BPS', 'CLOUDWATCH'],
      phaseTs: { SFTP: 4, BPS: 5 },
      spawnedAt: 4,
    },
    undefined,
    100,
    ctx,
  );

  assert.equal(result.result, 'pending');
  assert.equal(result.active, true);
  assert.match(result.detail ?? '', /awaiting CLOUDWATCH/);
  assert.equal(residualReason(result, undefined, 'clean'), null);
});

test('validation worker rejects a completed edge agent whose embedded filename has no CloudWatch phase', () => {
  const edge = applicationRegistry.byId('edge');
  assert.ok(edge);
  const logs = edgeLogs();
  const related = relatedLogsFor(edge, INCOMPLETE, logs);
  const ctx = appContextFor({ application: 'edge' }, applicationRegistry);
  const derived = deriveOutcome(edge, INCOMPLETE, related, ctx);
  derived.windowComplete = true;
  assert.equal(derived.status, 'unknown');

  const result = validateAgent(
    {
      messageId: INCOMPLETE,
      application: 'edge',
      status: 'completed',
      active: false,
      phases: ['SFTP', 'BPS', 'CLOUDWATCH'],
      phaseTs: { SFTP: 4, BPS: 5 },
      spawnedAt: 4,
      closedAt: 5,
    },
    undefined,
    100,
    ctx,
    [],
    derived,
  );
  assert.equal(result.result, 'failure');
  assert.match(result.delta.join('; '), /missing phase\(s\): CLOUDWATCH/);
  assert.match(result.delta.join('; '), /unverified completion/);
});

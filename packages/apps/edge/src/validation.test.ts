import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParsedLog } from '@log/shared';
import { edgeRelatedLogs } from './join.js';
import { edgeDeriveOutcome } from './outcomes.js';
import { edgeValidationChecks } from './validationChecks.js';
import { edgeValidationAgent } from './validationAgent.js';

const FILE = 'RSReel_End_2100_33_38_20260813-151338_CP_000.zip';
const RENAMED = `D20260813T151053713.${FILE}`;
const logs = [
  makeParsedLog('edge-sftp-log-group', 1, `status=SUCCESS service=sftp operation=put arguments=/opt/in/${FILE}`),
  makeParsedLog('edge-bps-log-group', 2, `now | ${FILE} | ${RENAMED} | /opt/out/${RENAMED} | SUCCESS`),
  makeParsedLog('edge-cloudwatch-log-group', 3, `BPS-AUDIT-EVENT : ZIP_FILE_NM :${RENAMED} XML_FILE_NM :Reject_Report_${FILE.replace(/\.zip$/, '.xml')}`),
  makeParsedLog('edge-sftp-log-group', 4, 'status=SUCCESS service=sftp operation=put arguments=/opt/in/another.zip'),
];

test('edge validation joins all groups by the embedded normalized ZIP value only', () => {
  const related = edgeRelatedLogs(FILE, logs);
  assert.equal(related.length, 3);
  assert.deepEqual(related.map((log) => log.stream), [
    'edge-sftp-log-group',
    'edge-bps-log-group',
    'edge-cloudwatch-log-group',
  ]);
});

test('edge outcome is completed only with the filename-correlated CloudWatch phase', () => {
  assert.equal(edgeDeriveOutcome(FILE, edgeRelatedLogs(FILE, logs)).status, 'completed');
  assert.equal(edgeDeriveOutcome(FILE, edgeRelatedLogs(FILE, logs).slice(0, 2)).status, 'unknown');
});

test('edge deterministic validation accepts consistent renamed ZIP and XML values', () => {
  assert.deepEqual(
    edgeValidationChecks({ messageId: FILE, agentStatus: 'completed', relatedLogs: edgeRelatedLogs(FILE, logs) }),
    [],
  );
});

test('edge deterministic outcome proves an explicit BPS failure', () => {
  const failed = makeParsedLog(
    'edge-bps-log-group',
    2,
    `now | ${FILE} | ${RENAMED} | /opt/out/${RENAMED} | FAILED`,
  );
  const outcome = edgeDeriveOutcome(FILE, [logs[0]!, failed]);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail ?? '', /FAILED/);
});

test('edge deterministic checks detect transfer and XML values inconsistent with their ZIP', () => {
  const wrongTransfer = makeParsedLog(
    'edge-bps-log-group',
    2,
    `now | ${FILE} | D20260813T151053713.another.zip | /opt/out/another.zip | SUCCESS`,
  );
  const wrongXml = makeParsedLog(
    'edge-cloudwatch-log-group',
    3,
    `BPS-AUDIT-EVENT : ZIP_FILE_NM :${RENAMED} XML_FILE_NM :Reject_Report_another.xml`,
  );
  const deltas = edgeValidationChecks({
    messageId: FILE,
    agentStatus: 'completed',
    relatedLogs: [wrongTransfer, wrongXml],
  });
  assert.equal(deltas.length, 2);
  assert.match(deltas.join('; '), /filename mismatch/);
  assert.match(deltas.join('; '), /XML mismatch/);
});

test('edge validation AI agent loads its prompt and receives filename-parsed evidence', async () => {
  let system = '';
  let evidence = '';
  const result = await edgeValidationAgent.review(
    {
      messageId: FILE,
      application: 'edge',
      agentStatus: 'completed',
      relatedLogs: edgeRelatedLogs(FILE, logs),
      deterministicResult: 'success',
      deterministicDetail: 'phases complete within SLA',
      residualReason: 'clean transaction review',
      phases: ['SFTP', 'BPS', 'CLOUDWATCH'],
      phaseTs: { SFTP: 1, BPS: 2, CLOUDWATCH: 3 },
    },
    async (receivedSystem, receivedEvidence) => {
      system = receivedSystem;
      evidence = receivedEvidence;
      return '{"claims":[]}';
    },
  );
  assert.match(system, /edge Validation AI Agent/);
  assert.match(evidence, new RegExp(FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(evidence, /<SFTP file=/);
  assert.deepEqual(result, { findings: [], rejected: [] });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_LOG_GROUPS } from './logGroups.js';
import { synthesizeEdgeFromRequest } from './simulateEdge.js';

const input = [
  '(1) sftp log:',
  '2026-08-13 12:10:53.000 info service=sftp operation=put arguments=/opt/Apps/BPSsftp/default/RSReel_End_2100_33_38_20260813-151338_CP_220.zip',
  '(2) BPS log:',
  '2026-08-13 12:10:53.712 | RSReel_End_2100_33_38_20260813-151338_CP_220.zip | D20260813T151053713.RSReel_End_2100_33_38_20260813-151338_CP_220.zip | /opt/Apps/BPSmntgw/prod/fcm/fgp/boston/default/20260813/CP_220/D20260813T151053713.RSReel_End_2100_33_38_20260813-151338_CP_220.zip | SUCCESS',
  '(3) Cloudwatch log:',
  '2026-08-13 15:11:19,613 ZIP_FILE_NM:"D20260813T151053713.RSReel_End_2100_33_38_20260813-151338_CP_220.zip"',
  '(4) simulate sftp log into edge-sftp-log-group with file name:RSReel_End_2100_33_38_20260813-151338_CP_000.zip',
  '(5) simulate BPS log into edge-bps-log-group with file name:RSReel_End_2100_33_38_20260813-151338_CP_000.zip',
  '(6) simulate Cloudwatch log into edge-cloudwatch-log-group with file name: D20260813T151053713.RSReel_End_2100_33_38_20260813-151338_CP_000.zip',
  '(7) simulate sftp log into edge-sftp-log-group with file name:RSReel_End_2100_33_38_20260813-151338_CP_001.zip',
  '(8) simulate BPS log into edge-bps-log-group with file name:RSReel_End_2100_33_38_20260813-151338_CP_001.zip',
].join('\n');

test('edge numbered commands generate complete CP_000 and incomplete CP_001 flows', () => {
  const targets = synthesizeEdgeFromRequest(input);
  assert.ok(targets);
  assert.deepEqual(targets.map(({ group }) => group), [...EDGE_LOG_GROUPS]);

  const sftp = targets.find(({ group }) => group === EDGE_LOG_GROUPS[0])!.samples;
  assert.equal(sftp.split('\n').length, 4);
  assert.match(sftp, /CP_000\.zip/);
  assert.match(sftp, /CP_001\.zip/);
  assert.doesNotMatch(sftp, /CP_220\.zip/);

  const bps = targets.find(({ group }) => group === EDGE_LOG_GROUPS[1])!.samples;
  assert.equal(bps.split('\n').length, 4);
  assert.match(bps, /\/20260813\/CP_000\/D20260813T151053713\..*CP_000\.zip/);
  assert.match(bps, /\/20260813\/CP_001\/D20260813T151053713\..*CP_001\.zip/);
  assert.doesNotMatch(bps, /CP_220/);

  const cloudwatch = targets.find(({ group }) => group === EDGE_LOG_GROUPS[2])!.samples;
  assert.equal(cloudwatch.split('\n').length, 5);
  assert.match(cloudwatch, /D20260813T151053713\..*CP_000\.zip/);
  assert.match(cloudwatch, /Reject_Report_.*CP_000\.xml/);
  assert.doesNotMatch(cloudwatch, /CP_001|CP_220/);
});

test('edge synthesis ignores pasted reference logs when there are no simulate commands', () => {
  assert.equal(synthesizeEdgeFromRequest(input.split('(4)')[0]!), undefined);
});

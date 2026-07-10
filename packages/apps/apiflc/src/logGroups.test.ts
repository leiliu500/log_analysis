import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitApiflcByLogGroup } from './logGroups.js';

test('splitApiflcByLogGroup routes labeled blocks to their groups', () => {
  const paste = [
    'Simulate Write to apiflc cloudwatch log group: /aws/lambda/adt-fca-d1-api_gateway_handler',
    '2026-07-02T04:34:43Z 45e5 INFO correlationID: 1234; FedLine Request: {}',
    '2026-07-02T04:34:48Z 45e5 INFO correlationID: 1234; Response from Data Services:',
    '',
    'Simulate Write to apiflc cloudwatch log group: /aws/lambda/adt-fca-d1-api_gateway_authorizer',
    '2026-07-02T04:34:42Z 2bef INFO auth response from: {}',
    '',
    'Simulate Write to apiflc cloudwatch log group: API-Gateway-Execution-Logs_9ioz6z9om1/d1',
    '(abc12345) Starting execution for request: abc12345',
    '(abc12345) Method completed with status: 200',
  ].join('\n');
  const segs = splitApiflcByLogGroup(paste);
  assert.equal(segs.length, 3);
  assert.equal(segs[0]!.group, '/aws/lambda/adt-fca-d1-api_gateway_handler');
  assert.match(segs[0]!.samples, /FedLine Request/);
  assert.equal(segs[1]!.group, '/aws/lambda/adt-fca-d1-api_gateway_authorizer');
  assert.equal(segs[2]!.group, 'API-Gateway-Execution-Logs_9ioz6z9om1/d1');
  assert.match(segs[2]!.samples, /Starting execution/);
});

test('splitApiflcByLogGroup does not treat in-content ARN/URI mentions as headers', () => {
  const paste = [
    'Simulate Write to apiflc cloudwatch log group: /aws/lambda/adt-fca-d1-api_gateway_handler',
    '(x) Endpoint request URI: https://lambda...:function:adt-fca-d1-api_gateway_authorizer/invocations',
    '(x) Method completed with status: 200',
  ].join('\n');
  const segs = splitApiflcByLogGroup(paste);
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.group, '/aws/lambda/adt-fca-d1-api_gateway_handler');
});

test('splitApiflcByLogGroup returns [] when no group headers are present', () => {
  assert.deepEqual(splitApiflcByLogGroup('just some logs\nwith no group header'), []);
});

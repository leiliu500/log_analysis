import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionTraceStep } from '@log/shared';
import { validateExecutionTrace } from './executionTrace.js';

const REQUIRED = [
  'poller.trigger', 'retention.anomalies', 'lifecycle.correlation-window',
  'lifecycle.extract-events', 'lifecycle.load-agents', 'lifecycle.advance',
  'persistence.agents', 'lifecycle.reconcile-anomalies', 'retention.agents', 'run.aggregate',
];

function step(component: string, sequence: number, over: Partial<ExecutionTraceStep> = {}): ExecutionTraceStep {
  return {
    id: `step-${sequence}`,
    sequence,
    component,
    name: component,
    status: 'completed',
    startedAt: sequence,
    completedAt: sequence + 1,
    durationMs: 1,
    ...(component === 'lifecycle.advance' ? { details: { spawned: 0, advanced: 0, closed: 0 } } : {}),
    ...over,
  };
}

const expected = {
  sources: [],
  bySource: {},
  agents: { spawned: 0, advanced: 0, closed: 0, anomalies: 0 },
  lifecycleSplit: { fastPathed: 0, reasoned: 0, deferredOverCap: 0 },
};

test('complete execution trace passes defensive validation', () => {
  const trace = REQUIRED.map((component, index) => step(component, index + 1));
  const result = validateExecutionTrace(trace, expected, 100);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.violations, []);
  assert.ok(result.checks >= REQUIRED.length);
});

test('validator rejects missing components and incomplete model-agent evidence', () => {
  const trace = REQUIRED
    .filter((component) => component !== 'persistence.agents')
    .map((component, index) => step(component, index + 1));
  trace.push(step('api-agent.reason', trace.length + 1, {
    status: 'completed',
    correlationId: 'tx-1',
    agent: {
      kind: 'api', name: 'apiflc API agent', execution: 'model', model: 'test-model',
    },
  }));
  const result = validateExecutionTrace(trace, { ...expected, lifecycleSplit: { ...expected.lifecycleSplit, reasoned: 1 } }, 100);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some((v) => v.code === 'missing_component'));
  assert.ok(result.violations.some((v) => v.code === 'missing_confidence'));
});

test('validator fails closed on component errors and unresolved API-agent work', () => {
  const trace = REQUIRED.map((component, index) => step(component, index + 1));
  trace.push(step('api-agent.reason', trace.length + 1, {
    status: 'deferred', correlationId: 'tx-2',
    agent: { kind: 'api', name: 'scp API agent', execution: 'deferred' },
  }));
  trace.push(step('alert.dispatch', trace.length + 1, {
    status: 'error', error: 'alert store unavailable',
  }));
  const result = validateExecutionTrace(trace, {
    ...expected,
    lifecycleSplit: { ...expected.lifecycleSplit, deferredOverCap: 1 },
  });
  assert.ok(result.violations.some((v) => v.code === 'agent_deferred'));
  assert.ok(result.violations.some((v) => v.code === 'component_error'));
});

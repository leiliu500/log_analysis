import type {
  ExecutionTraceStep,
  ExecutionTraceValidation,
  PollerRun,
} from '@log/shared';

export interface TraceExpectations {
  sources: string[];
  bySource: PollerRun['bySource'];
  agents: PollerRun['agents'];
  lifecycleSplit: { fastPathed: number; reasoned: number; deferredOverCap: number };
}

/**
 * Defense-in-depth validation for a completed ingestion trace. This does not trust the
 * recorder: it cross-checks the ordered steps against the independently computed run
 * summary and fails visibly when a component or agent decision was not accounted for.
 */
export function validateExecutionTrace(
  trace: ExecutionTraceStep[],
  expected: TraceExpectations,
  checkedAt = Date.now(),
): ExecutionTraceValidation {
  const violations: ExecutionTraceValidation['violations'] = [];
  let checks = 0;
  const check = (ok: boolean, code: string, message: string, stepId?: string): void => {
    checks += 1;
    if (!ok) violations.push({ code, message, ...(stepId ? { stepId } : {}) });
  };

  check(trace.length > 0, 'empty_trace', 'The execution contains no component trace.');
  check(new Set(trace.map((s) => s.id)).size === trace.length, 'duplicate_step_id', 'Trace step ids must be unique.');
  check(
    trace.every((s, index) => s.sequence === index + 1),
    'broken_sequence',
    'Trace sequence numbers must be contiguous and ordered.',
  );

  const components = new Set(trace.map((s) => s.component));
  for (const component of [
    'poller.trigger', 'retention.anomalies', 'lifecycle.correlation-window',
    'lifecycle.extract-events', 'lifecycle.load-agents', 'lifecycle.advance',
    'persistence.agents', 'lifecycle.reconcile-anomalies', 'retention.agents', 'run.aggregate',
  ]) {
    check(components.has(component), 'missing_component', `Required component ${component} is absent.`);
  }

  for (const source of expected.sources) {
    const sourceTrace = trace.filter((s) => s.source === source);
    check(sourceTrace.some((s) => s.component === 'connector.pull'), 'missing_source_pull', `${source} has no connector pull step.`);
    const summary = expected.bySource[source];
    if (summary && summary.parsed > 0) {
      for (const component of [
        'parser.batch', 'embedding.logs', 'persistence.logs', 'analysis.learn',
        'analysis.detect', 'analysis.correlate', 'anomaly-agent.fanout',
      ]) {
        check(
          sourceTrace.some((s) => s.component === component),
          'missing_source_component',
          `${source} parsed logs but did not record ${component}.`,
        );
      }
    }
    const completed = sourceTrace.find((s) => s.component === 'source.complete');
    check(!!completed, 'missing_source_completion', `${source} has no branch completion record.`);
    check(
      Number(completed?.details?.parsed ?? 0) === Number(summary?.parsed ?? 0) &&
        Number(completed?.details?.anomalies ?? 0) === Number(summary?.anomalies ?? 0),
      'source_summary_mismatch',
      `${source} trace totals do not match the persisted summary.`,
      completed?.id,
    );
  }

  const lifecycle = trace.find((s) => s.component === 'lifecycle.advance');
  check(
    Number(lifecycle?.details?.spawned ?? 0) === expected.agents.spawned &&
      Number(lifecycle?.details?.advanced ?? 0) === expected.agents.advanced &&
      Number(lifecycle?.details?.closed ?? 0) === expected.agents.closed,
    'agent_summary_mismatch',
    'Lifecycle trace totals do not match the persisted agent summary.',
    lifecycle?.id,
  );
  const fastPathed = trace.filter((s) => s.component === 'api-agent.fast-path' && s.status === 'completed').length;
  const reasoned = trace.filter((s) => s.component === 'api-agent.reason' && s.status === 'completed' && !!s.correlationId).length;
  const deferredOverCap = trace.filter(
    (s) => s.component === 'api-agent.reason' && !!s.correlationId && s.agent?.execution === 'deferred' && s.status === 'deferred',
  ).length;
  check(fastPathed === expected.lifecycleSplit.fastPathed, 'fast_path_mismatch', 'Fast-path API-agent count does not match lifecycle output.');
  check(reasoned === expected.lifecycleSplit.reasoned, 'reasoned_count_mismatch', 'Model-reasoned API-agent count does not match lifecycle output.');
  check(deferredOverCap === expected.lifecycleSplit.deferredOverCap, 'deferred_count_mismatch', 'Deferred API-agent count does not match lifecycle output.');

  for (const step of trace) {
    check(
      step.completedAt >= step.startedAt && step.durationMs === step.completedAt - step.startedAt,
      'invalid_timing',
      `${step.component} has inconsistent timing.`,
      step.id,
    );
    if (step.status === 'error') {
      check(!!step.error, 'unrecorded_error', `${step.component} failed without recording its error.`, step.id);
      check(false, 'component_error', `${step.component} recorded an execution error.`, step.id);
    }
    if (step.component === 'api-agent.reason' && step.status === 'deferred') {
      check(false, 'agent_deferred', `${step.agent?.name ?? 'API agent'} did not produce a decision in this execution.`, step.id);
    }
    if (step.agent?.execution === 'model') {
      check(!!step.agent.model, 'missing_model', `${step.agent.name} invoked a model without recording its id.`, step.id);
      if (step.status === 'completed') {
        check(
          step.agent.confidence != null && step.agent.confidence >= 0 && step.agent.confidence <= 1,
          'missing_confidence',
          `${step.agent.name} completed a model decision without a valid confidence score.`,
          step.id,
        );
      }
    }
  }

  return { status: violations.length ? 'failed' : 'passed', checkedAt, checks, violations };
}

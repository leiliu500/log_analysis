'use client';

import type { ExecutionTraceStep, PollerRun } from '@log/shared';

function clock(ts: number): string {
  return new Date(ts).toLocaleString();
}

function instant(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

const STATUS_STYLE: Record<ExecutionTraceStep['status'], string> = {
  completed: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  skipped: 'border-slate-500/30 bg-slate-500/15 text-slate-400',
  deferred: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  error: 'border-red-500/30 bg-red-500/15 text-red-300',
};

function stageName(component: string): string {
  if (component.startsWith('poller.') || component.startsWith('retention.')) return 'Run control';
  if (
    component.startsWith('connector.') ||
    component.startsWith('source.') ||
    component.startsWith('parser.') ||
    component.startsWith('embedding.')
  ) return 'Intake & enrich';
  if (component.startsWith('analysis.') || component.startsWith('anomaly-agent.')) return 'Detection';
  if (component.startsWith('api-agent.')) return 'API decision';
  if (component.startsWith('lifecycle.')) return 'Lifecycle';
  if (component.startsWith('persistence.') || component.startsWith('alert.')) return 'Persist & notify';
  if (component.startsWith('run.')) return 'Finalize';
  return 'Component';
}

function boxStyle(step: ExecutionTraceStep): string {
  if (step.agent?.kind === 'api') {
    return 'border-violet-400/70 bg-gradient-to-b from-violet-500/20 to-violet-950/20 shadow-[0_0_24px_rgba(139,92,246,0.12)]';
  }
  if (step.status === 'error') return 'border-red-500/60 bg-red-950/20';
  if (step.component.startsWith('lifecycle.')) return 'border-cyan-500/40 bg-cyan-950/15';
  if (step.component.startsWith('analysis.') || step.component.startsWith('anomaly-agent.')) {
    return 'border-sky-500/40 bg-sky-950/15';
  }
  if (step.component.startsWith('persistence.') || step.component.startsWith('alert.')) {
    return 'border-amber-500/35 bg-amber-950/10';
  }
  return 'border-edge bg-panel';
}

function FlowConnector({ failed = false }: { failed?: boolean }) {
  return (
    <div className='flex w-12 shrink-0 items-center' aria-hidden='true'>
      <span className={`h-px flex-1 ${failed ? 'bg-red-500/50' : 'bg-sky-500/40'}`} />
      <svg
        viewBox='0 0 10 10'
        className={`h-3 w-3 shrink-0 ${failed ? 'text-red-400' : 'text-sky-400'}`}
        fill='currentColor'
      >
        <path d='M0 0 10 5 0 10Z' />
      </svg>
    </div>
  );
}

function TraceStepBox({ step }: { step: ExecutionTraceStep }) {
  const apiAgent = step.agent?.kind === 'api';
  const agentStyle = apiAgent
    ? 'border-violet-400/30 bg-violet-500/10'
    : 'border-sky-400/20 bg-sky-500/5';

  return (
    <article className={`w-72 shrink-0 self-stretch rounded-xl border p-3 ${boxStyle(step)}`}>
      <div className='flex items-start justify-between gap-3'>
        <div className='flex items-center gap-2'>
          <span className='flex h-6 min-w-6 items-center justify-center rounded-md border border-slate-700 bg-black/20 px-1 font-mono text-[10px] text-slate-400'>
            {step.sequence}
          </span>
          <span className='text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500'>
            {stageName(step.component)}
          </span>
        </div>
        <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[step.status]}`}>
          {step.status}
        </span>
      </div>

      <div className='mt-3'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <h4 className='text-sm font-semibold leading-snug text-white'>{step.name}</h4>
          {apiAgent ? (
            <span className='rounded-md border border-violet-400/40 bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-100'>
              API agent
            </span>
          ) : null}
        </div>
        <p className='mt-1 break-all font-mono text-[10px] text-slate-500'>{step.component}</p>
      </div>

      <div className='mt-3 grid grid-cols-2 gap-2 text-[10px]'>
        <div className='rounded-md border border-edge bg-black/15 p-2'>
          <div className='uppercase tracking-wide text-slate-600'>Started</div>
          <div className='mt-0.5 font-mono text-slate-300'>{instant(step.startedAt)}Z</div>
        </div>
        <div className='rounded-md border border-edge bg-black/15 p-2'>
          <div className='uppercase tracking-wide text-slate-600'>Duration</div>
          <div className='mt-0.5 font-mono text-slate-300'>{duration(step.durationMs)}</div>
        </div>
      </div>

      {(step.source || step.application || step.correlationId) ? (
        <div className='mt-2 flex flex-wrap gap-1 text-[9px] font-mono text-slate-400'>
          {step.source ? <span className='rounded border border-edge bg-black/15 px-1.5 py-1'>source: {step.source}</span> : null}
          {step.application ? <span className='rounded border border-edge bg-black/15 px-1.5 py-1'>app: {step.application}</span> : null}
          {step.correlationId ? <span className='max-w-full break-all rounded border border-edge bg-black/15 px-1.5 py-1'>id: {step.correlationId}</span> : null}
        </div>
      ) : null}

      {step.agent ? (
        <div className={`mt-3 rounded-lg border p-2.5 text-[10px] ${agentStyle}`}>
          <div className='flex items-center justify-between gap-2'>
            <span className={apiAgent ? 'font-semibold text-violet-100' : 'font-semibold text-sky-200'}>
              {step.agent.name}
            </span>
            <span className='rounded bg-black/20 px-1.5 py-0.5 uppercase text-slate-400'>{step.agent.execution}</span>
          </div>
          <div className='mt-2'>
            <div className='uppercase tracking-wide text-slate-500'>Model</div>
            <div className='mt-0.5 break-all font-mono text-slate-200'>{step.agent.model ?? 'not invoked'}</div>
          </div>
          <div className='mt-2'>
            <div className='uppercase tracking-wide text-slate-500'>Confidence</div>
            <div className='mt-0.5 font-mono text-white'>
              {step.agent.confidence == null ? 'not returned' : `${(step.agent.confidence * 100).toFixed(1)}%`}
            </div>
          </div>
        </div>
      ) : null}

      {step.error ? (
        <div className='mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-200'>
          {step.error}
        </div>
      ) : null}

      {step.details && Object.keys(step.details).length ? (
        <details className='mt-3 rounded-lg border border-edge bg-black/10 p-2'>
          <summary className='cursor-pointer text-[10px] font-medium text-slate-400 hover:text-slate-200'>
            Open exact recorded data
          </summary>
          <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[9px] leading-relaxed text-slate-400'>
            {JSON.stringify(step.details, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function ValidationBox({ validation }: { validation: PollerRun['traceValidation'] }) {
  const passed = validation?.status === 'passed';
  return (
    <article
      className={`w-72 shrink-0 self-stretch rounded-xl border p-3 shadow-[0_0_24px_rgba(16,185,129,0.08)] ${
        passed ? 'border-emerald-400/60 bg-emerald-950/20' : 'border-red-400/60 bg-red-950/20'
      }`}
    >
      <div className='flex items-start justify-between gap-2'>
        <span className='text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500'>Defense gate</span>
        <span className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
          passed
            ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
            : 'border-red-500/30 bg-red-500/15 text-red-300'
        }`}>
          {validation?.status ?? 'missing'}
        </span>
      </div>
      <h4 className='mt-3 text-sm font-semibold text-white'>Trace integrity validation</h4>
      <p className='mt-1 text-[10px] leading-relaxed text-slate-400'>
        Independent completeness and consistency checks over the recorded workflow.
      </p>
      <div className='mt-3 grid grid-cols-2 gap-2 text-[10px]'>
        <div className='rounded-md border border-edge bg-black/15 p-2'>
          <div className='uppercase tracking-wide text-slate-600'>Checks</div>
          <div className='mt-0.5 font-mono text-white'>{validation?.checks ?? 0}</div>
        </div>
        <div className='rounded-md border border-edge bg-black/15 p-2'>
          <div className='uppercase tracking-wide text-slate-600'>Violations</div>
          <div className='mt-0.5 font-mono text-white'>{validation?.violations?.length ?? 0}</div>
        </div>
      </div>
      {validation?.violations?.length ? (
        <details className='mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2'>
          <summary className='cursor-pointer text-[10px] font-medium text-red-200'>Open validation failures</summary>
          <div className='mt-2 space-y-2'>
            {validation.violations.map((violation, index) => (
              <div key={`${violation.code}-${violation.stepId ?? index}`} className='rounded-md border border-red-500/20 bg-black/10 p-2 text-[9px] text-red-200'>
                <div className='font-mono text-red-400'>{violation.code}</div>
                <div className='mt-1'>{violation.message}</div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function TraceWorkflow({
  steps,
  validation,
}: {
  steps: ExecutionTraceStep[];
  validation: PollerRun['traceValidation'];
}) {
  return (
    <div className='overflow-hidden rounded-xl border border-edge bg-black/10'>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-2 text-[10px] text-slate-500'>
        <span className='font-semibold uppercase tracking-[0.14em] text-slate-400'>Execution workflow</span>
        <span>Follow the arrows · scroll horizontally · open any box for exact data</span>
      </div>
      <div className='overflow-x-auto bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.08)_1px,transparent_0)] [background-size:18px_18px]'>
        <ol className='flex min-w-max items-stretch p-5'>
          {steps.map((step) => (
            <li key={step.id} className='flex items-center'>
              <TraceStepBox step={step} />
              <FlowConnector failed={step.status === 'error'} />
            </li>
          ))}
          <li className='flex items-center'>
            <ValidationBox validation={validation} />
          </li>
        </ol>
      </div>
    </div>
  );
}

export function ExecutionTraceTab({ runs, appFilter = 'all' }: { runs: PollerRun[]; appFilter?: string }) {
  const failed = runs.filter((run) => run.traceValidation?.status === 'failed').length;
  const apiAgentCalls = runs.reduce(
    (sum, run) => sum + (run.trace ?? []).filter((step) => step.agent?.kind === 'api').length,
    0,
  );

  return (
    <section>
      <div className='mb-4 flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h2 className='text-lg font-semibold text-white'>Execution Trace</h2>
          <p className='mt-1 max-w-4xl text-xs text-slate-500'>
            Every retained ingestion execution is a connected workflow. Each recorded component is a box, and the final validation box independently checks that the flow is complete.
          </p>
        </div>
        <div className='flex gap-2 text-xs'>
          <span className='rounded-full bg-edge px-2 py-1 text-slate-300'>{runs.length} executions</span>
          <span className='rounded-full bg-violet-500/20 px-2 py-1 text-violet-200'>{apiAgentCalls} API-agent boxes</span>
          <span className={`rounded-full px-2 py-1 ${failed ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
            {failed} validation failures
          </span>
        </div>
      </div>

      {runs.length ? (
        <div className='space-y-3'>
          {runs.map((run, index) => {
            const allSteps = run.trace ?? [];
            const steps = appFilter === 'all'
              ? allSteps
              : allSteps.filter((step) => !step.application || step.application === appFilter);
            const validation = run.traceValidation;
            const passed = validation?.status === 'passed';

            return (
              <details key={run.id} open={index === 0} className='rounded-xl border border-edge bg-panel'>
                <summary className='cursor-pointer list-none p-4'>
                  <div className='flex flex-wrap items-center justify-between gap-3'>
                    <div>
                      <div className='flex flex-wrap items-center gap-2'>
                        <span className='font-medium text-white'>{clock(run.ranAt)}</span>
                        <span className='rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300'>{run.trigger}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                          passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
                        }`}>
                          trace validation: {passed ? 'passed' : 'failed'}
                        </span>
                      </div>
                      <div className='mt-1 font-mono text-[10px] text-slate-600'>{run.id}</div>
                    </div>
                    <div className='flex flex-wrap gap-3 text-xs text-slate-400'>
                      <span>{allSteps.length} component boxes</span>
                      {appFilter !== 'all' ? <span>{steps.length} in {appFilter} flow</span> : null}
                      <span>{run.windowMinutes}m window</span>
                      <span>{duration(run.durationMs)} total</span>
                      <span>{run.anomalies} anomalies</span>
                    </div>
                  </div>
                </summary>

                <div className='border-t border-edge p-4'>
                  {allSteps.length ? (
                    <TraceWorkflow steps={steps} validation={validation} />
                  ) : (
                    <div className='w-80 max-w-full rounded-xl border border-amber-500/30 bg-amber-500/10 p-3'>
                      <div className='text-xs font-medium text-amber-300'>Legacy execution</div>
                      <p className='mt-1 text-[10px] text-slate-400'>This run predates component workflow capture.</p>
                      <details className='mt-3 rounded-lg border border-amber-500/20 bg-black/10 p-2'>
                        <summary className='cursor-pointer text-[10px] text-amber-200'>Open retained run summary</summary>
                        <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[9px] text-slate-400'>
                          {JSON.stringify(
                            { bySource: run.bySource, agents: run.agents, stages: run.stages, byApplication: run.byApplication },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <p className='text-sm text-slate-500'>No ingestion executions have been recorded yet.</p>
      )}
    </section>
  );
}

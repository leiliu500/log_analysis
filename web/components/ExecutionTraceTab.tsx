'use client';

import type { ExecutionTraceStep, PollerRun } from '@log/shared';

function clock(ts: number): string {
  return new Date(ts).toLocaleString();
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

const STATUS_STYLE: Record<ExecutionTraceStep['status'], string> = {
  completed: 'bg-emerald-500/15 text-emerald-300',
  skipped: 'bg-slate-500/15 text-slate-400',
  deferred: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
};

function TraceStepRow({ step }: { step: ExecutionTraceStep }) {
  const apiAgent = step.agent?.kind === 'api';
  const cardStyle = apiAgent ? 'border-violet-500/60 bg-violet-500/10' : 'border-edge bg-black/10';
  return (
    <li className='relative pl-8'>
      <div className={`mb-2 rounded-lg border p-3 ${cardStyle}`}>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-mono text-[10px] text-slate-600'>#{step.sequence}</span>
            <span className='text-sm font-medium text-white'>{step.name}</span>
            {apiAgent ? <span className='rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-200'>API agent</span> : null}
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[step.status]}`}>{step.status}</span>
          </div>
          <span className='font-mono text-[11px] text-slate-500'>{duration(step.durationMs)}</span>
        </div>
        <div className='mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500'>
          <span>{step.component}</span>
          {step.source ? <span>source={step.source}</span> : null}
          {step.application ? <span>app={step.application}</span> : null}
          {step.correlationId ? <span>id={step.correlationId}</span> : null}
        </div>
        {step.agent ? (
          <div className='mt-2 grid gap-2 rounded-md border border-violet-500/20 bg-black/10 p-2 text-xs sm:grid-cols-3'>
            <div><span className='text-slate-500'>agent </span><span className='text-violet-200'>{step.agent.name}</span></div>
            <div><span className='text-slate-500'>model </span><span className='break-all font-mono text-slate-200'>{step.agent.model ?? 'not invoked'}</span></div>
            <div><span className='text-slate-500'>confidence </span><span className='font-mono text-white'>{step.agent.confidence == null ? 'not returned' : `${(step.agent.confidence * 100).toFixed(1)}%`}</span></div>
          </div>
        ) : null}
        {step.error ? <p className='mt-2 text-xs text-red-300'>{step.error}</p> : null}
        {step.details && Object.keys(step.details).length ? (
          <details className='mt-2'>
            <summary className='cursor-pointer text-[11px] text-slate-500 hover:text-slate-300'>Exact recorded details</summary>
            <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-2 text-[10px] text-slate-400'>
              {JSON.stringify(step.details, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
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
            Every retained ingestion execution and every recorded component path. Integrity validation cross-checks the trace against independent source and agent totals.
          </p>
        </div>
        <div className='flex gap-2 text-xs'>
          <span className='rounded-full bg-edge px-2 py-1 text-slate-300'>{runs.length} executions</span>
          <span className='rounded-full bg-violet-500/20 px-2 py-1 text-violet-200'>{apiAgentCalls} API-agent steps</span>
          <span className={`rounded-full px-2 py-1 ${failed ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{failed} validation failures</span>
        </div>
      </div>
      {runs.length ? <div className='space-y-3'>
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
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
                        trace validation: {passed ? 'passed' : 'failed'}
                      </span>
                    </div>
                    <div className='mt-1 font-mono text-[10px] text-slate-600'>{run.id}</div>
                  </div>
                  <div className='flex flex-wrap gap-3 text-xs text-slate-400'>
                    <span>{allSteps.length} steps</span>
                    {appFilter !== 'all' ? <span>{steps.length} in {appFilter} view</span> : null}
                    <span>{run.windowMinutes}m window</span>
                    <span>{duration(run.durationMs)} total</span>
                    <span>{run.anomalies} anomalies</span>
                  </div>
                </div>
              </summary>
              <div className='border-t border-edge p-4'>
                {validation?.violations?.length ? (
                  <div className='mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
                    <div className='text-xs font-semibold uppercase tracking-wide text-red-300'>Trace integrity violations</div>
                    <ul className='mt-2 space-y-1 text-xs text-red-200'>
                      {validation.violations.map((violation, violationIndex) => (
                        <li key={`${violation.code}-${violation.stepId ?? violationIndex}`}>
                          <span className='font-mono text-red-400'>{violation.code}</span>: {violation.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {allSteps.length ? (
                  <ol className='relative border-l border-edge'>
                    {steps.map((step) => <TraceStepRow key={step.id} step={step} />)}
                  </ol>
                ) : (
                  <details open className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-3'>
                    <summary className='text-xs font-medium text-amber-300'>Legacy execution: full component trace was not recorded</summary>
                    <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[10px] text-slate-400'>
                      {JSON.stringify({ bySource: run.bySource, agents: run.agents, stages: run.stages, byApplication: run.byApplication }, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </details>
          );
        })}
      </div> : <p className='text-sm text-slate-500'>No ingestion executions have been recorded yet.</p>}
    </section>
  );
}

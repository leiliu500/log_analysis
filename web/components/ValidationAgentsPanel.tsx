'use client';

import type { ValidationAgentInfo, ValidationAgentRun } from '@log/shared';

/**
 * The per-application VALIDATION AI AGENTS, shown as a LIFECYCLE rather than a permanent
 * roster: a card appears when a validation pass hands that app's agent residual work, and
 * disappears when the pass finishes. So this panel is empty whenever no validation is
 * running — which is most of the time, and is the point. An agent listed here is one
 * genuinely doing something right now.
 *
 * Distinct from the validation WORKERS below: a worker is a deterministic shadow of one
 * transaction; an agent is the app's LLM reviewer, which only ever sees the residual those
 * workers pass without proving.
 */

function secs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function Stat({ label, value, tone, title }: { label: string; value: number; tone: string; title: string }) {
  return (
    <div className="flex flex-col" title={title}>
      <span className={`text-lg font-semibold ${value > 0 ? tone : 'text-slate-600'}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

function RunningAgentCard({ run, info, now }: { run: ValidationAgentRun; info?: ValidationAgentInfo; now: number }) {
  const done = run.reviewed + run.failed;
  return (
    <div className="rounded-xl border border-violet-700/60 bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-violet-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          reviewing
        </span>
        <span className="text-[11px] text-slate-500">{secs(now - run.startedAt)}</span>
      </div>

      <div className="mb-1 truncate text-sm font-semibold text-white">
        {info?.displayName ?? run.application} validation agent
      </div>
      <div className="mb-2 truncate font-mono text-[10px] text-slate-500" title={info?.promptPath ?? ''}>
        {info?.promptPath ?? run.application}
      </div>

      <div className="mb-2 grid grid-cols-4 gap-2 border-y border-edge/60 py-2">
        <Stat label="queued" value={run.queued} tone="text-slate-200" title="Residual transactions handed to this agent for this pass." />
        <Stat label="suspected" value={run.suspected} tone="text-violet-300" title="Claims that survived re-verification against the real log rows." />
        <Stat
          label="discarded"
          value={run.discarded}
          tone="text-amber-300"
          title="Claims the admission gate threw out — fabricated log id, a quote that did not match, no positive witness, or a witness proving only that the line belongs to this transaction. Each would have been a false positive if trusted."
        />
        <Stat label="failed" value={run.failed} tone="text-orange-300" title="Reviews that could not complete (model error, throttling, truncated reply). Retried next pass — NOT counted as clean." />
      </div>

      <div className="text-[11px] text-slate-400">
        {done}/{run.queued} done
        <span className="text-slate-600">
          {' '}· {run.trigger === 'manual' ? 'triggered from the dashboard' : 'scheduled pass'}
        </span>
      </div>
    </div>
  );
}

export function ValidationAgentsPanel({
  agents,
  activeRuns,
  /** True while a "Validate now" request is in flight, before any run row exists yet. */
  starting = false,
  now,
}: {
  agents: ValidationAgentInfo[];
  activeRuns: ValidationAgentRun[];
  starting?: boolean;
  now: number;
}) {
  const enabled = agents.filter((a) => a.enabled);
  const byApp = new Map(agents.map((a) => [a.application, a]));

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Active Validation Agents</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${activeRuns.length ? 'bg-violet-500/20 text-violet-300' : 'bg-slate-500/20 text-slate-400'}`}
        >
          {activeRuns.length}
        </span>
        <span className="text-xs text-slate-500">
          spawned when a validation pass starts, closed when it finishes — only the residual is reviewed
        </span>
      </div>

      {activeRuns.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {activeRuns.map((r) => (
            <RunningAgentCard key={r.id} run={r} info={byApp.get(r.application)} now={now} />
          ))}
        </div>
      ) : starting ? (
        <p className="text-sm text-violet-300">Starting validation — agents will appear here while they review…</p>
      ) : (
        <p className="text-sm text-slate-500">
          No validation agent is running. One is spawned per application when a validation pass has residual
          transactions to review — deterministically clean, but with an outcome the logs never proved — and closed as
          soon as the pass finishes.
          {enabled.length > 0 ? (
            <span className="text-slate-600">
              {' '}
              Configured: {enabled.map((a) => a.displayName).join(', ')}.
            </span>
          ) : (
            <span className="text-amber-300/80">
              {' '}
              No application currently has an enabled validation agent
              {agents[0]?.disabledReason ? ` (${agents[0].disabledReason})` : ''}.
            </span>
          )}
        </p>
      )}
    </section>
  );
}

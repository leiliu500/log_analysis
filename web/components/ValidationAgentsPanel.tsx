'use client';

import type { ValidationAgent, ValidationAgentInfo } from '@log/shared';

/**
 * The per-application VALIDATION AI AGENTS — one card per onboarded app, distinct from
 * the per-transaction validation WORKERS above it. The two are different things and the
 * page shows both deliberately: a worker is a deterministic shadow of one transaction; an
 * agent is the app's LLM reviewer, which only ever sees the residual those workers pass
 * without proving.
 *
 * The card reports the agent's EFFECTIVE configuration as served by the API process, not
 * a static description, so an agent switched off in that runtime can never render as a
 * healthy one. The counters are derived from the same validation rows the page already
 * holds, so they need no extra request — and `discarded` is the one worth watching: it is
 * the model's observed hallucination rate, every one a false positive that would have
 * been recorded had the claim been trusted.
 */

/** Per-app tallies computed from the validation rows already on the page. */
function tally(rows: ValidationAgent[], application: string) {
  const mine = rows.filter((v) => v.application === application);
  return {
    reviewed: mine.filter((v) => v.aiReviewedAt != null).length,
    suspected: mine.filter((v) => v.result === 'ai_suspected').length,
    discarded: mine.reduce((n, v) => n + (v.aiRejected ?? 0), 0),
    failed: mine.filter((v) => v.aiError).length,
    /** Reviewed and raised nothing — the expected outcome for most transactions. */
    clean: mine.filter((v) => v.aiReviewedAt != null && (v.aiFindings?.length ?? 0) === 0).length,
  };
}

function Stat({ label, value, tone, title }: { label: string; value: number; tone: string; title: string }) {
  return (
    <div className="flex flex-col" title={title}>
      <span className={`text-lg font-semibold ${value > 0 ? tone : 'text-slate-600'}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

function AgentCard({ info, rows }: { info: ValidationAgentInfo; rows: ValidationAgent[] }) {
  const t = tally(rows, info.application);
  const on = info.enabled;
  return (
    <div className={`rounded-xl border bg-panel p-3 ${on ? 'border-violet-700/60' : 'border-edge'}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={`flex items-center gap-1.5 text-xs ${on ? 'text-violet-300' : 'text-slate-500'}`}>
          <span className={`h-2 w-2 rounded-full ${on ? 'animate-pulse bg-violet-400' : 'bg-slate-600'}`} />
          {on ? 'active' : 'disabled'}
        </span>
        <span className="font-mono text-[11px] text-slate-500">{info.application}</span>
      </div>

      <div className="mb-1 truncate text-sm font-semibold text-white">{info.displayName} validation agent</div>
      <div className="mb-2 truncate font-mono text-[10px] text-slate-500" title={info.promptPath ?? 'no spec declared'}>
        {info.promptPath ?? '— no spec declared —'}
      </div>

      {on ? (
        <>
          <div className="mb-2 grid grid-cols-4 gap-2 border-y border-edge/60 py-2">
            <Stat label="reviewed" value={t.reviewed} tone="text-slate-200" title="Residual transactions this agent reviewed." />
            <Stat label="suspected" value={t.suspected} tone="text-violet-300" title="Reviews that raised a claim which survived re-verification against the real log rows." />
            <Stat
              label="discarded"
              value={t.discarded}
              tone="text-amber-300"
              title="Claims the admission gate threw out — fabricated log id, a quote that did not match, no positive witness, or a witness that only proved the line belongs to this transaction. This is the model's observed hallucination rate; each one would have been a false positive if trusted."
            />
            <Stat label="failed" value={t.failed} tone="text-orange-300" title="Reviews that did not complete (model error, throttling, truncated reply). Retried on the next poll — NOT counted as clean." />
          </div>
          <div className="text-[11px] text-slate-400">
            {t.clean > 0 ? (
              <span>
                {t.clean} reviewed clean · scope <span className="text-slate-300">{info.scope}</span>
              </span>
            ) : (
              <span>
                scope <span className="text-slate-300">{info.scope}</span>
              </span>
            )}
            <span className="text-slate-600"> · ≤{info.maxPerPoll}/poll · {Math.round(info.deadlineMs / 1000)}s budget</span>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-amber-300/80">{info.disabledReason ?? 'not running in this runtime'}</div>
      )}
    </div>
  );
}

export function ValidationAgentsPanel({
  agents,
  rows,
}: {
  agents: ValidationAgentInfo[];
  /** Every validation row on the page (active + history) — the counters are derived from these. */
  rows: ValidationAgent[];
}) {
  const activeCount = agents.filter((a) => a.enabled).length;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Active Validation Agents</h2>
        <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-xs text-violet-300">{activeCount}</span>
        <span className="text-xs text-slate-500">
          one AI agent per application — reviews only the residual the deterministic workers pass without proving
        </span>
      </div>

      {agents.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((a) => (
            <AgentCard key={a.application} info={a} rows={rows} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          No application declares a validation agent, or the API could not report its configuration.
        </p>
      )}
    </section>
  );
}

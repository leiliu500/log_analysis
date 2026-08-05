'use client';

import type { ValidationAgent } from '@log/shared';

function clock(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const RESULT_STYLES: Record<string, string> = {
  success: 'bg-emerald-500/20 text-emerald-300',
  completed_with_issues: 'bg-amber-500/20 text-amber-300',
  failure: 'bg-red-500/20 text-red-300',
  pending: 'bg-sky-500/20 text-sky-300',
  // Deliberately NOT red: an AI-suspected transaction is not a proven failure. It is a
  // clean deterministic pass whose outcome the logs never proved, carrying a claim that
  // re-verified against those logs. Its own colour keeps the two populations distinct.
  ai_suspected: 'bg-violet-500/20 text-violet-300',
};

const isElevated = (s?: string): boolean => s === 'high' || s === 'critical';

/**
 * The DETERMINISTIC worker's verdict for a row, with the AI overlay stripped off.
 *
 * `result` is overloaded: when the AI agent admits a claim the row's result becomes
 * `ai_suspected`, which hides the fact that every deterministic check passed. Showing the
 * two in one column is exactly the conflation the rest of the design avoids — proven and
 * suspected are different populations and belong in different columns.
 *
 * The inverse is exact by construction, not a guess: `applyAiReview` promotes a row to
 * `ai_suspected` ONLY from a clean `success` with an empty delta (and the upsert's sticky
 * clause has the same guard), so `ai_suspected` always implies the worker said `success`.
 */
function workerResult(v: ValidationAgent): string {
  return v.result === 'ai_suspected' ? 'success' : v.result;
}

/**
 * Categorize a delta string into a compact, colour-coded chip so the richer
 * validation checks (status-vs-reality, evidence gaps, SCP ordering/duplicate,
 * system-of-record) are legible at a glance instead of one long red blob. The full
 * delta text stays available on hover. Order matters — most specific first.
 */
function deltaChip(d: string): { label: string; cls: string } {
  const t = d.toLowerCase();
  if (t.includes('status mismatch')) return { label: 'status mismatch', cls: 'bg-rose-500/25 text-rose-200 border-rose-500/50' };
  if (t.includes('unverified completion')) return { label: 'unverified', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (t.includes('incomplete evidence')) return { label: 'evidence gap', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  if (t.includes('ordering violation')) return { label: 'ordering', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' };
  if (t.includes('duplicate')) return { label: 'duplicate', cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' };
  if (t.includes('system-of-record')) return { label: 'record mismatch', cls: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40' };
  if (t.includes('sla breach')) return { label: 'SLA breach', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (t.includes('missing phase')) return { label: 'missing phase', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (t.includes('missing anomaly') || t.includes('unexpected anomaly') || t.includes('wrong level')) return { label: 'anomaly', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (t.includes('overdue') || t.includes('stuck')) return { label: 'stuck', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  return { label: 'delta', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
}

/** Compact result labels for the badge (the raw union value is verbose). */
const RESULT_LABELS: Record<string, string> = {
  success: 'success',
  completed_with_issues: 'completed · issues',
  failure: 'failure',
  pending: 'pending',
  ai_suspected: 'AI-suspected',
};

/** A protocol phase progress pip (mirrors AgentsPanel so the two views read alike). */
function Pip({ label, state }: { label: string; state: 'done' | 'idle' }) {
  const styles = {
    done: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
    idle: 'border-edge bg-panel text-slate-600',
  }[state];
  const mark = state === 'done' ? '✓' : '·';
  return (
    <div className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1 ${styles}`}>
      <span className="text-sm font-semibold">{mark}</span>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </div>
  );
}

/** One active (pending) validation agent — shadows an in-flight regular agent. */
function ValidationCard({ v }: { v: ValidationAgent }) {
  const overdue = v.slaBreached;
  return (
    <div className={`rounded-xl border bg-panel p-3 ${overdue ? 'border-amber-600/70' : 'border-sky-700/60'}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={`flex items-center gap-1.5 text-xs ${overdue ? 'text-amber-300' : 'text-sky-300'}`}>
          <span className={`h-2 w-2 animate-pulse rounded-full ${overdue ? 'bg-amber-400' : 'bg-sky-400'}`} />
          {overdue ? 'response overdue' : 'validation pending'}
        </span>
        <span className="text-[11px] text-slate-500">{ago(v.spawnedAt)}</span>
      </div>
      <div className="mb-2 truncate font-mono text-sm text-white" title={v.messageId}>
        {v.messageId}
      </div>
      {v.phases.length > 0 && (
        <div
          className="mb-2 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, v.phases.length)}, minmax(0, 1fr))` }}
        >
          {v.phases.map((p) => (
            <Pip key={p} label={p.toLowerCase()} state={v.phaseTs?.[p] !== undefined ? 'done' : 'idle'} />
          ))}
        </div>
      )}
      <div className={`text-[11px] ${overdue ? 'text-amber-300' : 'text-slate-400'}`}>
        {v.detail ?? 'awaiting close to validate'}
        {v.slaBudgetMinutes != null ? (
          <span className="text-slate-600"> · SLA {v.slaBudgetMinutes}m from {v.slaFromPhase}</span>
        ) : null}
      </div>
    </div>
  );
}

export function ValidationPanel({
  active,
  history,
  correlationLabel = 'messageId',
}: {
  active: ValidationAgent[];
  history: ValidationAgent[];
  /** What this application calls its correlation id (scp: messageId, apiflc: correlationID). */
  correlationLabel?: string;
}) {
  const failures = history.filter((v) => v.result === 'failure').length;
  const issues = history.filter((v) => v.result === 'completed_with_issues').length;
  // Completed cleanly BUT carried an associated anomaly below the app's issue
  // threshold — recorded, not flagged. Surfaced so the suppression is observable.
  // Counted off the WORKER's verdict, not the overloaded `result`: an AI suspicion must
  // not make a suppressed anomaly stop being counted as suppressed.
  const suppressed = history.filter((v) => workerResult(v) === 'success' && v.qualityAnomalies.length > 0).length;
  const aiSuspected = history.filter((v) => v.result === 'ai_suspected').length;
  const aiDiscarded = history.reduce((n, v) => n + (v.aiRejected ?? 0), 0);
  const aiFailed = history.filter((v) => v.aiError).length;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Active Validation Workers</h2>
        <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-300">{active.length}</span>
        <span className="text-xs text-slate-500">
          one validation worker per in-flight transaction — pending until the agent closes
        </span>
      </div>

      {active.length > 0 ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {active.map((v) => (
            <ValidationCard key={v.messageId} v={v} />
          ))}
        </div>
      ) : (
        <p className="mb-6 text-sm text-slate-500">
          No active validation workers. They shadow active ingestion agents — simulate an incomplete
          transaction so an agent stays active and a pending validation worker appears here.
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Validation History</h2>
        <span className="text-xs text-slate-500">{history.length} validated</span>
        {failures > 0 ? (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300">
            {failures} failure{failures === 1 ? '' : 's'}
          </span>
        ) : null}
        {issues > 0 ? (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
            {issues} with issues
          </span>
        ) : null}
        {failures === 0 && issues === 0 && history.length > 0 ? (
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">all consistent</span>
        ) : null}
        {suppressed > 0 ? (
          <span
            className="rounded-full bg-slate-500/20 px-2 py-0.5 text-xs text-slate-300"
            title="Completed cleanly but carried an associated anomaly below the app's issue threshold — recorded, not flagged as an issue."
          >
            {suppressed} suppressed
          </span>
        ) : null}
        {aiSuspected > 0 ? (
          <span
            className="rounded-full bg-violet-500/20 px-2 py-0.5 text-xs text-violet-300"
            title="Deterministically clean, but the outcome was never proven from the logs and the app's validation AI agent raised a claim that re-verified against those logs. A suspicion to triage, not a proven failure."
          >
            {aiSuspected} AI-suspected
          </span>
        ) : null}
        {aiFailed > 0 ? (
          <span
            className="rounded-full bg-orange-500/20 px-2 py-0.5 text-xs text-orange-300"
            title="AI reviews that did not complete (model error, throttling, or a truncated reply). These transactions were NOT reviewed — they are retried on the next poll, and must not be read as clean."
          >
            {aiFailed} review{aiFailed === 1 ? '' : 's'} failed
          </span>
        ) : null}
        {aiDiscarded > 0 ? (
          <span
            className="rounded-full bg-slate-500/20 px-2 py-0.5 text-xs text-slate-400"
            title="AI claims the admission gate discarded because a cited log id, quoted value, or predicate did not re-verify. This is the model's observed hallucination rate — every one would have been a false positive had it been trusted."
          >
            {aiDiscarded} AI claim{aiDiscarded === 1 ? '' : 's'} discarded
          </span>
        ) : null}
      </div>
      {history.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-edge">
                <th className="px-3 py-2">{correlationLabel}</th>
                <th className="px-3 py-2">agent status</th>
                <th className="px-3 py-2" title="The DETERMINISTIC validation worker's verdict: the anomaly/level invariant, phase completeness, the SLA, status-vs-reality, evidence completeness and the app's own checks. This is the proven result and an AI claim never changes it.">
                  worker result
                </th>
                <th className="px-3 py-2">phases</th>
                <th className="px-3 py-2">SLA</th>
                <th className="px-3 py-2">expected</th>
                <th className="px-3 py-2">actual</th>
                <th className="px-3 py-2">anomalies</th>
                <th className="px-3 py-2" title="The AI agent's outcome, kept in its own column so a suspicion is never mistaken for a proven verdict. It only ever reviews the residual — transactions the worker passed without proving the outcome — and its claims are re-executed against the real log rows before being recorded.">
                  agent result
                </th>
                <th className="px-3 py-2">delta</th>
                <th className="px-3 py-2">validated</th>
              </tr>
            </thead>
            <tbody className="font-mono text-slate-300">
              {history.slice(0, 60).map((v) => (
                <tr key={v.messageId} className="border-b border-edge/50">
                  <td className="px-3 py-1.5">{v.messageId}</td>
                  <td className="px-3 py-1.5 text-slate-400">{v.agentStatus}</td>
                  <td className="px-3 py-1.5">
                    {(() => {
                      const wr = workerResult(v);
                      return (
                        <span className={`whitespace-nowrap rounded px-1.5 py-0.5 ${RESULT_STYLES[wr] ?? 'bg-slate-500/20 text-slate-300'}`}>
                          {RESULT_LABELS[wr] ?? wr}
                        </span>
                      );
                    })()}
                  </td>
                  <td className={`px-3 py-1.5 ${v.missingPhases.length ? 'text-red-400' : 'text-slate-400'}`}>
                    {v.missingPhases.length ? `missing ${v.missingPhases.join(', ')}` : 'complete'}
                  </td>
                  <td className={`px-3 py-1.5 ${v.slaBreached ? 'text-red-400' : 'text-slate-400'}`}>
                    {v.responseLatencyMs != null
                      ? `${Math.round(v.responseLatencyMs / 60_000)}m${v.slaBudgetMinutes != null ? `/${v.slaBudgetMinutes}m` : ''}`
                      : v.slaBudgetMinutes != null
                        ? `≤${v.slaBudgetMinutes}m`
                        : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">
                    {v.expectedAnomaly ? `anomaly · ${v.expectedSeverity}` : 'no anomaly'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-400">
                    {v.actualAnomaly ? `anomaly · ${v.actualSeverity ?? '—'}` : 'no anomaly'}
                  </td>
                  <td className={`px-3 py-1.5 font-sans ${isElevated(v.maxQualitySeverity) ? 'text-amber-300' : 'text-slate-400'}`}>
                    {v.qualityAnomalies.length ? (
                      <span title={v.qualityAnomalies.map((q) => `${q.severity}: ${q.title}`).join('\n')}>
                        {v.maxQualitySeverity}: {v.qualityAnomalies[0]?.title}
                        {v.qualityAnomalies.length > 1 ? ` (+${v.qualityAnomalies.length - 1})` : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-sans">
                    {v.aiError ? (
                      <span
                        className="cursor-help whitespace-nowrap rounded border border-orange-500/40 bg-orange-500/20 px-1.5 py-0.5 text-[10px] text-orange-300"
                        title={`The AI review did NOT complete — this is not a clean result: ${v.aiError}. The next validation poll retries it.`}
                      >
                        review failed
                      </span>
                    ) : v.aiReviewedAt == null ? (
                      <span className="text-slate-600" title="Not reviewed — this transaction carries a deterministic verdict (a delta or issues), so the AI agent is never shown it.">
                        —
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {v.aiFindings.length ? (
                          <span
                            className="cursor-help whitespace-nowrap rounded border border-violet-500/40 bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200"
                            title={`SUSPECTED — ${v.aiFindings.length} claim(s) survived re-verification. This is a suspicion to triage, not a proven failure: the deterministic worker still says ${workerResult(v)}.\n\n${v.aiFindings
                              .map((f) => `${f.severity}: ${f.title} (${f.verifiedPredicates} predicate(s) re-verified on ${f.evidenceLogIds.join(', ')})`)
                              .join('\n')}`}
                          >
                            suspected · {v.aiFindings.length}
                          </span>
                        ) : (
                          <span
                            className="whitespace-nowrap rounded border border-emerald-600/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400/80"
                            title="The AI agent reviewed this transaction and raised nothing that survived re-verification. This is a completed review with a clean outcome — the expected answer for most transactions — not a skipped or failed one."
                          >
                            reviewed · clean
                          </span>
                        )}
                        {v.aiRejected ? (
                          <span
                            className="cursor-help whitespace-nowrap rounded border border-slate-600 bg-slate-500/20 px-1.5 py-0.5 text-[10px] text-slate-400"
                            title="Claims the admission gate discarded — a fabricated log id, a quote that did not match, or an assertion with no re-executable predicate. Each one would have been a false positive had it been trusted."
                          >
                            {v.aiRejected} discarded
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-sans">
                    {v.delta.length ? (
                      <div className="flex flex-wrap gap-1">
                        {v.delta.map((d, i) => {
                          const c = deltaChip(d);
                          return (
                            <span key={i} title={d} className={`cursor-help whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] ${c.cls}`}>
                              {c.label}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{v.closedAt ? clock(v.closedAt) : ago(v.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > 60 && (
            <div className="px-3 py-2 text-xs text-slate-500">…and {history.length - 60} more</div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No validated agents yet.</p>
      )}
    </section>
  );
}

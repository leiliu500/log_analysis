'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlatformTelemetry, TelemetryBuckets } from '@log/shared';
import { api } from '@/lib/api';

const REFRESH_MS = 30_000;

/**
 * Platform telemetry. Every figure comes from `GET /api/telemetry`, which aggregates in
 * SQL over the live tables — there is no mock, sampled, or placeholder path anywhere in
 * this view. Where a value cannot be computed (an average with no samples, a rate with no
 * observations) the API returns `undefined` and this renders "—", because an unmeasured
 * quantity is not zero and a dashboard that rounds it to zero is lying.
 *
 * CATEGORICAL PALETTE — fixed order, never cycled, validated not eyeballed:
 *   node validate_palette.js "#0284c7,#d97706,#7c3aed,#059669" --mode dark --surface #12161f
 *   → lightness band, chroma floor, CVD separation, normal-vision floor, contrast: ALL PASS
 * A 5th category folds into "other" rather than inventing a hue.
 *
 * Status colours (emerald/amber/red/violet) are RESERVED for state — validation results
 * and severities — never reused as a series colour, and always accompanied by a text
 * label so identity is never carried by colour alone.
 */
const CATEGORICAL = ['#0284c7', '#d97706', '#7c3aed', '#059669'] as const;

/** Status → the app's existing reserved tokens. Order is severity order, not hue order. */
const STATUS_TONE: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  failure: 'bg-red-500',
  medium: 'bg-amber-500',
  completed_with_issues: 'bg-amber-500',
  ai_suspected: 'bg-violet-500',
  low: 'bg-sky-600',
  pending: 'bg-sky-600',
  info: 'bg-slate-500',
  success: 'bg-emerald-600',
};

const fmt = (n: number): string => n.toLocaleString();
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** ms → a compact human duration. Returns '—' for an unmeasured value. */
function dur(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function ago(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
}

/**
 * A headline number. Deliberately NOT a chart: one magnitude with no comparison is a
 * number, and drawing it as a bar adds ink without adding information.
 */
function Stat({
  label,
  value,
  sub,
  tone = 'text-white',
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-3" title={title}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

/**
 * Magnitude across identity, as horizontal bars — the right form when categories have
 * names of varying length and the comparison is "which is biggest". Values are direct-
 * labelled in a text token (never in the series colour), the bar is thin, and the track
 * makes the zero baseline explicit so an empty category is visibly empty rather than absent.
 */
function BarRows({
  buckets,
  colorOf,
  emptyNote,
  max: forcedMax,
}: {
  buckets: TelemetryBuckets;
  colorOf?: (key: string, i: number) => string;
  emptyNote: string;
  max?: number;
}) {
  const entries = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <p className="text-xs text-slate-500">{emptyNote}</p>;
  const max = forcedMax ?? Math.max(...entries.map(([, v]) => v), 1);

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={k} className="flex items-center gap-2 text-xs" title={`${k}: ${fmt(v)}`}>
          <span className="w-28 shrink-0 truncate text-slate-400">{k}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-edge/60">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`,
                backgroundColor: colorOf ? colorOf(k, i) : CATEGORICAL[i % CATEGORICAL.length],
              }}
            />
          </div>
          <span className="w-14 shrink-0 text-right tabular-nums text-slate-300">{fmt(v)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Part-to-whole for one application's terminal outcomes. Segments carry a 2px surface gap
 * so adjacent fills never touch, and the legend below names every series — with three
 * series, colour alone must never be the identity carrier.
 */
function OutcomeBar({ completed, failed, error, other }: { completed: number; failed: number; error: number; other: number }) {
  const total = completed + failed + error + other;
  if (total === 0) return <div className="h-2 rounded-full bg-edge/60" />;
  const seg = [
    { n: completed, tone: 'bg-emerald-600', label: 'completed' },
    { n: failed, tone: 'bg-red-500', label: 'failed' },
    { n: error, tone: 'bg-amber-500', label: 'timed out' },
    { n: other, tone: 'bg-slate-600', label: 'other' },
  ].filter((s) => s.n > 0);
  return (
    <div className="flex h-2 gap-[2px] overflow-hidden rounded-full">
      {seg.map((s) => (
        <div
          key={s.label}
          className={`h-full ${s.tone} first:rounded-l-full last:rounded-r-full`}
          style={{ width: `${(s.n / total) * 100}%` }}
          title={`${s.label}: ${fmt(s.n)} of ${fmt(total)}`}
        />
      ))}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {note ? <span className="text-[11px] text-slate-500">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

const WINDOWS: Array<{ label: string; minutes: number }> = [
  { label: '1h', minutes: 60 },
  { label: '24h', minutes: 1440 },
  { label: '7d', minutes: 10080 },
  { label: '30d', minutes: 43200 },
];

export function TelemetryView() {
  const [t, setT] = useState<PlatformTelemetry | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setT(await api.telemetry(windowMinutes));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [windowMinutes]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const apps = useMemo(() => Object.entries(t?.transactions.byApplication ?? {}).sort(), [t]);
  const appColor = useMemo(() => {
    const order = apps.map(([a]) => a);
    return (app: string) => CATEGORICAL[Math.max(0, order.indexOf(app)) % CATEGORICAL.length]!;
  }, [apps]);

  const ai = t?.validationAi;
  /** Rows the deterministic engine passed but never proved — the AI stage's whole remit. */
  const totalRows = t ? Object.values(t.validation.byResult).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="p-8">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Telemetry</h1>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.minutes}
              onClick={() => setWindowMinutes(w.minutes)}
              className={`rounded-md px-2 py-1 text-xs ${
                windowMinutes === w.minutes ? 'bg-sky-600 text-white' : 'bg-panel text-slate-400 hover:text-slate-200'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-5 text-sm text-slate-400">
        Live platform metrics, every figure aggregated in SQL over the real tables — logs, anomalies, agents,
        validation, and poller runs. Nothing here is sampled or synthetic. A value that cannot be computed shows{' '}
        <span className="text-slate-300">—</span> rather than 0, because an unmeasured quantity is not zero. The
        window selector applies to the &quot;in window&quot; figures; totals are all-time. Refreshes every{' '}
        {REFRESH_MS / 1000}s.
      </p>

      {error && (
        <p className="mb-4 text-red-400">
          Could not reach API ({error}).
        </p>
      )}

      {loading && !t ? (
        <p className="text-sm text-slate-500">Loading telemetry…</p>
      ) : !t ? null : (
        <>
          {t.logs.total === 0 && t.transactions.total === 0 && (
            <div className="mb-6 rounded-xl border border-amber-700/50 bg-amber-500/10 p-3 text-sm text-amber-200">
              The database holds no logs or transactions yet, so every metric below is genuinely zero — not a
              rendering problem. Figures populate as the ingestion poller lands data.
            </div>
          )}

          {/* ---- Headline numbers. One magnitude each: a number, not a chart. ---- */}
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Logs stored"
              value={fmt(t.logs.total)}
              sub={t.logs.lastIngestAt ? `last ingest ${ago(t.logs.lastIngestAt)}` : 'never ingested'}
              title="Rows in parsed_logs."
            />
            <Stat
              label="Transactions"
              value={fmt(t.transactions.total)}
              sub={`${fmt(t.transactions.active)} active · ${fmt(t.transactions.closed)} closed`}
              title="Ingestion agents — one per transaction."
            />
            <Stat
              label="Anomalies"
              value={fmt(t.anomalies.total)}
              sub={`${fmt(t.anomalies.inWindow)} in window`}
              tone={t.anomalies.total > 0 ? 'text-amber-300' : 'text-white'}
            />
            <Stat
              label="Poller runs"
              value={fmt(t.poller.runs)}
              sub={t.poller.lastRunAt ? `last ${ago(t.poller.lastRunAt)}` : 'never run'}
              title="Scheduled ingestion passes (EventBridge) plus on-demand runs."
            />
          </div>

          {/* ---- Ingestion ---- */}
          <Section title="Ingestion" note="volume by origin, and how the poller is performing">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-edge bg-panel p-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Logs by source</div>
                <BarRows buckets={t.logs.bySource} emptyNote="No logs stored yet." />
                <div className="mt-3 mb-2 text-[11px] uppercase tracking-wide text-slate-500">Logs by level</div>
                <BarRows buckets={t.logs.byLevel} emptyNote="No logs stored yet." />
              </div>
              <div className="rounded-xl border border-edge bg-panel p-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Poller performance</div>
                <dl className="space-y-1.5 text-xs">
                  {[
                    ['Runs in window', fmt(t.poller.inWindow)],
                    ['Mean duration', dur(t.poller.avgDurationMs)],
                    ['p95 duration', dur(t.poller.p95DurationMs)],
                    ['Anomalies produced', fmt(t.poller.anomaliesProduced)],
                    [
                      'Retention span',
                      t.logs.oldestTs && t.logs.newestTs ? dur(t.logs.newestTs - t.logs.oldestTs) : '—',
                    ],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <dt className="text-slate-400">{k}</dt>
                      <dd className="tabular-nums text-slate-200">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 mb-2 text-[11px] uppercase tracking-wide text-slate-500">Runs by trigger</div>
                <BarRows buckets={t.poller.byTrigger} emptyNote="No poller runs recorded." />
              </div>
            </div>
          </Section>

          {/* ---- Transactions ---- */}
          <Section title="Transaction outcomes" note="terminal status mix and lifetime, per application">
            {apps.length === 0 ? (
              <p className="text-xs text-slate-500">No transactions recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500">
                    <tr className="border-b border-edge">
                      <th className="px-3 py-2">application</th>
                      <th className="px-3 py-2 w-64">outcome mix</th>
                      <th className="px-3 py-2 text-right">completed</th>
                      <th className="px-3 py-2 text-right">failed</th>
                      <th className="px-3 py-2 text-right">timed out</th>
                      <th className="px-3 py-2 text-right">p50</th>
                      <th className="px-3 py-2 text-right">p95</th>
                      <th className="px-3 py-2 text-right">max</th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-300">
                    {apps.map(([app, a]) => (
                      <tr key={app} className="border-b border-edge/50">
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: appColor(app) }} />
                            {app}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <OutcomeBar completed={a.completed} failed={a.failed} error={a.error} other={a.other} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{fmt(a.completed)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-300">{fmt(a.failed)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-300">{fmt(a.error)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{dur(a.p50Ms)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{dur(a.p95Ms)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{dur(a.maxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Legend: three series, so identity is never colour-alone. */}
                <div className="flex flex-wrap gap-3 border-t border-edge px-3 py-2 text-[11px] text-slate-500">
                  {[
                    ['bg-emerald-600', 'completed'],
                    ['bg-red-500', 'failed'],
                    ['bg-amber-500', 'timed out'],
                    ['bg-slate-600', 'other'],
                  ].map(([tone, label]) => (
                    <span key={label} className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-sm ${tone}`} />
                      {label}
                    </span>
                  ))}
                  <span className="ml-auto">p50 / p95 / max are lifetimes over closed transactions only.</span>
                </div>
              </div>
            )}
          </Section>


          {/* ---- Model calls: what the decisions above COST ---- */}
          <Section
            title="Model calls"
            note="latency and token cost per pipeline stage — provider-reported, not estimated"
          >
            {!t.models || t.models.total === 0 ? (
              <p className="text-xs text-slate-500">
                No model calls recorded in this window. Every Bedrock call is instrumented at the wrapper, so this
                stays empty only while the agents are genuinely idle.
              </p>
            ) : (
              <>
                <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Calls"
                    value={fmt(t.models.total)}
                    sub={`${fmt(t.models.failed)} failed${t.models.errorRate != null ? ` · ${pct(t.models.errorRate)}` : ''}`}
                    tone={t.models.failed > 0 ? 'text-orange-300' : 'text-white'}
                  />
                  <Stat
                    label="Latency p50 / p95"
                    value={`${dur(t.models.p50LatencyMs)} / ${dur(t.models.p95LatencyMs)}`}
                    sub={`max ${dur(t.models.maxLatencyMs)}`}
                    title="Bedrock's own metrics.latencyMs. avgWall below is our clock around the same call — the gap is transport plus our overhead."
                  />
                  <Stat
                    label="Tokens in / out"
                    value={`${fmt(t.models.inputTokens)} / ${fmt(t.models.outputTokens)}`}
                    sub={`mean wall ${dur(t.models.avgWallMs)}`}
                    title="Reported by Bedrock usage.*, so this is actual consumption rather than an estimate."
                  />
                  <Stat
                    label="Models in use"
                    value={String(Object.keys(t.models.byModel).length)}
                    sub={Object.keys(t.models.byModel).join(', ') || '—'}
                  />
                </div>

                <div className="mb-3 overflow-x-auto rounded-xl border border-edge bg-panel">
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-500">
                      <tr className="border-b border-edge">
                        <th className="px-3 py-2">pipeline stage</th>
                        <th className="px-3 py-2 text-right">calls</th>
                        <th className="px-3 py-2 text-right">failed</th>
                        <th className="px-3 py-2 text-right">p50</th>
                        <th className="px-3 py-2 text-right">p95</th>
                        <th className="px-3 py-2 text-right">tokens in</th>
                        <th className="px-3 py-2 text-right">tokens out</th>
                        <th className="px-3 py-2 text-right">mean reply</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {t.models.byStage.map((st, i) => (
                        <tr key={st.stage} className="border-b border-edge/50">
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="h-2 w-2 rounded-sm"
                                style={{ backgroundColor: CATEGORICAL[i % CATEGORICAL.length] }}
                              />
                              {st.stage}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(st.calls)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${st.failed > 0 ? 'text-orange-300' : 'text-slate-500'}`}>
                            {fmt(st.failed)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{dur(st.p50LatencyMs)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{dur(st.p95LatencyMs)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmt(st.inputTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmt(st.outputTokens)}</td>
                          <td
                            className="px-3 py-2 text-right tabular-nums text-slate-400"
                            title="Mean reply length. Replies clustering at the ceiling are the truncation signature that produced unparseable validation JSON."
                          >
                            {st.avgReplyChars != null ? `${Math.round(st.avgReplyChars)}c` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-edge bg-panel p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                      Stop reason
                      <span className="ml-1 normal-case text-slate-600">
                        — max_tokens means replies are being cut off
                      </span>
                    </div>
                    <BarRows
                      buckets={t.models.byStopReason}
                      colorOf={(k) => (k === 'max_tokens' ? '#d97706' : k === 'end_turn' ? '#059669' : '#475569')}
                      emptyNote="No completed calls in this window."
                    />
                  </div>
                  <div className="rounded-xl border border-edge bg-panel p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Recent failures</div>
                    {t.models.recentErrors.length === 0 ? (
                      <p className="text-xs text-slate-500">No model call has failed in this window.</p>
                    ) : (
                      <ul className="space-y-1 text-[11px]">
                        {t.models.recentErrors.map((e, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="shrink-0 text-slate-500">{ago(e.ts)}</span>
                            <span className="shrink-0 text-slate-400">{e.stage}</span>
                            <span className="truncate text-orange-300/90" title={e.error}>
                              {e.error}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            )}
          </Section>

          {/* ---- Validation ---- */}
          <Section title="Validation" note="deterministic worker verdicts across every shadowed transaction">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-edge bg-panel p-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                  Results ({fmt(totalRows)} validated)
                </div>
                <BarRows
                  buckets={t.validation.byResult}
                  colorOf={(k) => ({
                    success: '#059669',
                    failure: '#dc2626',
                    completed_with_issues: '#d97706',
                    ai_suspected: '#7c3aed',
                    pending: '#0284c7',
                  })[k] ?? '#475569'}
                  emptyNote="No validation results yet."
                />
              </div>
              <div className="rounded-xl border border-edge bg-panel p-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Signals</div>
                <dl className="space-y-1.5 text-xs">
                  {[
                    ['SLA breached', fmt(t.validation.slaBreached), t.validation.slaBreached > 0 ? 'text-amber-300' : 'text-slate-200'],
                    ['Carrying a delta', fmt(t.validation.withDelta), t.validation.withDelta > 0 ? 'text-red-300' : 'text-slate-200'],
                    ['Mean response latency', dur(t.validation.avgResponseLatencyMs), 'text-slate-200'],
                    ['Anomalies by severity', '', 'text-slate-200'],
                  ].map(([k, v, tone]) =>
                    v ? (
                      <div key={k} className="flex justify-between">
                        <dt className="text-slate-400">{k}</dt>
                        <dd className={`tabular-nums ${tone}`}>{v}</dd>
                      </div>
                    ) : null,
                  )}
                </dl>
                <div className="mt-3">
                  <BarRows
                    buckets={t.anomalies.bySeverity}
                    colorOf={(k) => ({ critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0284c7', info: '#475569' })[k] ?? '#475569'}
                    emptyNote="No anomalies recorded."
                  />
                </div>
              </div>
            </div>
          </Section>

          {/* ---- Validation AI ---- */}
          <Section
            title="Validation AI agent"
            note="a separate population from the verdicts above — suspicions, not proof"
          >
            <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Reviewed" value={fmt(ai?.reviewed ?? 0)} sub={`${fmt(ai?.runs ?? 0)} runs · ${fmt(ai?.running ?? 0)} running`} />
              <Stat
                label="Suspected"
                value={fmt(ai?.suspected ?? 0)}
                sub={`${fmt(ai?.admittedClaims ?? 0)} claims admitted`}
                tone={(ai?.suspected ?? 0) > 0 ? 'text-violet-300' : 'text-white'}
              />
              <Stat
                label="Claims discarded"
                value={fmt(ai?.discardedClaims ?? 0)}
                sub={ai?.discardRate != null ? `${pct(ai.discardRate)} of all claims` : 'no claims made yet'}
                tone={(ai?.discardedClaims ?? 0) > 0 ? 'text-amber-300' : 'text-white'}
                title="Claims the admission gate threw out — a fabricated log id, a quote that did not match, an unwitnessed assertion, or co-occurrence. This is the model's OBSERVED hallucination rate: each one would have been a false positive had the claim been trusted."
              />
              <Stat
                label="Failed reviews"
                value={fmt(ai?.failedReviews ?? 0)}
                sub={dur(ai?.avgRunMs) === '—' ? 'no runs timed' : `mean run ${dur(ai?.avgRunMs)}`}
                tone={(ai?.failedReviews ?? 0) > 0 ? 'text-orange-300' : 'text-white'}
                title="Reviews that could not complete — model error, throttling, or a reply too truncated to recover. NOT counted as clean; retried on the next poll."
              />
            </div>
            <div className="rounded-xl border border-edge bg-panel p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                Proposed deterministic rules, by recurrence
              </div>
              <BarRows
                buckets={ai?.ruleCandidates ?? {}}
                emptyNote="No rules proposed yet. A rule that keeps recurring is the queue for promoting a class into a deterministic check — which takes the model out of that loop for good."
              />
            </div>
          </Section>

          <p className="text-[11px] text-slate-600">
            Computed {ago(t.generatedAt)} · window {Math.round(t.windowMs / 60_000)} min · aggregated server-side in
            SQL over parsed_logs, anomalies, agents, validation_agents, validation_agent_runs and poller_runs.
          </p>
        </>
      )}
    </div>
  );
}

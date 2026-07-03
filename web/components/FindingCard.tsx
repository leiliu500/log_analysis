import type { Finding } from '@log/shared';

const SEV: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  low: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  info: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

export function FindingCard({ f }: { f: Finding }) {
  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={`rounded-md border px-2 py-0.5 text-xs uppercase ${SEV[f.severity] ?? SEV.info}`}>
          {f.severity}
        </span>
        <span className="text-xs text-slate-500">
          {f.kind} · {(f.confidence * 100).toFixed(0)}% conf · {f.sources.join(', ')}
        </span>
      </div>
      <h3 className="font-semibold text-white">{f.title}</h3>
      <p className="mt-1 text-sm text-slate-300">{f.summary}</p>

      {/* Source logs — the exact log lines this finding is based on. */}
      {f.evidence.length > 0 && (
        <details className="mt-3 text-sm" open>
          <summary className="cursor-pointer text-slate-400">
            Source logs ({f.evidence.length}) — this finding is derived only from these
          </summary>
          <div className="mt-2 space-y-2">
            {f.evidence.map((e, i) => (
              <div key={i} className="rounded-lg border border-edge bg-edge/40 p-2">
                <div className="mb-1 text-xs text-slate-500">
                  {new Date(e.timestamp).toLocaleString()} · {e.source} · {e.stream}
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-slate-300">
                  {e.excerpt}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )}

      {f.reasoning.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-slate-400">Reasoning ({f.reasoning.length} steps)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-400">
            {f.reasoning.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </details>
      )}
      {f.recommendations.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-slate-400">Recommendations</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-300">
            {f.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 text-xs text-slate-500">
        {new Date(f.windowStart).toLocaleString()} → {new Date(f.windowEnd).toLocaleTimeString()}
      </div>
    </div>
  );
}

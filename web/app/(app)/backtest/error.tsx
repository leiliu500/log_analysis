'use client';

/**
 * Route-level error boundary for /backtest. Without this, any render error in the
 * results panel would unwind the whole page (button included) and show nothing —
 * which reads as "the button does nothing". Here it surfaces the actual error and a
 * retry, so a failure is visible and recoverable instead of silent.
 */
export default function BacktestError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="p-8">
      <h1 className="mb-2 text-xl font-semibold text-red-300">Backtest page hit a rendering error</h1>
      <p className="mb-3 text-sm text-slate-400">
        The backtest itself may have run fine on the API — this is a UI render failure. Details below.
      </p>
      <pre className="max-h-80 overflow-auto rounded-lg border border-red-600/40 bg-red-500/10 p-3 text-xs text-red-200">
        {error.message}
        {error.stack ? `\n\n${error.stack}` : ''}
      </pre>
      <button onClick={reset} className="mt-3 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white">
        Retry
      </button>
    </div>
  );
}

import type { ApplicationDef } from './application.js';
import { loadPrompt } from './prompts.js';

/**
 * The agent inactivity (lifecycle) timeout for an application — how long a still-active
 * transaction may go without a new phase before the engine closes it as an error
 * (timeout). The value is NOT hardcoded per app: it is the single source of truth in the
 * app's own `transaction.md` lifecycle spec (e.g. SCP 30 minutes, apiflc 2 minutes), the
 * same prose the dynamic ingestion agent reasons over. The engine reads it back here for
 * the deterministic wall-clock backstop, so prompt and enforcement can never drift.
 */

/** Matches the "inactivity timeout … N minutes" directive in a transaction.md spec. */
const TIMEOUT_RE = /inactivity timeout(?::|\s+of)?\s+(\d+)\s*minute/i;

// Parsed minutes per prompt path (null = the prompt has no directive / failed to load).
const cache = new Map<string, number | null>();

/**
 * Resolve an app's lifecycle inactivity timeout in ms from its `transaction.md`, falling
 * back to `fallbackMs` when the app declares no prompt, the prompt can't be loaded, or it
 * states no timeout directive. Cached per prompt path (the prompt is immutable at runtime).
 */
export function lifecycleTimeoutMs(app: ApplicationDef | undefined, fallbackMs: number): number {
  const path = app?.transactionPromptPath;
  if (!path) return fallbackMs;
  if (!cache.has(path)) {
    let minutes: number | null = null;
    try {
      const m = loadPrompt(path).match(TIMEOUT_RE);
      minutes = m ? Number(m[1]) : null;
    } catch {
      minutes = null; // missing/unreadable spec ⇒ use the fallback, never crash
    }
    cache.set(path, minutes);
  }
  const minutes = cache.get(path);
  return minutes != null ? minutes * 60_000 : fallbackMs;
}

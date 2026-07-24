import type { DerivedOutcome, ParsedLog } from '@log/shared';
import { apiflcJoin } from './join.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';

/** The gateway HTTP status carried in an apiflc call's logs, if any. */
function httpStatusOf(logs: readonly ParsedLog[]): { status: number; logId: string } | undefined {
  for (const l of logs) {
    const s =
      l.raw.match(/received response\.\s*status:\s*(\d{3})/i)?.[1] ??
      l.raw.match(/method completed with status:\s*(\d{3})/i)?.[1];
    if (s) return { status: Number(s), logId: l.id };
  }
  return undefined;
}

/**
 * Re-derive an apiflc transaction's terminal outcome straight from its raw logs,
 * independent of the ingestion agent's recorded status — the validation engine's
 * status-vs-reality guard ({@link ApplicationDef.deriveOutcome}).
 *
 * apiflc's decisive outcome is the gateway HTTP status ("… Status: 200" / "Method
 * completed with status: 500"), which lives ONLY in the execution log keyed by the
 * gateway requestId — no protocol event carries it, so the generic protocol-based
 * derivation cannot see it. `relatedLogs` is the whole call (handler + authorizer +
 * gateway) already joined by the correlationID, so the status is present here.
 *   2xx/3xx ⇒ completed, 4xx/5xx ⇒ failed. With no status but a handler RESPONSE,
 *   the response was logged ⇒ completed. Otherwise the logs don't prove an outcome
 *   ⇒ unknown (never a mismatch).
 */
export function apiflcDeriveOutcome(_messageId: string, relatedLogs: readonly ParsedLog[]): DerivedOutcome {
  if (!relatedLogs.length) return { status: 'unknown', evidenceLogIds: [], phasesSeen: [] };
  const evidence = new Set<string>();
  const phases = new Set<string>();
  for (const l of relatedLogs) {
    const ev = apiflcTransactionProtocol.eventOf(l);
    if (ev) {
      phases.add(ev.type);
      evidence.add(l.id);
    }
  }
  const http = httpStatusOf(relatedLogs);
  if (http) {
    evidence.add(http.logId);
    phases.add('RESPONSE'); // a logged HTTP response IS the completing RESPONSE
    const phasesSeen = ['REQUEST', 'RESPONSE'].filter((p) => phases.has(p));
    const detail = `gateway HTTP ${http.status}`;
    return http.status >= 400
      ? { status: 'failed', evidenceLogIds: [...evidence], phasesSeen, detail }
      : { status: 'completed', evidenceLogIds: [...evidence], phasesSeen, detail };
  }
  const phasesSeen = ['REQUEST', 'RESPONSE'].filter((p) => phases.has(p));
  if (phases.has('RESPONSE'))
    return { status: 'completed', evidenceLogIds: [...evidence], phasesSeen, detail: 'handler RESPONSE present' };
  if (!evidence.size) return { status: 'unknown', evidenceLogIds: [], phasesSeen };
  return { status: 'unknown', evidenceLogIds: [...evidence], phasesSeen, detail: 'no RESPONSE or HTTP status in logs' };
}

/**
 * Surface each apiflc call's HTTP outcome for the Log Assistant, keyed by the
 * business correlationID.
 *
 * The HTTP status ("Received response. Status: 200 …" / "Method completed with
 * status: 200") lives ONLY in the execution log, keyed by the gateway requestId.
 * That line carries no transaction type, so it never appears in the correlated
 * REQUEST/RESPONSE table the assistant otherwise sees. {@link apiflcJoin} unions
 * the three groups' id spaces so the status resolves back to the correlationID.
 */
export function apiflcHttpOutcomes(logs: ParsedLog[]): string {
  const { find, entries } = apiflcJoin(logs);

  // Per connected component (final root): the business correlationID and any HTTP
  // status seen anywhere in that component.
  const corrByRoot = new Map<string, string>();
  const statusByRoot = new Map<string, string>();
  for (const { ids, raw } of entries) {
    if (!ids.length) continue;
    const root = find(ids[0]!);
    const corr = ids.find((x) => x.startsWith('corr:'));
    if (corr) corrByRoot.set(root, corr.slice('corr:'.length));
    const status =
      raw.match(/received response\.\s*status:\s*(\d{3})/i)?.[1] ?? raw.match(/method completed with status:\s*(\d{3})/i)?.[1];
    if (status) statusByRoot.set(root, status);
  }

  const lines: string[] = [];
  for (const [root, status] of statusByRoot) {
    const corr = corrByRoot.get(root);
    lines.push(`- ${corr ? `correlationID=${corr}` : `gateway requestId=${root.replace(/^req:/, '')}`}: HTTP ${status}`);
  }
  if (!lines.length) return '';
  return [
    'API-GATEWAY HTTP OUTCOMES (joined across the handler, authorizer and execution logs; 2xx/3xx = success, 4xx/5xx = failure):',
    ...lines.sort(),
  ].join('\n');
}

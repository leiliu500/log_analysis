import type { ParsedLog } from '@log/shared';
import { apiflcJoin } from './join.js';

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

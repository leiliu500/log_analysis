import type { DerivedOutcome, ParsedLog } from '@log/shared';
import { edgeMessageMeta, edgeTransactionProtocol } from './transactionProtocol.js';

/** Re-derive the terminal edge result directly from all filename-correlated rows. */
export function edgeDeriveOutcome(fileName: string, relatedLogs: readonly ParsedLog[]): DerivedOutcome {
  const evidenceLogIds: string[] = [];
  const seen = new Set<string>();
  let failure: { status: string; logId: string } | undefined;

  for (const log of relatedLogs) {
    const meta = edgeMessageMeta(log.raw);
    if (!meta || meta.corrId !== fileName) continue;
    evidenceLogIds.push(log.id);
    seen.add(meta.type);
    if (meta.status && !edgeTransactionProtocol.isSuccess(meta.status)) {
      failure ??= { status: meta.status, logId: log.id };
    }
  }
  const phasesSeen = edgeTransactionProtocol.allPhases.filter((phase) => seen.has(phase));
  if (failure) {
    return {
      status: 'failed',
      evidenceLogIds: [failure.logId],
      phasesSeen,
      detail: `edge phase carried non-success status ${failure.status}`,
    };
  }
  if (seen.has('CLOUDWATCH')) {
    return {
      status: 'completed',
      evidenceLogIds,
      phasesSeen,
      detail: 'CloudWatch audit/processing phase present after file transfer',
    };
  }
  return {
    status: 'unknown',
    evidenceLogIds,
    phasesSeen,
    detail: 'no CloudWatch audit/processing phase in logs',
  };
}

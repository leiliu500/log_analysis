import type { ParsedLog } from '@log/shared';
import { edgeCorrelationFile, edgeMessageMeta } from './transactionProtocol.js';

/** Edge invariants not expressible by the generic phase/SLA/outcome validator. */
export function edgeValidationChecks(input: {
  messageId: string;
  agentStatus: string;
  relatedLogs: readonly ParsedLog[];
}): string[] {
  const deltas = new Set<string>();

  for (const log of input.relatedLogs) {
    const meta = edgeMessageMeta(log.raw);
    if (!meta || meta.corrId !== input.messageId) continue;

    if (meta.type === 'BPS' && meta.transferFile) {
      const renamedOriginal = edgeCorrelationFile(meta.transferFile);
      if (renamedOriginal !== meta.originalFile) {
        deltas.add(
          `edge BPS filename mismatch: original ${meta.originalFile}, renamed transfer resolves to ${renamedOriginal}`,
        );
      }
    }

    if (meta.type === 'CLOUDWATCH' && meta.xmlFile) {
      const expectedXml = `Reject_Report_${meta.originalFile.replace(/\.zip$/i, '.xml')}`;
      if (meta.xmlFile !== expectedXml) {
        deltas.add(`edge audit XML mismatch: ${meta.xmlFile} does not match ZIP ${meta.originalFile}`);
      }
    }
  }

  return [...deltas];
}

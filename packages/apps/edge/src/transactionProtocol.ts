import type { ParsedLog, TransactionProtocol, TxEvent } from '@log/shared';

const TRANSFER_PREFIX = /^D\d{8}T\d{9}\./i;

/** Normalize the BPS-renamed filename back to the original SFTP filename. */
export function edgeCorrelationFile(fileName: string): string {
  return fileName.trim().replace(/^['"]|['"]$/g, '').replace(TRANSFER_PREFIX, '');
}

/** Extract an SFTP, BPS, or CloudWatch phase from one edge log line. */
export function edgeEvent(raw: string): TxEvent | undefined {
  const sftp = raw.match(/\bservice=sftp\b.*\boperation=put\b.*\barguments=\S*\/([^\s/]+\.zip)\b/i);
  if (sftp) return { type: 'SFTP', corrId: edgeCorrelationFile(sftp[1]!), ackCode: /\bstatus=SUCCESS\b/i.test(raw) ? 'SUCCESS' : undefined };

  const bps = raw.match(/\|\s*([^|\s]+\.zip)\s*\|\s*[^|]*\|\s*[^|]*\|\s*([A-Za-z]+)\s*$/i);
  if (bps) return { type: 'BPS', corrId: edgeCorrelationFile(bps[1]!), ackCode: bps[2] };

  const cloudwatch = raw.match(/\bZIP_FILE_NM(?:"\s*:\s*"|\s*:)\s*"?([A-Za-z0-9._-]+\.zip)/i);
  if (cloudwatch) return { type: 'CLOUDWATCH', corrId: edgeCorrelationFile(cloudwatch[1]!) };
  return undefined;
}

export const edgeTransactionProtocol: TransactionProtocol = {
  id: 'edge',
  initial: 'SFTP',
  phases: ['BPS', 'CLOUDWATCH'],
  allPhases: ['SFTP', 'BPS', 'CLOUDWATCH'],
  eventOf(log: ParsedLog): TxEvent | undefined {
    return edgeEvent(log.raw);
  },
  isSuccess(ackCode?: string): boolean {
    return !ackCode || /^(SUCCESS|OK|COMPLETED?)$/i.test(ackCode.trim());
  },
};

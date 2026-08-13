import type { ParsedLog, TransactionProtocol, TxEvent } from '@log/shared';

const TRANSFER_PREFIX = /^D\d{8}T\d{9}\./i;

/** Normalize the BPS-renamed filename back to the original SFTP filename. */
export function edgeCorrelationFile(fileName: string): string {
  return fileName.trim().replace(/^['"]|['"]$/g, '').replace(TRANSFER_PREFIX, '');
}

export interface EdgeMessageMeta {
  type: 'SFTP' | 'BPS' | 'CLOUDWATCH';
  corrId: string;
  /** Original file name before the BPS DyyyyMMddTHHmmssSSS. prefix. */
  originalFile: string;
  transferFile?: string;
  xmlFile?: string;
  status?: string;
}

/** Read one edge log line into the fields shared by ingestion, validation and Q&A. */
export function edgeMessageMeta(raw: string): EdgeMessageMeta | undefined {
  const sftpFile = raw.match(/\barguments=\S*\/([^\s/]+\.zip)\b/i)?.[1];
  if (/\bservice=sftp\b/i.test(raw) && /\boperation=put\b/i.test(raw) && sftpFile) {
    const status = raw.match(/\bstatus=([^\s|]+)/i)?.[1];
    const originalFile = edgeCorrelationFile(sftpFile);
    return { type: 'SFTP', corrId: originalFile, originalFile, status };
  }

  const bps = raw.match(/\|\s*([^|\s]+\.zip)\s*\|\s*([^|\s]+\.zip)\s*\|\s*([^|]*)\|\s*([A-Za-z_-]+)\s*$/i);
  if (bps) {
    const originalFile = edgeCorrelationFile(bps[1]!);
    return {
      type: 'BPS',
      corrId: originalFile,
      originalFile,
      transferFile: bps[2],
      status: bps[4],
    };
  }

  // JSON uses `"ZIP_FILE_NM":"..."`; text audit lines use `ZIP_FILE_NM :...`;
  // the processing-count line uses `ZipfileNM "..."`.
  const transferFile = raw.match(/\b(?:ZIP_FILE_NM|ZipfileNM)\b["\s]*(?::|=)?\s*"?([A-Za-z0-9._-]+\.zip)/i)?.[1];
  if (transferFile) {
    const originalFile = edgeCorrelationFile(transferFile);
    const xmlFile = raw.match(/\bXML_FILE_NM\b["\s]*(?::|=)?\s*"?([A-Za-z0-9._-]+\.xml)/i)?.[1];
    const status = raw.match(/\b(?:status|result)\s*[=:]\s*"?([A-Za-z_-]+)/i)?.[1];
    return { type: 'CLOUDWATCH', corrId: originalFile, originalFile, transferFile, xmlFile, status };
  }
  return undefined;
}

/** Extract an SFTP, BPS, or CloudWatch phase from one edge log line. */
export function edgeEvent(raw: string): TxEvent | undefined {
  const meta = edgeMessageMeta(raw);
  if (!meta) return undefined;
  return meta.status
    ? { type: meta.type, corrId: meta.corrId, ackCode: meta.status }
    : { type: meta.type, corrId: meta.corrId };
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
    return !ackCode || /^(SUCCESS|OK|COMPLETE|COMPLETED|PROCESSED)$/i.test(ackCode.trim());
  },
};

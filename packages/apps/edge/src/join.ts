import type { ParsedLog } from '@log/shared';
import { edgeMessageMeta } from './transactionProtocol.js';

/** Return every SFTP/BPS/CloudWatch row belonging to one original ZIP filename. */
export function edgeRelatedLogs(fileName: string, logs: readonly ParsedLog[]): ParsedLog[] {
  return logs
    .filter((log) => edgeMessageMeta(log.raw)?.corrId === fileName)
    .sort((a, b) => a.timestamp - b.timestamp);
}

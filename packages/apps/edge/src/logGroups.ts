/** CloudWatch log groups owned by the edge file-processing application. */
export const EDGE_LOG_GROUPS = [
  'edge-sftp-log-group',
  'edge-bps-log-group',
  'edge-cloudwatch-log-group',
] as const;

export type EdgeLogGroup = (typeof EDGE_LOG_GROUPS)[number];

/** Resolve an exact group name or an edge log-type phrase from a simulator request. */
export function parseEdgeLogGroup(message: string): EdgeLogGroup | undefined {
  for (const group of EDGE_LOG_GROUPS) if (message.includes(group)) return group;
  const text = message.toLowerCase();
  if (/\bedge\b[^\n]*\bsftp\b|\bsftp\s+log\b/.test(text)) return EDGE_LOG_GROUPS[0];
  if (/\bedge\b[^\n]*\bbps\b|\bbps\s+log\b/.test(text)) return EDGE_LOG_GROUPS[1];
  if (/\bedge\b[^\n]*\bcloudwatch\b|\bcloudwatch\s+log\b/.test(text)) return EDGE_LOG_GROUPS[2];
  return undefined;
}

function headerGroup(line: string): EdgeLogGroup | undefined {
  const label = line.match(/^\s*\(\d{1,2}\)\s*(sftp|bps|cloudwatch)\s+log\s*:?\s*$/i)?.[1]?.toLowerCase();
  if (label === 'sftp') return EDGE_LOG_GROUPS[0];
  if (label === 'bps') return EDGE_LOG_GROUPS[1];
  if (label === 'cloudwatch') return EDGE_LOG_GROUPS[2];

  const trimmed = line.trim().replace(/[:\-]\s*$/, '').trim();
  for (const group of EDGE_LOG_GROUPS) {
    if (!trimmed.endsWith(group)) continue;
    const prefix = trimmed.slice(0, trimmed.length - group.length);
    if (/\b(write|simulate|group|target|into|to)\b/i.test(prefix)) return group;
  }
  return undefined;
}

/** Split a raw, labeled edge paste into the SFTP, BPS, and CloudWatch blocks. */
export function splitEdgeByLogGroup(message: string): Array<{ group: string; samples: string }> {
  const segments: Array<{ group: EdgeLogGroup; lines: string[] }> = [];
  let current: { group: EdgeLogGroup; lines: string[] } | undefined;
  for (const line of message.split(/\r?\n/)) {
    const group = headerGroup(line);
    if (group) {
      current = { group, lines: [] };
      segments.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return segments
    .map(({ group, lines }) => ({ group, samples: lines.join('\n').trim() }))
    .filter(({ samples }) => samples.length > 0);
}

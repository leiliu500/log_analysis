import { EDGE_LOG_GROUPS, type EdgeLogGroup, parseEdgeLogGroup } from './logGroups.js';
import {
  EDGE_BPS_SAMPLE,
  EDGE_CLOUDWATCH_SAMPLE,
  EDGE_SAMPLE_ORIGINAL_FILE,
  EDGE_SAMPLE_PREFIX,
  EDGE_SAMPLE_TRANSFER_FILE,
  EDGE_SAMPLE_XML_FILE,
  EDGE_SFTP_SAMPLE,
} from './samples.js';
import { edgeCorrelationFile } from './transactionProtocol.js';

const FILE_NAME = /\bfile\s*name\s*:\s*['"]?([A-Za-z0-9._-]+\.zip)/i;
const PREFIX = /^(D\d{8}T\d{9}\.)/i;

function splitCommands(message: string): string[] {
  const starts = [...message.matchAll(/\(\d{1,2}\)/g)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  if (starts.length < 2) return [message];
  return starts.map((start, index) => message.slice(start, starts[index + 1] ?? message.length).trim());
}

function transferPrefix(fileName: string, wholeRequest: string): string {
  return fileName.match(PREFIX)?.[1] ?? wholeRequest.match(/\b(D\d{8}T\d{9}\.)[A-Za-z0-9._-]+\.zip/i)?.[1] ?? EDGE_SAMPLE_PREFIX;
}

function edgeFileNames(fileName: string, wholeRequest: string): {
  original: string;
  transfer: string;
  xml: string;
  date: string;
  office: string;
} {
  const original = edgeCorrelationFile(fileName);
  const transfer = `${transferPrefix(fileName, wholeRequest)}${original}`;
  const xml = `Reject_Report_${original.replace(/\.zip$/i, '.xml')}`;
  const date = original.match(/_(\d{8})-\d{6}_/)?.[1] ?? '20260813';
  const office = original.match(/_(CP_[A-Za-z0-9]+)\.zip$/i)?.[1] ?? 'CP_220';
  return { original, transfer, xml, date, office };
}

function renderSamples(group: EdgeLogGroup, fileName: string, wholeRequest: string): string {
  const names = edgeFileNames(fileName, wholeRequest);
  if (group === EDGE_LOG_GROUPS[0]) {
    return EDGE_SFTP_SAMPLE.replaceAll(EDGE_SAMPLE_ORIGINAL_FILE, names.original);
  }
  if (group === EDGE_LOG_GROUPS[1]) {
    return EDGE_BPS_SAMPLE
      .replaceAll('/20260813/CP_220/', `/${names.date}/${names.office}/`)
      .replaceAll(EDGE_SAMPLE_TRANSFER_FILE, names.transfer)
      .replaceAll(EDGE_SAMPLE_ORIGINAL_FILE, names.original);
  }
  return EDGE_CLOUDWATCH_SAMPLE
    .replaceAll(EDGE_SAMPLE_XML_FILE, names.xml)
    .replaceAll(EDGE_SAMPLE_TRANSFER_FILE, names.transfer);
}

/**
 * Generate edge logs from each numbered simulator command. Reference blocks (the
 * user's SFTP/BPS/CloudWatch examples) are templates only; only segments containing
 * "simulate" plus a file name become output. Commands targeting the same group are
 * merged so the generic simulator performs one CloudWatch write per group.
 */
export function synthesizeEdgeFromRequest(message: string): Array<{ group: string; samples: string }> | undefined {
  const byGroup = new Map<EdgeLogGroup, string[]>();
  for (const command of splitCommands(message)) {
    if (!/\bsimulate\b/i.test(command)) continue;
    const group = parseEdgeLogGroup(command);
    const fileName = command.match(FILE_NAME)?.[1];
    if (!group || !fileName) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), renderSamples(group, fileName, message)]);
  }
  const targets = [...byGroup.entries()].map(([group, samples]) => ({ group, samples: samples.join('\n') }));
  return targets.length ? targets : undefined;
}

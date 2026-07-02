import { createHash } from 'node:crypto';

/**
 * Turns a log message into a stable structural template by masking variable
 * tokens (numbers, ids, ips, quoted values). Structurally-identical logs share
 * a fingerprint, which drives grouping, baselines and learning.
 *
 * This is a lightweight, dependency-free approximation of the Drain algorithm.
 */
export function templateOf(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(message: string): string {
  return createHash('sha1').update(templateOf(message)).digest('hex').slice(0, 16);
}

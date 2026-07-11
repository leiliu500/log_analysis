import type { LogLevel } from '@log/shared';

const LEVEL_PATTERNS: [RegExp, LogLevel][] = [
  [/\b(fatal|panic|emerg)\b/i, 'fatal'],
  [/\b(error|err|exception|fail(ed|ure)?)\b/i, 'error'],
  [/\b(warn(ing)?)\b/i, 'warn'],
  [/\b(info|notice)\b/i, 'info'],
  [/\b(debug)\b/i, 'debug'],
  [/\b(trace|verbose)\b/i, 'trace'],
];

export function detectLevel(raw: string, explicit?: string): LogLevel {
  if (explicit) {
    const e = explicit.toLowerCase();
    if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(e))
      return e as LogLevel;
  }
  for (const [re, level] of LEVEL_PATTERNS) if (re.test(raw)) return level;
  return 'unknown';
}

/** Regex-based entity extractors. Keyed by entity name. */
const ENTITY_EXTRACTORS: Record<string, RegExp> = {
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  email: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  url: /\bhttps?:\/\/[^\s"'<>]+/g,
  requestId: /\b(?:req(?:uest)?[-_]?id|trace[-_]?id|correlation[-_]?id)[=:\s"]+([\w-]+)/gi,
  statusCode: /\b(?:status(?:[-_ ]?code)?|http)[=:\s"]+(\d{3})\b/gi,
  errorCode: /\b(?:error[-_ ]?code|errno)[=:\s"]+([\w-]+)/gi,
  host: /\b(?:host|hostname|server)[=:\s"]+([\w.-]+)/gi,
  service: /\b(?:service|svc|app(?:lication)?)[=:\s"]+([\w.-]+)/gi,
};

export function extractEntities(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, re] of Object.entries(ENTITY_EXTRACTORS)) {
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      found.add((m[1] ?? m[0]).trim());
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (found.size) out[name] = [...found];
  }
  return out;
}

/** Numeric field extraction (latency, duration, bytes, counts). */
const NUMERIC_FIELDS: [string, RegExp][] = [
  ['latencyMs', /\b(?:latency|duration|took|elapsed|response[-_ ]?time)[=:\s"]+(\d+(?:\.\d+)?)\s*(ms|s)?\b/i],
  ['bytes', /\b(?:bytes|size|length)[=:\s"]+(\d+)\b/i],
  ['statusCode', /\b(?:status(?:[-_ ]?code)?|http)[=:\s"]+(\d{3})\b/i],
];

export function extractNumericFields(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of NUMERIC_FIELDS) {
    const m = re.exec(text);
    if (m) {
      let val = Number(m[1]);
      if (name === 'latencyMs' && m[2]?.toLowerCase() === 's') val *= 1000;
      if (!Number.isNaN(val)) out[name] = val;
    }
  }
  return out;
}

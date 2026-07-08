/**
 * The named application CloudWatch log groups the simulator can target. These
 * mirror the log groups created in Terraform (infra/logs.tf). The simulator
 * routes generated messages to one of these based on either an explicit target
 * log-group name or a content type (e.g. "scp", "scp restapp", "cash").
 */
export const APPLICATION_LOG_GROUPS = [
  'adt-d2-scp-log-group',
  'adt-d2-scp-restapp-log-group',
  'esb-cloudwatch-logs-agent-cash',
] as const;

export type ApplicationLogGroup = (typeof APPLICATION_LOG_GROUPS)[number];

/**
 * Content-type keyword -> log group. Keys are normalized (lowercase, spaces and
 * underscores collapsed to '-'). More-specific content types (scp-restapp) are
 * distinct keys so "scp" alone still resolves to the plain SCP group.
 */
const CONTENT_TYPE_TO_LOG_GROUP: Record<string, ApplicationLogGroup> = {
  scp: 'adt-d2-scp-log-group',
  'scp-log': 'adt-d2-scp-log-group',
  'scp-restapp': 'adt-d2-scp-restapp-log-group',
  'scp-rest-app': 'adt-d2-scp-restapp-log-group',
  restapp: 'adt-d2-scp-restapp-log-group',
  'rest-app': 'adt-d2-scp-restapp-log-group',
  rest: 'adt-d2-scp-restapp-log-group',
  esb: 'esb-cloudwatch-logs-agent-cash',
  'agent-cash': 'esb-cloudwatch-logs-agent-cash',
  'cash-agent': 'esb-cloudwatch-logs-agent-cash',
};

const normalize = (s: string): string => s.trim().toLowerCase().replace(/[_\s]+/g, '-');

/**
 * Resolve a user-supplied string to a known application log group. Accepts an
 * exact log-group name (case-insensitive) or a content-type keyword. Returns
 * undefined when nothing matches (caller falls back to its default sink).
 */
export function resolveLogGroup(input?: string | null): ApplicationLogGroup | undefined {
  if (!input) return undefined;
  const norm = normalize(input);
  if (!norm) return undefined;
  const exact = APPLICATION_LOG_GROUPS.find((g) => g.toLowerCase() === input.trim().toLowerCase());
  if (exact) return exact;
  return CONTENT_TYPE_TO_LOG_GROUP[norm];
}

/**
 * Detect a target log group from a natural-language instruction. Looks first for
 * a literal log-group name, then for content-type keywords (most specific
 * first). Bare "cash"/"cashMessage" is intentionally NOT matched here so it
 * keeps routing to the default simulated-app stream unless the user names the
 * ESB group or an unambiguous "agent cash" / "esb" content type.
 */
export function parseLogGroup(message: string): ApplicationLogGroup | undefined {
  const m = message.toLowerCase();
  for (const g of APPLICATION_LOG_GROUPS) if (m.includes(g.toLowerCase())) return g;
  if (/\bscp[-\s]?rest[-\s]?app\b|\brest[-\s]?app\b/.test(m)) return 'adt-d2-scp-restapp-log-group';
  if (/\bscp\b/.test(m)) return 'adt-d2-scp-log-group';
  if (/\besb\b|\b(agent[-\s]?cash|cash[-\s]?agent)\b/.test(m)) return 'esb-cloudwatch-logs-agent-cash';
  return undefined;
}
